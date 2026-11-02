use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
    time::Duration,
};
mod agent;
mod chat;
mod hooks;
pub mod memory;
mod skills;
mod tasks;
pub use agent::public_run;
pub use chat::*;
pub use tasks::public_task;

#[derive(Serialize)]
pub struct Workspace {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub created_at: String,
}
#[derive(Serialize)]
pub struct WorkspacePage {
    pub items: Vec<Workspace>,
    pub total: i64,
    pub next_offset: Option<i64>,
}
pub struct Store {
    pub(crate) db: Connection,
    _lock: File,
}
impl Store {
    pub fn open(directory: &Path) -> Result<Self, String> {
        if !directory.is_absolute() {
            return Err("Data directory must be absolute".into());
        }
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("core.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock()
            .map_err(|_| "Another Core owns this data directory".to_string())?;
        let mut db =
            Connection::open(directory.join("troop.sqlite3")).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > 7 {
            return Err("Database was created by a newer TROOP version".into());
        }
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        )
        .map_err(|e| e.to_string())?;
        if version == 0 {
            let tx = db.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch("CREATE TABLE workspaces(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,path TEXT NOT NULL,path_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))); PRAGMA user_version=1;").map_err(|e|e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        if version < 2 {
            chat::migrate(&mut db)?;
        }
        if version < 3 {
            agent::migrate(&mut db)?;
        }
        if version < 4 {
            tasks::migrate(&mut db)?;
        }
        if version < 5 {
            memory::migrate(&mut db)?;
        }
        if version < 6 {
            skills::migrate(&mut db)?;
        }
        if version < 7 {
            hooks::migrate(&mut db)?;
        }
        db.execute("UPDATE turns SET status='interrupted',error_kind='core_interrupted',error_message='应用或 Core 上次中断；已保留收到的文本，请手动发送新消息。',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='streaming'", []).map_err(|e|e.to_string())?;
        let mut store = Self { db, _lock: lock };
        store.agent_recover()?;
        store.tasks_recover()?;
        store.memory_recover()?;
        store.hooks_recover()?;
        Ok(store)
    }
    pub fn list(&self, offset: i64) -> Result<WorkspacePage, String> {
        if offset < 0 {
            return Err("Invalid page offset".into());
        }
        let total = self
            .db
            .query_row("SELECT count(*) FROM workspaces", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| e.to_string())?;
        let mut query=self.db.prepare("SELECT id,name,path,created_at FROM workspaces ORDER BY id DESC LIMIT 50 OFFSET ?1").map_err(|e|e.to_string())?;
        let rows = query
            .query_map([offset], |r| {
                Ok(Workspace {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    path: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        let mut bytes = 0;
        for row in rows {
            let row = row.map_err(|e| e.to_string())?;
            let size = serde_json::to_vec(&row).map_err(|e| e.to_string())?.len();
            if bytes + size > 48_000 {
                break;
            }
            bytes += size;
            items.push(row);
        }
        let next = offset + items.len() as i64;
        Ok(WorkspacePage {
            items,
            total,
            next_offset: if next < total { Some(next) } else { None },
        })
    }
    pub fn add(&self, input: &str) -> Result<WorkspacePage, String> {
        if input.len() > 16_384 || !Path::new(input).is_absolute() {
            return Err("Choose an absolute workspace directory".into());
        }
        let path = fs::canonicalize(input).map_err(|e| format!("Cannot open workspace: {e}"))?;
        if !path.is_dir() {
            return Err("Workspace must be a directory".into());
        }
        let text = path
            .to_str()
            .ok_or("Workspace path must be valid Unicode")?;
        let name = path.file_name().and_then(|x| x.to_str()).unwrap_or(text);
        let key = if cfg!(windows) {
            text.to_lowercase()
        } else {
            text.to_owned()
        };
        self.db.execute("INSERT INTO workspaces(name,path,path_key) VALUES(?1,?2,?3) ON CONFLICT(path_key) DO NOTHING",params![name,text,key]).map_err(|e|e.to_string())?;
        self.list(0)
    }
    pub fn rename(&self, id: i64, name: &str) -> Result<WorkspacePage, String> {
        let name = name.trim();
        if id <= 0 || name.is_empty() || name.chars().count() > 120 {
            return Err("Name must contain 1–120 characters".into());
        }
        let count = self
            .db
            .execute(
                "UPDATE workspaces SET name=?1 WHERE id=?2",
                params![name, id],
            )
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("Workspace no longer exists".into());
        }
        self.list(0)
    }
    pub fn remove(&self, id: i64) -> Result<WorkspacePage, String> {
        if id <= 0 {
            return Err("Invalid workspace ID".into());
        }
        let count = self
            .db
            .execute("DELETE FROM workspaces WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("Workspace no longer exists".into());
        }
        self.list(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn newer_database_is_rejected_before_changing_its_journal_mode() {
        let directory = std::env::temp_dir().join(format!(
            "troop-newer-schema-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let database = directory.join("troop.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch("PRAGMA user_version=8;").unwrap();
        drop(connection);
        assert!(matches!(Store::open(&directory), Err(message) if message.contains("newer")));
        let connection = Connection::open(database).unwrap();
        let mode: String = connection
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "delete");
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 8);
    }

    #[test]
    fn version_one_workspaces_survive_chat_migration_and_removal_keeps_conversation() {
        let directory = std::env::temp_dir().join(format!(
            "troop-v1-migration-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let database = Connection::open(directory.join("troop.sqlite3")).unwrap();
        database.execute_batch("CREATE TABLE workspaces(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,path TEXT NOT NULL,path_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL DEFAULT 'original');INSERT INTO workspaces(name,path,path_key) VALUES('旧工作区','C:\\project','c:\\project');PRAGMA user_version=1;").unwrap();
        drop(database);
        let store = Store::open(&directory).unwrap();
        assert_eq!(store.list(0).unwrap().items[0].name, "旧工作区");
        let id = store.create_conversation("保留对话", Some(1)).unwrap();
        store.remove(1).unwrap();
        assert_eq!(store.conversations(0).unwrap()["items"][0]["id"], id);
        assert!(store.conversations(0).unwrap()["items"][0]["workspace_id"].is_null());
    }
}
