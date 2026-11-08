use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE; CREATE TABLE cli_interactions(id TEXT PRIMARY KEY,task_id INTEGER NOT NULL REFERENCES owned_tasks(id),document TEXT NOT NULL); CREATE INDEX cli_interactions_task ON cli_interactions(task_id,id); PRAGMA user_version=23; COMMIT;").map_err(|e|e.to_string())
}
pub(crate) fn save(db: &Connection, value: &Value) -> Result<(), String> {
    if value.to_string().len() > 48000 {
        return Err("交互记录超过容量，请缩小请求内容。".into());
    }
    db.execute("INSERT INTO cli_interactions(id,task_id,document) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET document=excluded.document", params![value["interaction_id"].as_str(),value["task_id"].as_i64(),value.to_string()]).map_err(|e|e.to_string())?;
    Ok(())
}
pub(crate) fn close_task(db: &Connection, task: i64) -> Result<(), String> {
    db.execute("UPDATE cli_interactions SET document=json_set(document,'$.state',CASE WHEN json_extract(document,'$.delivery.write_state')='started' THEN 'indeterminate' ELSE 'closed' END,'$.closed_reason','Owned task ended; inspect its evidence before creating linked work','$.revision',json_extract(document,'$.revision')+1) WHERE task_id=?1 AND json_extract(document,'$.state') IN ('pending','decided','sent')",[task]).map_err(|error|error.to_string())?;
    Ok(())
}
impl Store {
    pub fn cli_interactions_recover(&self) -> Result<(), String> {
        self.db.execute("UPDATE cli_interactions SET document=json_set(document,'$.state',CASE WHEN json_extract(document,'$.delivery.write_state')='started' THEN 'indeterminate' ELSE 'closed' END,'$.closed_reason','Core restarted; inspect the original Task before starting new work','$.revision',json_extract(document,'$.revision')+1) WHERE json_extract(document,'$.state') IN ('pending','decided','sent')",[]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn cli_interaction(&self, id: &str) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row(
                "SELECT document FROM cli_interactions WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "交互请求不存在。")?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
    pub fn cli_interaction_native(
        &self,
        task: i64,
        epoch: i64,
        session: &Value,
        native_id: &Value,
    ) -> Result<Option<Value>, String> {
        let raw:Option<String>=self.db.query_row(
            "SELECT document FROM cli_interactions WHERE task_id=?1 AND json_extract(document,'$.task_epoch')=?2 AND json_extract(document,'$.native_session_id')=json_extract(?3,'$') AND json_type(document,'$.native_request_id')=json_type(?4,'$') AND json_extract(document,'$.native_request_id')=json_extract(?4,'$')",
            params![task,epoch,session.to_string(),native_id.to_string()],|row|row.get(0)
        ).optional().map_err(|error|error.to_string())?;
        raw.map(|text| serde_json::from_str(&text).map_err(|error| error.to_string()))
            .transpose()
    }
    pub fn cli_interactions(&self, task: i64) -> Result<Value, String> {
        self.cli_interactions_page(task, None)
    }
    pub fn cli_interactions_page(&self, task: i64, before: Option<i64>) -> Result<Value, String> {
        self.owned_task(task)?;
        let mut query=self.db.prepare("SELECT rowid,document FROM cli_interactions WHERE task_id=?1 AND rowid<?2 ORDER BY rowid DESC LIMIT 33").map_err(|e|e.to_string())?;
        let rows = query
            .query_map(params![task, before.unwrap_or(i64::MAX)], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut cursor = None;
        let mut more = false;
        for row in rows {
            let (row_id, raw) = row.map_err(|error| error.to_string())?;
            let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            bytes += value.to_string().len();
            if bytes > 32000 && !items.is_empty() || items.len() >= 32 {
                more = true;
                break;
            }
            cursor = Some(row_id);
            items.push(value);
        }
        Ok(json!({"items":items,"next_cursor":if more {cursor} else {None}}))
    }
}
