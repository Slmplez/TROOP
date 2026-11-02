use super::Store;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE owned_tasks(id INTEGER PRIMARY KEY REFERENCES agent_invocations(id),owner_run_id INTEGER NOT NULL REFERENCES agent_runs(id),root_run_id INTEGER NOT NULL REFERENCES agent_runs(id),document TEXT NOT NULL);
      CREATE INDEX owned_tasks_owner ON owned_tasks(owner_run_id,id);
      CREATE INDEX owned_tasks_root ON owned_tasks(root_run_id,id);
      PRAGMA user_version=4; COMMIT;
    ").map_err(|e|e.to_string())
}
pub fn public_task(task: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "id",
        "owner_run_id",
        "parent_task_id",
        "root_run_id",
        "child_run_id",
        "kind",
        "state",
        "epoch",
        "completion_id",
        "consumed",
        "stopped",
        "reviewed",
        "stop_requested",
        "title",
    ] {
        result[key] = task[key].clone();
    }
    result
}
impl Store {
    pub fn active_task_roots(&self) -> Result<Vec<i64>, String> {
        let mut q=self.db.prepare("SELECT DISTINCT root_run_id FROM owned_tasks WHERE json_extract(document,'$.state') IN ('queued','dispatched','running','cancelling') ORDER BY root_run_id").map_err(|e|e.to_string())?;
        let rows = q.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn owned_task(&self, id: i64) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row("SELECT document FROM owned_tasks WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|_| "Owned task does not exist")?;
        serde_json::from_str(&raw).map_err(|_| "Owned task record is invalid".into())
    }
    pub fn owned_tasks(&self, root: i64) -> Result<Vec<Value>, String> {
        let mut q = self
            .db
            .prepare("SELECT document FROM owned_tasks WHERE root_run_id=?1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([root], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            r.map_err(|e| e.to_string()).and_then(|raw| {
                serde_json::from_str(&raw).map_err(|_| "Owned task record is invalid".into())
            })
        })
        .collect()
    }
    pub fn task_root(doc: &Value) -> i64 {
        doc["root_run_id"]
            .as_i64()
            .unwrap_or_else(|| doc["id"].as_i64().unwrap())
    }
    pub fn tree_runs(&self, root: i64) -> Result<Vec<Value>, String> {
        let mut q=self.db.prepare("SELECT document FROM agent_runs WHERE id=?1 OR json_extract(document,'$.root_run_id')=?1 ORDER BY id").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([root], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            r.map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str(&s).map_err(|_| "Run record is invalid".into()))
        })
        .collect()
    }
    /// Persist the whole selected subtree's stop fence before sending any cancellation.
    pub fn fence_runs(&mut self, ids: &[i64], intent: Option<&str>) -> Result<(), String> {
        let mut docs = ids
            .iter()
            .map(|id| self.agent_run(*id))
            .collect::<Result<Vec<_>, _>>()?;
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        for doc in &mut docs {
            if matches!(
                doc["state"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                continue;
            }
            if doc["intent"].is_null() {
                doc["intent"] = json!(intent);
            }
            doc["state"] = json!("cancelling");
            doc["revision"] = json!(doc["revision"].as_u64().unwrap_or(0) + 1);
            tx.execute(
                "UPDATE agent_runs SET state='cancelling',document=?1 WHERE id=?2",
                params![doc.to_string(), doc["id"].as_i64()],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO agent_events(run_id,epoch,kind,payload) VALUES(?1,?2,'tree_stop_requested',?3)",params![doc["id"].as_i64(),doc["epoch"].as_i64(),json!({"state":"cancelling","intent":doc["intent"]}).to_string()]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn tasks_quarantined(&self) -> Result<bool, String> {
        self.db.query_row("SELECT EXISTS(SELECT 1 FROM owned_tasks WHERE json_extract(document,'$.kind')='background' AND json_extract(document,'$.state') IN ('indeterminate','interrupted') AND coalesce(json_extract(document,'$.stopped'),0)=0 AND coalesce(json_extract(document,'$.reviewed'),0)=0)",[],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub fn tasks_recover(&mut self) -> Result<(), String> {
        let mut q=self.db.prepare("SELECT id FROM owned_tasks WHERE json_extract(document,'$.state') IN ('queued','dispatched','running','cancelling')").map_err(|e|e.to_string())?;
        let ids = q
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(q);
        for id in ids {
            let mut task = self.owned_task(id)?;
            let dispatched = matches!(
                task["state"].as_str(),
                Some("dispatched" | "running" | "cancelling")
            );
            task["state"] = json!(if task["kind"] == "background" && dispatched {
                "indeterminate"
            } else {
                "interrupted"
            });
            task["stopped"] = json!(task["kind"] != "background" || !dispatched);
            task["result"] = json!({"ok":false,"error":"Execution interrupted; reconcile before manual continuation. Previous work will not be replayed."});
            let mut owner = self.agent_run(task["owner_run_id"].as_i64().unwrap())?;
            self.agent_commit(
                &mut owner,
                &mut [],
                std::slice::from_mut(&mut task),
                None,
                "owned_task_recovered",
            )?;
        }
        Ok(())
    }
}
