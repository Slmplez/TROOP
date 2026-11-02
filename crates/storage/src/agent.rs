use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE agent_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,client_id TEXT NOT NULL UNIQUE,request TEXT NOT NULL,state TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE agent_invocations(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER NOT NULL REFERENCES agent_runs(id),document TEXT NOT NULL);
      CREATE INDEX agent_invocations_run ON agent_invocations(run_id,id);
      CREATE TABLE agent_events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER NOT NULL REFERENCES agent_runs(id),epoch INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      PRAGMA user_version=3; COMMIT;
    ").map_err(|e|e.to_string())
}
pub fn public_run(doc: &Value, brief: bool) -> Value {
    let mut result = json!({});
    for key in [
        "id",
        "state",
        "epoch",
        "revision",
        "step",
        "intent",
        "workspace_id",
        "error",
        "waiting",
        "created_at",
        "updated_at",
        "owner_task_id",
        "root_run_id",
        "depth",
        "read_only",
        "agent_id",
        "compaction_epoch",
        "compaction_count",
        "maintenance_job_id",
    ] {
        result[key] = doc[key].clone();
    }
    result["title"] = json!(doc["goal"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(80)
        .collect::<String>());
    if !brief {
        result["provider_name"] = doc["config"]["name"].clone();
        result["model"] = doc["config"]["model"].clone();
        for (key, limit) in [("goal", 1000), ("output", 3000)] {
            let text = doc[key].as_str().unwrap_or("");
            result[key] = json!(text.chars().take(limit).collect::<String>());
            result[format!("{key}_truncated")] = json!(text.chars().count() > limit);
        }
        result["last_model"] = doc["last_model"].clone();
        result["supplements"] = json!(doc["supplements"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|i| json!({"id":i["id"],"applied":i["applied"]}))
            .collect::<Vec<_>>());
    }
    result
}
impl Store {
    pub fn agent_events(&self, run: i64, before: Option<i64>) -> Result<Value, String> {
        self.agent_run(run)?;
        let mut q=self.db.prepare("SELECT id,epoch,kind,payload,created_at FROM agent_events WHERE run_id=?1 AND id<?2 ORDER BY id DESC LIMIT 16").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(params![run, before.unwrap_or(i64::MAX)], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            let (id, epoch, kind, payload, created_at) = row.map_err(|e| e.to_string())?;
            let p: Value = serde_json::from_str(&payload).map_err(|_| "执行事件损坏。")?;
            items.push(json!({"id":id,"epoch":epoch,"kind":kind,"created_at":created_at,"state":p["state"],"step":p["step"]}));
        }
        let more = items.len() > 15;
        items.truncate(15);
        let cursor = if more {
            items.last().map(|i| i["id"].clone())
        } else {
            None
        };
        Ok(json!({"items":items,"next_before":cursor}))
    }
    pub fn agent_event(&self, id: i64) -> Result<Value, String> {
        let (run, kind, payload): (i64, String, String) = self
            .db
            .query_row(
                "SELECT run_id,kind,payload FROM agent_events WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "执行事件不存在。")?;
        let p: Value = serde_json::from_str(&payload).map_err(|_| "执行事件损坏。")?;
        let invocations=p["invocations"].as_array().into_iter().flatten().map(|i|json!({"id":i["id"],"name":i["name"],"state":i["state"],"approval":i["approval"]})).collect::<Vec<_>>();
        Ok(
            json!({"id":id,"run_id":run,"kind":kind,"state":p["state"],"intent":p["intent"],"step":p["step"],"model_text":p["model_text"],"last_model":p["last_model"],"error":p["error"],"invocations":invocations}),
        )
    }
    pub fn agent_list(&self, offset: i64) -> Result<Value, String> {
        if offset < 0 {
            return Err("分页参数无效。".into());
        }
        let mut query = self
            .db
            .prepare("SELECT document FROM agent_runs ORDER BY id DESC LIMIT 30 OFFSET ?1")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([offset], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let items = rows
            .map(|r| {
                r.map_err(|e| e.to_string()).and_then(|s| {
                    serde_json::from_str::<Value>(&s)
                        .map(|v| public_run(&v, true))
                        .map_err(|_| "任务记录损坏。".into())
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let total: i64 = self
            .db
            .query_row("SELECT count(*) FROM agent_runs", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let next = offset + items.len() as i64;
        Ok(json!({"items":items,"total":total,"next_offset":if next<total{Some(next)}else{None}}))
    }
    pub fn agent_quarantined(&self) -> Result<bool, String> {
        self.db.query_row("SELECT EXISTS(SELECT 1 FROM agent_invocations WHERE json_extract(document,'$.state')='indeterminate' AND coalesce(json_extract(document,'$.stopped'),0)=0 AND coalesce(json_extract(document,'$.reviewed'),0)=0)",[],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub fn workspace_path(&self, id: i64) -> Result<String, String> {
        self.db
            .query_row("SELECT path FROM workspaces WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|_| "所选工作区不存在。".into())
    }
    pub fn agent_duplicate(&self, client: &str, request: &Value) -> Result<Option<Value>, String> {
        let row: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT request,document FROM agent_runs WHERE client_id=?1",
                [client],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match row {
            Some((original, doc)) => {
                if serde_json::from_str::<Value>(&original).map_err(|_| "任务请求记录损坏。")?
                    != *request
                {
                    return Err("任务标识已用于不同参数。".into());
                }
                Ok(Some(
                    serde_json::from_str(&doc).map_err(|_| "任务记录损坏。")?,
                ))
            }
            None => Ok(None),
        }
    }
    pub fn agent_create(
        &mut self,
        client: &str,
        request: &Value,
        doc: &mut Value,
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let now: String = tx
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        doc["created_at"] = json!(now);
        doc["updated_at"] = json!(now);
        tx.execute(
            "INSERT INTO agent_runs(client_id,request,state,document) VALUES(?1,?2,'queued',?3)",
            params![client, request.to_string(), doc.to_string()],
        )
        .map_err(|e| e.to_string())?;
        doc["id"] = json!(tx.last_insert_rowid());
        tx.execute(
            "UPDATE agent_runs SET document=?1 WHERE id=?2",
            params![doc.to_string(), doc["id"].as_i64()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO agent_events(run_id,epoch,kind,payload) VALUES(?1,1,'accepted',?2)",
            params![doc["id"].as_i64(), request.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn agent_run(&self, id: i64) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row("SELECT document FROM agent_runs WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|_| "任务不存在。")?;
        serde_json::from_str(&raw).map_err(|_| "任务记录损坏。".into())
    }
    pub fn agent_runs(&self) -> Result<Vec<Value>, String> {
        let mut q = self
            .db
            .prepare("SELECT document FROM agent_runs ORDER BY id DESC")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            r.map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str(&s).map_err(|_| "任务记录损坏。".into()))
        })
        .collect()
    }
    pub fn agent_invocation(&self, id: i64) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row(
                "SELECT document FROM agent_invocations WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "工具调用不存在。")?;
        serde_json::from_str(&raw).map_err(|_| "工具记录损坏。".into())
    }
    pub fn agent_invocations(&self, run: i64) -> Result<Vec<Value>, String> {
        let mut q = self
            .db
            .prepare("SELECT document FROM agent_invocations WHERE run_id=?1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([run], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            r.map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str(&s).map_err(|_| "工具记录损坏。".into()))
        })
        .collect()
    }
    /// Commit run state, immutable invocation identities/results, and the event together.
    pub fn agent_save(
        &mut self,
        doc: &mut Value,
        invocations: &mut [Value],
        kind: &str,
    ) -> Result<(), String> {
        self.agent_commit(doc, invocations, &mut [], None, kind)
    }
    pub fn agent_commit(
        &mut self,
        doc: &mut Value,
        invocations: &mut [Value],
        tasks: &mut [Value],
        child: Option<&mut Value>,
        kind: &str,
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        if let Some(action) = doc.as_object_mut().unwrap().remove("_memory_action") {
            super::memory::apply_action(&tx, &action, false)?;
        }
        if let Some(checkpoint) = doc.as_object_mut().unwrap().remove("_context_checkpoint") {
            tx.execute(
                "INSERT INTO context_checkpoints(run_id,epoch,document) VALUES(?1,?2,?3)",
                params![
                    doc["id"].as_i64(),
                    doc["epoch"].as_i64(),
                    checkpoint.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(child) = child {
            let client = format!("owned-task-{}", child["owner_task_id"]);
            child["created_at"] = doc["updated_at"].clone();
            child["updated_at"] = doc["updated_at"].clone();
            tx.execute("INSERT INTO agent_runs(client_id,request,state,document) VALUES(?1,'{}','queued','{}')", [&client]).map_err(|e|e.to_string())?;
            child["id"] = json!(tx.last_insert_rowid());
            tx.execute(
                "UPDATE agent_runs SET document=?1 WHERE id=?2",
                params![child.to_string(), child["id"].as_i64()],
            )
            .map_err(|e| e.to_string())?;
            tasks[0]["child_run_id"] = child["id"].clone();
            tx.execute(
                "INSERT INTO agent_events(run_id,epoch,kind,payload) VALUES(?1,1,'accepted',?2)",
                params![
                    child["id"].as_i64(),
                    json!({"owner_task_id":child["owner_task_id"]}).to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        for task in tasks {
            tx.execute("INSERT INTO owned_tasks(id,owner_run_id,root_run_id,document) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET document=excluded.document",params![task["id"].as_i64(),task["owner_run_id"].as_i64(),task["root_run_id"].as_i64(),task.to_string()]).map_err(|e|e.to_string())?;
        }
        for invocation in invocations.iter_mut() {
            if invocation["id"].as_i64().is_none() {
                tx.execute(
                    "INSERT INTO agent_invocations(run_id,document) VALUES(?1,'{}')",
                    [doc["id"].as_i64()],
                )
                .map_err(|e| e.to_string())?;
                invocation["id"] = json!(tx.last_insert_rowid());
            }
            tx.execute(
                "UPDATE agent_invocations SET document=?1 WHERE id=?2 AND run_id=?3",
                params![
                    invocation.to_string(),
                    invocation["id"].as_i64(),
                    doc["id"].as_i64()
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        if doc["reset_pending"] == true {
            doc["pending"] = json!(invocations
                .iter()
                .map(|i| i["id"].clone())
                .collect::<Vec<_>>());
            doc.as_object_mut().unwrap().remove("reset_pending");
        }
        doc["revision"] = json!(doc["revision"].as_i64().unwrap_or(0) + 1);
        let timestamp: String = tx
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        doc["updated_at"] = json!(timestamp);
        tx.execute(
            "UPDATE agent_runs SET state=?1,document=?2 WHERE id=?3",
            params![doc["state"].as_str(), doc.to_string(), doc["id"].as_i64()],
        )
        .map_err(|e| e.to_string())?;
        if matches!(kind, "model_text" | "background_output") {
            return tx.commit().map_err(|e| e.to_string());
        }
        let payload = json!({"version":1,"revision":doc["revision"],"state":doc["state"],"intent":doc["intent"],"step":doc["step"],"attempt":doc["attempt"],"error":doc["error"],"model_text":doc["model_text"],"last_model":if kind=="model_finished"{doc["last_model"].clone()}else{Value::Null},"invocations":invocations});
        tx.execute(
            "INSERT INTO agent_events(run_id,epoch,kind,payload) VALUES(?1,?2,?3,?4)",
            params![
                doc["id"].as_i64(),
                doc["epoch"].as_i64(),
                kind,
                payload.to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn agent_recover(&mut self) -> Result<(), String> {
        let mut q=self.db.prepare("SELECT id FROM agent_runs WHERE state NOT IN ('completed','failed','cancelled','interrupted')").map_err(|e|e.to_string())?;
        let ids = q
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(q);
        for id in ids {
            let mut doc = self.agent_run(id)?;
            let mut invocations = self.agent_invocations(id)?;
            for inv in &mut invocations {
                if matches!(inv["state"].as_str(), Some("dispatched" | "running")) {
                    inv["state"] = json!("indeterminate");
                    inv["reviewed"] = json!(false);
                    inv["stopped"] = json!(false);
                }
            }
            doc["state"] = json!("interrupted");
            doc["waiting"] = json!([]);
            doc["error"] = json!("上次执行中断；请核对工具记录后手动继续，旧操作不会自动重放。");
            self.agent_save(&mut doc, &mut invocations, "recovered")?;
        }
        Ok(())
    }
}
