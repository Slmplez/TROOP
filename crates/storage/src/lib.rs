use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
    time::Duration,
};
mod agent;
mod authorizations;
mod chat;
mod cli_interactions;
mod events;
mod follow;
mod followups;
mod group_runtime;
mod groups;
mod hooks;
mod lifecycle;
mod maintenance;
mod mcp;
mod mcp_runtime;
pub mod memory;
mod memory_conflicts;
mod memory_revisions;
mod oauth;
mod operations;
mod reminders;
mod rules;
pub use operations::OperationFailure;
mod skills;
mod tasks;
mod topics;
mod work_items;
pub use agent::public_run;
pub use chat::*;
pub use lifecycle::StopPlan;
pub use mcp::McpServer;
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
        if version > 30 {
            return Err("Database was created by a newer TROOP version".into());
        }
        let has_table = |name: &str| {
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [name],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())
        };
        if version >= 30
            && (!has_table("followup_states")?
                || !has_table("followup_chains")?
                || !has_table("followup_appointments")?)
        {
            return Err("Follow-up storage is incomplete".into());
        }
        if version >= 29
            && (!has_table("reminder_states")?
                || !has_table("reminder_slots")?
                || !has_table("reminder_notifications")?
                || !has_table("reminder_preferences")?)
        {
            return Err("Reminder storage is incomplete".into());
        }
        if version >= 27 && (!has_table("group_executors")? || !has_table("group_chains")?) {
            return Err("Group execution storage is incomplete".into());
        }
        if version >= 26
            && (!has_table("group_chats")?
                || !has_table("group_messages")?
                || !has_table("group_deliveries")?)
        {
            return Err("Group chat storage is incomplete".into());
        }
        if version>=26 && !db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='group_project_revoked')",[],|row|row.get::<_,bool>(0)).map_err(|error|error.to_string())? {return Err("Group membership revocation storage is incomplete".into());}
        if version >= 25 && !has_table("work_item_runs")? {
            return Err("Work item execution storage is incomplete".into());
        }
        if version >= 24 && !has_table("work_items")? {
            return Err("Work item storage is incomplete".into());
        }
        if version >= 23 && !has_table("cli_interactions")? {
            return Err("Incompatible CLI interaction schema".into());
        }
        if version >= 22 && !has_table("memory_conflicts")? {
            return Err("Incompatible conflict schema".into());
        }
        if version >= 21 && !has_table("memory_entries")? {
            return Err("Incompatible knowledge identity schema".into());
        }
        if version >= 20 && !db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='view' AND name='active_memories')",[],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())? {
            return Err("Incompatible active memory view".into());
        }
        if version >= 19 && !has_table("memory_forgetting")? {
            return Err("Incompatible forgetting schema".into());
        }
        if version >= 18 && !has_table("memory_revisions")? {
            return Err("Incompatible memory revision schema".into());
        }
        if version >= 17 && !has_table("source_event_receipts")? {
            return Err("Incompatible event receipt schema".into());
        }
        if version >= 16
            && (!has_table("event_sources")?
                || !has_table("event_inbox")?
                || !has_table("event_deliveries")?
                || !has_table("event_leases")?
                || !has_table("source_events")?)
        {
            return Err("Incompatible events schema".into());
        }
        if version >= 15
            && (!has_table("memory_maintenance_settings")?
                || !has_table("memory_maintenance_attempts")?)
        {
            return Err("Incompatible maintenance schema".into());
        }
        if version >= 14
            && (!has_table("automation_rules")? || !has_table("automation_deliveries")?)
        {
            return Err("Incompatible automation schema".into());
        }
        if version >= 13 && (!has_table("authorizations")? || !has_table("authorization_history")?)
        {
            return Err("Incompatible authorization schema".into());
        }
        if has_table("external_profiles")?
            || version >= 8 && !has_table("mcp_servers")?
            || version >= 9 && !has_table("mcp_oauth")?
            || version >= 10 && (!has_table("mcp_connections")? || !has_table("mcp_artifacts")?)
            || version >= 11 && (!has_table("operations")? || !has_table("storage_identity")?)
            || version >= 12
                && (!has_table("execution_changes")? || !has_table("execution_versions")?)
        {
            return Err(
                "Incompatible database lineage; use the matching or unified TROOP Core".into(),
            );
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
        if version < 8 {
            mcp::migrate(&mut db)?;
        }
        if version < 9 {
            oauth::migrate(&mut db)?;
        }
        if version < 10 {
            mcp_runtime::migrate(&mut db)?;
        }
        if version < 11 {
            operations::migrate(&mut db)?;
        }
        if version < 12 {
            follow::migrate(&mut db)?;
        }
        if version < 13 {
            authorizations::migrate(&mut db)?;
        }
        if version < 14 {
            rules::migrate(&mut db)?;
        }
        if version < 15 {
            maintenance::migrate(&mut db)?;
        }
        if version < 16 {
            events::migrate(&mut db)?;
        }
        if version < 17 {
            events::migrate_receipts(&mut db)?;
        }
        if version < 18 {
            memory_revisions::migrate(&mut db)?;
        }
        if version < 19 {
            memory_revisions::migrate_forgetting(&mut db)?;
        }
        if version < 20 {
            memory_revisions::migrate_visibility(&mut db)?;
        }
        if version < 21 {
            memory_revisions::migrate_identity(&mut db)?;
        }
        if version < 22 {
            memory_conflicts::migrate(&mut db)?;
        }
        db.execute("UPDATE turns SET status='interrupted',error_kind='core_interrupted',error_message='应用或 Core 上次中断；已保留收到的文本，请手动发送新消息。',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='streaming'", []).map_err(|e|e.to_string())?;
        if version < 23 {
            cli_interactions::migrate(&mut db)?;
        }
        if version < 24 {
            work_items::migrate(&mut db)?;
        }
        if version < 25 {
            work_items::migrate_runs(&mut db)?;
        }
        if version < 26 {
            groups::migrate(&mut db)?;
        }
        if version < 27 {
            group_runtime::migrate(&mut db)?;
        }
        if version < 28 {
            topics::migrate(&mut db)?;
        }
        if version < 29 {
            reminders::migrate(&mut db)?;
        }
        if version < 30 {
            followups::migrate(&mut db)?;
        }
        let mut store = Self { db, _lock: lock };
        store.recover_executions()?;
        store.cli_interactions_recover()?;
        store.recover_group_deliveries()?;
        store.recover_group_runs()?;
        store.reminder_recover()?;
        store.memory_recover()?;
        store.hooks_recover()?;
        store.oauth_recover()?;
        store.mcp_runtime_recover()?;
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
    fn foreign_and_partial_lineages_are_rejected_without_database_mutation() {
        for (version, tables) in [
            (8, "CREATE TABLE external_profiles(id TEXT);"),
            (10, "CREATE TABLE external_profiles(id TEXT);"),
            (8, ""),
            (9, "CREATE TABLE mcp_servers(id TEXT);"),
            (
                10,
                "CREATE TABLE mcp_servers(id TEXT); CREATE TABLE mcp_oauth(id TEXT);",
            ),
        ] {
            let directory = std::env::temp_dir().join(format!(
                "troop-lineage-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&directory).unwrap();
            let database = directory.join("troop.sqlite3");
            let connection = Connection::open(&database).unwrap();
            connection
                .execute_batch(&format!("{tables} PRAGMA user_version={version};"))
                .unwrap();
            let schema: i64 = connection
                .pragma_query_value(None, "schema_version", |r| r.get(0))
                .unwrap();
            drop(connection);
            assert!(matches!(Store::open(&directory), Err(message) if message.contains("lineage")));
            let connection = Connection::open(database).unwrap();
            let mode: String = connection
                .pragma_query_value(None, "journal_mode", |r| r.get(0))
                .unwrap();
            let after: i64 = connection
                .pragma_query_value(None, "schema_version", |r| r.get(0))
                .unwrap();
            let after_version: i64 = connection
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .unwrap();
            assert_eq!(mode, "delete");
            assert_eq!(schema, after);
            assert_eq!(version, after_version);
            drop(connection);
            fs::remove_dir_all(directory).unwrap();
        }
    }

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
        connection.execute_batch("PRAGMA user_version=31;").unwrap();
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
        assert_eq!(version, 31);
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
