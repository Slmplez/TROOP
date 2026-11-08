use super::Store;
use rusqlite::Connection;
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
        "continuation_of",
        "scope_change_interaction_id",
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
    pub fn tasks_quarantined(&self) -> Result<bool, String> {
        self.db.query_row("SELECT EXISTS(SELECT 1 FROM owned_tasks WHERE json_extract(document,'$.kind') IN ('background','external_cli') AND json_extract(document,'$.state') IN ('indeterminate','interrupted') AND coalesce(json_extract(document,'$.stopped'),0)=0 AND coalesce(json_extract(document,'$.reviewed'),0)=0)",[],|r|r.get(0)).map_err(|e|e.to_string())
    }
}
