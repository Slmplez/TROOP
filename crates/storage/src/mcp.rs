use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,config TEXT NOT NULL,secret_refs TEXT NOT NULL);CREATE TABLE mcp_revisions(server_id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY KEY(server_id,revision));CREATE TABLE mcp_secret_gc(reference TEXT PRIMARY KEY);PRAGMA user_version=8;").map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[derive(Serialize)]
pub struct McpServer {
    pub id: String,
    pub revision: i64,
    pub deleted: bool,
    pub config: Value,
    pub secret_keys: Vec<String>,
    #[serde(skip)]
    pub secret_refs: Value,
}
impl Store {
    pub fn mcp_server(&self, id: &str) -> Result<McpServer, String> {
        self.db
            .query_row(
                "SELECT revision,deleted,config,secret_refs FROM mcp_servers WHERE id=?1",
                [id],
                |r| {
                    let c: String = r.get(2)?;
                    let s: String = r.get(3)?;
                    let refs: Value = serde_json::from_str(&s).unwrap_or(Value::Null);
                    Ok(McpServer {
                        id: id.into(),
                        revision: r.get(0)?,
                        deleted: r.get(1)?,
                        config: serde_json::from_str(&c).unwrap_or(Value::Null),
                        secret_keys: refs
                            .as_object()
                            .map(|m| m.keys().cloned().collect())
                            .unwrap_or_default(),
                        secret_refs: refs,
                    })
                },
            )
            .map_err(|_| "MCP server not found".into())
    }
    pub fn mcp_list(&self, offset: usize) -> Result<Value, String> {
        let mut q = self
            .db
            .prepare("SELECT id FROM mcp_servers WHERE deleted=0 ORDER BY id LIMIT 21 OFFSET ?1")
            .map_err(|e| e.to_string())?;
        let ids = q
            .query_map([offset as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut items = vec![];
        let mut bytes = 0;
        for id in ids.iter().take(20) {
            let row = self.mcp_server(id)?;
            let n = serde_json::to_vec(&row)
                .map_err(|_| "Invalid MCP definition")?
                .len();
            if bytes + n > 40_000 {
                break;
            }
            bytes += n;
            items.push(row);
        }
        let end = offset + items.len();
        let more = items.len() < ids.len();
        Ok(json!({"items":items,"next_offset":if more{Some(end)}else{None}}))
    }
    pub fn mcp_save(
        &mut self,
        id: &str,
        expected: i64,
        config: &Value,
        refs: &Value,
        deleted: bool,
    ) -> Result<McpServer, String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let old: Option<(i64, bool, String)> = tx
            .query_row(
                "SELECT revision,deleted,secret_refs FROM mcp_servers WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if old
            .as_ref()
            .is_some_and(|(rev, gone, _)| *rev != expected || *gone)
            || old.is_none() && expected != 0
        {
            return Err("MCP definition changed; refresh before editing".into());
        }
        if old.is_none() {
            let count: i64 = tx
                .query_row(
                    "SELECT count(*) FROM mcp_servers WHERE deleted=0",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if count >= 64 {
                return Err("MCP library capacity reached".into());
            }
        }
        if let Some((_, _, s)) = &old {
            let old: Value =
                serde_json::from_str(s).map_err(|_| "Invalid MCP credential metadata")?;
            for reference in old
                .as_object()
                .ok_or("Invalid MCP credential metadata")?
                .values()
            {
                if !refs
                    .as_object()
                    .ok_or("Invalid MCP credential metadata")?
                    .values()
                    .any(|v| v == reference)
                {
                    tx.execute(
                        "INSERT OR IGNORE INTO mcp_secret_gc(reference) VALUES(?1)",
                        [reference
                            .as_str()
                            .ok_or("Invalid MCP credential reference")?],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        let revision = expected + 1;
        tx.execute("INSERT INTO mcp_servers(id,revision,deleted,config,secret_refs) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,config=excluded.config,secret_refs=excluded.secret_refs",params![id,revision,deleted,config.to_string(),refs.to_string()]).map_err(|e|e.to_string())?;
        tx.execute(
            "INSERT INTO mcp_revisions(server_id,revision,document) VALUES(?1,?2,?3)",
            params![
                id,
                revision,
                json!({"config":config,"deleted":deleted}).to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        for r in refs
            .as_object()
            .ok_or("Invalid MCP credential metadata")?
            .values()
        {
            tx.execute(
                "DELETE FROM mcp_secret_gc WHERE reference=?1",
                [r.as_str().ok_or("Invalid MCP credential reference")?],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.mcp_server(id)
    }
    pub fn mcp_revisions(&self, id: &str, offset: usize) -> Result<Value, String> {
        self.mcp_server(id)?;
        let mut q=self.db.prepare("SELECT revision,document,created_at FROM mcp_revisions WHERE server_id=?1 ORDER BY revision DESC LIMIT 21 OFFSET ?2").map_err(|e|e.to_string())?;
        let mut items=q.query_map(params![id,offset as i64],|r|{let text:String=r.get(1)?;Ok(json!({"revision":r.get::<_,i64>(0)?,"document":serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),"created_at":r.get::<_,String>(2)?}))}).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let total = items.len();
        let mut bytes = 0;
        let mut n = 0;
        for row in items.iter().take(20) {
            let size = row.to_string().len();
            if bytes + size > 40_000 {
                break;
            }
            bytes += size;
            n += 1;
        }
        items.truncate(n);
        Ok(json!({"items":items,"next_offset":if n<total{Some(offset+n)}else{None}}))
    }
    pub fn mcp_gc(&self) -> Result<Vec<String>, String> {
        let mut q = self
            .db
            .prepare("SELECT reference FROM mcp_secret_gc LIMIT 256")
            .map_err(|e| e.to_string())?;
        let r = q
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string());
        r
    }
    pub fn mcp_gc_done(&self, r: &str) -> Result<(), String> {
        self.db
            .execute("DELETE FROM mcp_secret_gc WHERE reference=?1", [r])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn mcp_prepare_secret(&self, r: &str) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR IGNORE INTO mcp_secret_gc(reference) VALUES(?1)",
                [r],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    /// A frozen Run must recheck this before opening a connection or dispatching a call.
    pub fn mcp_authorize(
        &self,
        id: &str,
        revision: i64,
        agent: i64,
        tool: Option<&str>,
    ) -> Result<McpServer, String> {
        self.memory_agent(agent)?;
        let s = self.mcp_server(id)?;
        if s.deleted
            || s.revision != revision
            || s.config["enabled"] != true
            || !s.config["agent_ids"]
                .as_array()
                .is_some_and(|a| a.contains(&json!(agent)))
            || tool.is_some_and(|t| {
                s.config["disabled_tools"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!(t)))
            })
        {
            return Err("MCP assignment, revision or tool permission revoked".into());
        }
        Ok(s)
    }
}
