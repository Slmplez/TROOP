//! Bounded durable invalidation feed. Cursors survive process generations; snapshots
//! and their high-water mark are read in one SQLite transaction.
use super::Store;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
#[cfg(test)]
mod tests;

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE execution_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,resource TEXT NOT NULL,resource_id INTEGER NOT NULL,run_id INTEGER NOT NULL,revision INTEGER NOT NULL);
        CREATE TABLE execution_versions(resource TEXT NOT NULL,resource_id INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(resource,resource_id));
        CREATE TRIGGER execution_changes_trim AFTER INSERT ON execution_changes BEGIN
          INSERT INTO execution_versions VALUES(NEW.resource,NEW.resource_id,NEW.sequence) ON CONFLICT(resource,resource_id) DO UPDATE SET revision=excluded.revision;
          DELETE FROM execution_changes WHERE sequence<=NEW.sequence-4096; END;").map_err(|e|e.to_string())?;
    for (table, resource, run, revision) in [
        ("agent_runs", "run", "NEW.id", "coalesce(json_extract(NEW.document,'$.revision'),0)"),
        ("owned_tasks", "task", "NEW.owner_run_id", "coalesce(json_extract((SELECT document FROM agent_runs WHERE id=NEW.owner_run_id),'$.revision'),0)"),
        ("agent_invocations", "invocation", "NEW.run_id", "coalesce(json_extract((SELECT document FROM agent_runs WHERE id=NEW.run_id),'$.revision'),0)"),
        ("hook_calls", "hook", "NEW.run_id", "0"),
        ("mcp_connections", "mcp", "NEW.run_id", "0"),
        ("agent_events", "event", "NEW.run_id", "coalesce(json_extract(NEW.payload,'$.revision'),0)"),
    ] {
        for action in ["INSERT", "UPDATE"] {
            // All identifiers and expressions above are compile-time constants.
            tx.execute_batch(&format!("CREATE TRIGGER follow_{table}_{action} AFTER {action} ON {table} BEGIN INSERT INTO execution_changes(resource,resource_id,run_id,revision) VALUES('{resource}',NEW.id,{run},{revision}); END;")).map_err(|e|e.to_string())?;
        }
    }
    tx.execute_batch("PRAGMA user_version=12;")
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

impl Store {
    pub fn execution_revision(&self, resource: &str, id: i64) -> Result<i64, String> {
        self.db.query_row("SELECT coalesce((SELECT revision FROM execution_versions WHERE resource=?1 AND resource_id=?2),0)",params![resource,id],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub fn execution_follow(
        &self,
        kind: &str,
        id: i64,
        cursor: Option<&str>,
        snapshot: impl FnOnce(&Store) -> Result<Value, String>,
    ) -> Result<Value, String> {
        if id <= 0 || !matches!(kind, "run" | "task" | "invocation") {
            return Err("Invalid follow resource".into());
        }
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let root = if kind == "run" {
            Self::task_root(&self.agent_run(id)?)
        } else if kind == "invocation" {
            let inv = self.agent_invocation(id)?;
            Self::task_root(
                &self.agent_run(inv["run_id"].as_i64().ok_or("Invalid invocation owner")?)?,
            )
        } else {
            self.owned_task(id)?["root_run_id"]
                .as_i64()
                .ok_or("Invalid task root")?
        };
        let instance = self.instance_id()?;
        let prefix = format!("f1:{instance}:{kind}:{id}:");
        let high: i64 = self.db.query_row("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='execution_changes'),0)",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        let low: i64 = self
            .db
            .query_row(
                "SELECT coalesce(min(sequence),?1+1) FROM execution_changes",
                [high],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let after = cursor
            .and_then(|s| s.strip_prefix(&prefix))
            .and_then(|s| s.parse::<i64>().ok());
        if cursor.is_some() && !after.is_some_and(|n| n >= low - 1 && n <= high) {
            return Ok(
                json!({"state":"reset_required","resource":kind,"id":id,"instance_id":instance,"from_cursor":cursor,"cursor":null,"has_more":false,"changes":[],"snapshot":null}),
            );
        }
        let mut changes = Vec::new();
        let mut end = high;
        if let Some(after) = after {
            end = (after + 32).min(high);
            let mut q = self.db.prepare("SELECT sequence,resource,resource_id,run_id,revision FROM execution_changes WHERE sequence>?1 AND sequence<=?2 ORDER BY sequence").map_err(|e|e.to_string())?;
            let rows = q
                .query_map(params![after, end], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut expected = after + 1;
            for row in rows {
                let (sequence, resource, resource_id, run_id, revision) =
                    row.map_err(|e| e.to_string())?;
                if sequence != expected {
                    break;
                }
                expected += 1;
                if Self::task_root(&self.agent_run(run_id)?) == root {
                    let resource_revision = if resource == "run" {
                        revision
                    } else {
                        sequence
                    };
                    let mut change = json!({"sequence":sequence,"resource":resource,"resource_id":resource_id,"run_id":run_id,"revision":resource_revision,"run_revision":revision});
                    if resource == "event" {
                        let event: Value = self.db.query_row("SELECT json_object('id',id,'epoch',epoch,'kind',kind,'created_at',created_at,'state',json_extract(payload,'$.state'),'step',json_extract(payload,'$.step')) FROM agent_events WHERE id=?1",[resource_id],|r|r.get::<_,String>(0)).map_err(|e|e.to_string()).and_then(|s|serde_json::from_str(&s).map_err(|e|e.to_string()))?;
                        change["event"] = event;
                    }
                    changes.push(change);
                }
            }
            if expected != end + 1 {
                return Ok(
                    json!({"state":"reset_required","resource":kind,"id":id,"instance_id":instance,"from_cursor":cursor,"cursor":null,"has_more":false,"changes":[],"snapshot":null}),
                );
            }
        }
        let data = if end == high {
            snapshot(self)?
        } else {
            Value::Null
        };
        let frame = json!({"state":if cursor.is_none(){"snapshot"}else{"delta"},"resource":kind,"id":id,"instance_id":instance,"from_cursor":cursor,"cursor":format!("{prefix}{end}"),"has_more":end<high,"changes":changes,"snapshot":data});
        tx.commit().map_err(|e| e.to_string())?;
        Ok(frame)
    }
}
