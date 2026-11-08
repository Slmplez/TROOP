use super::Store;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;CREATE TABLE mcp_connections(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER NOT NULL REFERENCES agent_runs(id),document TEXT NOT NULL);CREATE TABLE mcp_artifacts(id TEXT PRIMARY KEY,run_id INTEGER NOT NULL REFERENCES agent_runs(id),invocation_id INTEGER NOT NULL REFERENCES agent_invocations(id),document TEXT NOT NULL,content BLOB NOT NULL);PRAGMA user_version=10;COMMIT;").map_err(|e|e.to_string())
}
impl Store {
    pub fn mcp_connection_create(&mut self, doc: &mut Value) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO mcp_connections(run_id,document) VALUES(?1,?2)",
            params![doc["run_id"].as_i64(), doc.to_string()],
        )
        .map_err(|e| e.to_string())?;
        doc["id"] = json!(tx.last_insert_rowid());
        tx.execute(
            "UPDATE mcp_connections SET document=?1 WHERE id=?2",
            params![doc.to_string(), doc["id"].as_i64()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn mcp_connection_save(&self, doc: &Value) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE mcp_connections SET document=?1 WHERE id=?2",
                params![doc.to_string(), doc["id"].as_i64()],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn mcp_connection(&self, id: i64) -> Result<Value, String> {
        let text: String = self
            .db
            .query_row(
                "SELECT document FROM mcp_connections WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "MCP connection not found")?;
        serde_json::from_str(&text).map_err(|_| "Invalid MCP connection record".into())
    }
    pub fn mcp_connections(&self, run: i64) -> Result<Vec<Value>, String> {
        let mut q = self
            .db
            .prepare("SELECT document FROM mcp_connections WHERE run_id=?1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([run], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?)
                    .map_err(|_| "Invalid MCP connection record".into())
            })
            .collect();
        rows
    }
    pub fn mcp_runtime_recover(&self) -> Result<(), String> {
        self.db.execute("UPDATE mcp_connections SET document=json_set(document,'$.state',CASE WHEN json_extract(document,'$.transport')='stdio' THEN 'indeterminate' ELSE 'closed' END,'$.stopped',CASE WHEN json_extract(document,'$.transport')='stdio' THEN json('false') ELSE json('true') END,'$.error','Core interrupted; old connection not resumed') WHERE json_extract(document,'$.state') IN ('starting','open','closing')",[]).map(|_|()).map_err(|e|e.to_string())
    }
    pub fn mcp_quarantined(&self) -> Result<bool, String> {
        self.db.query_row("SELECT EXISTS(SELECT 1 FROM mcp_connections WHERE json_extract(document,'$.transport')='stdio' AND json_extract(document,'$.state')='indeterminate' AND coalesce(json_extract(document,'$.stopped'),0)=0 AND coalesce(json_extract(document,'$.reviewed'),0)=0)",[],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub fn mcp_artifact_bytes(&self, id: &str, run: i64) -> Result<Vec<u8>, String> {
        self.db
            .query_row(
                "SELECT content FROM mcp_artifacts WHERE id=?1 AND run_id=?2",
                params![id, run],
                |r| r.get(0),
            )
            .map_err(|_| "MCP artifact does not belong to this Run".into())
    }
    pub fn mcp_artifact(&self, id: &str, run: i64) -> Result<Value, String> {
        let text: String = self
            .db
            .query_row(
                "SELECT document FROM mcp_artifacts WHERE id=?1 AND run_id=?2",
                params![id, run],
                |r| r.get(0),
            )
            .map_err(|_| "MCP artifact does not belong to this Run")?;
        serde_json::from_str(&text).map_err(|_| "Invalid MCP artifact record".into())
    }
}
