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
    #[serde(default)]
    handoff_policy_ids: Vec<String>,
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Handoff {
    source_run_id: i64,
    route_id: String,
    client_request_id: String,
    reason: String,
    expected_change: String,
}
fn current_work(store: &Store, policy: &Value) -> Result<Value, String> {
    let item = store.work_item(policy["work_item_id"].as_i64().ok_or("工作项无效。")?)?;
    if work::definition_revision(&item) != policy["work_definition_revision"].as_i64().unwrap_or(0)
        || item["generation"].as_i64().unwrap_or(0)
            != policy["work_generation"].as_i64().unwrap_or(0)
    {
        return Err("工作定义或取消代次已变化，请重新确认跟进策略。".into());
    }
    if item["cancelled"] == true || item["archived"] == true || work::completed(&item) {
        return Err("工作已取消、归档或接纳完成。".into());
    }
    Ok(item)
}
impl Manager {
    fn pump_reviewed_followups(&self, store: &mut Store, now: i64) -> Result<(), String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Proposal {
            at_ms: i64,
            reason: String,
            expected_change: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Transfer {
            route_id: String,
            reason: String,
            expected_change: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Envelope {
            troop_followup: Option<Proposal>,
            troop_handoff: Option<Transfer>,
        }
        for candidate in store.followup_review_candidates()? {
            let id = candidate["id"].as_i64().ok_or("审核来源身份无效。")?;
            let key = format!(
                "cli-followup-{id}-{}",
                candidate["followup_bridge"]["evidence_sha256"]
                    .as_str()
                    .unwrap_or("")
            );
            let (receipt, _) = store.execute_operation(
                "followups",
                &key,
                "followups.reviewed_result",
                &candidate["followup_bridge"],
                None,
                |store| {
                    let run = store.agent_run(id)?;
                    let task = follow::reviewed_cli_result(store, &run)?;
                    if task["evidence"]["sha256"] != run["followup_bridge"]["evidence_sha256"]
                        || task["id"] != run["followup_bridge"]["task_id"]
                    {
                        return Err("审核证据关联已变化。".to_owned().into());
                    }
                    Self::external_authorized(store, &run)?;
                    let envelope = params::<Envelope>(
                        serde_json::from_str(
                            task["evidence"]["result"]["text"].as_str().unwrap_or(""),
                        )
                        .map_err(|_| "结构化提议无效。".to_owned())?,
                    )?;
                    let appointment = match (envelope.troop_followup, envelope.troop_handoff) {
                        (Some(proposal), None) => {
                            let policy = store.rules_all()?["items"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .find(|policy| {
                                    policy["kind"] == "followup"
                                        && policy["work_item_id"] == run["work_item_id"]
                                        && policy["cancelled"] != true
                                })
                                .cloned()
                                .ok_or_else(|| "工作没有有效跟进策略。".to_owned())?;
                            self.request_followup(
                                store,
                                Request {
                                    id: policy["id"].as_str().unwrap().to_owned(),
                                    expected_revision: policy["revision"].as_i64().unwrap(),
                                    client_request_id: Uuid::new_v4().to_string(),
                                    at_ms: proposal.at_ms,
                                    reason: proposal.reason,
                                    expected_change: proposal.expected_change,
                                    source_run_id: Some(id),
                                },
                                now,
                                false,
                            )?
                        }
                        (None, Some(transfer)) => self.handoff_appointment(
                            store,
                            &Handoff {
                                source_run_id: id,
                                route_id: transfer.route_id,
                                client_request_id: Uuid::new_v4().to_string(),
                                reason: transfer.reason,
                                expected_change: transfer.expected_change,
                            },
                            now,
                        )?,
                        _ => {
                            return Err("每份固定结果只能提出一次预约或一次交接。"
                                .to_owned()
                                .into())
                        }
                    };
                    let mut run = store.agent_run(id)?;
                    run["followup_bridge"]["state"] = json!("applied");
                    run["followup_bridge"]["appointment_id"] = appointment["id"].clone();
                    store.agent_save(&mut run, &mut [], "cli_followup_applied")?;
                    Ok((appointment, ()))
                },
            )?;
            if receipt["state"] == "rejected" {
                store.execute_operation(
                    "followups",
                    &format!("{key}-blocked"),
                    "followups.reviewed_blocked",
                    &receipt["error"],
                    None,
                    |store| {
                        let mut run = store.agent_run(id)?;
                        run["followup_bridge"]["state"] = json!("blocked");
                        run["followup_bridge"]["error"] = receipt["error"].clone();
                        store.agent_save(&mut run, &mut [], "cli_followup_blocked")?;
                        Ok((json!({"blocked":true}), ()))
                    },
                )?;
            }
        }
        Ok(())
    }
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
        if definition.handoff_policy_ids.len() > 8
            || definition
                .handoff_policy_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != definition.handoff_policy_ids.len()
        {
            return Err("最多配置八条不同的交接路由。".into());
        }
        for target in &definition.handoff_policy_ids {
            Uuid::parse_str(target).map_err(|_| "交接策略身份无效。")?;
            if Some(target.as_str()) == id {
                return Err("交接路由不能指向当前策略。".into());
            }
            let target = follow::policy(store, target)?;
            if target["cancelled"] == true
                || target["workspace_id"] != definition.workspace_id
                || target["project_id"] != value["project_id"]
            {
                return Err("交接目标已取消或不在相同项目与工作区。".into());
            }
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
        if method == "followups.chain" {
            return store.followup_chain(&request.id);
        }
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
        let chain = store.followup_chain(state["current_chain_id"].as_str().unwrap_or(&id))?;
        let blocker = self.followup_ready(store, &policy, now).err().or_else(|| {
            if chain["stopped"] == true
                || chain["expires_at_ms"].as_i64().unwrap_or(0) <= now
                || chain["wake_count"].as_i64().unwrap_or(0)
                    >= chain["wake_limit"].as_i64().unwrap_or(0)
            {
                Some("协作链已停止或达到期限／次数上限。".to_owned())
            } else {
                None
            }
        });
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
        policy["work_generation"] = json!(item["generation"].as_i64().unwrap_or(0));
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
        } else {
            let mut chain = store.followup_chain(&id)?;
            chain["wake_limit"] = saved["max_runs"].clone();
            let expiry = if let Some(origin) = chain["upstream_group_run_id"].as_i64() {
                let run = store.agent_run(origin)?;
                let upstream = store.group_chain(
                    run["group_chain_id"]
                        .as_str()
                        .ok_or_else(|| "上游协作链缺失。".to_owned())?,
                )?;
                saved["expires_at_ms"]
                    .as_i64()
                    .unwrap_or(0)
                    .min(upstream["expires_at"].as_i64().unwrap_or(0) * 1000)
            } else {
                saved["expires_at_ms"].as_i64().unwrap_or(0)
            };
            chain["expires_at_ms"] = json!(expiry);
            store.save_followup_chain(chain)?;
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
            || (!manual
                && request.at_ms
                    < now.saturating_add(policy["min_interval_ms"].as_i64().unwrap_or(60_000)))
            || request.at_ms >= policy["expires_at_ms"].as_i64().unwrap_or(0)
        {
            return Err("预约时间、理由或预期变化超出当前策略。".into());
        }
        if store.followup_pending(&request.id)?.len() >= 8 {
            return Err("同一工作项最多保留八个待处理预约。".into());
        }
        let state = store.followup_state(&request.id)?.ok_or("跟进状态缺失。")?;
        let mut chain_id = state["current_chain_id"]
            .as_str()
            .unwrap_or(&request.id)
            .to_owned();
        if let Some(id) = request.source_run_id {
            let (_, chain) = self.bind_followup_origin(store, &policy, id)?;
            chain_id = chain["id"].as_str().ok_or("链身份无效。")?.to_owned();
        }
        let chain = store.followup_chain(&chain_id)?;
        if chain["stopped"] == true
            || request.at_ms >= chain["expires_at_ms"].as_i64().unwrap_or(0)
            || chain["wake_count"].as_i64().unwrap_or(0)
                >= chain["wake_limit"].as_i64().unwrap_or(0)
        {
            return Err("预约超出协作链期限或链已停止。".into());
        }
        store.save_followup_appointment(json!({"policy_id":request.id,"policy_revision":policy["revision"],"policy_generation":state["generation"],"chain_id":chain_id,"chain_generation":chain["generation"],"client_key":request.client_request_id,"request":fingerprint,"source_run_id":request.source_run_id,"at_ms":request.at_ms,"reason":request.reason,"expected_change":request.expected_change,"manual":manual,"state":"pending","run_id":null,"created_at_ms":now}))
    }

    fn bind_followup_origin(
        &self,
        store: &mut Store,
        policy: &Value,
        id: i64,
    ) -> Result<(Value, Value), String> {
        let policy_id = policy["id"].as_str().ok_or("策略身份无效。")?;
        let state = store.followup_state(policy_id)?.ok_or("跟进状态缺失。")?;

        let mut source = store.agent_run(id)?;
        let item = current_work(store, policy)?;
        if source["work_item_id"] != item["id"]
            || item["current_run_id"] != source["id"]
            || source["work_definition_revision"] != policy["work_definition_revision"]
            || source["agent_id"] != policy["agent_id"]
            || source["intent"].is_string()
            || (lifecycle::run_terminal(&source)
                && follow::reviewed_cli_result(store, &source).is_err())
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
        if source["kind"] == "external_cli" {
            let task = follow::reviewed_cli_result(store, &source)?;
            if task["permission_plan"]["tool_mode"] != policy["start"]["tool_mode"]
                || task["permission_plan"]["approval_mode"] != policy["start"]["approval_mode"]
            {
                return Err("CLI 跟进不能改变来源工具或审批模式。".into());
            }
        }
        if crate::group_runtime::scope(&origin_grant) != crate::group_runtime::scope(&target_grant)
            || origin_grant["engine_id"] != target_grant["engine_id"]
        {
            return Err("预约不能扩大来源执行的能力范围。".into());
        }
        if let Some(reason) = self.authorization_blocker(store, &source) {
            return Err(reason);
        }
        let chain_id = source["followup_chain_id"]
            .as_str()
            .unwrap_or(policy_id)
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
        source["followup_policy_id"] = json!(policy_id);
        source["followup_policy_generation"] = state["generation"].clone();
        source["followup_work_generation"] = json!(item["generation"].as_i64().unwrap_or(0));

        source["followup_expires_at_ms"] = json!(chain["expires_at_ms"]
            .as_i64()
            .unwrap_or(0)
            .min(policy["expires_at_ms"].as_i64().unwrap_or(0)));
        if source["group_chain_id"].is_string() {
            source["followup_group_chain_id"] = source["group_chain_id"].clone();
        }
        store.agent_save(&mut source, &mut [], "followup_source_bound")?;
        Ok((source, chain))
    }
    fn handoff_appointment(
        &self,
        store: &mut Store,
        request: &Handoff,
        now: i64,
    ) -> Result<Value, String> {
        let source_id = request.source_run_id;
        let target_id = request.route_id.as_str();
        let key = request.client_request_id.as_str();
        let reason = request.reason.as_str();
        let expected = request.expected_change.as_str();
        Uuid::parse_str(key).map_err(|_| "交接身份无效。")?;
        let fingerprint = json!({"kind":"handoff","source_run_id":source_id,"route_id":target_id,"reason":reason,"expected_change":expected});
        if let Some(previous) = store.followup_duplicate(target_id, key)? {
            if previous["request"] != fingerprint {
                return Err("交接身份已用于其他参数。".into());
            }
            return Ok(previous);
        }
        let source = store.agent_run(source_id)?;
        let origin = store.rules_all()?["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|value| {
                value["kind"] == "followup"
                    && value["work_item_id"] == source["work_item_id"]
                    && value["cancelled"] != true
            })
            .cloned()
            .ok_or("来源工作缺少跟进策略。")?;
        self.followup_ready(store, &origin, now)?;
        if !origin["handoff_policy_ids"]
            .as_array()
            .is_some_and(|routes| routes.contains(&json!(target_id)))
        {
            return Err("该交接路由尚未配置。".into());
        }
        let target = follow::policy(store, target_id)?;
        self.followup_ready(store, &target, now)?;
        if origin["workspace_id"] != target["workspace_id"]
            || origin["project_id"] != target["project_id"]
        {
            return Err("交接不能跨越已确认的项目或工作区。".into());
        }
        let origin_grant = store.authorization_get(
            source["authorization_id"]
                .as_str()
                .ok_or("来源缺少授权。")?,
        )?;
        let target_grant = store.authorization_get(
            target["start"]["authorization_id"]
                .as_str()
                .ok_or("接收方缺少授权。")?,
        )?;
        if (!origin_grant["operations"]
            .as_array()
            .is_some_and(|operations| operations.contains(&json!("request_handoff")))
            && follow::reviewed_cli_result(store, &source).is_err())
            || crate::group_runtime::scope(&origin_grant)
                != crate::group_runtime::scope(&target_grant)
            || origin_grant["engine_id"] != target_grant["engine_id"]
        {
            return Err("交接超出来源授权能力上限。".into());
        }
        let item = current_work(store, &target)?;
        if source["kind"] == "external_cli" {
            let task = follow::reviewed_cli_result(store, &source)?;
            if task["permission_plan"]["tool_mode"] != target["start"]["tool_mode"]
                || task["permission_plan"]["approval_mode"] != target["start"]["approval_mode"]
            {
                return Err("CLI 交接不能扩大工具或审批模式。".into());
            }
        }
        if let Some(reason) = work::dependency_blocker(store, &item) {
            return Err(reason);
        }
        if !crate::groups::text_valid(reason, 600, true)
            || !crate::groups::text_valid(expected, 600, true)
        {
            return Err("交接需要有界理由与预期变化。".into());
        }
        let (_, chain) = self.bind_followup_origin(store, &origin, source_id)?;
        if chain["stopped"] == true
            || chain["wake_count"].as_i64().unwrap_or(0)
                >= chain["wake_limit"].as_i64().unwrap_or(0)
            || now >= chain["expires_at_ms"].as_i64().unwrap_or(0)
        {
            return Err("原协作链已停止或达到期限／次数上限。".into());
        }
        if store.followup_pending(target_id)?.len() >= 8 {
            return Err("接收方预约队列已满。".into());
        }
        let state = store
            .followup_state(target_id)?
            .ok_or("接收方跟进状态缺失。")?;
        store.save_followup_appointment(json!({"policy_id":target_id,"policy_revision":target["revision"],"policy_generation":state["generation"],"chain_id":chain["id"],"chain_generation":chain["generation"],"client_key":key,"request":fingerprint,"source_run_id":source_id,"at_ms":now,"reason":reason,"expected_change":expected,"manual":false,"kind":"handoff","state":"pending","run_id":null,"created_at_ms":now}))
    }
    pub(super) fn stop_followup_chain(
        &self,
        store: &mut Store,
        id: &str,
        reason: &str,
    ) -> Result<(Value, StopPlan), String> {
        let mut chain = store.followup_chain(id)?;
        let mut plan = StopPlan {
            runs: vec![],
            tasks: vec![],
        };
        if chain["stopped"] == true {
            return Ok((chain, plan));
        }
        chain["stopped"] = json!(true);
        chain["generation"] = json!(chain["generation"].as_i64().unwrap_or(0) + 1);
        chain["stop_reason"] = json!(reason);
        let chain = store.save_followup_chain(chain)?;
        for mut appointment in store.followup_chain_pending(id)? {
            appointment["state"] = json!("cancelled");
            appointment["status_reason"] = json!(reason);
            store.save_followup_appointment(appointment)?;
        }
        for run in store.followup_runs(id)? {
            if lifecycle::run_final(&run) {
                continue;
            }
            let run_id = run["id"].as_i64().ok_or("链执行身份无效。")?;
            self.flush_subtree_output(store, run_id)?;
            let stopped = store.stop_tree(
                run_id,
                Some("cancel"),
                &self.jobs.keys().copied().collect::<Vec<_>>(),
            )?;
            store.request_run_stop(run_id, true)?;
            plan.runs.extend(stopped.runs);
            plan.tasks.extend(stopped.tasks);
        }
        plan.runs.sort_unstable();
        plan.runs.dedup();
        plan.tasks.sort_unstable();
        plan.tasks.dedup();
        Ok((chain, plan))
    }
    pub(super) fn followup_command(
        &mut self,
        store: &mut Store,
        method: &str,
        input: Value,
        now: i64,
    ) -> Result<(Value, Option<StopPlan>), OperationFailure> {
        if method == "followups.stop_chain" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Stop {
                id: String,
                expected_revision: i64,
            }
            let request = params::<Stop>(input)?;
            let chain = store.followup_chain(&request.id)?;
            crate::groups::check_revision(Some(&chain), request.expected_revision)?;
            return self
                .stop_followup_chain(store, &request.id, "用户停止了整条跟进协作链。")
                .map(|(value, plan)| (value, Some(plan)))
                .map_err(Into::into);
        }
        if method == "followups.handoff" {
            let request = params::<Handoff>(input)?;
            return self
                .handoff_appointment(store, &request, now)
                .map(|value| (value, None))
                .map_err(Into::into);
        }
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
        let source = appointment["source_run_id"]
            .as_i64()
            .map(|id| store.agent_run(id))
            .transpose()?;
        let source_check = || -> Result<(), String> {
            let Some(source) = source.as_ref() else {
                return Ok(());
            };
            if source["causal_scope"].is_object() {
                let policy = store.causal_policy_resolve(&source["causal_scope"])?;
                if source["chain_depth"].as_i64().unwrap_or(0)
                    >= policy["limits"]["max_depth"].as_i64().unwrap()
                {
                    return Err("达到自动链深度上限。".into());
                }
            }
            if source["intent"].is_string()
                || matches!(
                    source["state"].as_str(),
                    Some("cancelled" | "failed" | "interrupted" | "cancelling")
                )
                || source["followup_chain_id"] != chain["id"]
                || source["followup_chain_generation"] != chain["generation"]
            {
                return Err("来源执行已停止、未核对或因果链失效。".into());
            }
            if let Some(reason) = self.authorization_blocker(store, source) {
                return Err(reason);
            }
            let origin_id = source["followup_policy_id"]
                .as_str()
                .ok_or("来源跟进身份缺失。")?;
            let origin = follow::policy(store, origin_id)?;
            let origin_state = store
                .followup_state(origin_id)?
                .ok_or("来源跟进状态缺失。")?;
            if origin["enabled"] != true
                || origin["cancelled"] == true
                || origin_state["generation"] != source["followup_policy_generation"]
            {
                return Err("来源策略已暂停、取消或修订。".into());
            }
            current_work(store, &origin)?;
            if appointment["kind"] == "handoff" {
                if !origin["handoff_policy_ids"]
                    .as_array()
                    .is_some_and(|routes| routes.contains(&policy["id"]))
                {
                    return Err("原交接路由已失效。".into());
                }
                if origin["workspace_id"] != policy["workspace_id"]
                    || origin["project_id"] != policy["project_id"]
                {
                    return Err("交接范围已变化。".into());
                }
            } else if origin["id"] != policy["id"] {
                return Err("预约所属工作已变化。".into());
            }
            let source_grant = store.authorization_get(
                source["authorization_id"]
                    .as_str()
                    .ok_or("来源授权缺失。")?,
            )?;
            let target_grant = store.authorization_get(
                policy["start"]["authorization_id"]
                    .as_str()
                    .ok_or("接收授权缺失。")?,
            )?;
            if crate::group_runtime::scope(&source_grant)
                != crate::group_runtime::scope(&target_grant)
                || source_grant["engine_id"] != target_grant["engine_id"]
            {
                return Err("当前接收授权超出来源能力上限。".into());
            }
            Ok(())
        };
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
            && appointment["kind"] != "handoff"
            && now
                > appointment["at_ms"]
                    .as_i64()
                    .unwrap_or(0)
                    .saturating_add(5000)
        {
            Some("预约时间已错过，保留记录并等待明确补跑。".to_owned())
        } else {
            material
                .as_ref()
                .err()
                .cloned()
                .or_else(|| source_check().err())
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
        let chain_runs = store.followup_runs(chain["id"].as_str().unwrap())?;
        let active = chain_runs
            .iter()
            .filter(|run| !lifecycle::run_final(run))
            .count();
        let upstream = chain["upstream_group_run_id"]
            .as_i64()
            .map(|id| {
                store.agent_run(id).and_then(|run| {
                    store.group_chain(run["group_chain_id"].as_str().ok_or("上游链身份缺失。")?)
                })
            })
            .transpose()?;
        let upstream_active = upstream
            .as_ref()
            .map(|upstream| {
                crate::group_runtime::chain_runs(store, upstream["id"].as_str().unwrap()).map(
                    |runs| {
                        runs.into_iter()
                            .filter(|run| !lifecycle::run_final(run))
                            .count()
                    },
                )
            })
            .transpose()?
            .unwrap_or(0);
        if let Some(upstream) = upstream.as_ref() {
            if let Some(reason) = crate::group_runtime::chain_blocker(upstream) {
                return Err(reason.into());
            }
            if upstream["wake_count"].as_i64().unwrap_or(0)
                >= upstream["wake_limit"].as_i64().unwrap_or(0)
            {
                return Err("上游协作链已达到启动次数上限。".to_owned().into());
            }
        }
        let usage = chain_runs
            .first()
            .map(|run| crate::group_runtime::usage(store, run))
            .transpose()?
            .unwrap_or((0, 0));
        if usage.0 >= 64 || usage.1 >= 128 {
            return Err("协作链已达到累计模型步骤或工具数量上限。".to_owned().into());
        }
        let wait = work::followup_start_blocker(store, &item)
            .or_else(|| {
                (state["last_started_at_ms"]
                    .as_i64()
                    .unwrap_or(i64::MIN / 2)
                    .saturating_add(policy["min_interval_ms"].as_i64().unwrap_or(60_000))
                    > now)
                    .then(|| "等待跟进最小启动间隔。".to_owned())
            })
            .or_else(|| {
                (active >= 2 || upstream_active >= 2 || self.live.len() >= 16)
                    .then(|| "等待协作链或全局执行并发容量。".to_owned())
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
        let routes=policy["handoff_policy_ids"].as_array().into_iter().flatten().map(|id|follow::policy(store,id.as_str().ok_or("交接身份无效。")?).map(|target|json!({"route_id":target["id"],"name":target["name"],"agent_id":target["agent_id"],"work_item_id":target["work_item_id"]}))).collect::<Result<Vec<_>,String>>()?;
        let context = json!({"work_item_id":item["id"],"definition_revision":work::definition_revision(&item),"goal_excerpt":excerpt(&item["goal"],200),"acceptance_excerpt":excerpt(&item["acceptance"],200),"appointment_id":appointment["id"],"reason":appointment["reason"],"expected_change":appointment["expected_change"],"followup_limits":{"now_ms":now,"earliest_proposal_at_ms":now.saturating_add(policy["min_interval_ms"].as_i64().unwrap_or(60_000)),"expires_at_ms":policy["expires_at_ms"].as_i64().unwrap_or(0).min(chain["expires_at_ms"].as_i64().unwrap_or(0)),"remaining_starts_after_this_run":chain["wake_limit"].as_i64().unwrap_or(0).saturating_sub(chain["wake_count"].as_i64().unwrap_or(0)+1)},"handoff_routes":routes,"source":source.as_ref().map(|run|json!({"run_id":run["id"],"revision":run["revision"],"output_excerpt":excerpt(&run["output"],400),"output_truncated":run["output"].as_str().is_some_and(|text|text.chars().count()>400)}))});
        start["goal"] = json!(format!(
            "{}\n\n本次预约复查的有界资料\n{}",
            start["goal"].as_str().unwrap_or(""),
            context
        ));
        if start.get("engine_id").is_some() {
            start["goal"]=json!(format!("{}\n需要后续检查时，只输出 JSON {{\"troop_followup\":{{\"at_ms\":毫秒时间戳,\"reason\":\"理由\",\"expected_change\":\"预期变化\"}}}}；交接使用 {{\"troop_handoff\":{{\"route_id\":\"已配置策略ID\",\"reason\":\"理由\",\"expected_change\":\"预期变化\"}}}}。每次仅选一种，固定证据经用户审核接纳后由 Core 校验。",start["goal"].as_str().unwrap_or("")));
        }
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
        if let Some(source) = source
            .as_ref()
            .filter(|run| run["causal_scope"].is_object())
        {
            run["causal_scope"] = source["causal_scope"].clone();
            run["chain_depth"] = json!(source["chain_depth"].as_i64().unwrap_or(0) + 1);
        }
        run["followup_chain_id"] = chain["id"].clone();
        run["followup_chain_generation"] = chain["generation"].clone();
        run["followup_policy_id"] = policy["id"].clone();
        run["followup_policy_generation"] = state["generation"].clone();
        run["followup_work_generation"] = json!(item["generation"].as_i64().unwrap_or(0));
        run["followup_expires_at_ms"] = json!(chain["expires_at_ms"]
            .as_i64()
            .unwrap_or(0)
            .min(policy["expires_at_ms"].as_i64().unwrap_or(0)));
        if let Some(mut upstream) = upstream {
            run["followup_group_chain_id"] = upstream["id"].clone();
            upstream["wake_count"] = json!(upstream["wake_count"].as_i64().unwrap_or(0) + 1);
            store.save_group_chain(upstream)?;
        }
        run["chain_id"] = chain["id"].clone();
        run["trigger"] = json!({"kind":"followup.due","policy_id":policy["id"],"policy_revision":policy["revision"],"appointment_id":appointment["id"],"source_run_id":appointment["source_run_id"],"permission":plan});
        store.agent_save(&mut run, &mut [], "followup_admitted")?;
        chain["wake_count"] = json!(chain["wake_count"].as_i64().unwrap_or(0) + 1);
        store.save_followup_chain(chain)?;
        state["wake_count"] = json!(state["wake_count"].as_i64().unwrap_or(0) + 1);
        state["last_started_at_ms"] = json!(now);
        state["current_run_id"] = json!(run_id);
        state["current_chain_id"] = run["followup_chain_id"].clone();
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
        self.pump_reviewed_followups(store, clock.now()?)?;
        for chain in store.followup_chains()? {
            if chain["stopped"] == true {
                continue;
            }
            let now = clock.now()?;
            let root_policy = follow::policy(
                store,
                chain["root_policy_id"].as_str().ok_or("根跟进身份缺失。")?,
            )?;
            let root_work = store.work_item(
                root_policy["work_item_id"]
                    .as_i64()
                    .ok_or("根工作身份缺失。")?,
            )?;
            let deadline = store
                .followup_runs(chain["id"].as_str().unwrap())?
                .iter()
                .any(|run| {
                    !lifecycle::run_final(run)
                        && run["followup_expires_at_ms"]
                            .as_i64()
                            .is_some_and(|expiry| expiry <= now)
                });
            let upstream = chain["upstream_group_run_id"]
                .as_i64()
                .map(|id| {
                    store
                        .agent_run(id)
                        .map(|run| crate::group_runtime::run_blocker(store, &run).is_some())
                })
                .transpose()?
                .unwrap_or(false);
            if now < chain["expires_at_ms"].as_i64().unwrap_or(0)
                && root_work["cancelled"] != true
                && !deadline
                && !upstream
            {
                continue;
            }
            let id = chain["id"].as_str().unwrap();
            let (_, plan) = store.execute_operation(
                "followups",
                &Uuid::new_v4().to_string(),
                "followups.expire",
                &json!({"id":id}),
                None,
                |store| {
                    self.stop_followup_chain(
                        store,
                        id,
                        "跟进期限已到、根工作已取消或上游协作链已失效。",
                    )
                    .map_err(Into::into)
                },
            )?;
            if let Some(plan) = plan {
                self.cancel_stop_plan(store, plan)?;
            }
        }
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
        if !matches!(
            inv["name"].as_str(),
            Some("propose_followup" | "request_handoff")
        ) {
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
                let appointment = if inv["name"] == "request_handoff" {
                    self.handoff_appointment(
                        store,
                        &Handoff {
                            source_run_id: run["id"]
                                .as_i64()
                                .ok_or_else(|| "来源执行身份缺失。".to_owned())?,
                            route_id: input["route_id"].as_str().unwrap_or("").to_owned(),
                            client_request_id: Uuid::new_v4().to_string(),
                            reason: input["reason"].as_str().unwrap_or("").to_owned(),
                            expected_change: input["expected_change"]
                                .as_str()
                                .unwrap_or("")
                                .to_owned(),
                        },
                        follow::now_ms(),
                    )?
                } else {
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
                    self.request_followup(store, request, follow::now_ms(), false)?
                };
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
