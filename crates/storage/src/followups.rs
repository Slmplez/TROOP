use super::{groups::rows, Store};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE followup_states(policy_id TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE followup_chains(id TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE followup_appointments(id INTEGER PRIMARY KEY AUTOINCREMENT,policy_id TEXT NOT NULL,client_key TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(policy_id,client_key));
      CREATE INDEX followup_due ON followup_appointments(json_extract(document,'$.state'),json_extract(document,'$.at_ms'),id);
      PRAGMA user_version=30;COMMIT;").map_err(|error|error.to_string())
}
fn transaction(store: &Store) -> Result<(), String> {
    if store.db.is_autocommit() {
        Err("跟进变更需要操作账本事务。".into())
    } else {
        Ok(())
    }
}
impl Store {
    pub fn followup_state(&self, id: &str) -> Result<Option<Value>, String> {
        rows(
            &self.db,
            "SELECT document FROM followup_states WHERE policy_id=?1",
            [id],
        )
        .map(|mut rows| rows.pop())
    }
    pub fn save_followup_state(&self, id: &str, value: &Value) -> Result<(), String> {
        transaction(self)?;
        self.db.execute("INSERT INTO followup_states VALUES(?1,?2) ON CONFLICT(policy_id) DO UPDATE SET document=excluded.document",params![id,value.to_string()]).map_err(|error|error.to_string())?;
        Ok(())
    }
    pub fn followup_chain(&self, id: &str) -> Result<Value, String> {
        rows(
            &self.db,
            "SELECT document FROM followup_chains WHERE id=?1",
            [id],
        )?
        .pop()
        .ok_or("跟进协作链不存在。".into())
    }
    pub fn save_followup_chain(&self, mut value: Value) -> Result<Value, String> {
        transaction(self)?;
        let revision = self
            .followup_chain(value["id"].as_str().ok_or("协作链身份无效。")?)
            .ok()
            .and_then(|value| value["revision"].as_i64())
            .unwrap_or(0);
        value["revision"] = json!(revision + 1);
        self.db.execute("INSERT INTO followup_chains VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET document=excluded.document",params![value["id"].as_str(),value.to_string()]).map_err(|error|error.to_string())?;
        Ok(value)
    }
    pub fn followup_appointment(&self, id: i64) -> Result<Value, String> {
        rows(
            &self.db,
            "SELECT document FROM followup_appointments WHERE id=?1",
            [id],
        )?
        .pop()
        .ok_or("预约不存在。".into())
    }
    pub fn followup_duplicate(&self, policy: &str, key: &str) -> Result<Option<Value>, String> {
        rows(
            &self.db,
            "SELECT document FROM followup_appointments WHERE policy_id=?1 AND client_key=?2",
            params![policy, key],
        )
        .map(|mut rows| rows.pop())
    }
    pub fn save_followup_appointment(&self, mut value: Value) -> Result<Value, String> {
        transaction(self)?;
        let id = if let Some(id) = value["id"].as_i64() {
            id
        } else {
            self.db.execute("INSERT INTO followup_appointments(policy_id,client_key,document) VALUES(?1,?2,'{}')",params![value["policy_id"].as_str(),value["client_key"].as_str()]).map_err(|error|error.to_string())?;
            self.db.last_insert_rowid()
        };
        value["id"] = json!(id);
        value["revision"] = json!(value["revision"].as_i64().unwrap_or(0) + 1);
        self.db
            .execute(
                "UPDATE followup_appointments SET document=?1 WHERE id=?2",
                params![value.to_string(), id],
            )
            .map_err(|error| error.to_string())?;
        Ok(value)
    }
    pub fn followup_history(
        &self,
        policy: &str,
        before: Option<i64>,
    ) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM followup_appointments WHERE policy_id=?1 AND id<?2 ORDER BY id DESC LIMIT 9",params![policy,before.unwrap_or(i64::MAX)])
    }
    pub fn followup_pending(&self, policy: &str) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM followup_appointments WHERE policy_id=?1 AND json_extract(document,'$.state') IN ('pending','waiting') ORDER BY id LIMIT 9",[policy])
    }
    pub fn followup_runs(&self, chain: &str) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM agent_runs WHERE json_extract(document,'$.followup_chain_id')=?1 ORDER BY id",[chain])
    }
    pub fn followup_chain_pending(&self, chain: &str) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM followup_appointments WHERE json_extract(document,'$.chain_id')=?1 AND json_extract(document,'$.state') IN ('pending','waiting') ORDER BY id",[chain])
    }
    pub fn followup_group_runs(&self, chain: &str) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM agent_runs WHERE json_extract(document,'$.followup_group_chain_id')=?1 ORDER BY id",[chain])
    }
    pub fn followup_chains(&self) -> Result<Vec<Value>, String> {
        rows(
            &self.db,
            "SELECT document FROM followup_chains ORDER BY id",
            [],
        )
    }
}
