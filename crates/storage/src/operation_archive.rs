use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveConfiguration {
    expected_revision: i64,
    enabled: bool,
    retention_seconds: i64,
}

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE operation_archive_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,enabled INTEGER NOT NULL,retention_seconds INTEGER NOT NULL);
        INSERT INTO operation_archive_settings VALUES(1,1,0,2592000);
        CREATE TABLE operation_archive_settings_history(revision INTEGER PRIMARY KEY,document TEXT NOT NULL);
        CREATE TABLE operation_receipt_times(subject TEXT NOT NULL,operation_id TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(subject,operation_id));
        CREATE INDEX operation_receipt_age ON operation_receipt_times(updated_at);
        INSERT INTO operation_receipt_times SELECT subject,operation_id,unixepoch() FROM operations;
        CREATE TABLE operation_archives(archive_id TEXT PRIMARY KEY,subject TEXT NOT NULL,operation_id TEXT NOT NULL,receipt TEXT NOT NULL,archived_at INTEGER NOT NULL,UNIQUE(subject,operation_id));
        CREATE TRIGGER operation_receipt_insert AFTER INSERT ON operations BEGIN INSERT INTO operation_receipt_times VALUES(NEW.subject,NEW.operation_id,unixepoch()); END;
        CREATE TRIGGER operation_receipt_update AFTER UPDATE OF receipt ON operations BEGIN UPDATE operation_receipt_times SET updated_at=unixepoch() WHERE subject=NEW.subject AND operation_id=NEW.operation_id; END;
        PRAGMA user_version=34;").map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

impl Store {
    pub(crate) fn operation_retry_receipt(
        &self,
        subject: &str,
        receipt: Value,
    ) -> Result<Value, String> {
        if subject != "desktop" && receipt["state"] == "archived" {
            return self.operation_archive_get(
                subject,
                receipt["operation_id"]
                    .as_str()
                    .ok_or("缺少归档操作身份。")?,
                receipt["archive_ref"]["archive_id"]
                    .as_str()
                    .ok_or("缺少归档引用。")?,
            );
        }
        Ok(receipt)
    }
    pub fn operation_archive_settings(&self) -> Result<Value, String> {
        self.db.query_row("SELECT revision,enabled,retention_seconds FROM operation_archive_settings WHERE id=1", [], |r| {
            Ok(json!({"revision":r.get::<_,i64>(0)?,"enabled":r.get::<_,bool>(1)?,"retention_seconds":r.get::<_,i64>(2)?}))
        }).map_err(|e|e.to_string())
    }

    pub fn operation_archive_configure(&self, input: &Value) -> Result<Value, String> {
        let configuration: ArchiveConfiguration =
            serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
        let expected = configuration.expected_revision;
        let enabled = configuration.enabled;
        let seconds = configuration.retention_seconds;
        if !(60..=315360000).contains(&seconds) {
            return Err("归档保留期应为 60 秒至 10 年。".into());
        }
        if self.db.execute("UPDATE operation_archive_settings SET revision=revision+1,enabled=?1,retention_seconds=?2 WHERE id=1 AND revision=?3",params![enabled,seconds,expected]).map_err(|e|e.to_string())? != 1 {
            return Err("归档配置修订已变化，请刷新。".into());
        }
        let settings = self.operation_archive_settings()?;
        self.db
            .execute(
                "INSERT INTO operation_archive_settings_history VALUES(?1,?2)",
                params![settings["revision"].as_i64(), settings.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(settings)
    }

    /// Archive only completed command receipts. Execution and reconciliation state
    /// stays in its existing ledger, including every unresolved external effect.
    pub fn archive_operations(&self) -> Result<Value, String> {
        self.db
            .execute_batch("SAVEPOINT receipt_archive")
            .map_err(|e| e.to_string())?;
        let result = self.archive_operations_batch();
        match result {
            Ok(value) => {
                self.db
                    .execute_batch("RELEASE receipt_archive")
                    .map_err(|e| e.to_string())?;
                Ok(value)
            }
            Err(error) => {
                self.db
                    .execute_batch("ROLLBACK TO receipt_archive; RELEASE receipt_archive")
                    .map_err(|e| format!("{error}; archive rollback failed: {e}"))?;
                Err(error)
            }
        }
    }

    fn archive_operations_batch(&self) -> Result<Value, String> {
        let settings = self.operation_archive_settings()?;
        if settings["enabled"] != true {
            return Ok(json!({"archived":0,"settings_revision":settings["revision"]}));
        }
        let mut statement = self.db.prepare("SELECT o.subject,o.operation_id,o.method,o.fingerprint,o.receipt FROM operations o JOIN operation_receipt_times t USING(subject,operation_id) WHERE t.updated_at<=unixepoch()-?1 AND json_extract(o.receipt,'$.state') IN ('committed','rejected','dismissed') ORDER BY t.updated_at,o.subject,o.operation_id LIMIT 100").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([settings["retention_seconds"].as_i64()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (subject, id, method, fingerprint, raw) in &rows {
            let receipt: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
            let archive_id: String = self
                .db
                .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            self.db
                .execute(
                    "INSERT INTO operation_archives VALUES(?1,?2,?3,?4,unixepoch())",
                    params![archive_id, subject, id, raw],
                )
                .map_err(|e| e.to_string())?;
            let reference = json!({"archive_id":archive_id,"operation_id":id,"instance_id":self.instance_id()?});
            let stub = json!({"operation_id":id,"instance_id":self.instance_id()?,"method":method,"state":"archived","terminal_state":receipt["state"],"fingerprint":fingerprint,"archive_ref":reference,"execution_ref":receipt["execution_ref"]});
            self.db
                .execute(
                    "UPDATE operations SET receipt=?1 WHERE subject=?2 AND operation_id=?3",
                    params![stub.to_string(), subject, id],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(json!({"archived":rows.len(),"settings_revision":settings["revision"]}))
    }

    pub fn operation_archive_get(
        &self,
        subject: &str,
        id: &str,
        archive_id: &str,
    ) -> Result<Value, String> {
        let raw: Option<String> = self.db.query_row("SELECT receipt FROM operation_archives WHERE subject=?1 AND operation_id=?2 AND archive_id=?3",params![subject,id,archive_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        serde_json::from_str(&raw.ok_or("归档回执不存在或无权读取。")?).map_err(|e| e.to_string())
    }
}
