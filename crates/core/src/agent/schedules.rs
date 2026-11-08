use super::*;
use crate::{reminders, work_items as work};
use troop_protocol::schedule::{Schedule, Slot};
use troop_storage::OperationFailure;

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    kind: String,
    event: String,
    name: String,
    enabled: bool,
    agent_id: i64,
    workspace_id: i64,
    project_id: Option<String>,
    work_item_id: Option<i64>,
    schedule: Schedule,
    start: Value,
    expected_plan_sha256: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    id: Option<String>,
    expected_revision: i64,
    rule: Definition,
}
#[derive(Deserialize)]
struct ExecutionScope {
    agent_id: i64,
    workspace_id: i64,
    project_id: Option<String>,
    work_item_id: Option<i64>,
}
fn require_rule(store: &Store, id: &str) -> Result<Value, String> {
    let rule = store.rule_get(id)?;
    if rule["kind"] != "scheduled" {
        return Err("该规则不是定时执行。".into());
    }
    Ok(rule)
}
fn next_state(store: &Store, rule: &Value, slot: &Slot, now: i64) -> Result<(), String> {
    let id = rule["id"].as_str().ok_or("定时规则身份无效。")?;
    let mut state = store.reminder_state(id)?.ok_or("调度游标不存在。")?;
    let schedule: Schedule =
        serde_json::from_value(rule["schedule"].clone()).map_err(|e| e.to_string())?;
    state["next_slot"] =
        serde_json::to_value(schedule.following(slot)?).map_err(|e| e.to_string())?;
    state["watermark_ms"] = json!(state["watermark_ms"].as_i64().unwrap_or(0).max(now));
    store.reminder_save_state(id, state)
}
fn rule_run(store: &Store, rule: &Value) -> Result<Option<Value>, String> {
    store
        .reminder_state(rule["id"].as_str().ok_or("规则身份无效。")?)?
        .and_then(|state| state["current_run_id"].as_i64())
        .map(|id| store.agent_run(id))
        .transpose()
}
fn overlap(store: &Store, rule: &Value) -> Result<(), String> {
    if let Some(run) = rule_run(store, rule)? {
        let id = run["id"].as_i64().ok_or("执行身份无效。")?;
        if !lifecycle::run_final(&run)
            || store
                .owned_tasks(id)?
                .iter()
                .any(|task| lifecycle::task_active(task) || lifecycle::task_unresolved(task))
            || store
                .agent_invocations(id)?
                .iter()
                .any(lifecycle::needs_review)
        {
            return Err("该规则的前次执行尚未结束，或等待审核／核对。".into());
        }
    }
    Ok(())
}
fn skip_due(store: &Store, rule: &Value, now: i64, reason: &str) -> Result<(), String> {
    let id = rule["id"].as_str().ok_or("规则身份无效。")?;
    for _ in 0..1024 {
        let state = store.reminder_state(id)?.ok_or("调度游标不存在。")?;
        let Some(raw) = state.get("next_slot").filter(|value| !value.is_null()) else {
            return Ok(());
        };
        let slot: Slot = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
        if slot.at_ms > now {
            return Ok(());
        }
        store.reminder_record_slot(rule, raw, "skipped", reason, now)?;
        next_state(store, rule, &slot, now)?;
    }
    Err("正在整理错过的触发，请稍后修改。".into())
}
impl Manager {
    fn scheduled_material(
        &self,
        store: &Store,
        rule: &Value,
        id: Option<&str>,
    ) -> Result<(Value, Value), String> {
        let definition = params::<Definition>(rule.clone())?;
        if definition.kind != "scheduled"
            || definition.event != "time.due"
            || !crate::groups::text_valid(&definition.name, 120, true)
            || !text_ok(definition.start["goal"].as_str().unwrap_or(""))
            || rule.to_string().len() > 16_000
        {
            return Err("定时执行名称、目标或配置无效。".into());
        }
        definition.schedule.validate()?;
        self.automatic_material(store, rule, id)
    }
    pub(super) fn automatic_material(
        &self,
        store: &Store,
        rule: &Value,
        id: Option<&str>,
    ) -> Result<(Value, Value), String> {
        let definition = params::<ExecutionScope>(rule.clone())?;
        store.memory_agent(definition.agent_id)?;
        store.workspace_path(definition.workspace_id)?;
        let projects = definition
            .project_id
            .as_ref()
            .map(|id| json!([id]))
            .unwrap_or(json!([]));
        if rule["start"]["agent_id"] != definition.agent_id
            || rule["start"]["workspace_id"] != definition.workspace_id
            || rule["start"]["project_ids"] != projects
        {
            return Err("定时执行的 Agent、项目和工作区必须与启动配置一致。".into());
        }
        if let Some(project) = definition.project_id {
            if !store
                .memory_projects(definition.agent_id)?
                .as_array()
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["slug"] == project && item["joined"] == true)
                })
            {
                return Err("负责 Agent 的项目成员资格已失效。".into());
            }
        }
        let grant = store.authorization_get(
            rule["start"]["authorization_id"]
                .as_str()
                .ok_or("定时执行需要明确的范围预授权。")?,
        )?;
        let mut start = rule["start"].clone();
        start["rule_id"] = if grant["rule_id"].is_null() {
            Value::Null
        } else {
            json!(id)
        };
        if start
            .get("continuation_of")
            .is_some_and(|value| !value.is_null())
            || start.get("action").is_some_and(|value| !value.is_null())
        {
            return Err("定时 Agent 需要独立的新执行配置。".into());
        }
        let mut permission_rule = rule.clone();
        permission_rule["id"] = json!(id);
        permission_rule["start"] = start.clone();
        self.rule_permission(store, &permission_rule)?;
        let mut plan = if start.get("engine_id").is_some() {
            self.preview_external(store, start.clone())?
        } else {
            let request = params::<Start>(start.clone())?;
            let provider = store.provider(request.provider_id.as_deref().ok_or("请选择模型。")?)?;
            let config: Config =
                serde_json::from_value(provider.config.clone()).map_err(|_| "模型配置无效。")?;
            config.endpoint()?;
            let basis = json!({"grant_id":grant["id"],"grant_revision":grant["revision"],"agent_id":definition.agent_id,"workspace_id":definition.workspace_id,"project_ids":projects,"operations":grant["operations"],"read_roots":grant["read_roots"],"write_roots":grant["write_roots"],"network":grant["network"],"provider_id":provider.id,"provider_config":provider.config,"provider_binding_sha256":tools::hash(json!({"config":provider.config,"secret_ref":provider.secret_ref}).to_string().as_bytes())});
            json!({"plan_sha256":tools::hash(basis.to_string().as_bytes()),"plan":basis})
        };
        plan["grant_id"] = grant["id"].clone();
        plan["grant_revision"] = grant["revision"].clone();
        if let Some(id) = definition.work_item_id {
            let item = store.work_item(id)?;
            if item["owner_agent_id"] != definition.agent_id
                || item["workspace_id"] != definition.workspace_id
                || item["project_id"] != rule["project_id"]
            {
                return Err("工作项与定时执行的负责人或范围不一致。".into());
            }
        }
        Ok((plan, start))
    }
    pub(crate) fn schedules_read(
        &self,
        store: &Store,
        method: &str,
        input: Value,
        now: i64,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Query {
            id: String,
            before: Option<i64>,
        }
        if method == "schedules.preview" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Preview {
                id: Option<String>,
                rule: Definition,
            }
            let request = params::<Preview>(input)?;
            let mut rule = serde_json::to_value(request.rule).map_err(|e| e.to_string())?;
            // An optional identity allows previewing a grant explicitly bound to this rule.
            rule["id"] = json!(request.id);
            let material =
                self.scheduled_material(store, &definition_only(&rule), rule["id"].as_str())?;
            let mut result = reminders::preview(json!({"schedule":rule["schedule"]}), now)?;
            result["plan"] = material.0["plan"].clone();
            result["plan_sha256"] = material.0["plan_sha256"].clone();
            return Ok(result);
        }
        let query = params::<Query>(input)?;
        let rule = require_rule(store, &query.id)?;
        if method == "schedules.get" {
            return self.scheduled_public(store, rule);
        }
        if method == "schedules.history" {
            return crate::groups::paginate(
                store.reminder_history(&query.id, query.before)?,
                |value| Self::scheduled_occurrence(store, value),
            );
        }
        Err("定时执行写操作需要操作账本。".into())
    }
    fn scheduled_public(&self, store: &Store, mut rule: Value) -> Result<Value, String> {
        let state = store
            .reminder_state(rule["id"].as_str().ok_or("规则身份无效。")?)?
            .ok_or("调度游标不存在。")?;
        let blocker = overlap(store, &rule)
            .err()
            .or_else(|| self.scheduled_current(store, &rule).err());
        let cancelled = rule["cancelled"] == true;
        rule["next_slot"] = state["next_slot"].clone();
        rule["current_run"] = json!(rule_run(store, &rule)?.map(|run| public_run(&run, true)));
        rule["phase"] = json!(if cancelled {
            "cancelled"
        } else if rule["enabled"] != true {
            "paused"
        } else if state["next_slot"].is_null() {
            "completed"
        } else {
            "active"
        });
        rule["current_blocker"] = json!(blocker);
        rule["allowed_actions"] = json!({"save":{"allowed":!cancelled,"reason":if cancelled{Some("定时规则已取消。")}else{None}},"cancel":{"allowed":!cancelled,"reason":if cancelled{Some("定时规则已取消。")}else{None}},"run":{"allowed":!cancelled&&blocker.is_none(),"reason":if cancelled{Some("定时规则已取消。".to_owned())}else{blocker}}});
        let toggle_reason = if cancelled {
            Some("定时规则已取消。".to_owned())
        } else if rule["enabled"] == true {
            None
        } else if state["next_slot"].is_null() {
            Some("该规则没有未来触发，请先修改时间。".to_owned())
        } else {
            self.scheduled_current(store, &rule).err()
        };
        rule["allowed_actions"]["set_enabled"] =
            json!({"allowed":toggle_reason.is_none(),"reason":toggle_reason});
        Ok(rule)
    }
    fn scheduled_current(&self, store: &Store, rule: &Value) -> Result<(Value, Value), String> {
        let (plan, mut start) =
            self.scheduled_material(store, &definition_only(rule), rule["id"].as_str())?;
        if plan["plan_sha256"] != rule["expected_plan_sha256"] {
            return Err("启动权限计划、模型或授权修订已变化，请重新预览并保存。".into());
        }
        if let Some(id) = rule["work_item_id"].as_i64() {
            let item = store.work_item(id)?;
            if rule["work_definition_revision"] != work::definition_revision(&item) {
                return Err("工作目标已变化，请重新核对定时规则。".into());
            }
            if let Some(reason) = work::start_blocker(store, &item) {
                return Err(reason);
            }
        }
        if start.get("engine_id").is_some() {
            start["expected_plan_sha256"] = plan["plan_sha256"].clone();
        }
        Ok((plan, start))
    }
    pub(super) fn save_schedule(
        &mut self,
        store: &mut Store,
        input: Value,
        now: i64,
    ) -> Result<Value, OperationFailure> {
        let request = params::<Save>(input)?;
        let id = request.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        Uuid::parse_str(&id).map_err(|_| "定时规则身份无效。".to_owned())?;
        let old = store.rule_get(&id).ok();
        if let Some(old) = &old {
            if old["kind"] != "scheduled" || old["cancelled"] == true {
                return Err("规则类型已变化或已取消。".to_owned().into());
            }
            crate::groups::check_revision(Some(old), request.expected_revision)?;
            skip_due(store, old, now, "旧修订尚未派发的槽位已跳过。")?;
        } else {
            crate::groups::check_revision(None, request.expected_revision)?;
        }
        let mut rule = serde_json::to_value(request.rule).map_err(|e| e.to_string())?;
        // Identity is passed separately to the strict definition parser.
        let plan = self.scheduled_material(store, &rule, Some(&id))?.0;
        if rule["start"].get("engine_id").is_some() {
            rule["start"] = Self::external_start_definition(rule["start"].clone())?;
            rule["start"]["expected_plan_sha256"] = plan["plan_sha256"].clone();
        }
        if rule["expected_plan_sha256"].is_null()
            || rule["expected_plan_sha256"] != plan["plan_sha256"]
        {
            return Err("请先预览并确认当前启动权限计划。".to_owned().into());
        }
        let mut state = store.reminder_state(&id)?.unwrap_or(json!({}));
        let anchor = state["watermark_ms"].as_i64().unwrap_or(now).max(now);
        let schedule: Schedule =
            serde_json::from_value(rule["schedule"].clone()).map_err(|e| e.to_string())?;
        let next = schedule.next(anchor)?;
        if rule["enabled"] == true && next.is_none() {
            return Err("该规则没有未来触发时间。".to_owned().into());
        }
        rule["cancelled"] = json!(false);
        rule["work_definition_revision"] = json!(rule["work_item_id"]
            .as_i64()
            .map(|id| store
                .work_item(id)
                .map(|item| work::definition_revision(&item)))
            .transpose()?);
        let saved = store.rule_save(
            &id,
            request.expected_revision,
            rule,
            json!({"kind":"desktop"}),
        )?;
        state["next_slot"] = json!(next);
        state["watermark_ms"] = json!(anchor);
        state["rule_revision"] = saved["revision"].clone();
        store.reminder_save_state(&id, state)?;
        self.scheduled_public(store, saved).map_err(Into::into)
    }
    fn scheduled_occurrence(store: &Store, mut value: Value) -> Result<Value, String> {
        value["run"] = json!(value["run_id"]
            .as_i64()
            .map(|id| store.agent_run(id).map(|run| public_run(&run, true)))
            .transpose()?);
        value["work_item"] = json!(value["work_item_id"]
            .as_i64()
            .map(|id| store.work_item(id).map(|item| work::public(store, item)))
            .transpose()?);
        Ok(value)
    }
    fn dispatch_scheduled(
        &mut self,
        store: &mut Store,
        rule: &Value,
        slot: &Slot,
        now: i64,
        manual: bool,
        reason: Option<&str>,
    ) -> Result<(Value, Option<Value>), OperationFailure> {
        let raw = json!(slot);
        if let Some(previous) = store.reminder_find_slot(
            rule["id"]
                .as_str()
                .ok_or_else(|| "规则身份无效。".to_owned())?,
            &slot.slot_key,
        )? {
            if !manual {
                next_state(store, rule, slot, now)?;
            }
            return Ok((previous, None));
        }
        let blocker = reason
            .map(str::to_owned)
            .or_else(|| overlap(store, rule).err());
        let material = if blocker.is_none() {
            self.scheduled_current(store, rule)
        } else {
            Err(blocker.clone().unwrap())
        };
        let blocked = material.as_ref().err().cloned();
        let state = if reason.is_some() {
            "skipped"
        } else if blocked.is_some() {
            "blocked"
        } else {
            "dispatched"
        };
        let slot_id = store
            .reminder_record_slot(
                rule,
                &raw,
                state,
                blocked.as_deref().unwrap_or("时间条件及预授权已接纳。"),
                now,
            )?
            .ok_or_else(|| "触发记录已存在。".to_owned())?;
        let mut occurrence = store.reminder_slot(slot_id)?;
        occurrence["manual"] = json!(manual);
        occurrence["run_id"] = Value::Null;
        occurrence["work_item_id"] = rule["work_item_id"].clone();
        occurrence["frozen_definition"] = json!({"schedule":rule["schedule"],"start":rule["start"],"work_definition_revision":rule["work_definition_revision"]});
        let mut activated = None;
        if let Ok((plan, mut start)) = material {
            start["client_run_id"] = json!(Uuid::new_v4().to_string());
            if let Some(id) = rule["work_item_id"].as_i64() {
                let item = store.work_item(id)?;
                start["goal"] = json!(format!(
                    "{}\n\n工作目标\n{}\n\n验收条件\n{}",
                    start["goal"].as_str().unwrap_or(""),
                    item["goal"].as_str().unwrap_or(""),
                    item["acceptance"].as_str().unwrap_or("")
                ));
            }
            let method = if start.get("engine_id").is_some() {
                "cli.start"
            } else {
                "agent.start"
            };
            let started = self.apply_record_command(store, method, start)?;
            let id = started["run"]["id"]
                .as_i64()
                .ok_or_else(|| "执行身份缺失。".to_owned())?;
            let mut run = store.agent_run(id)?;
            let permission = json!({"grant_id":plan["grant_id"],"grant_revision":plan["grant_revision"],"plan_sha256":plan["plan_sha256"]});
            run["trigger"] = json!({"kind":"scheduled","rule_id":rule["id"],"rule_revision":rule["revision"],"slot_id":slot_id,"slot_key":slot.slot_key,"timezone":slot.timezone,"manual":manual,"permission":permission});
            store.agent_save(&mut run, &mut [], "scheduled_execution_linked")?;
            if let Some(work_id) = rule["work_item_id"].as_i64() {
                self.link_started_work(store, &store.work_item(work_id)?, id)?;
            }
            let mut cursor = store
                .reminder_state(rule["id"].as_str().unwrap())?
                .ok_or_else(|| "调度游标不存在。".to_owned())?;
            cursor["current_run_id"] = json!(id);
            store.reminder_save_state(rule["id"].as_str().unwrap(), cursor)?;
            occurrence["run_id"] = json!(id);
            occurrence["permission"] = permission;
            activated = Some(started);
        }
        store.reminder_save_slot(&occurrence)?;
        if !manual {
            next_state(store, rule, slot, now)?;
        }
        Ok((occurrence, activated))
    }
    pub(super) fn schedule_command(
        &mut self,
        store: &mut Store,
        method: &str,
        input: Value,
        now: i64,
    ) -> Result<(Value, Option<Value>), OperationFailure> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Request {
            id: String,
            expected_revision: i64,
            client_trigger_id: Option<String>,
            source_slot_id: Option<i64>,
            enabled: Option<bool>,
        }
        let request = params::<Request>(input)?;
        let rule = require_rule(store, &request.id)?;
        crate::groups::check_revision(Some(&rule), request.expected_revision)?;
        if rule["cancelled"] == true {
            return Err("定时规则已取消。".to_owned().into());
        }
        if method == "schedules.set_enabled" {
            let enabled = request
                .enabled
                .ok_or_else(|| "请指定启停状态。".to_owned())?;
            if enabled {
                self.scheduled_current(store, &rule)?;
            }
            skip_due(store, &rule, now, "启停修订前未派发的槽位已跳过。")?;
            let cursor = store
                .reminder_state(&request.id)?
                .ok_or_else(|| "调度游标不存在。".to_owned())?;
            if enabled && cursor["next_slot"].is_null() {
                return Err("该规则没有未来触发，请先修改时间。".to_owned().into());
            }
            let mut value = rule.clone();
            value["enabled"] = json!(enabled);
            let saved = store.rule_save(
                &request.id,
                request.expected_revision,
                value,
                json!({"kind":"desktop"}),
            )?;
            return Ok((self.scheduled_public(store, saved)?, None));
        }
        if method == "schedules.cancel" {
            skip_due(store, &rule, now, "定时规则已取消，旧槽位跳过。")?;
            let mut value = rule.clone();
            value["cancelled"] = json!(true);
            value["enabled"] = json!(false);
            let saved = store.rule_save(
                &request.id,
                request.expected_revision,
                value,
                json!({"kind":"desktop"}),
            )?;
            return Ok((self.scheduled_public(store, saved)?, None));
        }
        let key = request
            .client_trigger_id
            .ok_or_else(|| "手动触发身份缺失。".to_owned())?;
        Uuid::parse_str(&key).map_err(|_| "手动触发身份无效。".to_owned())?;
        if let Some(id) = request.source_slot_id {
            if store.reminder_slot(id)?["rule_id"] != rule["id"] {
                return Err("原槽位不属于该规则。".to_owned().into());
            }
        }
        let slot = troop_protocol::schedule::manual_slot(
            rule["schedule"]["timezone"]
                .as_str()
                .ok_or_else(|| "时区无效。".to_owned())?,
            now,
            &key,
        )?;
        let (mut value, activation) =
            self.dispatch_scheduled(store, &rule, &slot, now, true, None)?;
        if value.get("source_slot_id").is_none() {
            value["source_slot_id"] = json!(request.source_slot_id);
            store.reminder_save_slot(&value)?;
        } else if value["source_slot_id"] != json!(request.source_slot_id) {
            return Err("手动触发身份已经用于另一来源。".to_owned().into());
        }
        Ok((Self::scheduled_occurrence(store, value)?, activation))
    }
    pub fn pump_schedules(
        &mut self,
        store: &mut Store,
        clock: &reminders::Clock,
    ) -> Result<(), String> {
        for rule in store.rules_all()?["items"]
            .as_array()
            .ok_or("规则列表无效。")?
        {
            if rule["kind"] != "scheduled" {
                continue;
            }
            for _ in 0..4 {
                let now = clock.now()?;
                let cutoff = clock.cutoff();
                let state = store
                    .reminder_state(rule["id"].as_str().ok_or("规则身份无效。")?)?
                    .ok_or("调度游标不存在。")?;
                let Some(raw) = state.get("next_slot").filter(|value| !value.is_null()) else {
                    break;
                };
                let slot: Slot = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
                if slot.at_ms > now {
                    break;
                }
                let reason = if rule["cancelled"] == true {
                    Some("定时规则已取消。")
                } else if rule["enabled"] != true {
                    Some("定时规则已暂停。")
                } else if slot.state == "dst_gap" {
                    Some("夏令时缺失时刻，已跳过。")
                } else if slot.at_ms <= cutoff || now - slot.at_ms > reminders::GRACE_MS {
                    Some("退出、休眠或调度延迟错过触发，已跳过。")
                } else {
                    None
                };
                let op = Uuid::new_v4().to_string();
                let (receipt, effect) = store.execute_operation(
                    "scheduler",
                    &op,
                    "schedules.trigger",
                    &json!({"rule_id":rule["id"],"slot_key":slot.slot_key}),
                    None,
                    |store| self.dispatch_scheduled(store, rule, &slot, now, false, reason),
                )?;
                if let Some(Some(started)) = effect {
                    self.activate_committed_command("agent.start", &started);
                }
                if receipt["state"] == "rejected" {
                    let message = receipt["error"]["message"]
                        .as_str()
                        .unwrap_or("派发未提交。");
                    let (failure,_)=store.execute_operation("scheduler",&Uuid::new_v4().to_string(),"schedules.blocked",&json!({"rule_id":rule["id"],"slot_key":slot.slot_key,"failed_operation":op}),None,|store|{
                        store.reminder_record_slot(rule,raw,"blocked",message,now)?;next_state(store,rule,&slot,now)?;Ok((json!({"recorded":true}),()))
                    })?;
                    if failure["state"] == "rejected" {
                        eprintln!(
                            "Scheduled execution deferred: {}",
                            failure["error"]["message"]
                        );
                        break;
                    }
                }
            }
        }
        Ok(())
    }
}
fn definition_only(rule: &Value) -> Value {
    let mut value = json!({});
    for key in [
        "kind",
        "event",
        "name",
        "enabled",
        "agent_id",
        "workspace_id",
        "project_id",
        "work_item_id",
        "schedule",
        "start",
        "expected_plan_sha256",
    ] {
        value[key] = rule[key].clone();
    }
    value
}
