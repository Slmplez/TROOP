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

pub(super) fn migrate_archive(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let recorded: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('operations') WHERE name='recorded_at')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !recorded {
        tx.execute_batch(
            "ALTER TABLE operations ADD COLUMN recorded_at INTEGER NOT NULL DEFAULT 0;
             UPDATE operations SET recorded_at=unixepoch() WHERE recorded_at=0;",
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS operation_receipt_archive(
            subject TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            method TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            receipt TEXT,
            archive_ref TEXT NOT NULL UNIQUE,
            archived_at INTEGER NOT NULL,
            payload_expires_at INTEGER,
            PRIMARY KEY (subject, operation_id)
        );
        PRAGMA user_version=35;",
    )
    .map_err(|e| e.to_string())?;
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
        if let Some(old) = self.operation_fingerprint(subject, id)? {
            let receipt = if old == fingerprint {
                self.operation_get(subject, id)?
            } else {
                json!({"operation_id":id,"instance_id":self.instance_id()?,"state":"conflict","error":{"kind":"operation_conflict","message":"此 operationId 已用于不同命令或参数。"}})
            };
            return Ok((receipt, false));
        }
        let receipt = json!({"operation_id":id,"instance_id":self.instance_id()?,"method":method,"mode":"external","state":"needs_reconciliation","result":null,"error":{"kind":"needs_reconciliation","message":"外部操作已登记；请核对资源当前状态，不能自动重放。"},"execution_ref":null});
        tx.execute(
            "INSERT INTO operations(subject, operation_id, method, fingerprint, receipt, recorded_at) VALUES(?1,?2,?3,?4,?5,unixepoch())",
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
        if receipt["state"] == "archived" {
            return Err("操作回执已归档，不能再完成。".into());
        }
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
        if let Some(raw) = raw {
            return serde_json::from_str(&raw).map_err(|_| "Invalid operation receipt".into());
        }
        if let Some(reference) = self.archived_reference(subject, id)? {
            return Ok(reference);
        }
        Ok(json!({"operation_id":id,"instance_id":self.instance_id()?,"state":"not_found"}))
    }

    pub fn operation_archive_get(&self, archive_ref: &str) -> Result<Value, String> {
        let receipt: Option<Option<String>> = self
            .db
            .query_row(
                "SELECT receipt FROM operation_receipt_archive WHERE archive_ref=?1",
                [archive_ref],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(receipt) = receipt else {
            return Err("归档引用不存在。".into());
        };
        let Some(receipt) = receipt.filter(|value| !value.is_empty()) else {
            return Err("归档正文已超过保留期。".into());
        };
        let mut value: Value =
            serde_json::from_str(&receipt).map_err(|_| "Invalid operation receipt".to_owned())?;
        value["archive_ref"] = json!(archive_ref);
        Ok(value)
    }

    pub fn retain_operation_receipts(&mut self) -> Result<usize, String> {
        // Match event payload retention: archive after 30 days, then keep the
        // body for another 30 days. The archive reference stays after that.
        self.archive_operation_receipts(2_592_000, 2_592_000)
    }

    pub fn archive_operation_receipts(
        &mut self,
        archive_after_seconds: i64,
        payload_retention_seconds: i64,
    ) -> Result<usize, String> {
        if archive_after_seconds < 0 || payload_retention_seconds < 0 {
            return Err("操作回执保留期无效。".into());
        }
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let moved = tx
            .execute(
                "INSERT INTO operation_receipt_archive(
                    subject, operation_id, method, fingerprint, receipt, archive_ref, archived_at, payload_expires_at
                )
                SELECT subject, operation_id, method, fingerprint, receipt,
                    'archive:' || lower(hex(randomblob(16))), unixepoch(), unixepoch()+?1
                FROM operations
                WHERE recorded_at > 0 AND recorded_at < unixepoch()-?2",
                params![payload_retention_seconds, archive_after_seconds],
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM operations WHERE recorded_at > 0 AND recorded_at < unixepoch()-?1",
            [archive_after_seconds],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE operation_receipt_archive SET receipt=NULL
             WHERE receipt IS NOT NULL AND payload_expires_at IS NOT NULL AND payload_expires_at <= unixepoch()",
            [],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(moved)
    }

    fn operation_fingerprint(&self, subject: &str, id: &str) -> Result<Option<String>, String> {
        let live: Option<String> = self
            .db
            .query_row(
                "SELECT fingerprint FROM operations WHERE subject=?1 AND operation_id=?2",
                params![subject, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if live.is_some() {
            return Ok(live);
        }
        self.db
            .query_row(
                "SELECT fingerprint FROM operation_receipt_archive WHERE subject=?1 AND operation_id=?2",
                params![subject, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    fn archived_reference(&self, subject: &str, id: &str) -> Result<Option<Value>, String> {
        struct Archived {
            method: String,
            receipt: Option<String>,
            archive_ref: String,
            archived_at: i64,
            payload_expires_at: Option<i64>,
        }
        let row = self
            .db
            .query_row(
                "SELECT method, receipt, archive_ref, archived_at, payload_expires_at
                 FROM operation_receipt_archive WHERE subject=?1 AND operation_id=?2",
                params![subject, id],
                |row| {
                    Ok(Archived {
                        method: row.get(0)?,
                        receipt: row.get(1)?,
                        archive_ref: row.get(2)?,
                        archived_at: row.get(3)?,
                        payload_expires_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(Archived {
            method,
            receipt,
            archive_ref,
            archived_at,
            payload_expires_at,
        }) = row
        else {
            return Ok(None);
        };
        let parsed: Value = receipt
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or(Value::Null);
        let instance = parsed["instance_id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or(self.instance_id()?);
        let mut reference = json!({
            "operation_id": id,
            "instance_id": instance,
            "state": "archived",
            "method": method,
            "archive_ref": archive_ref,
            "archived_at": archived_at
        });
        if let Some(expires) = payload_expires_at {
            reference["payload_expires_at"] = json!(expires);
        }
        Ok(Some(reference))
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
            let previous = self.operation_fingerprint(subject, id)?;
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
                    "INSERT INTO operations(subject, operation_id, method, fingerprint, receipt, recorded_at) VALUES(?1,?2,?3,?4,'{}',unixepoch())",
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
