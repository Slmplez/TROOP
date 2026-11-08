use super::Store;
use rusqlite::{params, Connection, OptionalExtension, Params};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE group_chats(id INTEGER PRIMARY KEY AUTOINCREMENT,document TEXT NOT NULL);
      CREATE TABLE group_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES group_chats(id),client_id TEXT NOT NULL,request TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(group_id,client_id));
      CREATE INDEX group_messages_stream ON group_messages(group_id,id);
      CREATE TABLE group_deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES group_chats(id),message_id INTEGER NOT NULL REFERENCES group_messages(id),agent_id INTEGER NOT NULL,document TEXT NOT NULL,UNIQUE(message_id,agent_id));
      CREATE INDEX group_deliveries_recipient ON group_deliveries(group_id,agent_id,id);
      CREATE TRIGGER group_project_revoked AFTER DELETE ON memory_members BEGIN
        UPDATE group_deliveries SET document=json_set(document,'$.state','cancelled','$.reason','项目成员资格已撤销。','$.revision',json_extract(document,'$.revision')+1,'$.updated_at',unixepoch())
        WHERE agent_id=OLD.agent_id AND group_id IN (SELECT id FROM group_chats WHERE json_extract(document,'$.project_id')=OLD.project) AND json_extract(document,'$.state') IN ('queued','waiting_resume');
      END;
      PRAGMA user_version=26; COMMIT;").map_err(|error|error.to_string())
}
pub(super) fn rows(
    db: &Connection,
    sql: &str,
    parameters: impl Params,
) -> Result<Vec<Value>, String> {
    let mut statement = db.prepare(sql).map_err(|error| error.to_string())?;
    let records = statement
        .query_map(parameters, |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    records
        .map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        })
        .collect()
}
pub(super) fn require_transaction(store: &Store) -> Result<(), String> {
    if store.db.is_autocommit() {
        return Err("群聊变更需要操作账本事务。".into());
    }
    Ok(())
}
impl Store {
    pub fn group(&self, id: i64) -> Result<Value, String> {
        let value = self.group_document(id)?;
        self.project_topic(value)
    }
    pub(crate) fn group_document(&self, id: i64) -> Result<Value, String> {
        rows(
            &self.db,
            "SELECT document FROM group_chats WHERE id=?1",
            [id],
        )?
        .pop()
        .ok_or("群聊不存在。".into())
    }
    pub fn groups(&self, before: Option<i64>, archived: bool) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM group_chats WHERE id<?1 AND json_extract(document,'$.archived')=?2 AND json_extract(document,'$.source_group_id') IS NULL ORDER BY id DESC LIMIT 21",params![before.unwrap_or(i64::MAX),archived])
    }
    pub fn save_group(&self, mut group: Value, previous: Option<&Value>) -> Result<Value, String> {
        require_transaction(self)?;
        let id = if let Some(old) = previous {
            old["id"].as_i64().ok_or("群身份无效。")?
        } else {
            self.db
                .execute("INSERT INTO group_chats(document) VALUES('{}')", [])
                .map_err(|error| error.to_string())?;
            self.db.last_insert_rowid()
        };
        let now: i64 = self
            .db
            .query_row("SELECT unixepoch()", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        group["id"] = json!(id);
        group["revision"] = json!(
            previous
                .and_then(|old| old["revision"].as_i64())
                .unwrap_or(0)
                + 1
        );
        group["created_at"] = previous
            .map(|old| old["created_at"].clone())
            .unwrap_or(json!(now));
        group["updated_at"] = json!(now);
        self.db
            .execute(
                "UPDATE group_chats SET document=?1 WHERE id=?2",
                params![group.to_string(), id],
            )
            .map_err(|error| error.to_string())?;
        self.refresh_topics(&group, previous)?;
        Ok(group)
    }
    pub fn group_message(&self, id: i64) -> Result<Value, String> {
        rows(
            &self.db,
            "SELECT document FROM group_messages WHERE id=?1",
            [id],
        )?
        .pop()
        .ok_or("群消息不存在。".into())
    }
    pub fn group_duplicate_message(
        &self,
        group: i64,
        client: &str,
        input: &Value,
    ) -> Result<Option<Value>, String> {
        let previous: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT request,document FROM group_messages WHERE group_id=?1 AND client_id=?2",
                params![group, client],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some((request, document)) = previous {
            let mut previous: Value =
                serde_json::from_str(&request).map_err(|error| error.to_string())?;
            let mut current = input.clone();
            previous
                .as_object_mut()
                .unwrap()
                .remove("expected_revision");
            current.as_object_mut().unwrap().remove("expected_revision");
            if previous != current {
                return Err("消息身份已用于不同内容或目标。".into());
            }
            return Ok(Some(
                serde_json::from_str(&document).map_err(|error| error.to_string())?,
            ));
        }
        Ok(None)
    }
    pub fn group_messages(&self, group: i64, before: Option<i64>) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM group_messages WHERE group_id=?1 AND id<?2 ORDER BY id DESC LIMIT 21",params![group,before.unwrap_or(i64::MAX)])
    }
    pub fn group_delivery(&self, id: i64) -> Result<Value, String> {
        rows(
            &self.db,
            "SELECT document FROM group_deliveries WHERE id=?1",
            [id],
        )?
        .pop()
        .ok_or("投递不存在。".into())
    }
    pub fn group_deliveries(
        &self,
        group: i64,
        message: Option<i64>,
        before: Option<i64>,
    ) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM group_deliveries WHERE group_id=?1 AND (?2 IS NULL OR message_id=?2) AND id<?3 ORDER BY id DESC LIMIT 21",params![group,message,before.unwrap_or(i64::MAX)])
    }
    pub fn group_pending_deliveries(&self, group: i64) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM group_deliveries WHERE group_id=?1 AND json_extract(document,'$.state') IN ('queued','waiting_resume','blocked') ORDER BY id",[group])
    }
    pub fn group_pending_count(&self, group: i64, agent: i64) -> Result<i64, String> {
        self.db.query_row("SELECT count(*) FROM group_deliveries WHERE group_id=?1 AND agent_id=?2 AND json_extract(document,'$.state') IN ('queued','waiting_resume','blocked','dispatched','awaiting_reconciliation')",params![group,agent],|row|row.get(0)).map_err(|error|error.to_string())
    }
    pub fn group_delivery_summary(&self, message: i64) -> Result<Value, String> {
        let mut result = json!({"queued":0,"waiting_resume":0,"rejected":0,"cancelled":0});
        let mut statement=self.db.prepare("SELECT json_extract(document,'$.state'),count(*) FROM group_deliveries WHERE message_id=?1 GROUP BY json_extract(document,'$.state')").map_err(|error|error.to_string())?;
        for row in statement
            .query_map([message], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?
        {
            let (state, count) = row.map_err(|error| error.to_string())?;
            result[state] = json!(count);
        }
        Ok(result)
    }
    pub fn save_group_delivery(&self, mut delivery: Value) -> Result<Value, String> {
        require_transaction(self)?;
        let now: i64 = self
            .db
            .query_row("SELECT unixepoch()", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if delivery["created_at"].is_null() {
            delivery["created_at"] = json!(now);
        }
        delivery["updated_at"] = json!(now);
        if delivery["id"].is_null() {
            self.db.execute("INSERT INTO group_deliveries(group_id,message_id,agent_id,document) VALUES(?1,?2,?3,'{}')",params![delivery["group_id"].as_i64(),delivery["message_id"].as_i64(),delivery["agent_id"].as_i64()]).map_err(|error|error.to_string())?;
            delivery["id"] = json!(self.db.last_insert_rowid());
        }
        delivery["revision"] = json!(delivery["revision"].as_i64().unwrap_or(0) + 1);
        self.db
            .execute(
                "UPDATE group_deliveries SET document=?1 WHERE id=?2",
                params![delivery.to_string(), delivery["id"].as_i64()],
            )
            .map_err(|error| error.to_string())?;
        Ok(delivery)
    }
    pub fn insert_group_message(
        &self,
        mut message: Value,
        request: &Value,
    ) -> Result<Value, String> {
        require_transaction(self)?;
        self.db.execute("INSERT INTO group_messages(group_id,client_id,request,document) VALUES(?1,?2,?3,'{}')",params![message["group_id"].as_i64(),message["client_message_id"].as_str(),request.to_string()]).map_err(|error|error.to_string())?;
        message["id"] = json!(self.db.last_insert_rowid());
        let now: i64 = self
            .db
            .query_row("SELECT unixepoch()", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        message["created_at"] = json!(now);
        self.db
            .execute(
                "UPDATE group_messages SET document=?1 WHERE id=?2",
                params![message.to_string(), message["id"].as_i64()],
            )
            .map_err(|error| error.to_string())?;
        Ok(message)
    }
    pub fn recover_group_deliveries(&self) -> Result<(), String> {
        self.db.execute("UPDATE group_deliveries SET document=json_set(document,'$.state','waiting_resume','$.reason','应用重启，请明确继续或取消旧投递。','$.revision',json_extract(document,'$.revision')+1,'$.updated_at',unixepoch()) WHERE json_extract(document,'$.state')='queued'",[]).map_err(|error|error.to_string())?;
        Ok(())
    }
}
