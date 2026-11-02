use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE skills(id TEXT PRIMARY KEY,version_id INTEGER NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE skill_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,skill_id TEXT NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE skill_files(version_id INTEGER NOT NULL REFERENCES skill_versions(id),path TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(version_id,path));
      CREATE TABLE skill_disabled(agent_id INTEGER NOT NULL REFERENCES memory_agents(id),skill_id TEXT NOT NULL REFERENCES skills(id),PRIMARY KEY(agent_id,skill_id));
      PRAGMA user_version=6; COMMIT;").map_err(|e| e.to_string())
}
impl Store {
    pub fn skill_current(&self, id: &str) -> Result<Option<Value>, String> {
        let row: Option<(i64, i64, bool)> = self
            .db
            .query_row(
                "SELECT version_id,revision,deleted FROM skills WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        row.map(|(version, revision, deleted)| {
            let mut doc = self.skill_version(version)?;
            doc["revision"] = json!(revision);
            doc["deleted"] = json!(deleted);
            Ok(doc)
        })
        .transpose()
    }
    pub fn skill_version(&self, version: i64) -> Result<Value, String> {
        let (id, raw, created): (String, String, String) = self
            .db
            .query_row(
                "SELECT skill_id,document,created_at FROM skill_versions WHERE id=?1",
                [version],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "Skill version not found")?;
        let mut doc: Value = serde_json::from_str(&raw).map_err(|_| "Invalid skill version")?;
        doc["id"] = json!(id);
        doc["version_id"] = json!(version);
        doc["created_at"] = json!(created);
        Ok(doc)
    }
    pub fn skill_ids(&self) -> Result<Vec<String>, String> {
        let mut q = self
            .db
            .prepare("SELECT id FROM skills WHERE deleted=0 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string());
        rows
    }
    pub fn skill_versions(&self, id: &str, offset: usize) -> Result<Value, String> {
        let mut q=self.db.prepare("SELECT id,created_at,json_extract(document,'$.name'),json_extract(document,'$.digest'),json_extract(document,'$.mode') FROM skill_versions WHERE skill_id=?1 ORDER BY id DESC LIMIT 21 OFFSET ?2").map_err(|e|e.to_string())?;
        let mut items=q.query_map(params![id,offset as i64],|r|Ok(json!({"version_id":r.get::<_,i64>(0)?,"created_at":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"digest":r.get::<_,String>(3)?,"mode":r.get::<_,String>(4)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let more = items.len() > 20;
        items.truncate(20);
        Ok(json!({"items":items,"next_offset":if more{Some(offset+20)}else{None}}))
    }
    pub fn skill_allowed(&self, agent: i64, id: &str) -> Result<bool, String> {
        self.memory_agent(agent)?;
        self.db.query_row("SELECT EXISTS(SELECT 1 FROM skills WHERE id=?1 AND deleted=0 AND NOT EXISTS(SELECT 1 FROM skill_disabled WHERE agent_id=?2 AND skill_id=?1))",params![id,agent],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub fn skill_enable(&self, agent: i64, id: &str, enabled: bool) -> Result<(), String> {
        self.memory_agent(agent)?;
        if self.skill_current(id)?.is_none_or(|v| v["deleted"] == true) {
            return Err("Skill no longer exists".into());
        }
        if enabled {
            self.db.execute(
                "DELETE FROM skill_disabled WHERE agent_id=?1 AND skill_id=?2",
                params![agent, id],
            )
        } else {
            self.db.execute(
                "INSERT OR IGNORE INTO skill_disabled(agent_id,skill_id) VALUES(?1,?2)",
                params![agent, id],
            )
        }
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
    pub fn skill_remove(&self, id: &str, expected: i64) -> Result<(), String> {
        let n=self.db.execute("UPDATE skills SET deleted=1,revision=revision+1 WHERE id=?1 AND revision=?2 AND deleted=0",params![id,expected]).map_err(|e|e.to_string())?;
        if n != 1 {
            return Err("Skill version conflict; refresh before deleting".into());
        }
        Ok(())
    }
    pub fn skill_put(
        &mut self,
        id: &str,
        expected: i64,
        doc: &Value,
        files: &[(String, Vec<u8>)],
    ) -> Result<Value, String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let current: Option<i64> = tx
            .query_row("SELECT revision FROM skills WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if current.unwrap_or(0) != expected {
            return Err("Skill version conflict; preview again".into());
        }
        let total: i64 = tx
            .query_row("SELECT count(*) FROM skill_versions", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let count: i64 = tx
            .query_row(
                "SELECT count(*) FROM skills WHERE deleted=0 AND id<>?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= 100 || total >= 1000 {
            return Err(
                "Skill library capacity reached (100 active, 1000 archived versions)".into(),
            );
        }
        tx.execute(
            "INSERT INTO skill_versions(skill_id,document) VALUES(?1,?2)",
            params![id, doc.to_string()],
        )
        .map_err(|e| e.to_string())?;
        let version = tx.last_insert_rowid();
        for (path, bytes) in files {
            tx.execute(
                "INSERT INTO skill_files(version_id,path,content) VALUES(?1,?2,?3)",
                params![version, path, bytes],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("INSERT INTO skills(id,version_id,revision) VALUES(?1,?2,1) ON CONFLICT(id) DO UPDATE SET version_id=excluded.version_id,revision=skills.revision+1,deleted=0",params![id,version]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        self.skill_current(id)?.ok_or("Saved skill missing".into())
    }
    pub fn skill_file(&self, version: i64, path: &str) -> Result<Vec<u8>, String> {
        self.db
            .query_row(
                "SELECT content FROM skill_files WHERE version_id=?1 AND path=?2",
                params![version, path],
                |r| r.get(0),
            )
            .map_err(|_| "Skill file not found".into())
    }
    pub fn skill_files(&self, version: i64) -> Result<Vec<(String, Vec<u8>)>, String> {
        let mut q = self
            .db
            .prepare("SELECT path,content FROM skill_files WHERE version_id=?1 ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([version], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string());
        rows
    }
}
