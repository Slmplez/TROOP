use super::*;

impl Manager {
    pub(crate) fn office_host_available(&self, store: &Store) -> Result<(), String> {
        if self.execution.blocked(store)? {
            return Err(
                "当前有受管 Worker 占用或隔离宿主资源，请等待停止核对后再打开或提交文件。".into(),
            );
        }
        Ok(())
    }
    pub(super) fn office_read_tool(
        &mut self,
        store: &mut Store,
        run: &mut Value,
        invocation: &mut Value,
    ) -> Result<bool, String> {
        if invocation["name"] != "office_read" {
            return Ok(false);
        }
        let result = crate::office::open(
            store,
            run["workspace_id"].as_i64().ok_or("工作区无效。")?,
            invocation["arguments"]["path"]
                .as_str()
                .ok_or("文件路径无效。")?,
        )
        .and_then(|document| crate::office::get(store, document["id"].as_str().unwrap(), None));
        let result = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        self.finish_memory_tool(store, run, invocation, result)
    }

    pub(super) fn office_prepare_write(
        store: &Store,
        run: &Value,
        invocation: &mut Value,
    ) -> Result<(), String> {
        let name = invocation["name"].as_str().unwrap_or("");
        if !matches!(name, "write_file" | "office_edit") {
            return Ok(());
        }
        let workspace = run["workspace_id"].as_i64().ok_or("工作区无效。")?;
        let relative = invocation["arguments"]["path"]
            .as_str()
            .ok_or("文件路径无效。")?;
        let root =
            std::fs::canonicalize(store.workspace_path(workspace)?).map_err(|_| "工作区无效。")?;
        let path = tools::target(&root, relative, true)?;
        let key = path.to_string_lossy().into_owned();
        #[cfg(windows)]
        let key = key.to_lowercase();
        let document = if name == "office_edit" {
            crate::office::open(store, workspace, relative)?
        } else if let Some(document) = store.office_by_path(&key)? {
            document
        } else {
            return Ok(());
        };
        let id = document["id"].as_str().ok_or("文件身份无效。")?;
        let revision = document["revision"].as_i64().ok_or("文件版本无效。")?;
        if name == "office_edit"
            && invocation["arguments"]["expected_revision"]
                .as_str()
                .and_then(|value| value.parse::<i64>().ok())
                != Some(revision)
        {
            return Err("办公文件版本已变化，请重新读取后重做。".into());
        }
        if !document["pending"].is_null() || !store.office_drafts(id)?.is_empty() {
            return Err("文件存在未保存草稿或待核对写入，已停止 Agent 覆盖。".into());
        }
        let current = crate::office::get(store, id, None)?;
        if current["external_changed"] == true
            || document["sha256"] != invocation["arguments"]["expected_hash"]
        {
            return Err("文件已变化，请核对版本后重做。".into());
        }
        let content = invocation["arguments"]["content"]
            .as_str()
            .ok_or("文件正文无效。")?;
        crate::office::text_valid(content)?;
        let effect = Uuid::new_v4().to_string();
        store.office_begin_write(id, revision, json!({"effect_id":effect,"sha256":tools::hash(content.as_bytes()),"previous_sha256":document["sha256"],"content":content,"reason":"agent_edit","source_run_id":run["id"],"invocation_id":invocation["id"]}))?;
        invocation["office_effect"] = json!({"document_id":id,"effect_id":effect});
        Ok(())
    }

    pub(super) fn office_finish_worker(store: &Store, invocation: &Value, result: &mut Value) {
        if invocation["office_error"].is_string() {
            *result = json!({"ok":false,"error":invocation["office_error"],"stopped":true});
            return;
        }
        let Some(id) = invocation["office_effect"]["document_id"].as_str() else {
            return;
        };
        let effect = invocation["office_effect"]["effect_id"]
            .as_str()
            .unwrap_or("");
        if result["ok"] == true && result["value"]["effect_unknown"] != true {
            if let Some(sha) = result["value"]["sha256"].as_str() {
                match store.office_finish_write(id, effect, sha) {
                    Ok(document) => {
                        result["value"]["office_version"] = document;
                        return;
                    }
                    Err(error) => {
                        result["error"] = json!(error);
                    }
                }
            }
        }
        result["ok"] = json!(false);
        result["indeterminate"] = json!(true);
        result["office_effect"] = invocation["office_effect"].clone();
        result["error"] = json!("办公写入结果等待核对，提议与历史版本已保留。");
    }
}
