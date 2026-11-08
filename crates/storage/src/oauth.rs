use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;CREATE TABLE mcp_oauth(server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id),revision INTEGER NOT NULL,document TEXT NOT NULL,secret_refs TEXT NOT NULL);PRAGMA user_version=9;COMMIT;").map_err(|e|e.to_string())
}
impl Store {
    /// Internal snapshot, never serialize secret_refs into an IPC response.
    pub fn oauth_get(&self, id: &str) -> Result<Value, String> {
        let row: Option<(i64, String, String)> = self
            .db
            .query_row(
                "SELECT revision,document,secret_refs FROM mcp_oauth WHERE server_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match row {
            Some((revision, text, refs)) => {
                let mut doc: Value =
                    serde_json::from_str(&text).map_err(|_| "Invalid OAuth record")?;
                doc["revision"] = json!(revision);
                doc["secret_refs"] =
                    serde_json::from_str(&refs).map_err(|_| "Invalid OAuth credential metadata")?;
                Ok(doc)
            }
            None => {
                Ok(json!({"server_id":id,"revision":0,"state":"disconnected","secret_refs":{}}))
            }
        }
    }
    pub fn oauth_save(
        &mut self,
        id: &str,
        server_revision: i64,
        expected: i64,
        doc: &Value,
        refs: &Value,
    ) -> Result<Value, String> {
        let server = self.mcp_server(id)?;
        if server.deleted || server.revision != server_revision {
            return Err("MCP server revision revoked during OAuth operation".into());
        }
        self.oauth_commit(id, expected, doc, refs)
    }
    /// Disconnect/recovery may clear a grant after its MCP definition was deleted or edited.
    pub fn oauth_commit(
        &mut self,
        id: &str,
        expected: i64,
        doc: &Value,
        refs: &Value,
    ) -> Result<Value, String> {
        let mut safe = doc.clone();
        safe.as_object_mut()
            .ok_or("Invalid OAuth document")?
            .remove("secret_refs");
        safe.as_object_mut().unwrap().remove("authorization_url");
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let old: Option<(i64, String)> = tx
            .query_row(
                "SELECT revision,secret_refs FROM mcp_oauth WHERE server_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if old.as_ref().map(|r| r.0).unwrap_or(0) != expected {
            return Err("OAuth operation superseded".into());
        }
        if let Some((_, text)) = old {
            let previous: Value =
                serde_json::from_str(&text).map_err(|_| "Invalid OAuth credentials")?;
            for r in previous
                .as_object()
                .ok_or("Invalid OAuth credentials")?
                .values()
            {
                if !refs
                    .as_object()
                    .ok_or("Invalid OAuth credentials")?
                    .values()
                    .any(|v| v == r)
                {
                    tx.execute(
                        "INSERT OR IGNORE INTO mcp_secret_gc(reference) VALUES(?1)",
                        [r.as_str().ok_or("Invalid OAuth reference")?],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        tx.execute("INSERT INTO mcp_oauth(server_id,revision,document,secret_refs) VALUES(?1,?2,?3,?4) ON CONFLICT(server_id) DO UPDATE SET revision=excluded.revision,document=excluded.document,secret_refs=excluded.secret_refs",params![id,expected+1,safe.to_string(),refs.to_string()]).map_err(|e|e.to_string())?;
        for r in refs
            .as_object()
            .ok_or("Invalid OAuth credentials")?
            .values()
        {
            tx.execute(
                "DELETE FROM mcp_secret_gc WHERE reference=?1",
                [r.as_str().ok_or("Invalid OAuth reference")?],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.oauth_get(id)
    }
    pub fn oauth_recover(&mut self) -> Result<(), String> {
        let mut q = self
            .db
            .prepare("SELECT server_id FROM mcp_oauth")
            .map_err(|e| e.to_string())?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(q);
        for id in ids {
            let mut d = self.oauth_get(&id)?;
            let state = match d["state"].as_str() {
                Some("authorizing") => "interrupted",
                Some("refreshing") => "refresh_uncertain",
                Some("revoking") => "revocation_unknown",
                _ => continue,
            };
            d["state"] = json!(state);
            d["error"] = json!("Core interrupted; operation not replayed");
            let refs = d["secret_refs"].clone();
            self.oauth_commit(&id, d["revision"].as_i64().unwrap(), &d, &refs)?;
        }
        Ok(())
    }
}
