use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE automation_rules(id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(id,revision));
        CREATE TABLE automation_deliveries(rule_id TEXT NOT NULL,event_key TEXT NOT NULL,workspace_id INTEGER NOT NULL,created_at INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(rule_id,event_key));
        PRAGMA user_version=14; COMMIT;").map_err(|e| e.to_string())
}
impl Store {
    pub fn record_work_acceptance(&self, item: &Value) -> Result<(), String> {
        if self.db.is_autocommit() {
            return Err("工作接纳事件需要操作事务。".into());
        }
        let run = self.agent_run(
            item["accepted"]["run_id"]
                .as_i64()
                .ok_or("接纳执行身份无效。")?,
        )?;
        let payload = json!({"work_item_id":item["id"],"workspace_id":item["workspace_id"],"project_id":item["project_id"],"acceptance":item["accepted"],"chain_id":run["chain_id"].as_str().map(str::to_owned).unwrap_or_else(||format!("run-{}",run["id"])),"chain_depth":run["chain_depth"].as_u64().unwrap_or(0)});
        self.db.execute("INSERT INTO agent_events(run_id,epoch,kind,payload) SELECT ?1,?2,'work_accepted',?3 WHERE NOT EXISTS(SELECT 1 FROM agent_events WHERE kind='work_accepted' AND json_extract(payload,'$.work_item_id')=?4 AND json_extract(payload,'$.acceptance.run_id')=?1 AND json_extract(payload,'$.acceptance.definition_revision')=?5)",params![run["id"].as_i64(),run["epoch"].as_i64(),payload.to_string(),item["id"].as_i64(),item["accepted"]["definition_revision"].as_i64()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn work_rule_candidates(&self, rule: &Value) -> Result<Vec<Value>, String> {
        let mut query=self.db.prepare("SELECT id,run_id,epoch,payload FROM agent_events e WHERE kind='work_accepted' AND id>?1 AND json_extract(payload,'$.workspace_id')=?2 AND (json_extract(payload,'$.work_item_id')=?3 OR json_extract(payload,'$.work_item_id') IN (SELECT value FROM json_each(?5))) AND NOT EXISTS(SELECT 1 FROM automation_deliveries d WHERE d.rule_id=?4 AND d.event_key='work:'||e.id AND COALESCE(json_extract(d.document,'$.state'),'')<>'waiting') ORDER BY id LIMIT 20").map_err(|e|e.to_string())?;
        let rows = query
            .query_map(
                params![
                    rule["after_event"].as_i64(),
                    rule["workspace_id"].as_i64(),
                    rule["source_work_item_id"].as_i64(),
                    rule["id"].as_str(),
                    rule["work_item_id"]
                        .as_i64()
                        .map(|id| self
                            .work_item(id)
                            .map(|item| item["dependency_ids"].to_string()))
                        .transpose()?
                        .unwrap_or("[]".into())
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        rows.map(|row| work_event(row.map_err(|e| e.to_string())?))
            .collect()
    }
    pub fn work_acceptance_event(&self, id: i64) -> Result<Value, String> {
        let row=self.db.query_row("SELECT id,run_id,epoch,payload FROM agent_events WHERE id=?1 AND kind='work_accepted'",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(|_|"工作接纳事件不存在。")?;
        work_event(row)
    }
    pub fn rule_get(&self, id: &str) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row(
                "SELECT document FROM automation_rules WHERE id=?1 ORDER BY revision DESC LIMIT 1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "规则不存在。")?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
    pub fn rules_all(&self) -> Result<Value, String> {
        let mut q = self.db.prepare("SELECT document FROM automation_rules r WHERE revision=(SELECT MAX(revision) FROM automation_rules WHERE id=r.id) AND COALESCE(json_extract(document,'$.cancelled'),0)=0 ORDER BY rowid DESC LIMIT 100").map_err(|e| e.to_string())?;
        let items = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str::<Value>(&r.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"items":items,"next_offset":null}))
    }
    pub fn rules_list(&self, offset: usize) -> Result<Value, String> {
        if offset > 1_000_000 {
            return Err("分页无效。".into());
        }
        let mut query = self.db.prepare("SELECT document FROM automation_rules r WHERE revision=(SELECT MAX(revision) FROM automation_rules WHERE id=r.id) ORDER BY rowid DESC LIMIT 21 OFFSET ?1").map_err(|e|e.to_string())?;
        let raw = query
            .query_map([offset as i64], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        super::authorizations::page(raw, offset)
    }
    pub fn rule_save(
        &mut self,
        id: &str,
        expected: i64,
        mut rule: Value,
        author: Value,
    ) -> Result<Value, String> {
        let old = self.rule_get(id).ok();
        if old
            .as_ref()
            .map(|r| r["revision"].as_i64().unwrap_or(0))
            .unwrap_or(0)
            != expected
        {
            return Err("规则修订冲突，请刷新。".into());
        }
        if old.is_none() && self.rules_all()?["items"].as_array().unwrap().len() >= 100 {
            return Err("最多保存 100 条规则。".into());
        }
        let effective_from: i64 = self
            .db
            .query_row(
                "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        rule["effective_from_ms"] = json!(effective_from);
        rule["created_at_ms"] = old
            .as_ref()
            .map(|r| r["created_at_ms"].clone())
            .filter(|v| !v.is_null())
            .unwrap_or(json!(effective_from));
        if let Some(origin) = old
            .as_ref()
            .and_then(|value| value.get("origin"))
            .or_else(|| author.get("automation_origin"))
        {
            rule["origin"] = origin.clone();
        }
        rule["author"] = author;
        rule["updated_at"] = json!(self
            .db
            .query_row("SELECT unixepoch()", [], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?);
        rule["id"] = json!(id);
        rule["revision"] = json!(expected + 1);
        rule["after_event"] = if let Some(old) = old.filter(|_| rule["event"] != "work.accepted") {
            old["after_event"].clone()
        } else {
            json!(self
                .db
                .query_row("SELECT COALESCE(MAX(id),0) FROM agent_events", [], |r| r
                    .get::<_, i64>(0))
                .map_err(|e| e.to_string())?)
        };
        self.db
            .execute(
                "INSERT INTO automation_rules VALUES(?1,?2,?3)",
                params![id, expected + 1, rule.to_string()],
            )
            .map_err(|e| e.to_string())?;
        self.db.execute("UPDATE automation_deliveries SET document=json_set(document,'$.state','skipped','$.reason','规则修订已变化，旧等待事件已结束。') WHERE rule_id=?1 AND json_extract(document,'$.state')='waiting'",[id]).map_err(|e|e.to_string())?;
        Ok(rule)
    }
    pub fn rule_history(&self, id: &str, offset: usize) -> Result<Value, String> {
        if offset > 1_000_000 {
            return Err("分页无效。".into());
        }
        let mut q = self
            .db
            .prepare(
                "SELECT document FROM automation_rules WHERE id=?1 ORDER BY revision DESC LIMIT 6 OFFSET ?2",
            )
            .map_err(|e| e.to_string())?;
        let mut items = q
            .query_map(params![id, offset as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str::<Value>(&r.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut q=self.db.prepare("SELECT document FROM automation_deliveries WHERE rule_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 6 OFFSET ?2").map_err(|e|e.to_string())?;
        let mut deliveries = q
            .query_map(params![id, offset as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str::<Value>(&r.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let next = if items.len() > 5 || deliveries.len() > 5 {
            Some(offset + 5)
        } else {
            None
        };
        items.truncate(5);
        deliveries.truncate(5);
        Ok(json!({"items":items,"deliveries":deliveries,"next_offset":next}))
    }
    pub fn rule_candidates(&self, rule: &Value) -> Result<Vec<Value>, String> {
        let mut q=self.db.prepare("SELECT r.document FROM agent_runs r WHERE r.state IN ('completed','failed') AND json_extract(r.document,'$.workspace_id')=?1 AND (SELECT MAX(id) FROM agent_events WHERE run_id=r.id AND kind<>'work_accepted')>?2 AND NOT EXISTS(SELECT 1 FROM automation_deliveries d WHERE d.rule_id=?3 AND d.event_key=CAST(r.id AS TEXT)||':'||json_extract(r.document,'$.epoch') AND COALESCE(json_extract(d.document,'$.state'),'')<>'waiting') ORDER BY r.id LIMIT 20").map_err(|e|e.to_string())?;
        let candidates = q
            .query_map(
                params![
                    rule["workspace_id"].as_i64(),
                    rule["after_event"].as_i64(),
                    rule["id"].as_str()
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())?
            .map(|r| {
                serde_json::from_str::<Value>(&r.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            })
            .collect();
        candidates
    }
    pub fn rule_frequency_blocked(&self, workspace: i64) -> Result<bool, String> {
        self.db.query_row("SELECT COUNT(*)>=3 OR COALESCE(MAX(created_at),0)>unixepoch()-60 FROM automation_deliveries WHERE workspace_id=?1 AND created_at>unixepoch()-3600 AND json_extract(document,'$.state')='dispatched'",[workspace],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub fn rule_waiting_reason(
        &self,
        rule: &Value,
        event: &Value,
    ) -> Result<Option<String>, String> {
        let key = if let Some(id) = event["work_event_id"].as_i64() {
            format!("work:{id}")
        } else if let Some(id) = event["external_event_id"].as_i64() {
            format!("external:{id}")
        } else {
            format!("{}:{}", event["id"], event["epoch"])
        };
        self.db.query_row("SELECT json_extract(document,'$.reason') FROM automation_deliveries WHERE rule_id=?1 AND event_key=?2 AND json_extract(document,'$.state')='waiting'",params![rule["id"].as_str(),key],|row|row.get(0)).optional().map_err(|e|e.to_string())
    }
    pub fn rule_delivery(&self, rule: &Value, event: &Value, result: &Value) -> Result<(), String> {
        self.db
            .execute(
                "INSERT INTO automation_deliveries VALUES(?1,?2,?3,unixepoch(),?4) ON CONFLICT(rule_id,event_key) DO UPDATE SET document=excluded.document,created_at=excluded.created_at WHERE json_extract(automation_deliveries.document,'$.state')='waiting'",
                params![
                    rule["id"].as_str(),
                    if let Some(id) = event["work_event_id"].as_i64() {
                        format!("work:{id}")
                    } else if let Some(id) = event["external_event_id"].as_i64() {
                        format!("external:{id}")
                    } else {
                        format!("{}:{}", event["id"], event["epoch"])
                    },
                    rule["workspace_id"].as_i64(),
                    result.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn work_event((id, run, epoch, raw): (i64, i64, i64, String)) -> Result<Value, String> {
    let mut value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    value["id"] = json!(run);
    value["epoch"] = json!(epoch);
    value["work_event_id"] = json!(id);
    value["kind"] = json!("work.accepted");
    value["state"] = json!("accepted");
    Ok(value)
}
