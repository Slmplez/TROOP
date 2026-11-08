use super::*;
use crate::{followups as follow, work_items as work};
use troop_storage::{OperationFailure, StopPlan};

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    name: String,
    enabled: bool,
    work_item_id: i64,
    agent_id: i64,
    workspace_id: i64,
    project_id: Option<String>,
    start: Value,
    expected_plan_sha256: Option<String>,
    expires_at_ms: i64,
    min_interval_ms: i64,
    max_runs: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    id: Option<String>,
    expected_revision: i64,
    policy: Definition,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    expected_revision: i64,
    client_request_id: String,
    at_ms: i64,
    reason: String,
    expected_change: String,
    source_run_id: Option<i64>,
}
fn current_work(store: &Store, policy: &Value) -> Result<Value, String> {
    let item = store.work_item(policy["work_item_id"].as_i64().ok_or("工作项无效。")?)?;
    if work::definition_revision(&item) != policy["work_definition_revision"].as_i64().unwrap_or(0)
        || item["generation"] != policy["work_generation"]
    {
        return Err("工作定义或取消代次已变化，请重新确认跟进策略。".into());
    }
    if item["cancelled"] == true || item["archived"] == true || work::completed(&item) {
        return Err("工作已取消、归档或接纳完成。".into());
    }
    Ok(item)
}
impl Manager {
    fn followup_material(
        &self,
        store: &Store,
        value: &Value,
        id: Option<&str>,
        now: i64,
    ) -> Result<(Value, Value), String> {
        let definition = params::<Definition>(value.clone())?;
        if !crate::groups::text_valid(&definition.name, 120, true)
            || !crate::groups::text_valid(
                definition.start["goal"].as_str().unwrap_or(""),
                1500,
                true,
            )
            || !(1..=16).contains(&definition.max_runs)
            || !(60_000..=86_400_000).contains(&definition.min_interval_ms)
            || definition.expires_at_ms <= now
            || definition.expires_at_ms > now.saturating_add(30 * 86_400_000)
            || value.to_string().len() > 12_000
        {
            return Err("跟进名称、次数、间隔或期限无效。".into());
        }
        let grant = store.authorization_get(
            definition.start["authorization_id"]
                .as_str()
                .ok_or("跟进需要明确范围预授权。")?,
        )?;
        if definition.expires_at_ms
            > grant["expires_at"]
                .as_i64()
                .unwrap_or(0)
                .saturating_mul(1000)
        {
            return Err("跟进期限超出授权有效期。".into());
        }
        self.automatic_material(store, value, id)
    }
    pub(crate) fn followups_read(
        &self,
        store: &Store,
        method: &str,
        input: Value,
        now: i64,
    ) -> Result<Value, String> {
        if method == "followups.preview" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Preview {
                id: Option<String>,
                policy: Definition,
            }
            let request = params::<Preview>(input)?;
            let value = serde_json::to_value(request.policy).map_err(|error| error.to_string())?;
            return self
                .followup_material(store, &value, request.id.as_deref(), now)
                .map(|(plan, _)| plan);
        }
        if method == "followups.list" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Query {
                before: Option<String>,
            }
            let request = params::<Query>(input)?;
            let mut values = store.rules_all()?["items"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            values.retain(|value| {
                value["kind"] == "followup"
                    && request.before.as_ref().is_none_or(|before| {
                        value["id"].as_str().is_some_and(|id| id < before.as_str())
                    })
            });
            values.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
            let mut items = Vec::new();
            for value in values.iter().take(8) {
                let value = self.followup_public(store, value.clone(), now)?;
                if json!(&items).to_string().len() + value.to_string().len() > 40_000 {
                    break;
                }
                items.push(value);
            }
            let next = if items.len() < values.len() {
                items.last().map(|value| value["id"].clone())
            } else {
                None
            };
            return Ok(json!({"items":items,"next_before":next}));
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Query {
            id: String,
            before: Option<i64>,
        }
        let request = params::<Query>(input)?;
        let policy = follow::policy(store, &request.id)?;
        if method == "followups.get" {
            return self.followup_public(store, policy, now);
        }
        if method == "followups.history" {
            let rows = store.followup_history(&request.id, request.before)?;
            let mut items = Vec::new();
            for mut value in rows.iter().take(8).cloned() {
                value["run"] = json!(value["run_id"]
                    .as_i64()
                    .map(|id| store.agent_run(id).map(|run| public_run(&run, true)))
                    .transpose()?);
                if json!(&items).to_string().len() + value.to_string().len() > 40_000 {
                    break;
                }
                items.push(value);
            }
            let next = if items.len() < rows.len() {
                items.last().map(|value| value["id"].clone())
            } else {
                None
            };
            return Ok(json!({"items":items,"next_before":next}));
        }
        Err("跟进写入需要操作账本。".into())
    }
    fn followup_public(&self, store: &Store, mut policy: Value, now: i64) -> Result<Value, String> {
        let id = policy["id"].as_str().ok_or("策略身份无效。")?.to_owned();
        let state = store.followup_state(&id)?.ok_or("跟进状态缺失。")?;
        let chain = store.followup_chain(&id)?;
        let blocker = self.followup_ready(store, &policy, now).err();
        policy["state"] = state;
        policy["chain"] = chain;
        policy["appointments"] = json!(store.followup_pending(&id)?);
        policy["current_blocker"] = json!(blocker);
        let mutable = policy["cancelled"] != true;
        policy["allowed_actions"] = json!({"save":{"allowed":mutable,"reason":if mutable{None}else{Some("跟进已取消。")}},"set_enabled":{"allowed":mutable,"reason":if mutable{None}else{Some("跟进已取消。")}},"request":{"allowed":blocker.is_none(),"reason":blocker},"cancel":{"allowed":mutable,"reason":if mutable{None}else{Some("跟进已取消。")}},"stop_chain":{"allowed":policy["chain"]["stopped"]!=true,"reason":null}});
        Ok(policy)
    }
    fn save_followup(
        &self,
        store: &mut Store,
        input: Value,
        now: i64,
    ) -> Result<Value, OperationFailure> {
        let request = params::<Save>(input)?;
        let id = request.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        Uuid::parse_str(&id).map_err(|_| "策略身份无效。".to_owned())?;
        let previous = store.rule_get(&id).ok();
        crate::groups::check_revision(previous.as_ref(), request.expected_revision)?;
        if previous
            .as_ref()
            .is_some_and(|old| old["kind"] != "followup" || old["cancelled"] == true)
        {
            return Err("策略类型变化或已取消。".to_owned().into());
        }
        let mut policy = serde_json::to_value(request.policy).map_err(|error| error.to_string())?;
        for old in store.rules_all()?["items"].as_array().into_iter().flatten() {
            if old["kind"] == "followup"
                && old["id"] != id
                && old["work_item_id"] == policy["work_item_id"]
                && old["cancelled"] != true
            {
                return Err("同一工作项已有跟进策略。".to_owned().into());
            }
        }
        if previous
            .as_ref()
            .is_some_and(|old| old["work_item_id"] != policy["work_item_id"])
        {
            return Err("策略所属工作项固定。".to_owned().into());
        }
        let (plan, _) = self.followup_material(store, &policy, Some(&id), now)?;
        if policy["expected_plan_sha256"] != plan["plan_sha256"] {
            return Err("请先预览并确认当前跟进权限计划。".to_owned().into());
        }
        if policy["start"].get("engine_id").is_some() {
            policy["start"] = Self::external_start_definition(policy["start"].clone())?;
            policy["start"]["expected_plan_sha256"] = plan["plan_sha256"].clone();
        }
        let item = store.work_item(policy["work_item_id"].as_i64().unwrap())?;
        policy["work_definition_revision"] = json!(work::definition_revision(&item));
        policy["work_generation"] = item["generation"].clone();
        current_work(store, &policy)?;
        policy["kind"] = json!("followup");
        policy["cancelled"] = json!(false);
        let mut state = store.followup_state(&id)?.unwrap_or(
            json!({"generation":0,"wake_count":0,"last_started_at_ms":null,"current_run_id":null}),
        );
        state["generation"] = json!(state["generation"].as_i64().unwrap_or(0) + 1);
        self.invalidate_followup_appointments(store, &id, "策略修订已变化。")?;
        let saved = store.rule_save(
            &id,
            request.expected_revision,
            policy,
            json!({"kind":"desktop"}),
        )?;
        store.save_followup_state(&id, &state)?;
        if previous.is_none() {
            store.save_followup_chain(json!({"id":id,"root_policy_id":id,"generation":0,"stopped":false,"wake_count":0,"wake_limit":saved["max_runs"],"expires_at_ms":saved["expires_at_ms"],"upstream_group_run_id":null}))?;
        }
        self.followup_public(store, saved, now).map_err(Into::into)
    }
    fn invalidate_followup_appointments(
        &self,
        store: &Store,
        id: &str,
        reason: &str,
    ) -> Result<(), String> {
        for mut appointment in store.followup_pending(id)? {
            appointment["state"] = json!("cancelled");
            appointment["reason"] = json!(reason);
            store.save_followup_appointment(appointment)?;
        }
        Ok(())
    }
    fn followup_ready(
        &self,
        store: &Store,
        policy: &Value,
        now: i64,
    ) -> Result<(Value, Value), String> {
        if policy["enabled"] != true || policy["cancelled"] == true {
            return Err("跟进策略已暂停或取消。".into());
        }
        current_work(store, policy)?;
        let id = policy["id"].as_str().ok_or("策略身份无效。")?;
        let state = store.followup_state(id)?.ok_or("跟进状态缺失。")?;
        if state["wake_count"].as_i64().unwrap_or(0) >= policy["max_runs"].as_i64().unwrap_or(0) {
            return Err("达到工作项跟进启动次数上限。".into());
        }
        let material = self.followup_material(store, &follow::definition(policy), Some(id), now)?;
        if material.0["plan_sha256"] != policy["expected_plan_sha256"] {
            return Err("启动配置或授权已变化，请重新确认跟进策略。".into());
        }
        Ok(material)
    }
    fn request_followup(
        &self,
        store: &mut Store,
        request: Request,
        now: i64,
        manual: bool,
    ) -> Result<Value, String> {
        Uuid::parse_str(&request.client_request_id).map_err(|_| "预约请求身份无效。")?;
        let fingerprint = json!({"at_ms":request.at_ms,"reason":request.reason,"expected_change":request.expected_change,"source_run_id":request.source_run_id,"manual":manual});
        if let Some(old) = store.followup_duplicate(&request.id, &request.client_request_id)? {
            if old["request"] != fingerprint {
                return Err("预约请求身份已用于其他参数。".into());
            }
            return Ok(old);
        }
        let policy = follow::policy(store, &request.id)?;
        crate::groups::check_revision(Some(&policy), request.expected_revision)
            .map_err(|error| error.message)?;
        self.followup_ready(store, &policy, now)?;
        if !crate::groups::text_valid(&request.reason, 600, true)
            || !crate::groups::text_valid(&request.expected_change, 600, true)
            || request.at_ms
                < now.saturating_add(if manual {
                    0
                } else {
                    policy["min_interval_ms"].as_i64().unwrap_or(60_000)
                })
            || request.at_ms >= policy["expires_at_ms"].as_i64().unwrap_or(0)
        {
            return Err("预约时间、理由或预期变化超出当前策略。".into());
        }
        if store.followup_pending(&request.id)?.len() >= 8 {
            return Err("同一工作项最多保留八个待处理预约。".into());
        }
        let state = store.followup_state(&request.id)?.ok_or("跟进状态缺失。")?;
        let mut chain_id = request.id.clone();
        if let Some(id) = request.source_run_id {
            let mut source = store.agent_run(id)?;
            let item = current_work(store, &policy)?;
            if source["work_item_id"] != item["id"]
                || source["work_definition_revision"] != policy["work_definition_revision"]
                || source["agent_id"] != policy["agent_id"]
                || source["intent"].is_string()
                || lifecycle::run_terminal(&source)
                || source["root_run_id"].is_number()
                || (source["followup_policy_generation"].is_number()
                    && source["followup_policy_generation"] != state["generation"])
            {
                return Err("来源执行或跟进代次已失效。".into());
            }
            let origin_grant = store.authorization_get(
                source["authorization_id"]
                    .as_str()
                    .ok_or("来源缺少授权。")?,
            )?;
            let target_grant =
                store.authorization_get(policy["start"]["authorization_id"].as_str().unwrap())?;
            if crate::group_runtime::scope(&origin_grant)
                != crate::group_runtime::scope(&target_grant)
                || origin_grant["engine_id"] != target_grant["engine_id"]
            {
                return Err("预约不能扩大来源执行的能力范围。".into());
            }
            if let Some(reason) = self.authorization_blocker(store, &source) {
                return Err(reason);
            }
            chain_id = source["followup_chain_id"]
                .as_str()
                .unwrap_or(&request.id)
                .to_owned();
            let mut chain = store.followup_chain(&chain_id)?;
            if source["group_chain_id"].is_string() && chain["upstream_group_run_id"].is_null() {
                chain["upstream_group_run_id"] = json!(id);
                let upstream = store.group_chain(source["group_chain_id"].as_str().unwrap())?;
                chain["expires_at_ms"] = json!(chain["expires_at_ms"]
                    .as_i64()
                    .unwrap_or(0)
                    .min(upstream["expires_at"].as_i64().unwrap_or(0) * 1000));
                chain = store.save_followup_chain(chain)?;
            }
            source["followup_chain_id"] = json!(chain_id);
            source["followup_chain_generation"] = chain["generation"].clone();
            source["followup_policy_id"] = json!(request.id);
            source["followup_policy_generation"] = state["generation"].clone();
            source["followup_work_generation"] = item["generation"].clone();
            store.agent_save(&mut source, &mut [], "followup_proposed")?;
        }
        let chain = store.followup_chain(&chain_id)?;
        if chain["stopped"] == true || request.at_ms >= chain["expires_at_ms"].as_i64().unwrap_or(0)
        {
            return Err("预约超出协作链期限或链已停止。".into());
        }
        store.save_followup_appointment(json!({"policy_id":request.id,"policy_revision":policy["revision"],"policy_generation":state["generation"],"chain_id":chain_id,"chain_generation":chain["generation"],"client_key":request.client_request_id,"request":fingerprint,"source_run_id":request.source_run_id,"at_ms":request.at_ms,"reason":request.reason,"expected_change":request.expected_change,"manual":manual,"state":"pending","run_id":null,"created_at_ms":now}))
    }
    pub(super) fn followup_command(
        &mut self,
        store: &mut Store,
        method: &str,
        input: Value,
        now: i64,
    ) -> Result<(Value, Option<StopPlan>), OperationFailure> {
        if method == "followups.save" {
            return self
                .save_followup(store, input, now)
                .map(|value| (value, None));
        }
        if matches!(method, "followups.request" | "followups.run") {
            let request = params::<Request>(input)?;
            return self
                .request_followup(store, request, now, method == "followups.run")
                .map(|value| (value, None))
                .map_err(Into::into);
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Change {
            id: String,
            expected_revision: i64,
            enabled: Option<bool>,
        }
        let request = params::<Change>(input)?;
        let mut policy = follow::policy(store, &request.id)?;
        crate::groups::check_revision(Some(&policy), request.expected_revision)?;
        if policy["cancelled"] == true {
            return Err("跟进策略已取消。".to_owned().into());
        }
        if method == "followups.set_enabled" {
            let enabled = request
                .enabled
                .ok_or_else(|| "请指定启停状态。".to_owned())?;
            if enabled {
                self.followup_material(
                    store,
                    &follow::definition(&policy),
                    Some(&request.id),
                    now,
                )?;
                current_work(store, &policy)?;
            }
            policy["enabled"] = json!(enabled);
        } else if method == "followups.cancel" {
            policy["cancelled"] = json!(true);
            policy["enabled"] = json!(false);
        } else {
            return Err("未知跟进命令。".to_owned().into());
        }
        self.invalidate_followup_appointments(
            store,
            &request.id,
            "跟进启停或取消已使旧预约失效。",
        )?;
        let mut state = store
            .followup_state(&request.id)?
            .ok_or_else(|| "跟进状态缺失。".to_owned())?;
        state["generation"] = json!(state["generation"].as_i64().unwrap_or(0) + 1);
        store.save_followup_state(&request.id, &state)?;
        let saved = store.rule_save(
            &request.id,
            request.expected_revision,
            policy,
            json!({"kind":"desktop"}),
        )?;
        self.followup_public(store, saved, now)
            .map(|value| (value, None))
            .map_err(Into::into)
    }
    fn followup_dispatch(
        &mut self,
        store: &mut Store,
        mut appointment: Value,
        now: i64,
    ) -> Result<(Value, Option<Value>), OperationFailure> {
        if !matches!(appointment["state"].as_str(), Some("pending" | "waiting")) {
            return Ok((appointment, None));
        }
        let policy = follow::policy(
            store,
            appointment["policy_id"]
                .as_str()
                .ok_or_else(|| "策略身份缺失。".to_owned())?,
        )?;
        let id = policy["id"].as_str().unwrap();
        let mut state = store
            .followup_state(id)?
            .ok_or_else(|| "跟进状态缺失。".to_owned())?;
        let mut chain = store.followup_chain(
            appointment["chain_id"]
                .as_str()
                .ok_or_else(|| "链身份缺失。".to_owned())?,
        )?;
        let material = self.followup_ready(store, &policy, now);
        let invalid = if state["generation"] != appointment["policy_generation"]
            || chain["generation"] != appointment["chain_generation"]
            || chain["stopped"] == true
        {
            Some("预约代次已失效或协作链已停止。".to_owned())
        } else if now >= chain["expires_at_ms"].as_i64().unwrap_or(0)
            || chain["wake_count"].as_i64().unwrap_or(0)
                >= chain["wake_limit"].as_i64().unwrap_or(0)
        {
            Some("协作链期限或启动次数已达到上限。".to_owned())
        } else if appointment["state"] == "pending"
            && appointment["manual"] != true
            && now
                > appointment["at_ms"]
                    .as_i64()
                    .unwrap_or(0)
                    .saturating_add(5000)
        {
            Some("预约时间已错过，保留记录并等待明确补跑。".to_owned())
        } else {
            material.as_ref().err().cloned()
        };
        if let Some(reason) = invalid {
            appointment["state"] = json!("blocked");
            appointment["status_reason"] = json!(reason);
            return store
                .save_followup_appointment(appointment)
                .map(|value| (value, None))
                .map_err(Into::into);
        }
        let item = current_work(store, &policy)?;
        let wait = work::followup_start_blocker(store, &item).or_else(|| {
            (state["last_started_at_ms"]
                .as_i64()
                .unwrap_or(i64::MIN / 2)
                .saturating_add(policy["min_interval_ms"].as_i64().unwrap_or(60_000))
                > now)
                .then(|| "等待跟进最小启动间隔。".to_owned())
        });
        if let Some(reason) = wait {
            if appointment["state"] != "waiting" || appointment["status_reason"] != reason {
                appointment["state"] = json!("waiting");
                appointment["status_reason"] = json!(reason);
                appointment = store.save_followup_appointment(appointment)?;
            }
            return Ok((appointment, None));
        }
        let (plan, mut start) = material.map_err(OperationFailure::from)?;
        let excerpt = |value: &Value, limit: usize| {
            value
                .as_str()
                .unwrap_or("")
                .chars()
                .take(limit)
                .collect::<String>()
        };
        let source = appointment["source_run_id"]
            .as_i64()
            .map(|id| store.agent_run(id))
            .transpose()?;
        let context = json!({"work_item_id":item["id"],"definition_revision":work::definition_revision(&item),"goal_excerpt":excerpt(&item["goal"],200),"acceptance_excerpt":excerpt(&item["acceptance"],200),"appointment_id":appointment["id"],"reason":appointment["reason"],"expected_change":appointment["expected_change"],"source":source.as_ref().map(|run|json!({"run_id":run["id"],"revision":run["revision"],"output_excerpt":excerpt(&run["output"],400),"output_truncated":run["output"].as_str().is_some_and(|text|text.chars().count()>400)}))});
        start["goal"] = json!(format!(
            "{}\n\n本次预约复查的有界资料\n{}",
            start["goal"].as_str().unwrap_or(""),
            context
        ));
        start["client_run_id"] = json!(Uuid::new_v4().to_string());
        if start.get("engine_id").is_some() {
            start["expected_plan_sha256"] = plan["plan_sha256"].clone();
        }
        let method = if start.get("engine_id").is_some() {
            "cli.start"
        } else {
            "agent.start"
        };
        let started = self.apply_record_command(store, method, start)?;
        let run_id = started["run"]["id"]
            .as_i64()
            .ok_or_else(|| "执行身份缺失。".to_owned())?;
        self.link_started_work(store, &item, run_id)?;
        let mut run = store.agent_run(run_id)?;
        run["followup_chain_id"] = chain["id"].clone();
        run["followup_chain_generation"] = chain["generation"].clone();
        run["followup_policy_id"] = policy["id"].clone();
        run["followup_policy_generation"] = state["generation"].clone();
        run["followup_work_generation"] = item["generation"].clone();
        run["chain_id"] = chain["id"].clone();
        run["trigger"] = json!({"kind":"followup.due","policy_id":policy["id"],"policy_revision":policy["revision"],"appointment_id":appointment["id"],"source_run_id":appointment["source_run_id"],"permission":plan});
        store.agent_save(&mut run, &mut [], "followup_admitted")?;
        chain["wake_count"] = json!(chain["wake_count"].as_i64().unwrap_or(0) + 1);
        store.save_followup_chain(chain)?;
        state["wake_count"] = json!(state["wake_count"].as_i64().unwrap_or(0) + 1);
        state["last_started_at_ms"] = json!(now);
        state["current_run_id"] = json!(run_id);
        store.save_followup_state(id, &state)?;
        appointment["state"] = json!("dispatched");
        appointment["status_reason"] = Value::Null;
        appointment["run_id"] = json!(run_id);
        appointment["dispatched_at_ms"] = json!(now);
        appointment["frozen_definition"] = json!({"policy_revision":policy["revision"],"work_definition_revision":policy["work_definition_revision"],"plan_sha256":plan["plan_sha256"],"context":context});
        let appointment = store.save_followup_appointment(appointment)?;
        Ok((appointment, Some(started)))
    }
    pub fn pump_followups(
        &mut self,
        store: &mut Store,
        clock: &crate::reminders::Clock,
    ) -> Result<(), String> {
        for policy in store.rules_all()?["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|value| value["kind"] == "followup")
        {
            for appointment in
                store.followup_pending(policy["id"].as_str().ok_or("策略身份无效。")?)?
            {
                let now = clock.now()?;
                if appointment["at_ms"].as_i64().unwrap_or(i64::MAX) > now {
                    continue;
                }
                let operation = Uuid::new_v4().to_string();
                let (receipt, effect) = store.execute_operation(
                    "followups",
                    &operation,
                    "followups.due",
                    &json!({"appointment_id":appointment["id"]}),
                    None,
                    |store| self.followup_dispatch(store, appointment.clone(), now),
                )?;
                if let Some(Some(started)) = effect {
                    self.activate_committed_command("agent.start", &started);
                }
                if receipt["state"] == "rejected" {
                    store.execute_operation(
                        "followups",
                        &Uuid::new_v4().to_string(),
                        "followups.blocked",
                        &json!({"appointment_id":appointment["id"]}),
                        None,
                        |store| {
                            let mut value =
                                store.followup_appointment(appointment["id"].as_i64().unwrap())?;
                            value["state"] = json!("blocked");
                            value["status_reason"] = receipt["error"]["message"].clone();
                            Ok((store.save_followup_appointment(value)?, ()))
                        },
                    )?;
                }
            }
        }
        Ok(())
    }
    pub(super) fn followup_tool(
        &mut self,
        store: &mut Store,
        run: &mut Value,
        inv: &mut Value,
    ) -> Result<bool, String> {
        if inv["name"] != "propose_followup" {
            return Ok(false);
        }
        let policy = store.rules_all()?["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|value| {
                value["kind"] == "followup"
                    && value["work_item_id"] == run["work_item_id"]
                    && value["cancelled"] != true
            })
            .cloned();
        let input = inv["arguments"].clone();
        let (receipt, _) = store.execute_operation(
            "agent",
            &format!("followup-{}-{}", inv["id"], inv["epoch"]),
            "followups.propose",
            &input,
            None,
            |store| {
                let policy = policy
                    .as_ref()
                    .ok_or_else(|| "本次工作没有跟进策略。".to_owned())?;
                let request = Request {
                    id: policy["id"].as_str().unwrap().to_owned(),
                    expected_revision: policy["revision"].as_i64().unwrap(),
                    client_request_id: Uuid::new_v4().to_string(),
                    at_ms: input["at_ms"]
                        .as_str()
                        .and_then(|value| value.parse().ok())
                        .ok_or_else(|| "预约时间需要毫秒时间戳。".to_owned())?,
                    reason: input["reason"].as_str().unwrap_or("").to_owned(),
                    expected_change: input["expected_change"].as_str().unwrap_or("").to_owned(),
                    source_run_id: run["id"].as_i64(),
                };
                let appointment = self.request_followup(store, request, follow::now_ms(), false)?;
                *run = store.agent_run(run["id"].as_i64().unwrap())?;
                inv["state"] = json!("succeeded");
                inv["result"] = json!({"ok":true,"appointment":appointment});
                self.settle_tool(run, inv)?;
                store.agent_save(run, std::slice::from_mut(inv), "followup_proposal_settled")?;
                Ok((appointment, ()))
            },
        )?;
        if receipt["state"] == "rejected" {
            *run = store.agent_run(run["id"].as_i64().unwrap())?;
            *inv = store.agent_invocation(inv["id"].as_i64().unwrap())?;
            inv["state"] = json!("failed");
            inv["result"] = json!({"ok":false,"error":receipt["error"]});
            self.settle_tool(run, inv)?;
            store.agent_save(run, std::slice::from_mut(inv), "followup_proposal_rejected")?;
        }
        Ok(true)
    }
}
