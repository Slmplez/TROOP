use super::*;
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Respond {
    interaction_id: String,
    expected_revision: i64,
    task_epoch: i64,
    request_sha256: String,
    answer: Answer,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Answer {
    Plan {
        accepted: bool,
        plan_sha256: String,
    },
    ScopeChange {
        note: String,
    },
    Permission {
        option_id: String,
    },
    Question {
        answers: std::collections::BTreeMap<String, Vec<String>>,
    },
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn validate_request(raw: &Value) -> Result<(), String> {
    let valid_id = raw["native_request_id"].as_i64().is_some()
        || raw["native_request_id"].as_str().is_some_and(text_ok);
    if !valid_id || !raw["native_session_id"].as_str().is_some_and(text_ok) {
        return Err("原生交互身份无效。".into());
    }
    if raw["kind"] == "plan" {
        let text = raw["body"]["text"]
            .as_str()
            .filter(|text| text_ok(text))
            .ok_or("计划正文无效。")?;
        if raw["body"]["version"] != 1
            || raw["body"]["sha256"] != tools::hash(text.as_bytes())
            || raw.to_string().len() > 16000
        {
            return Err("计划版本或摘要无效。".into());
        }
        return Ok(());
    }
    if raw["kind"] == "permission" {
        let options = raw["body"]["options"]
            .as_array()
            .filter(|items| !items.is_empty() && items.len() <= 16)
            .ok_or("审批选项无效。")?;
        let mut ids = std::collections::BTreeSet::new();
        for option in options {
            let id = option["optionId"]
                .as_str()
                .filter(|id| text_ok(id))
                .ok_or("审批选项 ID 无效。")?;
            if !option["name"].as_str().is_some_and(text_ok)
                || !matches!(
                    option["kind"].as_str(),
                    Some("allow_once" | "allow_always" | "reject_once" | "reject_always")
                )
            {
                return Err("审批选项类型或名称无效。".into());
            }
            if !ids.insert(id) {
                return Err("审批选项 ID 重复。".into());
            }
        }
        if raw.to_string().len() > 16000 {
            return Err("审批请求超过容量。".into());
        }
        return Ok(());
    }
    if raw["kind"] != "question" || raw.to_string().len() > 16000 {
        return Err("原生问题形态超过当前接入能力。".into());
    }
    let questions = raw["body"]["questions"]
        .as_array()
        .ok_or("问题结构无效。")?;
    if questions.is_empty() || questions.len() > 8 {
        return Err("原生问题形态超过当前接入能力。".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for question in questions {
        let key = question["id"]
            .as_str()
            .filter(|v| text_ok(v))
            .ok_or("问题 ID 无效。")?;
        if !ids.insert(key)
            || question["isSecret"] == true
            || !text_ok(question["question"].as_str().unwrap_or(""))
        {
            return Err("原生问题形态超过当前接入能力。".into());
        }
        let options = question["options"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 16)
            .ok_or("当前问题需要明确选项。")?;
        let mut labels = std::collections::BTreeSet::new();
        for option in options {
            let label = option["label"]
                .as_str()
                .filter(|v| text_ok(v))
                .ok_or("选项无效。")?;
            if !labels.insert(label) {
                return Err("原生问题形态超过当前接入能力。".into());
            }
        }
    }
    Ok(())
}
fn native_target(workspace: &str, raw: &str) -> Option<PathBuf> {
    use std::path::{Component, Path};
    if raw.is_empty() || raw.len() > 4000 || raw.contains('\0') {
        return None;
    }
    let raw = Path::new(raw);
    if raw
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return None;
    }
    let mut candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        Path::new(workspace).join(raw)
    };
    let mut suffix = Vec::new();
    while !candidate.exists() {
        suffix.push(candidate.file_name()?.to_os_string());
        if !candidate.pop() {
            return None;
        }
    }
    let mut resolved = std::fs::canonicalize(candidate).ok()?;
    for component in suffix.iter().rev() {
        resolved.push(component);
    }
    Some(resolved)
}
impl Manager {
    fn interaction_blocker(&self, store: &Store, request: &Value) -> Option<String> {
        let Ok(task) = store.owned_task(request["task_id"].as_i64().unwrap_or(0)) else {
            return Some("交互 Task 不存在。".into());
        };
        let Ok(run) = store.agent_run(request["run_id"].as_i64().unwrap_or(0)) else {
            return Some("交互 Run 不存在。".into());
        };
        if task["epoch"] != request["task_epoch"]
            || task["stop_requested"] == true
            || !matches!(task["state"].as_str(), Some("running" | "dispatched"))
            || !run["intent"].is_null()
            || terminal(&run)
            || !self.cli_waiters.contains_key(&task["id"].as_i64()?)
        {
            return Some("交互所属执行已停止或连接已失效。".into());
        }
        if request["expires_at"].as_i64().unwrap_or(0) <= now() {
            return Some("交互请求已到期。".into());
        }
        Self::external_authorized(store, &run).err()
    }
    pub(super) fn interaction_read(
        &self,
        store: &Store,
        method: &str,
        input: Value,
    ) -> Result<Value, String> {
        let decorate = |mut value: Value| {
            let reason = if value["state"] != "pending" {
                Some("该请求已作出决定或已关闭。".to_owned())
            } else {
                self.interaction_blocker(store, &value)
            };
            let approve_reason = reason.clone().or_else(|| {
                if value["kind"] == "permission"
                    && self.permission_scope(store, &value).unwrap_or(None) == Some(true)
                {
                    None
                } else {
                    Some("所需执行范围缺少完整参数或能力证据。".into())
                }
            });
            value["allowed_actions"] = json!({
                "respond":{"allowed":reason.is_none(),"reason":reason},
                "approve":{"allowed":approve_reason.is_none(),"reason":approve_reason},
                "request_scope_change":{"allowed":reason.is_none() && value["kind"]=="permission","reason":reason}
            });
            value
        };
        if method == "cli.interaction" {
            return Ok(decorate(store.cli_interaction(
                input["interaction_id"].as_str().ok_or("交互 ID 无效。")?,
            )?));
        }
        let mut page = store.cli_interactions_page(
            input["task_id"].as_i64().ok_or("Task ID 无效。")?,
            input["before"].as_i64(),
        )?;
        page["items"] = json!(page["items"]
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(decorate)
            .collect::<Vec<_>>());
        Ok(page)
    }
    pub(super) fn receive_interaction(
        &mut self,
        store: &mut Store,
        id: i64,
        epoch: i64,
        raw: Value,
        sender: blocking::Sender<Value>,
    ) -> Result<(), String> {
        let mut task = store.owned_task(id)?;
        let mut run = store.agent_run(task["owner_run_id"].as_i64().ok_or("缺少执行归属。")?)?;
        if task["epoch"] != epoch
            || !self.jobs.contains_key(&id)
            || task["stop_requested"] == true
            || !run["intent"].is_null()
            || Self::external_authorized(store, &run).is_err()
        {
            return Ok(());
        }
        if let Err(reason) = validate_request(&raw) {
            let _ = sender.send(json!({"error":reason}));
            return Ok(());
        }
        let sha = tools::hash(raw.to_string().as_bytes());
        if let Some(mut previous) = store.cli_interaction_native(
            id,
            epoch,
            &raw["native_session_id"],
            &raw["native_request_id"],
        )? {
            let conflict = previous["request_sha256"] != sha;
            if conflict {
                previous["protocol_conflict"] = json!({"received_sha256":sha,"at":now()});
                previous["closed_reason"] =
                    json!("原生请求身份相同但正文发生冲突，请核对已有执行效果。");
                previous["state"] = json!("indeterminate");
            } else if previous["expires_at"].as_i64().unwrap_or(0) <= now()
                || matches!(previous["state"].as_str(), Some("closed" | "indeterminate"))
            {
                let _ = sender.send(json!({"error":"旧原生请求已关闭或到期。"}));
                return Ok(());
            } else {
                let count = previous["redelivery_count"].as_u64().unwrap_or(0);
                if count >= 8 {
                    let _ = sender.send(json!({"error":"原生请求重投超过容量，请核对执行。"}));
                    return Ok(());
                }
                previous["redelivery_count"] = json!(count + 1);
                if previous["state"] == "sent" {
                    previous["delivery"]["previous_write_state"] =
                        previous["delivery"]["write_state"].clone();
                    previous["state"] = json!("decided");
                }
            }
            previous["revision"] = json!(previous["revision"].as_i64().unwrap() + 1);
            run["_cli_interaction"] = previous.clone();
            store.agent_commit(
                &mut run,
                &mut [],
                std::slice::from_mut(&mut task),
                None,
                if conflict {
                    "cli_native_request_conflict"
                } else {
                    "cli_native_request_repeated"
                },
            )?;
            if conflict {
                self.cli_waiters.remove(&id);
                let _ = sender.send(json!({"error":"原生请求正文冲突，执行效果需要核对。"}));
            } else {
                self.cli_waiters.insert(
                    id,
                    (
                        previous["interaction_id"].as_str().unwrap().to_owned(),
                        sender,
                    ),
                );
            }
            return Ok(());
        }
        if self.cli_waiters.contains_key(&id) {
            let _ = sender.send(json!({"error":"当前作业已有待答请求。"}));
            return Ok(());
        }
        let grant =
            store.authorization_get(run["authorization_id"].as_str().ok_or("缺少授权。")?)?;
        let expires_at = (now()
            + task["permission_plan"]["human_wait_seconds"]
                .as_i64()
                .unwrap_or(900))
        .min(grant["expires_at"].as_i64().unwrap_or(0))
        .min(task["execution_deadline"].as_i64().unwrap_or(0));
        let request = json!({
            "interaction_id":Uuid::new_v4().to_string(),
            "revision":1,
            "run_id":run["id"],
            "task_id":id,
            "task_epoch":epoch,
            "attempt":run["attempt"],
            "native_request_id":raw["native_request_id"],
            "native_session_id":raw["native_session_id"],
            "native_turn_id":raw["native_turn_id"],
            "source":raw.get("source").cloned().unwrap_or(json!("native")),
            "kind":raw["kind"],
            "body":raw["body"],
            "request_sha256":sha,
            "state":"pending",
            "created_at":now(),
            "expires_at":expires_at,
            "authorization_id":grant["id"],
            "authorization_revision":grant["revision"],
            "decision":null,
            "delivery":{"write_state":"not_started","confirmation":"unavailable"}
        });
        task["interaction_id"] = request["interaction_id"].clone();
        run["waiting"] = json!([
            "external_cli",
            if raw["kind"] == "question" {
                "question"
            } else {
                "approval"
            }
        ]);
        run["_cli_interaction"] = request.clone();
        store.agent_commit(
            &mut run,
            &mut [],
            std::slice::from_mut(&mut task),
            None,
            "cli_question_requested",
        )?;
        self.cli_waiters.insert(
            id,
            (
                request["interaction_id"].as_str().unwrap().to_owned(),
                sender,
            ),
        );
        if request["kind"] == "permission" && task["permission_plan"]["approval_mode"] != "manual" {
            let kind = match self.permission_scope(store, &request)? {
                Some(true) => Some("allow_once"),
                Some(false) => Some("reject_once"),
                None => None,
            };
            if let Some(option) = request["body"]["options"]
                .as_array()
                .unwrap()
                .iter()
                .find(|option| Some(option["kind"].as_str().unwrap_or("")) == kind)
            {
                let operation_id = Uuid::new_v4().to_string();
                let input = json!({"interaction_id":request["interaction_id"],"expected_revision":request["revision"],"task_epoch":epoch,"request_sha256":request["request_sha256"],"answer":{"kind":"permission","option_id":option["optionId"]}});
                let _ = store.execute_operation(
                    "authorization",
                    &operation_id,
                    "cli.auto-approve",
                    &input,
                    None,
                    |store| {
                        self.respond_interaction(
                            store,
                            input.clone(),
                            &operation_id,
                            "authorization",
                        )
                        .map(|value| (value, ()))
                        .map_err(troop_storage::OperationFailure::from)
                    },
                )?;
            }
        }
        Ok(())
    }
    fn permission_scope(&self, store: &Store, request: &Value) -> Result<Option<bool>, String> {
        let task = store.owned_task(request["task_id"].as_i64().ok_or("Task ID 无效。")?)?;
        let plan = &task["permission_plan"];
        let tool = request["body"]["tool_name"].as_str().unwrap_or("");
        let call = &request["body"]["tool_call"];
        let Some(tools) = plan["native_tools"].as_array() else {
            return Ok(None);
        };
        let known_tool = tools.contains(&json!(tool));
        let filtered_kind = matches!(
            tool,
            "copilot_filtered_tool" | "opencode_filtered_tool" | "grok_filtered_tool"
        ) && match call["kind"].as_str() {
            Some("read") => ["view", "read", "read_file"]
                .iter()
                .any(|name| tools.contains(&json!(name))),
            Some("edit") => ["create", "write", "write_file"]
                .iter()
                .any(|name| tools.contains(&json!(name))),
            Some("execute") => ["powershell", "bash", "shell"]
                .iter()
                .any(|name| tools.contains(&json!(name))),
            _ => false,
        };
        if !matches!(
            plan["adapter"].as_str(),
            Some(
                "copilot-acp-contained-v1"
                    | "claude-stream-contained-v1"
                    | "opencode-acp-contained-v1"
                    | "grok-acp-contained-v1"
                    | "pi-rpc-contained-v1"
                    | "omp-rpc-contained-v1"
            )
        ) || plan["scope"] != "contained_native_process"
            || !(known_tool || filtered_kind)
            || !call["rawInput"].is_object()
        {
            return Ok(None);
        }
        let (read, execute) = match call["kind"].as_str() {
            Some("read") => (true, false),
            Some("edit") => (false, false),
            Some("execute") => (false, true),
            _ => (tool == "view", tool == "powershell"),
        };
        if execute {
            return Ok(call["rawInput"]["command"]
                .as_str()
                .filter(|command| text_ok(command))
                .map(|_| true));
        }
        let run = store.agent_run(request["run_id"].as_i64().ok_or("Run ID 无效。")?)?;
        let workspace = run["workspace"].as_str().ok_or("工作区无效。")?;
        let mut paths = Vec::new();
        for field in ["fileName", "filePath", "file_path", "path"] {
            if let Some(value) = call["rawInput"][field].as_str() {
                paths.push(value);
            }
        }
        for location in call["locations"].as_array().into_iter().flatten() {
            if let Some(value) = location["path"].as_str() {
                paths.push(value);
            }
        }
        if paths.is_empty() {
            return Ok(None);
        }
        for raw in paths {
            let Some(path) = native_target(workspace, raw) else {
                return Ok(None);
            };
            let key = if read { "read_roots" } else { "write_roots" };
            if !plan[key].as_array().is_some_and(|roots| {
                roots
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|root| path.starts_with(std::path::Path::new(root)))
            }) {
                return Ok(Some(false));
            }
        }
        Ok(Some(true))
    }
    pub(super) fn respond_interaction(
        &self,
        store: &mut Store,
        input: Value,
        operation_id: &str,
        actor: &str,
    ) -> Result<Value, String> {
        let args = params::<Respond>(input)?;
        let mut request = store.cli_interaction(&args.interaction_id)?;
        if request["task_epoch"] != args.task_epoch
            || request["request_sha256"] != args.request_sha256
        {
            return Err("请求身份或正文已变化。".into());
        }
        let answer = serde_json::to_value(&args.answer).map_err(|e| e.to_string())?;
        if !request["decision"].is_null() {
            if request["decision"]["answer"] == answer {
                return Ok(json!({"accepted":true,"duplicate":true}));
            }
            return Err("请求已有不同决定。".into());
        }
        if request["revision"] != args.expected_revision || request["state"] != "pending" {
            return Err("交互修订已过期。".into());
        }
        if let Some(reason) = self.interaction_blocker(store, &request) {
            return Err(reason);
        }
        if let Answer::Question { answers } = &args.answer {
            if request["kind"] != "question" {
                return Err("回答类型不匹配。".into());
            }
            let questions = request["body"]["questions"]
                .as_array()
                .ok_or("问题无效。")?;
            if answers.len() != questions.len() {
                return Err("请回答全部问题。".into());
            }
            for question in questions {
                let selected = answers
                    .get(question["id"].as_str().unwrap())
                    .ok_or("缺少问题答案。")?;
                let multiple = question["multiSelect"] == true || question["multi"] == true;
                let unique = selected.iter().collect::<std::collections::BTreeSet<_>>();
                if selected.is_empty()
                    || (!multiple && selected.len() != 1)
                    || unique.len() != selected.len()
                    || selected.iter().any(|label| {
                        !question["options"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|option| option["label"] == *label)
                    })
                {
                    return Err("答案选项无效。".into());
                }
            }
        } else if let Answer::Permission { option_id } = &args.answer {
            if request["kind"] != "permission" {
                return Err("回答类型不匹配。".into());
            }
            let option = request["body"]["options"]
                .as_array()
                .ok_or("审批选项无效。")?
                .iter()
                .find(|option| option["optionId"] == *option_id)
                .ok_or("审批选项不存在。")?;
            if option["kind"] != "reject_once"
                && !(option["kind"] == "allow_once"
                    && self.permission_scope(store, &request)? == Some(true))
            {
                return Err("该审批选项需要额外的授权或能力证据。".into());
            }
        } else if let Answer::Plan {
            accepted: _,
            plan_sha256,
        } = &args.answer
        {
            if request["kind"] != "plan" || request["body"]["sha256"] != *plan_sha256 {
                return Err("计划正文或版本已变化。".into());
            }
        } else if let Answer::ScopeChange { note } = &args.answer {
            if request["kind"] != "permission" || !text_ok(note) {
                return Err("权限变更需要有效的原生审批和说明。".into());
            }
        }
        request["decision"] =
            json!({"answer":answer,"actor":actor,"operation_id":operation_id,"decided_at":now()});
        let scope_change = matches!(args.answer, Answer::ScopeChange { .. });
        request["state"] = json!(if scope_change { "closed" } else { "decided" });
        request["revision"] = json!(args.expected_revision + 1);
        let mut task = store.owned_task(request["task_id"].as_i64().unwrap())?;
        let mut run = store.agent_run(request["run_id"].as_i64().unwrap())?;
        if scope_change {
            task["scope_change_interaction_id"] = request["interaction_id"].clone();
        }
        run["_cli_interaction"] = request;
        store.agent_commit(
            &mut run,
            &mut [],
            std::slice::from_mut(&mut task),
            None,
            "cli_question_decided",
        )?;
        Ok(
            json!({"accepted":true,"duplicate":false,"scope_change_requested":scope_change,"task_id":task["id"]}),
        )
    }
    pub(super) fn pump_interactions(&mut self, store: &mut Store) -> Result<(), String> {
        for id in self.cli_waiters.keys().copied().collect::<Vec<_>>() {
            let key = self.cli_waiters[&id].0.clone();
            let mut request = store.cli_interaction(&key)?;
            let reason = self.interaction_blocker(store, &request);
            if reason.is_some() {
                self.cli_waiters.remove(&id);
                request["state"] = json!("closed");
                request["closed_reason"] = json!(reason);
            } else if request["state"] == "decided" {
                request["delivery"]["write_state"] = json!("started");
            } else {
                continue;
            }
            let mut task = store.owned_task(id)?;
            let mut run = store.agent_run(request["run_id"].as_i64().unwrap())?;
            request["revision"] = json!(request["revision"].as_i64().unwrap() + 1);
            run["_cli_interaction"] = request.clone();
            store.agent_commit(
                &mut run,
                &mut [],
                std::slice::from_mut(&mut task),
                None,
                "cli_response_dispatch",
            )?;
            if let Some((_, sender)) = self.cli_waiters.remove(&id) {
                if sender.send(json!({"interaction_id":key,"native_request_id":request["native_request_id"],"native_session_id":request["native_session_id"],"request_sha256":request["request_sha256"],"task_epoch":request["task_epoch"],"answer":request["decision"]["answer"]})).is_err() {
                    request["state"] = json!("indeterminate");
                    request["closed_reason"] = json!("Worker 回应通道已断开，需要核对原作业。");
                    request["revision"] = json!(request["revision"].as_i64().unwrap() + 1);
                    run["_cli_interaction"] = request;
                    store.agent_commit(&mut run, &mut [], std::slice::from_mut(&mut task), None, "cli_response_channel_lost")?;
                }
            }
        }
        Ok(())
    }
    pub(super) fn merge_interaction_deliveries(
        store: &Store,
        task: &Value,
        run: &mut Value,
        result: &Value,
    ) -> Result<(), String> {
        let mut records = Vec::new();
        for fact in result["value"]["interaction_deliveries"]
            .as_array()
            .into_iter()
            .flatten()
            .take(16)
        {
            let Some(id) = fact["interaction_id"].as_str() else {
                continue;
            };
            let Ok(mut request) = store.cli_interaction(id) else {
                continue;
            };
            let expected = if request["source"] == "host_plan_confirmation" {
                "host_recorded"
            } else {
                "written"
            };
            if request["task_id"] != task["id"]
                || request["task_epoch"] != task["epoch"]
                || fact["task_epoch"] != task["epoch"]
                || fact["request_sha256"] != request["request_sha256"]
                || fact["native_request_id"] != request["native_request_id"]
                || fact["native_session_id"] != request["native_session_id"]
                || fact["write_state"] != expected
                || request["decision"].is_null()
                || request["delivery"]["write_state"] != "started"
            {
                continue;
            }
            request["delivery"]["write_state"] = json!(expected);
            request["delivery"]["source"] = json!("worker_final_receipt");
            request["delivery"]["adapter_source"] = fact["source"].clone();
            if request["state"] == "decided" {
                request["state"] = json!("sent");
            }
            request["revision"] = json!(request["revision"].as_i64().unwrap() + 1);
            records.push(request);
        }
        run["_cli_interactions"] = json!(records);
        Ok(())
    }
    pub(super) fn interaction_sent(
        &self,
        store: &mut Store,
        task: &mut Value,
        run: &mut Value,
        key: &str,
        host: bool,
    ) -> Result<(), String> {
        let mut request = store.cli_interaction(key)?;
        if request["task_id"] != task["id"]
            || request["task_epoch"] != task["epoch"]
            || request["delivery"]["write_state"] != "started"
        {
            return Ok(());
        }
        if request["state"] == "decided" {
            request["state"] = json!("sent");
        }
        if host != (request["source"] == "host_plan_confirmation") {
            return Err("交付事实来源与请求不匹配。".into());
        }
        request["delivery"]["write_state"] = json!(if host { "host_recorded" } else { "written" });
        request["delivery"]["source"] = json!(if host {
            "host_plan_consumer"
        } else {
            "native_adapter_write"
        });
        request["revision"] = json!(request["revision"].as_i64().unwrap() + 1);
        if !terminal(run) && run["intent"].is_null() {
            run["waiting"] = json!(["external_cli"]);
        }
        run["_cli_interaction"] = request;
        store.agent_commit(
            run,
            &mut [],
            std::slice::from_mut(task),
            None,
            "cli_response_written",
        )
    }
}
