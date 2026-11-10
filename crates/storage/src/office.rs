use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|error| error.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS office_documents(id TEXT PRIMARY KEY,workspace_id INTEGER NOT NULL REFERENCES workspaces(id),path_key TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(workspace_id,path_key));
      CREATE INDEX IF NOT EXISTS office_physical_path ON office_documents(path_key);
      CREATE TABLE IF NOT EXISTS office_versions(document_id TEXT NOT NULL REFERENCES office_documents(id),revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(document_id,revision));
      CREATE TABLE IF NOT EXISTS office_drafts(document_id TEXT NOT NULL REFERENCES office_documents(id),actor TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(document_id,actor));
      CREATE TABLE IF NOT EXISTS office_references(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES office_documents(id),revision INTEGER NOT NULL,document TEXT NOT NULL);").map_err(|error|error.to_string())?;
    tx.execute_batch("PRAGMA user_version=32;")
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

pub(super) fn migrate_references(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|error| error.to_string())?;
    let has_references:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('turns') WHERE name='office_reference_ids')",[],|row|row.get(0)).map_err(|error|error.to_string())?;
    if !has_references {
        tx.execute_batch(
            "ALTER TABLE turns ADD COLUMN office_reference_ids TEXT NOT NULL DEFAULT '[]';",
        )
        .map_err(|error| error.to_string())?;
    }
    tx.execute_batch("PRAGMA user_version=33;")
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

impl Store {
    pub fn finish_office_operation(
        &self,
        id: &str,
        result: Result<Value, String>,
    ) -> Result<Value, String> {
        let started: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM office_documents WHERE json_extract(document,'$.pending.operation_id')=?1 UNION ALL SELECT 1 FROM office_versions WHERE json_extract(document,'$.operation_id')=?1)",[id],|row|row.get(0)).map_err(|e|e.to_string())?;
        if started || result.is_ok() {
            return self.finish_external_operation("desktop", id, result);
        }
        let message = result.unwrap_err();
        let mut receipt = self.operation_get("desktop", id)?;
        receipt["state"] = json!("rejected");
        receipt["error"] = json!({"kind":"request_rejected","message":message});
        self.db
            .execute(
                "UPDATE operations SET receipt=?1 WHERE subject='desktop' AND operation_id=?2",
                params![receipt.to_string(), id],
            )
            .map_err(|e| e.to_string())?;
        Ok(receipt)
    }
    pub fn office_document(&self, id: &str) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row(
                "SELECT document FROM office_documents WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|_| "文件记录不存在。")?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
    pub fn office_by_path(&self, path: &str) -> Result<Option<Value>, String> {
        self.db
            .query_row(
                "SELECT document FROM office_documents WHERE path_key=?1 ORDER BY rowid LIMIT 1",
                [path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .map(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
            .transpose()
    }
    pub fn office_create(&self, mut document: Value, content: &str) -> Result<Value, String> {
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        document["revision"] = json!(1);
        document["pending"] = Value::Null;
        tx.execute(
            "INSERT INTO office_documents VALUES(?1,?2,?3,?4)",
            params![
                document["id"].as_str(),
                document["workspace_id"].as_i64(),
                document["path_key"].as_str(),
                document.to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        let version = json!({"revision":1,"sha256":document["sha256"],"content":content,"reason":"opened","source_run_id":null});
        tx.execute(
            "INSERT INTO office_versions VALUES(?1,1,?2)",
            params![document["id"].as_str(), version.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(document)
    }
    pub fn office_version(&self, id: &str, revision: i64) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row(
                "SELECT document FROM office_versions WHERE document_id=?1 AND revision=?2",
                params![id, revision],
                |row| row.get(0),
            )
            .map_err(|_| "文件版本不存在。")?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
    pub fn office_effect_version(&self, id: &str, effect: &str) -> Result<Option<Value>, String> {
        self.db.query_row("SELECT document FROM office_versions WHERE document_id=?1 AND json_extract(document,'$.effect_id')=?2 ORDER BY revision DESC LIMIT 1",params![id,effect],|row|row.get::<_,String>(0)).optional().map_err(|e|e.to_string())?.map(|raw|serde_json::from_str(&raw).map_err(|e|e.to_string())).transpose()
    }
    pub fn office_list(&self, workspace: i64, before: Option<&str>) -> Result<Value, String> {
        let mut query = self.db.prepare("SELECT document FROM office_documents WHERE workspace_id=?1 AND id<?2 ORDER BY id DESC LIMIT 21").map_err(|e|e.to_string())?;
        let mut items = query
            .query_map(params![workspace, before.unwrap_or("~")], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?
            .map(|row| {
                serde_json::from_str::<Value>(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let next = if items.len() > 20 {
            items.truncate(20);
            items.last().map(|item| item["id"].clone())
        } else {
            None
        };
        // Pending content is fetched only from the selected document.
        for item in &mut items {
            item["pending"] = json!(!item["pending"].is_null());
        }
        Ok(json!({"items":items,"next_before":next}))
    }
    pub fn office_history(&self, id: &str, before: Option<i64>) -> Result<Value, String> {
        self.office_document(id)?;
        let mut query = self.db.prepare("SELECT document FROM office_versions WHERE document_id=?1 AND revision<?2 ORDER BY revision DESC LIMIT 21").map_err(|e|e.to_string())?;
        let mut items = query
            .query_map(params![id, before.unwrap_or(i64::MAX)], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?
            .map(|row| {
                let mut value: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                value.as_object_mut().unwrap().remove("content");
                value.as_object_mut().unwrap().remove("document");
                Ok(value)
            })
            .collect::<Result<Vec<_>, String>>()?;
        let next = if items.len() > 20 {
            items.truncate(20);
            items.last().map(|item| item["revision"].clone())
        } else {
            None
        };
        Ok(json!({"items":items,"next_before":next}))
    }
    pub fn office_drafts(&self, id: &str) -> Result<Vec<Value>, String> {
        let mut query = self
            .db
            .prepare(
                "SELECT document FROM office_drafts WHERE document_id=?1 ORDER BY actor LIMIT 17",
            )
            .map_err(|e| e.to_string())?;
        let drafts = query
            .query_map([id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|row| {
                serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect();
        drafts
    }
    pub fn office_save_draft(
        &self,
        id: &str,
        actor: &str,
        expected: i64,
        base: i64,
        content: &str,
    ) -> Result<Value, String> {
        self.office_version(id, base)?;
        if !self.office_document(id)?["pending"].is_null() {
            return Err("文件写入等待核对，暂不能开始或更新草稿。".into());
        }
        let drafts = self.office_drafts(id)?;
        let previous = drafts.iter().find(|draft| draft["actor"] == actor);
        if previous
            .map(|draft| draft["revision"].as_i64().unwrap_or(0))
            .unwrap_or(0)
            != expected
        {
            return Err("草稿修订冲突，请先载入已保存草稿。".into());
        }
        if previous.is_none() && drafts.len() >= 16 {
            return Err("该文件最多保存十六份窗口草稿。".into());
        }
        let draft =
            json!({"actor":actor,"revision":expected+1,"base_revision":base,"content":content});
        self.db.execute("INSERT INTO office_drafts VALUES(?1,?2,?3) ON CONFLICT(document_id,actor) DO UPDATE SET document=excluded.document",params![id,actor,draft.to_string()]).map_err(|e|e.to_string())?;
        Ok(draft)
    }
    pub fn office_discard_draft(&self, id: &str, actor: &str, expected: i64) -> Result<(), String> {
        let draft = self
            .office_drafts(id)?
            .into_iter()
            .find(|draft| draft["actor"] == actor)
            .ok_or("草稿不存在。")?;
        if draft["revision"] != expected {
            return Err("草稿已变化，请重新核对。".into());
        }
        self.db
            .execute(
                "DELETE FROM office_drafts WHERE document_id=?1 AND actor=?2",
                params![id, actor],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn office_begin_write(
        &self,
        id: &str,
        expected: i64,
        intent: Value,
    ) -> Result<Value, String> {
        let mut document = self.office_document(id)?;
        if document["revision"] != expected || !document["pending"].is_null() {
            return Err("文件修订冲突或前次写入等待核对。".into());
        }
        document["pending"] = intent;
        self.db
            .execute(
                "UPDATE office_documents SET document=?2 WHERE id=?1",
                params![id, document.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(document)
    }
    pub fn office_finish_write(&self, id: &str, effect: &str, sha: &str) -> Result<Value, String> {
        let mut document = self.office_document(id)?;
        let intent = document["pending"].clone();
        if intent["effect_id"] != effect || intent["sha256"] != sha {
            return Err("文件效果身份或摘要不匹配。".into());
        }
        let revision = document["revision"].as_i64().ok_or("文件修订无效。")? + 1;
        let mut version = json!({"revision":revision,"sha256":sha,"content":intent["content"],"reason":intent["reason"],"source_run_id":intent["source_run_id"],"effect_id":effect,"operation_id":intent["operation_id"],"operation_subject":intent["operation_subject"]});
        document["revision"] = json!(revision);
        document["sha256"] = json!(sha);
        document["pending"] = Value::Null;
        version["document"] = document.clone();
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO office_versions VALUES(?1,?2,?3)",
            params![id, revision, version.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE office_documents SET document=?2 WHERE id=?1",
            params![id, document.to_string()],
        )
        .map_err(|e| e.to_string())?;
        if let Some(actor) = intent["actor"].as_str() {
            tx.execute("DELETE FROM office_drafts WHERE document_id=?1 AND actor=?2 AND json_extract(document,'$.revision')=?3",params![intent["draft_document_id"].as_str().unwrap_or(id),actor,intent["draft_revision"].as_i64()]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(document)
    }
    pub fn office_abandon_write(&self, id: &str, effect: &str) -> Result<Value, String> {
        let mut document = self.office_document(id)?;
        if document["pending"]["effect_id"] != effect {
            return Err("文件效果身份已变化。".into());
        }
        // Keep the failed proposal as a draft so recovery never loses its content.
        let pending = document["pending"].clone();
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        document["pending"] = Value::Null;
        tx.execute(
            "UPDATE office_documents SET document=?2 WHERE id=?1",
            params![id, document.to_string()],
        )
        .map_err(|e| e.to_string())?;
        self.office_save_draft(
            id,
            effect,
            0,
            document["revision"].as_i64().ok_or("文件修订无效。")?,
            pending["content"].as_str().ok_or("写入正文无效。")?,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(document)
    }
    pub fn office_add_reference(&self, id: &str, reference: Value) -> Result<Value, String> {
        self.db
            .execute(
                "INSERT INTO office_references VALUES(?1,?2,?3,?4)",
                params![
                    id,
                    reference["document_id"].as_str(),
                    reference["revision"].as_i64(),
                    reference.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(reference)
    }
    pub fn office_reference(&self, id: &str) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row(
                "SELECT document FROM office_references WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|_| "内容引用不存在。")?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
}
