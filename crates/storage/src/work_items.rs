use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE; CREATE TABLE work_items(id INTEGER PRIMARY KEY, document TEXT NOT NULL); PRAGMA user_version=24; COMMIT;").map_err(|error|error.to_string())
}
pub(super) fn migrate_runs(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE; CREATE TABLE work_item_runs(run_id INTEGER PRIMARY KEY REFERENCES agent_runs(id),work_item_id INTEGER NOT NULL REFERENCES work_items(id),document TEXT NOT NULL); CREATE INDEX work_item_runs_owner ON work_item_runs(work_item_id,run_id); PRAGMA user_version=25; COMMIT;").map_err(|error|error.to_string())
}

impl Store {
    pub fn work_item_run(&self, run: i64) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row(
                "SELECT document FROM work_item_runs WHERE run_id=?1",
                [run],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        serde_json::from_str(&raw).map_err(|error| error.to_string())
    }
    pub fn work_item_runs(&self, id: i64, before: Option<i64>) -> Result<Value, String> {
        self.work_item(id)?;
        let mut statement = self.db.prepare("SELECT document FROM work_item_runs WHERE work_item_id=?1 AND run_id<?2 ORDER BY run_id DESC LIMIT 9").map_err(|error|error.to_string())?;
        let mut items = statement
            .query_map(params![id, before.unwrap_or(i64::MAX)], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?
            .map(|raw| {
                serde_json::from_str::<Value>(&raw.map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let more = items.len() > 8;
        items.truncate(8);
        let next = if more {
            items.last().map(|item| item["run_id"].clone())
        } else {
            None
        };
        Ok(json!({"items":items,"next_before":next}))
    }
    pub fn save_work_item_run(&self, link: &Value) -> Result<(), String> {
        if self.db.is_autocommit() {
            return Err("工作执行关联需要操作事务。".into());
        }
        self.db.execute("INSERT INTO work_item_runs VALUES(?1,?2,?3) ON CONFLICT(run_id) DO UPDATE SET document=excluded.document WHERE work_item_runs.work_item_id=excluded.work_item_id", params![link["run_id"].as_i64(),link["work_item_id"].as_i64(),link.to_string()]).map_err(|error|error.to_string())?;
        Ok(())
    }
    pub fn work_item(&self, id: i64) -> Result<Value, String> {
        let raw: Option<String> = self
            .db
            .query_row("SELECT document FROM work_items WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|error| error.to_string())?;
        serde_json::from_str(&raw.ok_or("工作项不存在。")?).map_err(|error| error.to_string())
    }
    pub fn work_items(&self, query: &Value) -> Result<Value, String> {
        let mut statement = self.db.prepare("SELECT document FROM work_items WHERE (?1 IS NULL OR id<?1) AND json_extract(document,'$.archived')=?2 AND (?3 IS NULL OR json_extract(document,'$.owner_agent_id')=?3) AND (?4 IS NULL OR json_extract(document,'$.project_id')=?4) AND (?5 IS NULL OR json_extract(document,'$.workspace_id')=?5) ORDER BY id DESC LIMIT 21").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map(
                params![
                    query["before"].as_i64(),
                    query["archived"] == true,
                    query["owner_agent_id"].as_i64(),
                    query["project_id"].as_str(),
                    query["workspace_id"].as_i64()
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let available = rows.len();
        let mut items = Vec::new();
        let mut bytes = 0;
        for raw in rows.into_iter().take(20) {
            if bytes + raw.len() > 30_000 && !items.is_empty() {
                break;
            }
            bytes += raw.len();
            items.push(serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?);
        }
        let next = if items.len() < available {
            items.last().map(|item| item["id"].clone())
        } else {
            None
        };
        Ok(json!({"items":items,"next_before":next}))
    }
    // Domain state and its operation receipt share the caller's transaction.
    pub fn save_work_item(
        &self,
        mut item: Value,
        previous: Option<&Value>,
    ) -> Result<Value, String> {
        if self.db.is_autocommit() {
            return Err("工作项变更需要操作事务。".into());
        }
        let id = match previous {
            Some(old) => old["id"].as_i64().ok_or("工作项身份无效。")?,
            None => self
                .db
                .query_row("SELECT COALESCE(MAX(id),0)+1 FROM work_items", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|error| error.to_string())?,
        };
        let now: i64 = self
            .db
            .query_row("SELECT unixepoch()", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        item["id"] = json!(id);
        item["revision"] = json!(
            previous
                .and_then(|old| old["revision"].as_i64())
                .unwrap_or(0)
                + 1
        );
        item["created_at"] = previous
            .map(|old| old["created_at"].clone())
            .unwrap_or(json!(now));
        item["updated_at"] = json!(now);
        self.db.execute("INSERT INTO work_items VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET document=excluded.document",params![id,item.to_string()]).map_err(|error|error.to_string())?;
        Ok(item)
    }
}
