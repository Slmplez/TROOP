use super::{
    groups::{require_transaction, rows},
    Store,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE group_executors(group_id INTEGER NOT NULL REFERENCES group_chats(id),agent_id INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(group_id,agent_id));
      CREATE TABLE group_chains(id TEXT PRIMARY KEY,group_id INTEGER NOT NULL REFERENCES group_chats(id),document TEXT NOT NULL);
      CREATE UNIQUE INDEX group_delivery_run ON group_deliveries(json_extract(document,'$.run_id')) WHERE json_extract(document,'$.run_id') IS NOT NULL;
      DROP TRIGGER group_project_revoked;
      CREATE TRIGGER group_project_revoked AFTER DELETE ON memory_members BEGIN
        UPDATE group_deliveries SET document=json_set(document,'$.state','cancelled','$.reason','项目成员资格已撤销。','$.revision',json_extract(document,'$.revision')+1,'$.updated_at',unixepoch())
        WHERE agent_id=OLD.agent_id AND group_id IN (SELECT id FROM group_chats WHERE json_extract(document,'$.project_id')=OLD.project) AND json_extract(document,'$.state') IN ('queued','waiting_resume','blocked','dispatched','adopted','awaiting_reconciliation')
        AND NOT (coalesce(json_extract(document,'$.adopted'),0)=1 AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=json_extract(group_deliveries.document,'$.run_id') AND r.state='completed'));
      END;
      PRAGMA user_version=27; COMMIT;").map_err(|error|error.to_string())
}
impl Store {
    pub fn group_earliest_pending(&self, group: i64, agent: i64) -> Result<Option<i64>, String> {
        use rusqlite::OptionalExtension;
        self.db.query_row("SELECT id FROM group_deliveries WHERE group_id=?1 AND agent_id=?2 AND json_extract(document,'$.state') IN ('queued','waiting_resume','blocked','dispatched','awaiting_reconciliation') ORDER BY id LIMIT 1",params![group,agent],|row|row.get(0)).optional().map_err(|error|error.to_string())
    }
    pub fn group_executor(&self, group: i64, agent: i64) -> Result<Option<Value>, String> {
        let current = self.group(group)?;
        let owner = current["source_group_id"].as_i64().unwrap_or(group);
        rows(
            &self.db,
            "SELECT document FROM group_executors WHERE group_id=?1 AND agent_id=?2",
            params![owner, agent],
        )
        .map(|mut items| {
            items.pop().map(|mut value| {
                value["group_id"] = json!(group);
                value
            })
        })
    }
    pub fn save_group_executor(&self, mut value: Value) -> Result<Value, String> {
        require_transaction(self)?;
        let previous = self.group_executor(
            value["group_id"].as_i64().ok_or("群身份无效。")?,
            value["agent_id"].as_i64().ok_or("Agent 身份无效。")?,
        )?;
        value["revision"] = json!(
            previous
                .and_then(|value| value["revision"].as_i64())
                .unwrap_or(0)
                + 1
        );
        self.db.execute("INSERT INTO group_executors VALUES(?1,?2,?3) ON CONFLICT(group_id,agent_id) DO UPDATE SET document=excluded.document",params![value["group_id"].as_i64(),value["agent_id"].as_i64(),value.to_string()]).map_err(|error|error.to_string())?;
        Ok(value)
    }
    pub fn group_chain(&self, id: &str) -> Result<Value, String> {
        rows(
            &self.db,
            "SELECT document FROM group_chains WHERE id=?1",
            [id],
        )?
        .pop()
        .ok_or("协作链不存在。".into())
    }
    pub fn group_chain_for_message(&self, id: i64) -> Result<Option<Value>, String> {
        rows(
            &self.db,
            "SELECT document FROM group_chains WHERE json_extract(document,'$.root_message_id')=?1",
            [id],
        )
        .map(|mut items| items.pop())
    }
    pub fn save_group_chain(&self, mut value: Value) -> Result<Value, String> {
        require_transaction(self)?;
        let previous = rows(
            &self.db,
            "SELECT document FROM group_chains WHERE id=?1",
            [value["id"].as_str().ok_or("协作链身份无效。")?],
        )?
        .pop();
        value["revision"] = json!(
            previous
                .and_then(|value| value["revision"].as_i64())
                .unwrap_or(0)
                + 1
        );
        self.db.execute("INSERT INTO group_chains VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET document=excluded.document",params![value["id"].as_str(),value["group_id"].as_i64(),value.to_string()]).map_err(|error|error.to_string())?;
        Ok(value)
    }
    pub fn group_dispatch_candidates(&self) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT d.document FROM group_deliveries d JOIN group_chats g ON g.id=d.group_id JOIN group_executors e ON e.group_id=coalesce(json_extract(g.document,'$.source_group_id'),d.group_id) AND e.agent_id=d.agent_id
          WHERE json_extract(d.document,'$.state')='queued' AND json_extract(e.document,'$.enabled')=1
          AND NOT EXISTS(SELECT 1 FROM group_deliveries older WHERE older.group_id=d.group_id AND older.agent_id=d.agent_id AND older.id<d.id AND json_extract(older.document,'$.state') IN ('queued','waiting_resume','blocked','dispatched','awaiting_reconciliation'))
          AND NOT EXISTS(SELECT 1 FROM group_deliveries owned JOIN agent_runs r ON r.id=json_extract(owned.document,'$.run_id') WHERE owned.group_id=d.group_id AND owned.agent_id=d.agent_id AND (r.state NOT IN ('completed','failed','cancelled') OR json_extract(owned.document,'$.state')='awaiting_reconciliation'))
          AND (SELECT count(*) FROM group_deliveries active JOIN agent_runs r ON r.id=json_extract(active.document,'$.run_id') WHERE json_extract(active.document,'$.chain_id')=coalesce(json_extract(d.document,'$.chain_id'),(SELECT c.id FROM group_chains c WHERE json_extract(c.document,'$.root_message_id')=d.message_id LIMIT 1)) AND r.state NOT IN ('completed','failed','cancelled'))<2
          ORDER BY d.id LIMIT 64",[])
    }
    pub fn group_linked_deliveries(&self) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT d.document FROM group_deliveries d JOIN agent_runs r ON r.id=json_extract(d.document,'$.run_id') JOIN group_chats g ON g.id=d.group_id LEFT JOIN group_chains c ON c.id=json_extract(d.document,'$.chain_id')
          WHERE r.state IN ('queued','running','waiting','cancelling')
          OR coalesce(json_extract(d.document,'$.observed_run_revision'),-1)<>json_extract(r.document,'$.revision')
          OR coalesce(json_extract(d.document,'$.observed_group_revision'),-1)<>json_extract(g.document,'$.revision')
          OR coalesce(json_extract(d.document,'$.observed_chain_revision'),-1)<>coalesce(json_extract(c.document,'$.revision'),0)
          OR (json_extract(c.document,'$.expires_at')<=unixepoch() AND json_extract(d.document,'$.state') IN ('dispatched','awaiting_reconciliation') AND coalesce(json_extract(d.document,'$.reply_state'),'')<>'blocked')
          OR json_extract(d.document,'$.reply_state') IS NULL ORDER BY d.id LIMIT 128",[])
    }
    pub fn group_recipient_runs(&self, group: i64, agent: i64) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT r.document FROM agent_runs r JOIN group_deliveries d ON r.id=json_extract(d.document,'$.run_id') WHERE d.group_id=?1 AND d.agent_id=?2 AND (r.state NOT IN ('completed','failed','cancelled') OR json_extract(d.document,'$.state')='awaiting_reconciliation') ORDER BY r.id",params![group,agent])
    }
    pub fn group_chain_deliveries(&self, chain: &str) -> Result<Vec<Value>, String> {
        rows(&self.db,"SELECT document FROM group_deliveries WHERE json_extract(document,'$.chain_id')=?1 ORDER BY id",[chain])
    }
    pub fn group_delivery_for_run(&self, run: i64) -> Result<Option<Value>, String> {
        rows(
            &self.db,
            "SELECT document FROM group_deliveries WHERE json_extract(document,'$.run_id')=?1",
            [run],
        )
        .map(|mut items| items.pop())
    }
    pub fn group_atomic<T>(
        &mut self,
        apply: impl FnOnce(&mut Store) -> Result<T, String>,
    ) -> Result<T, String> {
        if !self.db.is_autocommit() {
            return Err("群运行事务不能嵌套。".into());
        }
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        match apply(self) {
            Ok(value) => {
                if let Err(error) = self.db.execute_batch("COMMIT") {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(error.to_string());
                }
                Ok(value)
            }
            Err(error) => {
                self.db
                    .execute_batch("ROLLBACK")
                    .map_err(|rollback| rollback.to_string())?;
                Err(error)
            }
        }
    }
    pub fn recover_group_runs(&self) -> Result<(), String> {
        self.db.execute("UPDATE group_deliveries SET document=json_set(document,'$.state','awaiting_reconciliation','$.reason','执行已中断，请先核对原 Run。','$.revision',json_extract(document,'$.revision')+1) WHERE json_extract(document,'$.run_id') IS NOT NULL AND json_extract(document,'$.state') IN ('dispatched','adopted') AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=json_extract(group_deliveries.document,'$.run_id') AND r.state NOT IN ('completed','failed','cancelled'))",[]).map_err(|error|error.to_string())?;
        Ok(())
    }
}
