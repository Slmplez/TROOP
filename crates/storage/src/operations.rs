//! Single-writer command receipts. Domain changes and the terminal receipt commit
//! together; the closure must return runtime actions rather than perform them.
use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[cfg(test)]
mod tests;

pub struct OperationFailure {
    pub kind: &'static str,
    pub message: String,
    pub current_revision: Option<i64>,
}
impl From<String> for OperationFailure {
    fn from(message: String) -> Self {
        Self {
            kind: "request_rejected",
            message,
            current_revision: None,
        }
    }
}

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE storage_identity(id INTEGER PRIMARY KEY CHECK(id=1),instance_id TEXT NOT NULL UNIQUE);
        INSERT INTO storage_identity VALUES(1,lower(hex(randomblob(16))));
        CREATE TABLE operations(subject TEXT NOT NULL,operation_id TEXT NOT NULL,method TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(subject,operation_id));
        PRAGMA user_version=11;").map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

impl Store {
    /// External effects cannot join SQLite. Commit the intent first; a crash or
    /// ambiguous failure remains reconcilable and is never automatically replayed.
    pub fn reserve_external_operation(
        &mut self,
        subject: &str,
        id: &str,
        method: &str,
        input: &Value,
        expected_revision: Option<i64>,
    ) -> Result<(Value, bool), String> {
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                json!({"method":method,"input":input,"expected_revision":expected_revision})
                    .to_string()
                    .as_bytes()
            )
        );
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT fingerprint,receipt FROM operations WHERE subject=?1 AND operation_id=?2",
                params![subject, id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((old, raw)) = previous {
            let receipt = if old == fingerprint {
                serde_json::from_str(&raw).map_err(|_| "Invalid operation receipt")?
            } else {
                json!({"operation_id":id,"instance_id":self.instance_id()?,"state":"conflict","error":{"kind":"operation_conflict","message":"此 operationId 已用于不同命令或参数。"}})
            };
            return Ok((receipt, false));
        }
        let receipt = json!({"operation_id":id,"instance_id":self.instance_id()?,"method":method,"mode":"external","state":"needs_reconciliation","result":null,"error":{"kind":"needs_reconciliation","message":"外部操作已登记；请核对资源当前状态，不能自动重放。"},"execution_ref":null});
        tx.execute(
            "INSERT INTO operations VALUES(?1,?2,?3,?4,?5)",
            params![subject, id, method, fingerprint, receipt.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok((receipt, true))
    }
    pub fn finish_external_operation(
        &self,
        subject: &str,
        id: &str,
        result: Result<Value, String>,
    ) -> Result<Value, String> {
        let mut receipt = self.operation_get(subject, id)?;
        match result {
            Ok(value) => {
                receipt["state"] = json!("committed");
                receipt["result"] = value;
                receipt["error"] = Value::Null;
            }
            Err(message) => {
                receipt["error"] = json!({"kind":"needs_reconciliation","message":message});
            }
        }
        self.db
            .execute(
                "UPDATE operations SET receipt=?1 WHERE subject=?2 AND operation_id=?3",
                params![receipt.to_string(), subject, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(receipt)
    }
    pub fn instance_id(&self) -> Result<String, String> {
        self.db
            .query_row(
                "SELECT instance_id FROM storage_identity WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }
    pub fn operation_get(&self, subject: &str, id: &str) -> Result<Value, String> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT receipt FROM operations WHERE subject=?1 AND operation_id=?2",
                params![subject, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(|_| "Invalid operation receipt".into()),
            None => {
                Ok(json!({"operation_id":id,"instance_id":self.instance_id()?,"state":"not_found"}))
            }
        }
    }

    pub fn execute_operation<T>(
        &mut self,
        subject: &str,
        id: &str,
        method: &str,
        input: &Value,
        expected_revision: Option<i64>,
        apply: impl FnOnce(&mut Store) -> Result<(Value, T), OperationFailure>,
    ) -> Result<(Value, Option<T>), String> {
        // serde_json's default Map is sorted; nested object ordering is canonical too.
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                json!({"method":method,"input":input,"expected_revision":expected_revision})
                    .to_string()
                    .as_bytes()
            )
        );
        if !self.db.is_autocommit() {
            return Err("Operation cannot nest inside another transaction".into());
        }
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            let previous: Option<String> = self
                .db
                .query_row(
                    "SELECT fingerprint FROM operations WHERE subject=?1 AND operation_id=?2",
                    params![subject, id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(previous) = previous {
                if previous != fingerprint {
                    return Ok((
                        json!({"operation_id":id,"instance_id":self.instance_id()?,"state":"conflict","error":{"kind":"operation_conflict","message":"此 operationId 已用于不同命令或参数。"}}),
                        None,
                    ));
                }
                return Ok((self.operation_get(subject, id)?, None));
            }
            self.db
                .execute(
                    "INSERT INTO operations VALUES(?1,?2,?3,?4,'{}')",
                    params![subject, id, method, fingerprint],
                )
                .map_err(|e| e.to_string())?;
            self.db
                .execute_batch("SAVEPOINT operation_apply")
                .map_err(|e| e.to_string())?;
            let (state, value, error, effect) = match apply(self) {
                Ok((value, effect)) => {
                    self.db
                        .execute_batch("RELEASE operation_apply")
                        .map_err(|e| e.to_string())?;
                    ("committed", value, Value::Null, Some(effect))
                }
                Err(error) => {
                    self.db
                        .execute_batch("ROLLBACK TO operation_apply; RELEASE operation_apply")
                        .map_err(|e| e.to_string())?;
                    (
                        "rejected",
                        Value::Null,
                        json!({"kind":error.kind,"message":error.message,"currentRevision":error.current_revision}),
                        None,
                    )
                }
            };
            let execution_ref = if matches!(method, "agent.start" | "cli.start") {
                value["run"]["id"].clone()
            } else if method == "cli.review" {
                value["run_id"].clone()
            } else if matches!(
                method,
                "agent.cancel" | "agent.resume" | "agent.steer" | "agent.compact"
            ) {
                input["id"].clone()
            } else {
                Value::Null
            };
            let receipt = json!({"operation_id":id,"instance_id":self.instance_id()?,"method":method,"state":state,"result":value,"error":error,"execution_ref":execution_ref});
            self.db
                .execute(
                    "UPDATE operations SET receipt=?1 WHERE subject=?2 AND operation_id=?3",
                    params![receipt.to_string(), subject, id],
                )
                .map_err(|e| e.to_string())?;
            Ok((receipt, effect))
        })();
        match result {
            Ok(value) => {
                if let Err(error) = self.db.execute_batch("COMMIT") {
                    self.db
                        .execute_batch("ROLLBACK")
                        .map_err(|e| format!("Operation rollback failed: {e}"))?;
                    return Err(error.to_string());
                }
                Ok(value)
            }
            Err(error) => {
                self.db
                    .execute_batch("ROLLBACK")
                    .map_err(|e| format!("Operation rollback failed: {e}"))?;
                Err(error)
            }
        }
    }
}
