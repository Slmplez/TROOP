use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE hooks(id INTEGER PRIMARY KEY AUTOINCREMENT,revision INTEGER NOT NULL,document TEXT NOT NULL);
      CREATE TABLE hook_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER NOT NULL REFERENCES agent_runs(id),event_key TEXT NOT NULL,rule_id INTEGER NOT NULL,document TEXT NOT NULL,UNIQUE(run_id,event_key,rule_id));
      PRAGMA user_version=7; COMMIT;").map_err(|e|e.to_string())
}
impl Store {
    pub fn hook_remove(&self, id: i64, expected: i64) -> Result<(), String> {
        let n = self
            .db
            .execute(
                "DELETE FROM hooks WHERE id=?1 AND revision=?2",
                params![id, expected],
            )
            .map_err(|e| e.to_string())?;
        if n != 1 {
            return Err("Hook definition changed; refresh before deleting".into());
        }
        Ok(())
    }
    pub fn hook_rules(&self) -> Result<Vec<Value>, String> {
        let mut q = self
            .db
            .prepare("SELECT id,revision,document FROM hooks ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            let (id, revision, text) = r.map_err(|e| e.to_string())?;
            let mut d: Value =
                serde_json::from_str(&text).map_err(|_| "Invalid Hook definition")?;
            d["id"] = json!(id);
            d["revision"] = json!(revision);
            Ok(d)
        })
        .collect()
    }
    pub fn hook_save(&self, id: Option<i64>, expected: i64, doc: &Value) -> Result<Value, String> {
        let id = if let Some(id) = id {
            let n = self
                .db
                .execute(
                    "UPDATE hooks SET revision=revision+1,document=?1 WHERE id=?2 AND revision=?3",
                    params![doc.to_string(), id, expected],
                )
                .map_err(|e| e.to_string())?;
            if n != 1 {
                return Err("Hook definition changed; refresh before editing".into());
            }
            id
        } else {
            let n: i64 = self
                .db
                .query_row("SELECT count(*) FROM hooks", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if n >= 64 || expected != 0 {
                return Err("Hook capacity reached or invalid creation revision".into());
            }
            self.db
                .execute(
                    "INSERT INTO hooks(revision,document) VALUES(1,?1)",
                    [doc.to_string()],
                )
                .map_err(|e| e.to_string())?;
            self.db.last_insert_rowid()
        };
        self.hook_rules()?
            .into_iter()
            .find(|h| h["id"] == id)
            .ok_or("Saved Hook missing".into())
    }
    pub fn hook_call_key(&self, run: i64, key: &str, rule: i64) -> Result<Option<Value>, String> {
        let row:Option<(i64,String)>=self.db.query_row("SELECT id,document FROM hook_calls WHERE run_id=?1 AND event_key=?2 AND rule_id=?3",params![run,key,rule],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        row.map(|(id, text)| {
            let mut d: Value = serde_json::from_str(&text).map_err(|_| "Invalid Hook receipt")?;
            d["id"] = json!(id);
            Ok(d)
        })
        .transpose()
    }
    pub fn hook_call(&self, id: i64) -> Result<Value, String> {
        let text: String = self
            .db
            .query_row("SELECT document FROM hook_calls WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|_| "Hook call not found")?;
        serde_json::from_str(&text).map_err(|_| "Invalid Hook receipt".into())
    }
    pub fn hook_call_create(&self, doc: &mut Value) -> Result<(), String> {
        self.db
            .execute(
                "INSERT INTO hook_calls(run_id,event_key,rule_id,document) VALUES(?1,?2,?3,?4)",
                params![
                    doc["run_id"].as_i64(),
                    doc["event_key"].as_str(),
                    doc["rule"]["id"].as_i64(),
                    doc.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        doc["id"] = json!(self.db.last_insert_rowid());
        self.hook_call_save(doc)
    }
    pub fn hook_call_save(&self, doc: &Value) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE hook_calls SET document=?1 WHERE id=?2",
                params![doc.to_string(), doc["id"].as_i64()],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn hook_calls(&self, run: i64) -> Result<Vec<Value>, String> {
        let mut q = self
            .db
            .prepare("SELECT document FROM hook_calls WHERE run_id=?1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([run], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?)
                    .map_err(|_| "Invalid Hook receipt".into())
            })
            .collect();
        rows
    }
    pub fn hooks_recover(&self) -> Result<(), String> {
        self.db.execute("UPDATE hook_calls SET document=json_set(document,'$.state','cancelled','$.error','Core interrupted before dispatch; not replayed') WHERE json_extract(document,'$.state')='queued'",[]).map_err(|e|e.to_string())?;
        self.db.execute("UPDATE hook_calls SET document=json_set(document,'$.state','indeterminate','$.error','Core interrupted; inspect effects and process stop before manual continuation','$.reviewed',json('false')) WHERE json_extract(document,'$.state') IN ('running','dispatched')",[]).map(|_|()).map_err(|e|e.to_string())
    }
    pub fn hooks_quarantined(&self) -> Result<bool, String> {
        self.db.query_row("SELECT EXISTS(SELECT 1 FROM hook_calls WHERE json_extract(document,'$.state')='indeterminate' AND coalesce(json_extract(document,'$.stopped'),0)=0 AND coalesce(json_extract(document,'$.reviewed'),0)=0)",[],|r|r.get(0)).map_err(|e|e.to_string())
    }
}
