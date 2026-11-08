use super::{
    groups::{require_transaction, rows},
    Store,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE UNIQUE INDEX group_topic_source ON group_chats(json_extract(document,'$.source_message_id')) WHERE json_extract(document,'$.source_group_id') IS NOT NULL;
      CREATE INDEX group_topic_parent ON group_chats(json_extract(document,'$.source_group_id'),id);
      PRAGMA user_version=28; COMMIT;").map_err(|error|error.to_string())
}
impl Store {
    pub fn topic_participants(&self, id: i64) -> Result<Vec<i64>, String> {
        let mut query=self.db.prepare("SELECT json_extract(document,'$.sender_agent_id') AS agent FROM group_messages WHERE group_id=?1 AND json_extract(document,'$.sender_agent_id') IS NOT NULL UNION SELECT targets.value AS agent FROM group_messages m,json_each(m.document,'$.recipient_agent_ids') targets WHERE m.group_id=?1 ORDER BY agent").map_err(|error|error.to_string())?;
        let rows = query
            .query_map([id], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| row.map_err(|error| error.to_string()))
            .collect()
    }
    pub fn child_topic_ids(&self, group: i64) -> Result<Vec<i64>, String> {
        let mut query=self.db.prepare("SELECT id FROM group_chats WHERE json_extract(document,'$.source_group_id')=?1 ORDER BY id").map_err(|error|error.to_string())?;
        let rows = query
            .query_map([group], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| row.map_err(|error| error.to_string()))
            .collect()
    }
    pub fn topic_for_message(&self, id: i64) -> Result<Option<Value>, String> {
        rows(&self.db,"SELECT document FROM group_chats WHERE json_extract(document,'$.source_group_id') IS NOT NULL AND json_extract(document,'$.source_message_id')=?1",[id])?.pop().map(|value|self.project_topic(value)).transpose()
    }
    pub fn topics(&self, group: i64, before: Option<i64>) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM group_chats WHERE json_extract(document,'$.source_group_id')=?1 AND id<?2 ORDER BY id DESC LIMIT 21",params![group,before.unwrap_or(i64::MAX)])?.into_iter().map(|value|self.project_topic(value)).collect()
    }
    pub fn topic_document(&self, id: i64) -> Result<Value, String> {
        let value = self.group_document(id)?;
        if !value["source_group_id"].is_i64() {
            return Err("话题不存在。".into());
        }
        Ok(value)
    }
    pub(crate) fn project_topic(&self, mut topic: Value) -> Result<Value, String> {
        let Some(parent_id) = topic["source_group_id"].as_i64() else {
            return Ok(topic);
        };
        let parent = self.group_document(parent_id)?;
        if parent["source_group_id"].is_i64() {
            return Err("话题来源必须是主群。".into());
        }
        let overrides = topic["member_overrides"].clone();
        topic["members"] = parent["members"].clone();
        for member in topic["members"].as_array_mut().ok_or("群成员资料无效。")? {
            let own = overrides.as_array().into_iter().flatten().find(|entry| {
                entry["agent_id"] == member["agent_id"]
                    && entry["parent_joined_revision"] == member["joined_revision"]
            });
            member["listen_override"] = own
                .map(|entry| entry["listen_mode"].clone())
                .unwrap_or(Value::Null);
            member["receiving_override"] = own
                .map(|entry| entry["receiving"].clone())
                .unwrap_or(Value::Null);
            if let Some(listen) = own.and_then(|entry| entry["listen_mode"].as_str()) {
                member["listen_mode"] = json!(listen);
            }
            if own.is_some_and(|entry| entry["receiving"] == false) {
                member["receiving"] = json!(false);
            }
        }
        topic["rules"] = topic["rules_override"]
            .as_str()
            .map(|text| json!(text))
            .unwrap_or(parent["rules"].clone());
        topic["own_paused"] = topic["paused"].clone();
        topic["own_archived"] = topic["archived"].clone();
        topic["paused"] = json!(topic["paused"] == true || parent["paused"] == true);
        topic["archived"] = json!(
            topic["archived"] == true
                || parent["archived"] == true
                || topic["scope_invalidated"] == true
        );
        topic["project_id"] = parent["project_id"].clone();
        topic["source_group_revision"] = parent["revision"].clone();
        Ok(topic)
    }
    pub(crate) fn refresh_topics(&self, parent: &Value, old: Option<&Value>) -> Result<(), String> {
        require_transaction(self)?;
        if parent["source_group_id"].is_i64() {
            return Ok(());
        }
        let changed = old.is_some_and(|old| old["project_id"] != parent["project_id"]);
        self.db.execute("UPDATE group_chats SET document=json_set(document,'$.revision',json_extract(document,'$.revision')+1,'$.updated_at',unixepoch(),'$.scope_invalidated',json(CASE WHEN ?2 OR json_extract(document,'$.scope_invalidated')=1 THEN 'true' ELSE 'false' END)) WHERE json_extract(document,'$.source_group_id')=?1",params![parent["id"].as_i64(),changed]).map_err(|error|error.to_string())?;
        Ok(())
    }
}
