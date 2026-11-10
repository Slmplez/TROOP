use super::*;
use troop_protocol::{OperationRequest, OPERATION_COMMANDS};
use troop_storage::{OperationFailure, StopPlan};

enum AfterCommit {
    Activate,
    WorkStart(i64),
    MaintenanceSettings(i64),
    Stop(StopPlan),
    None,
}

impl Manager {
    pub(super) fn apply_record_command(
        &mut self,
        store: &mut Store,
        method: &str,
        p: Value,
    ) -> Result<Value, String> {
        match method {
            "cli.start" => self.start_external(store, p),
            "cli.review" => self.review_external(store, p),
            "agent.start" => {
                let a = params::<Start>(p.clone())?;
                if Uuid::parse_str(&a.client_run_id).is_err() || !text_ok(&a.goal) {
                    return Err("任务输入或幂等标识无效。".into());
                }
                if let Some(mut doc) = store.agent_duplicate(&a.client_run_id, &p)? {
                    doc["duplicate"] = json!(true);
                    return Ok(json!({"run":public_run(&doc,false),"duplicate":true}));
                }
                if self.live.len() >= 16 {
                    return Err("最多保留 16 个活动任务，请先停止或完成已有任务。".into());
                }
                let workspace = store.workspace_path(a.workspace_id)?;
                store.memory_agent(a.agent_id)?;
                let (config, secret_ref) = if a.action.is_some() {
                    if a.authorization_id.is_none() {
                        return Err("直接工具动作需要明确授权。".into());
                    }
                    (Value::Null, Value::Null)
                } else {
                    let provider =
                        store.provider(a.provider_id.as_deref().ok_or("请选择模型。")?)?;
                    let config: Config = serde_json::from_value(provider.config.clone())
                        .map_err(|_| "模型配置损坏。")?;
                    config.endpoint()?;
                    (provider.config, json!(provider.secret_ref))
                };
                let mut doc = json!({"state":"queued","epoch":1,"revision":0,"step":0,"intent":null,"workspace_id":a.workspace_id,"workspace":workspace,"provider_id":a.provider_id,"config":config,"secret_ref":secret_ref,"goal":a.goal,"history":[{"role":"user","content":a.goal}],"pending":[],"output":"","model_text":"","supplements":[],"waiting":[],"error":null});
                doc["kind"] = json!(if a.action.is_some() {
                    "tool_action"
                } else {
                    "agent"
                });
                doc["agent_id"] = json!(a.agent_id);
                doc["authorization_id"] = json!(a.authorization_id);
                doc["project_ids"] = json!(a.project_ids);
                doc["rule_id"] = json!(a.rule_id);
                doc["rule_management_authorization_id"] = json!(a.rule_management_authorization_id);
                if let Some(reason) = self.authorization_blocker(store, &doc) {
                    return Err(reason);
                }
                Self::freeze_mcp(store, &mut doc)?;
                Self::freeze_hooks(store, &mut doc)?;
                if a.authorization_id.is_some() {
                    doc["authorization_revision"] = store
                        .authorization_get(a.authorization_id.as_deref().unwrap())?["revision"]
                        .clone();
                    if let Some(reason) = self.authorization_blocker(store, &doc) {
                        return Err(reason);
                    }
                }
                self.prepare_skills(store, &mut doc)?;
                let expanded =
                    Self::expand_workflows(store, &mut doc, &a.goal, a.workflow_id.as_deref())?;
                doc["history"] = json!([{"role":"user","content":expanded}]);
                store.agent_create(&a.client_run_id, &p, &mut doc)?;
                if let Some(action) = a.action {
                    let mut inv = json!({"run_id":doc["id"],"call_id":a.client_run_id,"epoch":1,"name":action["name"],"arguments":action["arguments"],"state":"prepared","approval":null,"result":null,"reviewed":false,"stopped":true});
                    self.authorize_invocation(store, &doc, &mut inv)?;
                    store.agent_save(
                        &mut doc,
                        std::slice::from_mut(&mut inv),
                        "action_prepared",
                    )?;
                    doc["pending"] = json!([inv["id"]]);
                    Self::save(store, &mut doc, "action_queued")?;
                }
                Ok(json!({"run":public_run(&doc,false),"duplicate":false}))
            }
            "agent.approve" => {
                let a = params::<Approval>(p)?;
                let mut inv = store.agent_invocation(a.id)?;
                let mut doc = store.agent_run(inv["run_id"].as_i64().unwrap())?;
                if inv["epoch"] != a.epoch {
                    return Err("审批版本已过期。".into());
                }
                if let Some(previous) = inv["approval"].as_bool() {
                    if previous != a.approved {
                        return Err("审批已作出不同决定。".into());
                    }
                    return Ok(json!({"accepted":true,"duplicate":true}));
                }
                if let Some(reason) = self
                    .authorization_blocker(store, &doc)
                    .or_else(|| self.approval_blocker(&doc, &inv))
                {
                    return Err(reason);
                }
                inv["approval"] = json!(a.approved);
                store.agent_save(&mut doc, std::slice::from_mut(&mut inv), "approval_decided")?;
                Ok(json!({"accepted":true,"duplicate":false}))
            }
            "agent.steer" => {
                let a = params::<Steer>(p)?;
                if !text_ok(&a.text) || Uuid::parse_str(&a.client_input_id).is_err() {
                    return Err("补充指令无效。".into());
                }
                let mut doc = store.agent_run(a.id)?;
                let mut inputs = doc["supplements"].as_array().cloned().unwrap_or_default();
                if let Some(previous) = inputs.iter().find(|v| v["id"] == a.client_input_id) {
                    if previous["text"] != a.text {
                        return Err("补充指令标识冲突。".into());
                    }
                    return Ok(json!({"accepted":true,"duplicate":true}));
                }
                if matches!(doc["kind"].as_str(), Some("tool_action" | "external_cli")) {
                    return Err("直接工具动作与外部 CLI 执行不接收补充指令。".into());
                }
                if terminal(&doc) || !doc["intent"].is_null() {
                    return Err("任务已停止或中断，不能接收补充指令。".into());
                }
                if inputs.len() >= 8 {
                    return Err("本次任务补充指令已达到 8 条上限。".into());
                }
                Self::expand_workflows(store, &mut doc.clone(), &a.text, None)?;
                inputs.push(json!({"id":a.client_input_id,"text":a.text,"applied":false}));
                doc["supplements"] = json!(inputs);
                Self::save(store, &mut doc, "input_received")?;
                Ok(json!({"accepted":true}))
            }
            "agent.reconcile" => {
                let a = params::<Reconcile>(p)?;
                let evidence = self.reconciliation_evidence(&a, false)?;
                store.reconcile_invocation(a.id, a.epoch, evidence)?;
                Ok(json!({"accepted":true}))
            }
            "agent.resume" => {
                if store.agent_run(params::<Id>(p.clone())?.id)?["kind"] == "external_cli" {
                    return Err(
                        "外部执行保留原记录；先核对旧效果，再通过 cli.start 明确创建新作业。"
                            .into(),
                    );
                }
                if self.live.len() >= 16 {
                    return Err("活动任务已达到 16 个上限，请先停止或完成已有任务。".into());
                }
                let id = params::<Id>(p)?.id;
                if let Some(reason) = self.authorization_blocker(store, &store.agent_run(id)?) {
                    return Err(reason);
                }
                let doc = store.resume_run(id, |doc, results| {
                    for inv in results {
                        if doc["kind"] != "tool_action" {
                            self.providers.model.append_result(doc, inv)?;
                        }
                    }
                    Ok(())
                })?;
                Ok(public_run(&doc, false))
            }
            _ => Err("Unsupported record command".into()),
        }
    }
    pub(super) fn activate_committed_command(&mut self, method: &str, value: &Value) {
        let id = if method == "agent.resume" {
            value["id"].as_i64()
        } else if matches!(method, "agent.start" | "cli.start") && value["duplicate"] != true {
            value["run"]["id"].as_i64()
        } else {
            None
        };
        if let Some(id) = id {
            self.live.insert(id, Live::default());
        }
    }
    pub fn execute_operation(
        &mut self,
        store: &mut Store,
        request: OperationRequest,
        reminder_now_ms: i64,
    ) -> Result<Value, String> {
        if !OPERATION_COMMANDS.contains(&request.method.as_str()) {
            return Err("Command has no transactional operation adapter".into());
        }
        if Uuid::parse_str(&request.operation_id).is_err()
            || request.instance_id != store.instance_id()?
        {
            return Err("Invalid operation identity or storage instance".into());
        }
        if (request.method.starts_with("work_items.")
            || request.method.starts_with("groups.")
            || request.method.starts_with("topics.")
            || request.method.starts_with("followups."))
            && request.expected_revision.is_some()
        {
            return Err("资源修订请通过命令参数指定。".into());
        }
        let method = request.method.as_str();
        let input = request.input;
        let mut canonical = input.clone();
        if method == "agent.start" && canonical.is_object() {
            let obj = canonical.as_object_mut().unwrap();
            obj.entry("agent_id").or_insert(json!(1));
            obj.entry("workflow_id").or_insert(Value::Null);
        }
        let (receipt, effect) = store.execute_operation(
            "desktop",
            &request.operation_id,
            method,
            &canonical,
            request.expected_revision,
            |store| {
                if method == "automations.confirm" {
                    return self
                        .confirm_automation(store, input.clone(), reminder_now_ms)
                        .map(|value| (value, AfterCommit::None));
                }
                if method.starts_with("followups.") {
                    let (value, stop) =
                        self.followup_command(store, method, input.clone(), reminder_now_ms)?;
                    return Ok((
                        value,
                        stop.map(AfterCommit::Stop).unwrap_or(AfterCommit::None),
                    ));
                }
                if method == "rules.save" && input["rule"]["kind"] == "scheduled" {
                    return self
                        .save_schedule(store, input.clone(), reminder_now_ms)
                        .map(|value| (value, AfterCommit::None));
                }
                if method.starts_with("schedules.") {
                    let (value, activation) =
                        self.schedule_command(store, method, input.clone(), reminder_now_ms)?;
                    return Ok((
                        value,
                        activation
                            .map(|started| {
                                AfterCommit::WorkStart(started["run"]["id"].as_i64().unwrap())
                            })
                            .unwrap_or(AfterCommit::None),
                    ));
                }
                if method.starts_with("reminders.")
                    || method.starts_with("notifications.")
                    || (method == "rules.save" && input["rule"]["kind"] == "reminder")
                {
                    return crate::reminders::write(store, method, input.clone(), reminder_now_ms)
                        .map(|value| (value, AfterCommit::None));
                }
                if method.starts_with("topics.") {
                    return crate::topics::write(store, method, input.clone())
                        .map(|value| (value, AfterCommit::None));
                }
                if method.starts_with("groups.") {
                    let (value, stop) =
                        self.group_execution_command(store, method, input.clone())?;
                    return Ok((
                        value,
                        stop.map(AfterCommit::Stop).unwrap_or(AfterCommit::None),
                    ));
                }
                if method.starts_with("work_items.") {
                    if matches!(
                        method,
                        "work_items.start" | "work_items.accept" | "work_items.cancel"
                    ) {
                        let (value, run, stop) =
                            self.execute_work_item(store, method, input.clone())?;
                        return Ok((
                            value,
                            if let Some(plan) = stop {
                                AfterCommit::Stop(plan)
                            } else if let Some(id) = run {
                                AfterCommit::WorkStart(id)
                            } else {
                                AfterCommit::None
                            },
                        ));
                    }
                    return crate::work_items::write(store, method, input.clone())
                        .map(|value| (value, AfterCommit::None));
                }
                if let Some(expected) = request.expected_revision {
                    let id = input["id"].as_i64().ok_or_else(|| {
                        OperationFailure::from(
                            "Expected revision requires an existing resource".to_string(),
                        )
                    })?;
                    let owner = if matches!(method, "agent.approve" | "agent.reconcile") {
                        store.agent_invocation(id)?["run_id"].as_i64().unwrap()
                    } else if matches!(
                        method,
                        "agent.stop-task" | "agent.reconcile-task" | "cli.review"
                    ) {
                        store.owned_task(id)?["owner_run_id"].as_i64().unwrap()
                    } else {
                        id
                    };
                    if store.agent_run(owner)?["revision"] != expected {
                        return Err(OperationFailure {
                            current_revision: store.agent_run(owner)?["revision"].as_i64(),
                            kind: "revision_conflict",
                            message: "Run revision changed; refresh before issuing a new operation"
                                .into(),
                        });
                    }
                }
                if matches!(method, "authorizations.save" | "authorizations.revoke") {
                    if let Some(id) = input["id"].as_str().filter(|id| {
                        input["expected_revision"] != 0 || store.authorization_get(id).is_ok()
                    }) {
                        let current = store.authorization_get(id)?;
                        if input["expected_revision"] != current["revision"] {
                            return Err(OperationFailure {
                                kind: "revision_conflict",
                                message: format!(
                                    "授权已变化，当前修订为 {}，请刷新后重试。",
                                    current["revision"]
                                ),
                                current_revision: current["revision"].as_i64(),
                            });
                        }
                    }
                }
                let result: Result<(Value, AfterCommit), String> = (|| match method {
                    "cli.respond" => {
                        let value = self.respond_interaction(
                            store,
                            input.clone(),
                            &request.operation_id,
                            "user",
                        )?;
                        if value["scope_change_requested"] == true && value["duplicate"] != true {
                            let (_, plan) = store.stop_owned_task(
                                value["task_id"].as_i64().unwrap(),
                                &self.jobs.keys().copied().collect::<Vec<_>>(),
                            )?;
                            Ok((value, AfterCommit::Stop(plan)))
                        } else {
                            Ok((value, AfterCommit::None))
                        }
                    }
                    "rules.save" => Ok((
                        self.rules_rpc(store, method, input.clone())?,
                        AfterCommit::None,
                    )),
                    "events.recheck" => {
                        #[derive(Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct RecheckSource {
                            source_id: String,
                            expected_revision: i64,
                        }
                        let args = params::<RecheckSource>(input.clone())?;
                        let source = store.event_source(&args.source_id)?;
                        if source["revision"] != args.expected_revision {
                            return Err("来源配置已变化，请刷新后重新核对。".into());
                        }
                        store.source_event_recheck(&args.source_id)?;
                        Ok((json!({"accepted":true}), AfterCommit::None))
                    }
                    "authorizations.save" | "authorizations.revoke" => Ok((
                        crate::authorizations::write(store, method, input.clone())?,
                        AfterCommit::None,
                    )),
                    "memory.maintenance.save" => {
                        let saved = self.save_maintenance_settings(store, input.clone())?;
                        let agent = saved["agent_id"].as_i64().unwrap();
                        Ok((saved, AfterCommit::MaintenanceSettings(agent)))
                    }
                    "memory.membership" | "memory.write" | "memory.edit" | "memory.restore"
                    | "memory.resolve" => Ok((
                        self.memory_rpc(store, method, input.clone())?,
                        AfterCommit::None,
                    )),
                    "skills.import" | "skills.enable" | "skills.remove" | "skills.edit"
                    | "skills.refresh" => Ok((
                        self.skills_rpc(store, method, input.clone())?,
                        AfterCommit::None,
                    )),
                    "hooks.reconcile" => Ok((
                        self.hooks_rpc(store, method, input.clone())?,
                        AfterCommit::None,
                    )),
                    "agent.mcp-reconcile" => Ok((
                        self.mcp_dispatch(store, method, input.clone())?,
                        AfterCommit::None,
                    )),
                    "workspace.add" => Ok((
                        json!(store.add(&params::<crate::Add>(input.clone())?.path)?),
                        AfterCommit::None,
                    )),
                    "workspace.rename" => {
                        let a = params::<crate::Rename>(input.clone())?;
                        Ok((json!(store.rename(a.id, &a.name)?), AfterCommit::None))
                    }
                    "workspace.remove" => {
                        let id = params::<Id>(input.clone())?.id;
                        if self.owns_workspace(store, id) {
                            return Err("请先停止使用此工作区的任务。".into());
                        }
                        Ok((json!(store.remove(id)?), AfterCommit::None))
                    }
                    "agent.cancel" => {
                        let id = params::<Id>(input.clone())?.id;
                        self.flush_subtree_output(store, id)?;
                        let plan = store.stop_tree(
                            id,
                            Some("cancel"),
                            &self.jobs.keys().copied().collect::<Vec<_>>(),
                        )?;
                        let run = store.request_run_stop(id, true)?;
                        Ok((public_run(&run, false), AfterCommit::Stop(plan)))
                    }
                    "agent.stop-task" => {
                        let id = params::<Id>(input.clone())?.id;
                        let task = store.owned_task(id)?;
                        if let Some(child) = task["child_run_id"].as_i64() {
                            self.flush_subtree_output(store, child)?;
                        }
                        let (task, plan) = store
                            .stop_owned_task(id, &self.jobs.keys().copied().collect::<Vec<_>>())?;
                        Ok((troop_storage::public_task(&task), AfterCommit::Stop(plan)))
                    }
                    "agent.reconcile-task" => Ok((
                        self.task_rpc(store, method, input.clone())?,
                        AfterCommit::None,
                    )),
                    "agent.compact" => Ok((
                        self.memory_rpc(store, method, input.clone())?,
                        AfterCommit::None,
                    )),
                    _ => Ok((
                        self.apply_record_command(store, method, input.clone())?,
                        AfterCommit::Activate,
                    )),
                })();
                result.map_err(OperationFailure::from)
            },
        )?;
        if let Some(effect) = effect {
            match effect {
                AfterCommit::Activate => {
                    self.activate_committed_command(method, &receipt["result"])
                }
                AfterCommit::WorkStart(id) => {
                    self.live.insert(id, Live::default());
                }
                AfterCommit::Stop(plan) => self.cancel_stop_plan(store, plan)?,
                AfterCommit::MaintenanceSettings(agent) => {
                    self.maintenance_settings_committed(store, agent)?
                }
                AfterCommit::None => {}
            }
        }
        Ok(receipt)
    }
}
