use super::{groups::rows, Store};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE reminder_states(rule_id TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE reminder_slots(id INTEGER PRIMARY KEY AUTOINCREMENT,rule_id TEXT NOT NULL,slot_key TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(rule_id,slot_key));
      CREATE TABLE reminder_notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,rule_id TEXT NOT NULL,slot_id INTEGER NOT NULL REFERENCES reminder_slots(id),document TEXT NOT NULL);
      CREATE TABLE reminder_preferences(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);
      INSERT INTO reminder_preferences VALUES(1,'{\"revision\":1,\"enabled\":true}');
      PRAGMA user_version=29;COMMIT;").map_err(|error|error.to_string())
}
impl Store {
    pub fn reminder_find_slot(&self, rule: &str, key: &str) -> Result<Option<Value>, String> {
        rows(
            &self.db,
            "SELECT document FROM reminder_slots WHERE rule_id=?1 AND slot_key=?2",
            params![rule, key],
        )
        .map(|mut values| values.pop())
    }
    pub fn reminder_save_slot(&self, value: &Value) -> Result<(), String> {
        self.reminder_transaction()?;
        self.db
            .execute(
                "UPDATE reminder_slots SET document=?1 WHERE id=?2",
                params![value.to_string(), value["id"].as_i64()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn reminder_slot(&self, id: i64) -> Result<Value, String> {
        rows(
            &self.db,
            "SELECT document FROM reminder_slots WHERE id=?1",
            [id],
        )?
        .pop()
        .ok_or("触发记录不存在。".into())
    }
    pub fn reminder_manual_notification(
        &self,
        rule: &str,
        key: &str,
    ) -> Result<Option<Value>, String> {
        rows(&self.db,"SELECT n.document FROM reminder_notifications n JOIN reminder_slots s ON s.id=n.slot_id WHERE s.rule_id=?1 AND s.slot_key=?2 LIMIT 1",params![rule,key]).map(|mut rows|rows.pop())
    }
    pub fn reminder_notification_recent(&self, after: i64) -> Result<bool, String> {
        self.db.query_row("SELECT EXISTS(SELECT 1 FROM reminder_notifications WHERE json_extract(document,'$.claimed_at_ms')>?1 AND json_extract(document,'$.state') IN ('dispatching','shown','indeterminate'))",[after],|row|row.get(0)).map_err(|e|e.to_string())
    }
    fn reminder_transaction(&self) -> Result<(), String> {
        if self.db.is_autocommit() {
            Err("提醒变更需要账本事务。".into())
        } else {
            Ok(())
        }
    }
    pub fn reminder_state(&self, id: &str) -> Result<Option<Value>, String> {
        rows(
            &self.db,
            "SELECT document FROM reminder_states WHERE rule_id=?1",
            [id],
        )
        .map(|mut values| values.pop())
    }
    pub fn reminder_save_state(&self, id: &str, value: Value) -> Result<(), String> {
        self.reminder_transaction()?;
        self.db.execute("INSERT INTO reminder_states VALUES(?1,?2) ON CONFLICT(rule_id) DO UPDATE SET document=excluded.document",params![id,value.to_string()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn reminder_record_slot(
        &self,
        rule: &Value,
        slot: &Value,
        state: &str,
        reason: &str,
        now: i64,
    ) -> Result<Option<i64>, String> {
        self.reminder_transaction()?;
        let value = json!({"rule_id":rule["id"],"rule_revision":rule["revision"],"slot":slot,"state":state,"reason":reason,"recorded_at_ms":now});
        let inserted = self
            .db
            .execute(
                "INSERT OR IGNORE INTO reminder_slots(rule_id,slot_key,document) VALUES(?1,?2,?3)",
                params![
                    rule["id"].as_str(),
                    slot["slot_key"].as_str(),
                    value.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        if inserted == 0 {
            return Ok(None);
        }
        let id = self.db.last_insert_rowid();
        let mut value = value;
        value["id"] = json!(id);
        self.db
            .execute(
                "UPDATE reminder_slots SET document=?1 WHERE id=?2",
                params![value.to_string(), id],
            )
            .map_err(|e| e.to_string())?;
        Ok(Some(id))
    }
    pub fn reminder_notification(&self, id: i64) -> Result<Value, String> {
        rows(
            &self.db,
            "SELECT document FROM reminder_notifications WHERE id=?1",
            [id],
        )?
        .pop()
        .ok_or("通知不存在。".into())
    }
    pub fn reminder_add_notification(&self, mut value: Value) -> Result<Value, String> {
        self.reminder_transaction()?;
        self.db
            .execute(
                "INSERT INTO reminder_notifications(rule_id,slot_id,document) VALUES(?1,?2,'{}')",
                params![value["rule_id"].as_str(), value["slot_id"].as_i64()],
            )
            .map_err(|e| e.to_string())?;
        value["id"] = json!(self.db.last_insert_rowid());
        value["revision"] = json!(0);
        self.reminder_save_notification(value)
    }
    pub fn reminder_save_notification(&self, mut value: Value) -> Result<Value, String> {
        self.reminder_transaction()?;
        value["revision"] = json!(value["revision"].as_i64().unwrap_or(0) + 1);
        self.db
            .execute(
                "UPDATE reminder_notifications SET document=?1 WHERE id=?2",
                params![value.to_string(), value["id"].as_i64()],
            )
            .map_err(|e| e.to_string())?;
        Ok(value)
    }
    pub fn reminder_pending(&self) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM reminder_notifications WHERE json_extract(document,'$.state')='pending' ORDER BY id LIMIT 100",[])
    }
    pub fn reminder_history(&self, id: &str, before: Option<i64>) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM reminder_slots WHERE rule_id=?1 AND id<?2 ORDER BY id DESC LIMIT 21",params![id,before.unwrap_or(i64::MAX)])
    }
    pub fn reminder_notifications(
        &self,
        id: Option<&str>,
        before: Option<i64>,
    ) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM reminder_notifications WHERE (?1 IS NULL OR rule_id=?1) AND id<?2 ORDER BY id DESC LIMIT 21",params![id,before.unwrap_or(i64::MAX)])
    }
    pub fn reminder_preferences(&self) -> Result<Value, String> {
        rows(
            &self.db,
            "SELECT document FROM reminder_preferences WHERE id=1",
            [],
        )?
        .pop()
        .ok_or("通知设置不存在。".into())
    }
    pub fn reminder_save_preferences(&self, mut value: Value) -> Result<Value, String> {
        self.reminder_transaction()?;
        value["revision"] = json!(value["revision"].as_i64().unwrap_or(0) + 1);
        self.db
            .execute(
                "UPDATE reminder_preferences SET document=?1 WHERE id=1",
                [value.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(value)
    }
    pub fn reminder_cancel_pending(&self, id: &str, reason: &str) -> Result<(), String> {
        self.reminder_transaction()?;
        self.db.execute("UPDATE reminder_notifications SET document=json_set(document,'$.state','cancelled','$.reason',?2,'$.revision',json_extract(document,'$.revision')+1) WHERE rule_id=?1 AND json_extract(document,'$.state')='pending'",params![id,reason]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn reminder_recover(&self) -> Result<(), String> {
        self.db.execute_batch("BEGIN IMMEDIATE;UPDATE reminder_notifications SET document=json_set(document,'$.state',CASE WHEN json_extract(document,'$.state')='dispatching' THEN 'indeterminate' ELSE 'expired' END,'$.reason','Core 重启前的投递未确认，请查看记录。','$.revision',json_extract(document,'$.revision')+1) WHERE json_extract(document,'$.state') IN ('pending','dispatching');COMMIT;").map_err(|e|e.to_string())
    }
}
