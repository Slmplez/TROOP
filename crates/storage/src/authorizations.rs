use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE authorizations(id TEXT PRIMARY KEY,document TEXT NOT NULL);
        CREATE TABLE authorization_history(grant_id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(grant_id,revision));
        PRAGMA user_version=13;").map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
impl Store {
    pub fn authorization_get(&self, id: &str) -> Result<Value, String> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT h.document FROM authorizations a JOIN authorization_history h ON h.grant_id=a.id AND h.revision=json_extract(a.document,'$.revision') WHERE a.id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&raw.ok_or("授权不存在。")?).map_err(|e| e.to_string())
    }
    pub fn authorization_list(&self, offset: usize) -> Result<Value, String> {
        if offset > 1_000_000 {
            return Err("分页无效。".into());
        }
        let mut query = self
            .db
            .prepare("SELECT document FROM authorizations ORDER BY rowid DESC LIMIT 21 OFFSET ?1")
            .map_err(|e| e.to_string())?;
        let raw = query
            .query_map([offset as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        page(raw, offset)
    }
    pub fn authorization_record_evaluation(
        &self,
        id: &str,
        revision: i64,
        evaluation: &Value,
    ) -> Result<(), String> {
        if serde_json::to_vec(evaluation)
            .map_err(|e| e.to_string())?
            .len()
            > 24_000
        {
            return Err("评估快照过长。".into());
        }
        self.db.execute("UPDATE authorization_history SET document=json_set(document,'$.last_evaluation',json(?1)) WHERE grant_id=?2 AND revision=?3",params![evaluation.to_string(),id,revision]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn authorization_history(&self, id: &str, offset: usize) -> Result<Value, String> {
        self.authorization_get(id)?;
        if offset > 1_000_000 {
            return Err("分页无效。".into());
        }
        let mut query=self.db.prepare("SELECT document FROM authorization_history WHERE grant_id=?1 ORDER BY revision DESC LIMIT 21 OFFSET ?2").map_err(|e|e.to_string())?;
        let raw = query
            .query_map(params![id, offset as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        page(raw, offset)
    }
    /// Called inside the existing operation transaction. Snapshot and current row
    /// therefore share the command's atomic receipt.
    pub fn authorization_save(
        &self,
        id: &str,
        expected: i64,
        mut grant: Value,
        revoke: bool,
    ) -> Result<Value, String> {
        let old = self
            .db
            .query_row(
                "SELECT document FROM authorizations WHERE id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .map(|r| serde_json::from_str::<Value>(&r).map_err(|e| e.to_string()))
            .transpose()?;
        let revision = old
            .as_ref()
            .and_then(|r| r["revision"].as_i64())
            .unwrap_or(0);
        if expected != revision || old.as_ref().is_some_and(|r| r["revoked"] == true) {
            return Err("授权已变化或已撤销，请刷新后重新创建意图。".into());
        }
        let now: i64 = self
            .db
            .query_row("SELECT unixepoch()", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if revoke {
            grant = old.clone().ok_or("授权不存在。")?;
        }
        grant["id"] = json!(id);
        grant["revision"] = json!(revision + 1);
        grant["revoked"] = json!(revoke);
        grant["created_at"] = old
            .as_ref()
            .map(|r| r["created_at"].clone())
            .unwrap_or(json!(now));
        grant["updated_at"] = json!(now);
        grant["actor"] = json!("desktop");
        self.db.execute("INSERT INTO authorizations VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET document=excluded.document",params![id,grant.to_string()]).map_err(|e|e.to_string())?;
        self.db
            .execute(
                "INSERT INTO authorization_history VALUES(?1,?2,?3)",
                params![id, revision + 1, grant.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(grant)
    }
}

pub(super) fn page(raw: Vec<String>, offset: usize) -> Result<Value, String> {
    let available = raw.len();
    let mut items = Vec::new();
    let mut bytes = 0;
    for row in raw.into_iter().take(20) {
        if bytes + row.len() > 40_000 {
            if items.is_empty() {
                return Err("授权记录超过分页容量。".into());
            }
            break;
        }
        bytes += row.len();
        items.push(serde_json::from_str::<Value>(&row).map_err(|e| e.to_string())?);
    }
    let next = if items.len() < available {
        Some(offset + items.len())
    } else {
        None
    };
    Ok(json!({"items":items,"next_offset":next}))
}
