use super::*;
use troop_storage::OperationFailure;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    id: Option<String>,
    expected_revision: i64,
    rule: Definition,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    name: String,
    enabled: bool,
    event: String,
    workspace_id: i64,
    source_run_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_work_item_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    work_item_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    work_definition_revision: Option<i64>,
    source_id: Option<String>,
    event_state: Option<String>,
    expires_at: i64,
    start: Value,
}
impl Manager {
    pub(super) fn rules_tool(
        &mut self,
        store: &mut Store,
        run: &mut Value,
        inv: &mut Value,
    ) -> Result<bool, String> {
        if inv["name"] != "manage_rule" {
            return Ok(false);
        }
        let input = inv["arguments"].clone();
        let operation = format!("invocation-{}-{}", inv["id"], inv["epoch"]);
        let (receipt, _) = store.execute_operation(
            "agent", &operation, "rules.save", &input, None, |store| {
                let grant_id = run["rule_management_authorization_id"].as_str()
                    .ok_or_else(|| "本次 Run 缺少规则管理授权。".to_string())?;
                let grant = store.authorization_get(grant_id)?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs() as i64;
                let definition = input["definition"].as_str()
                    .ok_or_else(|| "规则配置无效。".to_string())?;
                let parsed:Definition = serde_json::from_str(definition).map_err(|e|e.to_string())?;
                let rule=serde_json::to_value(parsed).map_err(|e|e.to_string())?;
                let id = input["id"].as_str().unwrap_or("");
                let mut action = "create_rule";
                if !id.is_empty() {
                    let mut old = store.rule_get(id)?;
                    if !projects_managed(store,&grant,&old["start"]["project_ids"])?
                        || old["workspace_id"] != run["workspace_id"]
                        || old["start"]["agent_id"] != run["agent_id"] {
                        return Err(OperationFailure::from("原规则超出管理授权。".to_string()));
                    }
                    for key in ["id", "revision", "after_event", "author", "updated_at", "created_at_ms", "effective_from_ms"] {
                        old.as_object_mut().unwrap().remove(key);
                    }
                    let definition=params::<Definition>(old)?;
                    let mut old=serde_json::to_value(definition).map_err(|e|e.to_string())?;
                    old["enabled"] = rule["enabled"].clone();
                    action = if old == rule { "toggle_rule" } else { "edit_rule" };
                }
                let current = grant["purpose"] == "rule_management" && grant["revoked"] != true
                    && grant["expires_at"].as_i64().unwrap_or(0) > now;
                let identity_matches = grant["agent_id"] == run["agent_id"]
                    && grant["workspace_id"] == run["workspace_id"] && grant["engine_id"] == "native";
                let scope_matches = rule["workspace_id"] == run["workspace_id"]
                    && rule["start"]["workspace_id"] == run["workspace_id"]
                    && rule["start"]["agent_id"] == run["agent_id"]
                    && rule["expires_at"].as_i64().unwrap_or(i64::MAX) <= grant["expires_at"].as_i64().unwrap_or(0)
                    && (grant["rule_id"].is_null() || grant["rule_id"] == id);
                let projects_match = projects_managed(store,&grant,&run["project_ids"])?
                    && projects_managed(store,&grant,&rule["start"]["project_ids"])?;
                let operation_allowed = grant["operations"].as_array().is_some_and(|v| v.contains(&json!(action)));
                if !current || !identity_matches || !scope_matches || !projects_match || !operation_allowed {
                    return Err(OperationFailure::from("规则变更超出管理授权。".to_string()));
                }
                let revision = input["expected_revision"].as_str().and_then(|s| s.parse::<i64>().ok())
                    .ok_or_else(|| "规则修订无效。".to_string())?;
                let saved = self.save_rule(store, json!({
                    "id": if id.is_empty() {Value::Null} else {json!(id)},
                    "expected_revision": revision, "rule": rule
                }),json!({"kind":"agent","agent_id":run["agent_id"],"grant_id":grant["id"],"grant_revision":grant["revision"]}))?;
                inv["state"] = json!("succeeded");
                inv["result"] = json!({"ok":true,"rule_id":saved["id"],"revision":saved["revision"],
                    "management_grant_id":grant["id"],"management_grant_revision":grant["revision"]});
                self.settle_tool(run, inv)?;
                store.agent_save(run, std::slice::from_mut(inv), "rule_managed")?;
                Ok((saved, ()))
            },
        )?;
        if receipt["state"] == "rejected" {
            *run = store.agent_run(run["id"].as_i64().unwrap())?;
            *inv = store.agent_invocation(inv["id"].as_i64().unwrap())?;
            inv["state"] = json!("failed");
            inv["result"] = json!({"ok":false,"error":receipt["error"]});
            self.settle_tool(run, inv)?;
            store.agent_save(run, std::slice::from_mut(inv), "rule_management_rejected")?;
        }
        Ok(true)
    }
    pub fn rules_rpc(
        &mut self,
        store: &mut Store,
        method: &str,
        input: Value,
    ) -> Result<Value, String> {
        match method {
            "rules.list" => store.rules_list(input["offset"].as_u64().unwrap_or(0) as usize),
            "rules.get" => store.rule_get(input["id"].as_str().ok_or("规则标识无效。")?),
            "rules.history" => store.rule_history(
                input["id"].as_str().ok_or("规则标识无效。")?,
                input["offset"].as_u64().unwrap_or(0) as usize,
            ),
            "rules.save" => self.save_rule(store, input, json!({"kind":"desktop"})),
            "rules.simulate" => {
                let rule = store.rule_get(input["id"].as_str().ok_or("规则标识无效。")?)?;
                let event = if let Some(id) = input["work_event_id"].as_i64() {
                    store.work_acceptance_event(id)?
                } else if let Some(id) = input["external_event_id"].as_i64() {
                    external_event(store.source_event(id)?)
                } else {
                    store.agent_run(input["run_id"].as_i64().ok_or("执行标识无效。")?)?
                };
                self.rule_simulation(store, &rule, &event)
            }
            _ => Err("规则写操作需要操作账本。".into()),
        }
    }
    fn save_rule(&self, store: &mut Store, input: Value, author: Value) -> Result<Value, String> {
        let mut a = params::<Save>(input)?;
        if a.id
            .as_deref()
            .and_then(|id| store.rule_get(id).ok())
            .is_some_and(|rule| matches!(rule["kind"].as_str(), Some("reminder" | "scheduled")))
        {
            return Err("提醒与事件规则的类型不能互相改写。".into());
        }
        if !text_ok(&a.rule.name)
            || a.rule.name.len() > 120
            || !matches!(
                a.rule.event.as_str(),
                "work.accepted"
                    | "run.completed"
                    | "run.failed"
                    | "github.workflow.completed"
                    | "github.issue.changed"
                    | "github.pull_request.changed"
                    | "gitlab.pipeline.changed"
                    | "gitlab.issue.changed"
                    | "gitlab.merge_request.changed"
                    | "webhook.changed"
            )
            || a.rule.expires_at <= 0
            || a.expected_revision < 0
        {
            return Err("规则名称、事件、有效期或修订无效。".into());
        }
        store.workspace_path(a.rule.workspace_id)?;
        let start = if a.rule.start.get("engine_id").is_some() {
            a.rule.start = Self::external_start_definition(a.rule.start.clone())?;
            a.rule.start.clone()
        } else {
            let start = params::<Start>(a.rule.start.clone())?;
            json!({"workspace_id":start.workspace_id,"authorization_id":start.authorization_id,"project_ids":start.project_ids})
        };
        if start["workspace_id"] != a.rule.workspace_id || !start["authorization_id"].is_string() {
            return Err("规则动作必须绑定同一工作区的明确授权。".into());
        }
        if a.rule
            .event_state
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 64)
        {
            return Err("规则事件状态无效。".into());
        }
        if a.rule.event == "work.accepted" {
            let source =
                store.work_item(a.rule.source_work_item_id.ok_or("请选择前置工作项。")?)?;
            if a.rule.source_id.is_some()
                || a.rule.source_run_id.is_some()
                || a.rule.work_item_id.is_none()
                || source["workspace_id"] != a.rule.workspace_id
                || source["project_id"]
                    .as_str()
                    .map(|id| json!([id]))
                    .unwrap_or(json!([]))
                    != start["project_ids"]
            {
                return Err("前置工作项的事件来源或范围不匹配。".into());
            }
        } else if a.rule.source_work_item_id.is_some() {
            return Err("该事件不支持前置工作项来源。".into());
        }
        if let Some(id) = a.rule.work_item_id {
            let item = store.work_item(id)?;
            if a.rule.source_work_item_id.is_some_and(|source| {
                !item["dependency_ids"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&json!(source)))
            }) {
                return Err("请先将来源工作项加入后续工作的依赖。".into());
            }
            if item["workspace_id"] != a.rule.workspace_id
                || item["owner_agent_id"] != a.rule.start["agent_id"]
                || item["project_id"]
                    .as_str()
                    .map(|id| json!([id]))
                    .unwrap_or(json!([]))
                    != start["project_ids"]
                || a.rule.start.get("action").is_some_and(|v| !v.is_null())
                || a.rule.source_work_item_id == Some(id)
            {
                return Err("后续工作项与启动目标或范围不匹配。".into());
            }
            if a.rule.start.get("engine_id").is_some()
                && !a.rule.start["expected_plan_sha256"].is_string()
            {
                return Err("工作项 CLI 规则需要确认权限计划。".into());
            }
            a.rule.work_definition_revision = Some(crate::work_items::definition_revision(&item));
        } else if a.rule.work_definition_revision.is_some() {
            return Err("请指定后续工作项。".into());
        }
        if a.rule.event.starts_with("run.") || a.rule.event == "work.accepted" {
            if a.rule.source_id.is_some() {
                return Err("内部事件不能绑定外部来源。".into());
            }
        } else {
            let source =
                store.event_source(a.rule.source_id.as_deref().ok_or("请选择外部事件来源。")?)?;
            let projects = source["project_ids"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if source["workspace_id"] != a.rule.workspace_id
                || source["consumer_id"] != store.instance_id()?
                || a.rule.source_run_id.is_some()
                || (projects.is_empty()
                    != start["project_ids"].as_array().is_none_or(Vec::is_empty))
                || start["project_ids"]
                    .as_array()
                    .ok_or("规则项目范围无效。")?
                    .iter()
                    .any(|p| !projects.contains(p))
                || !a
                    .rule
                    .event
                    .starts_with(&format!("{}.", source["kind"].as_str().unwrap_or("")))
            {
                return Err("规则来源或项目范围不匹配。".into());
            }
        }
        if serde_json::to_vec(&a.rule)
            .map_err(|e| e.to_string())?
            .len()
            > 4_000
        {
            return Err("规则过长。".into());
        }
        let id = a.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        Uuid::parse_str(&id).map_err(|_| "规则标识无效。")?;
        store.rule_save(
            &id,
            a.expected_revision,
            serde_json::to_value(a.rule).map_err(|e| e.to_string())?,
            author,
        )
    }
    fn rule_simulation(&self, store: &Store, rule: &Value, event: &Value) -> Result<Value, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs() as i64;
        let event_kind = if event["work_event_id"].is_number() {
            "work.accepted".to_owned()
        } else if event["external_event_id"].is_null() {
            format!("run.{}", event["state"].as_str().unwrap_or(""))
        } else {
            event["kind"].as_str().unwrap_or("").to_owned()
        };
        let mut matched = rule["enabled"] == true
            && rule["expires_at"].as_i64().unwrap_or(0) > now
            && rule["workspace_id"] == event["workspace_id"]
            && (rule["source_run_id"].is_null() || rule["source_run_id"] == event["id"])
            && rule["event"] == event_kind;
        matched =
            matched && (rule["event_state"].is_null() || rule["event_state"] == event["state"]);
        if event["work_event_id"].is_number() {
            let source =
                store.work_item(event["work_item_id"].as_i64().ok_or("工作事件身份无效。")?)?;
            matched = matched
                && (rule["source_work_item_id"] == source["id"]
                    || rule["work_item_id"]
                        .as_i64()
                        .map(|id| {
                            store.work_item(id).map(|item| {
                                item["dependency_ids"]
                                    .as_array()
                                    .is_some_and(|ids| ids.contains(&source["id"]))
                            })
                        })
                        .transpose()?
                        .unwrap_or(false))
                && source["workspace_id"] == rule["workspace_id"]
                && source["project_id"]
                    .as_str()
                    .map(|id| json!([id]))
                    .unwrap_or(json!([]))
                    == rule["start"]["project_ids"]
                && crate::work_items::completed(&source)
                && source["archived"] != true
                && source["accepted"] == event["acceptance"];
        }
        if !event["external_event_id"].is_null() {
            let source =
                store.event_source(event["source_id"].as_str().ok_or("事件来源无效。")?)?;
            let effective = rule["effective_from_ms"]
                .as_i64()
                .or_else(|| rule["created_at_ms"].as_i64())
                .unwrap_or(i64::MAX);
            let occurred = event["occurred_at_ms"]
                .as_i64()
                .map(|time| {
                    time.saturating_add(event["time_precision_ms"].as_i64().unwrap_or(1) - 1)
                })
                .unwrap_or(event["received_at_ms"].as_i64().unwrap_or(0));
            matched = matched
                && rule["source_id"] == source["id"]
                && source["enabled"] == true
                && event["review_state"] == "valid"
                && event["expires_at"].as_i64().unwrap_or(0) > crate::events::now()
                && event["received_at_ms"].as_i64().unwrap_or(0) >= effective
                && occurred >= effective;
        }
        let mut reason = if matched {
            "事件条件匹配。"
        } else {
            "规则暂停、过期或事件条件不匹配。"
        }
        .to_string();
        let mut permission = Value::Null;
        let mut executable = false;
        if matched {
            match self.rule_permission(store, rule) {
                Ok(plan) => {
                    executable = true;
                    permission = plan;
                }
                Err(error) => reason = error,
            }
            if let Some(limit) = store.automation_limit_reason(rule, event)? {
                executable = false;
                reason = limit;
            }
            if let Some(id) = rule["work_item_id"].as_i64() {
                let item = store.work_item(id)?;
                let blocker = if rule["work_definition_revision"]
                    != crate::work_items::definition_revision(&item)
                {
                    Some("后续工作定义已变化，请重新保存规则。".to_owned())
                } else if item["workspace_id"] != rule["workspace_id"]
                    || item["owner_agent_id"] != rule["start"]["agent_id"]
                    || item["project_id"]
                        .as_str()
                        .map(|id| json!([id]))
                        .unwrap_or(json!([]))
                        != rule["start"]["project_ids"]
                {
                    Some("后续工作范围已变化。".to_owned())
                } else if crate::work_items::current_run(store, &item)?.is_some_and(|run| {
                    matches!(run["state"].as_str(), Some("cancelled" | "failed"))
                        && run["work_definition_revision"]
                            == crate::work_items::definition_revision(&item)
                }) {
                    Some("前次工作执行已取消或失败，请通过工作启动入口明确重新交办。".to_owned())
                } else {
                    crate::work_items::start_blocker(store, &item)
                };
                if let Some(blocker) = blocker {
                    executable = false;
                    reason = blocker;
                }
            }
        }
        Ok(
            json!({"matched":matched,"executable":executable,"reason":reason,"permission":permission,"rule_revision":rule["revision"],"event_run_id":if event["external_event_id"].is_null(){event["id"].clone()}else{Value::Null},"external_event_id":event["external_event_id"]}),
        )
    }

    pub(super) fn rule_permission(&self, store: &Store, rule: &Value) -> Result<Value, String> {
        let grant = store.authorization_get(
            rule["start"]["authorization_id"]
                .as_str()
                .ok_or("规则缺少授权。")?,
        )?;
        let rule_id = if grant["rule_id"].is_null() {
            Value::Null
        } else {
            rule["id"].clone()
        };
        if rule["start"].get("engine_id").is_some() {
            let mut start = rule["start"].clone();
            start["rule_id"] = rule_id;
            let mut plan = self.external_rule_plan(store, start)?;
            plan["decision"] = json!("allow");
            return Ok(plan);
        }
        let start = params::<Start>(rule["start"].clone())?;
        let mut run = json!({"agent_id":start.agent_id,"workspace_id":start.workspace_id,"authorization_id":start.authorization_id,"project_ids":start.project_ids,"rule_id":rule_id,"kind":if start.action.is_some(){"tool_action"}else{"agent"}});
        let permission = if let Some(action) = start.action {
            let mut inv = json!({"name":action["name"],"arguments":action["arguments"]});
            self.authorize_invocation(store, &run, &mut inv)?;
            inv["permission_plan"].clone()
        } else {
            if let Some(error) = self.authorization_blocker(store, &run) {
                return Err(error);
            }
            json!({"grant_id":grant["id"],"grant_revision":grant["revision"],"decision":"allow","enforcement":"native tool dispatch gate"})
        };
        Self::freeze_hooks(store, &mut run)?;
        Self::freeze_mcp(store, &mut run)?;
        if let Some(error) = self.authorization_blocker(store, &run) {
            return Err(error);
        }
        Ok(permission)
    }
    pub fn pump_rules(&mut self, store: &mut Store) -> Result<(), String> {
        let rules = store.rules_all()?;
        for rule in rules["items"].as_array().unwrap() {
            if matches!(
                rule["kind"].as_str(),
                Some("reminder" | "scheduled" | "followup")
            ) {
                continue;
            }
            let candidates = if rule["event"] == "work.accepted" {
                store.work_rule_candidates(rule)?
            } else if rule["source_id"].is_string() {
                store
                    .source_rule_candidates(rule)?
                    .into_iter()
                    .map(external_event)
                    .collect()
            } else {
                store.rule_candidates(rule)?
            };
            for event in candidates {
                let preflight = self.rule_simulation(store, rule, &event)?;
                let waiting = rule["work_item_id"].is_number()
                    && preflight["matched"] == true
                    && preflight["executable"] != true
                    && preflight["reason"].as_str().is_some_and(|reason| {
                        reason.starts_with("达到工作区")
                            || reason.starts_with("等待前置")
                            || reason.starts_with("当前执行尚未")
                            || reason.starts_with("当前结果等待")
                    });
                if waiting
                    && store.rule_waiting_reason(rule, &event)?.as_deref()
                        == preflight["reason"].as_str()
                {
                    continue;
                }
                let op_id = Uuid::new_v4().to_string();
                let input = json!({"rule_id":rule["id"],"work_event_id":event["work_event_id"],"work_item_id":rule["work_item_id"],"event_run_id":if event["external_event_id"].is_null(){event["id"].clone()}else{Value::Null},"external_event_id":event["external_event_id"],"event_epoch":event["epoch"]});
                let (receipt, effect) = store.execute_operation(
                    "rules",
                    &op_id,
                    "rules.trigger",
                    &input,
                    None,
                    |store| {
                        let simulation = self.rule_simulation(store, rule, &event)?;
                        let mut result = simulation.clone();
                        result["work_item_id"]=rule["work_item_id"].clone();result["work_event_id"]=event["work_event_id"].clone();result["work_definition_revision"]=rule["work_definition_revision"].clone();
                    let permission = &simulation["permission"];
                    result["permission"] = json!({"grant_id":permission["grant_id"],"grant_revision":permission["grant_revision"],"decision":permission["decision"]});
                        result["state"] = json!(if waiting {"waiting"}else{"skipped"});
                        let mut run_result = Value::Null;
                        if simulation["executable"] == true {
                            let mut start = rule["start"].clone();
                            start["client_run_id"] = json!(op_id);
                            let grant=store.authorization_get(start["authorization_id"].as_str().ok_or_else(||"规则授权无效。".to_string())?)?;
                            start["rule_id"] = if grant["rule_id"].is_null() {Value::Null} else {rule["id"].clone()};
                            let method = if start.get("engine_id").is_some() { "cli.start" } else { "agent.start" };
                            if let Some(id)=rule["work_item_id"].as_i64(){let item=store.work_item(id)?;start["goal"]=json!(format!("{}\n\n工作目标\n{}\n\n验收条件\n{}",start["goal"].as_str().unwrap_or(""),item["goal"].as_str().unwrap_or(""),item["acceptance"].as_str().unwrap_or("")));}
                            run_result = self
                                .apply_record_command(store, method, start)
                                .map_err(OperationFailure::from)?;
                            let mut run =
                                store.agent_run(run_result["run"]["id"].as_i64().unwrap())?;
                            run["trigger"] = input.clone();
                            run["chain_id"] = event["chain_id"]
                                .as_str()
                                .map(|s| json!(s))
                                .unwrap_or_else(|| json!(format!("run-{}", event["id"])));
                            run["chain_depth"] =
                                json!(event["chain_depth"].as_u64().unwrap_or(0) + 1);
                            Self::save(store, &mut run, "rule_action_accepted")?;
                            if let Some(work_id)=rule["work_item_id"].as_i64(){self.link_started_work(store,&store.work_item(work_id)?,run["id"].as_i64().unwrap())?;}
                            result["run_id"] = run["id"].clone();
                            result["state"] = json!("dispatched");
                        }
                        store.rule_delivery(rule, &event, &result)?;
                        Ok((result, run_result))
                    },
                )?;
                if let Some(run) = effect {
                    if !run.is_null() {
                        self.activate_committed_command("agent.start", &run);
                    }
                }
                if receipt["state"] == "rejected" {
                    store.rule_delivery(rule,&event,&json!({"state":"needs_attention","reason":receipt["error"]["message"],"error":receipt["error"],"rule_revision":rule["revision"],"event_run_id":if event["external_event_id"].is_null(){event["id"].clone()}else{Value::Null},"external_event_id":event["external_event_id"]}))?;
                }
            }
        }
        Ok(())
    }
}

fn projects_managed(store: &Store, grant: &Value, projects: &Value) -> Result<bool, String> {
    let scope = grant["project_ids"]
        .as_array()
        .ok_or("管理授权项目范围无效。")?;
    let projects = projects.as_array().cloned().unwrap_or_default();
    if !scope.is_empty() && projects.is_empty() {
        return Ok(false);
    }
    let members = store.memory_projects(grant["agent_id"].as_i64().ok_or("授权执行者无效。")?)?;
    Ok(projects.iter().all(|project| {
        scope.contains(project)
            && members
                .as_array()
                .unwrap()
                .iter()
                .any(|member| member["slug"] == *project && member["joined"] == true)
    }))
}

fn external_event(mut event: Value) -> Value {
    event["external_event_id"] = event["id"].clone();
    event["id"] = json!(format!("external:{}", event["id"]));
    event["epoch"] = json!(1);
    event
}
