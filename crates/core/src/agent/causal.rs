use super::*;

impl Manager {
    pub(super) fn causal_action(&self, invocation: &Value) -> Option<String> {
        let name = invocation["name"].as_str()?;
        if self.providers.tools.read_only(name)
            || matches!(
                name,
                "spawn_agent" | "stop_task" | "propose_followup" | "request_handoff"
            )
        {
            return None;
        }
        Some(
            match name {
                "write_file" | "office_edit" => "file.write",
                "run_command" | "start_background" => "process.exec",
                "manage_rule" => "rule.write",
                other => other,
            }
            .to_owned(),
        )
    }

    pub(super) fn causal_check_invocation(
        &self,
        store: &Store,
        run: &Value,
        invocation: &mut Value,
    ) -> Result<(), String> {
        if !run["causal_scope"].is_object() {
            return Ok(());
        }
        let Some(action) = self.causal_action(invocation) else {
            return Ok(());
        };
        let effect = format!("invocation:{}:{}", invocation["id"], invocation["epoch"]);
        let decision = store.causal_write_check(&run["causal_scope"], &action, &effect)?;
        invocation["causal_limit"] = decision.clone();
        if decision["allowed"] != true {
            return Err(decision["reason"].as_str().unwrap().to_owned());
        }
        Ok(())
    }

    pub(super) fn causal_reserve_invocation(
        &self,
        store: &Store,
        run: &Value,
        invocation: &mut Value,
    ) -> Result<(), String> {
        if !run["causal_scope"].is_object() {
            return Ok(());
        }
        let Some(action) = self.causal_action(invocation) else {
            return Ok(());
        };
        let effect = format!("invocation:{}:{}", invocation["id"], invocation["epoch"]);
        invocation["causal_write"] = store.causal_write_reserve(
            &run["causal_scope"],
            &action,
            &effect,
            run["id"].as_i64().ok_or("缺少回流 Run 身份。")?,
        )?;
        Ok(())
    }
}

pub(super) fn event_scope(store: &Store, rule: &Value, event: &Value) -> Result<Value, String> {
    if event["external_event_id"].is_number() {
        let kind = event["kind"].as_str().ok_or("缺少事件种类。")?;
        let family = kind
            .rsplit_once('.')
            .map(|(family, _)| family)
            .unwrap_or(kind);
        return Ok(
            json!({"workspace_id":rule["workspace_id"],"source_id":event["source_id"],"subject_id":format!("{family}:{}",event["subject_id"].as_str().ok_or("缺少事件对象身份。")?)}),
        );
    }
    let run_id = event["run_id"]
        .as_i64()
        .or_else(|| event["id"].as_i64())
        .ok_or("缺少来源执行身份。")?;
    let run = store.agent_run(run_id)?;
    if run["causal_scope"].is_object() {
        return Ok(run["causal_scope"].clone());
    }
    Ok(
        json!({"workspace_id":rule["workspace_id"],"source_id":format!("internal:{}",rule["workspace_id"]),"subject_id":event["work_item_id"].as_i64().map(|id|format!("work:{id}")).unwrap_or_else(||format!("run:{run_id}"))}),
    )
}
