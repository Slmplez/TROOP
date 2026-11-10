use super::*;
use troop_protocol::schedule::Schedule;
use troop_storage::OperationFailure;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    turn_id: i64,
    authorization_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    troop_automation: Proposal,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Proposal {
    kind: String,
    name: String,
    body: Option<String>,
    goal: Option<String>,
    schedule: Schedule,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirm {
    turn_id: i64,
    authorization_id: Option<String>,
    source_sha256: String,
    expected_plan_sha256: Option<String>,
}

impl Manager {
    pub(crate) fn automation_result(
        &self,
        store: &Store,
        input: Value,
        now: i64,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ResultQuery {
            turn_id: i64,
            run_id: i64,
        }
        let query = params::<ResultQuery>(input)?;
        let draft = self.preview_automation(store, json!({"turn_id":query.turn_id}), now)?;
        if draft["registered"].is_null() {
            return Err("来源自动化尚未登记。".into());
        }
        let run = store.agent_run(query.run_id)?;
        if run["trigger"]["kind"] != "scheduled"
            || run["trigger"]["rule_id"] != draft["id"]
            || run["state"] != "completed"
        {
            return Err("该结果尚未完成或不属于来源自动化。".into());
        }
        if run["kind"] == "external_cli" {
            crate::followups::reviewed_cli_result(store, &run)?;
        }
        let output = run["output"].as_str().unwrap_or("");
        let excerpt = output.chars().take(2000).collect::<String>();
        Ok(
            json!({"run_id":query.run_id,"rule_id":draft["id"],"sha256":tools::hash(output.as_bytes()),"content":excerpt,"truncated":output.chars().count()>2000}),
        )
    }
    pub(crate) fn preview_automation(
        &self,
        store: &Store,
        input: Value,
        now: i64,
    ) -> Result<Value, String> {
        let query = params::<Query>(input)?;
        let source = store.automation_chat_source(query.turn_id)?;
        if source["state"] != "completed" {
            return Err("请等待来源回复完整结束。".into());
        }
        let agent = source["agent_id"].as_i64().ok_or("对话 Agent 无效。")?;
        store.memory_agent(agent)?;
        if let Some(project) = source["project_id"].as_str() {
            if !store
                .memory_projects(agent)?
                .as_array()
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["slug"] == project && item["joined"] == true)
                })
            {
                return Err("对话项目成员资格已失效。".into());
            }
        }
        let text = source["output"].as_str().ok_or("来源回复无效。")?;
        if text.len() > 16_000 {
            return Err("自动化提议超过长度限制。".into());
        }
        let proposal: Envelope = serde_json::from_str(text.trim()).map_err(|_| {
            "回复尚未形成完整自动化草稿，请在对话中补充时间、时区、重复规则及目标。"
        })?;
        let proposal = proposal.troop_automation;
        proposal.schedule.validate()?;
        let sha = tools::hash(source.to_string().as_bytes());
        let identity = tools::hash(
            format!("{}:chat-automation:{}", store.instance_id()?, query.turn_id).as_bytes(),
        );
        let id = format!(
            "{}-{}-{}-{}-{}",
            &identity[..8],
            &identity[8..12],
            &identity[12..16],
            &identity[16..20],
            &identity[20..32]
        );
        let origin = json!({"turn_id":query.turn_id,"conversation_id":source["conversation_id"],"source_sha256":sha,"authorization_id":query.authorization_id});
        if let Ok(saved) = store.rule_get(&id) {
            if saved["origin"]["source_sha256"] != sha
                || (query.authorization_id.is_some()
                    && saved["origin"]["authorization_id"] != json!(query.authorization_id))
            {
                return Err("该回复已登记其他自动化配置，请使用新回复。".into());
            }
            return Ok(
                json!({"id":id,"source_sha256":sha,"origin":origin,"registered":saved,"rule":null,"preview":null}),
            );
        }
        let mut rule = json!({"kind":proposal.kind,"event":"time.due","name":proposal.name,"enabled":true,"agent_id":agent,"project_id":source["project_id"],"schedule":proposal.schedule});
        let preview = match proposal.kind.as_str() {
            "reminder" => {
                if proposal.goal.is_some()
                    || proposal
                        .body
                        .as_deref()
                        .is_none_or(|text| !crate::groups::text_valid(text, 4000, true))
                {
                    return Err("纯提醒需要明确正文。".into());
                }
                rule["body"] = json!(proposal.body);
                crate::reminders::preview(json!({"schedule":rule["schedule"]}), now)?
            }
            "scheduled" => {
                if proposal.body.is_some()
                    || proposal.goal.as_deref().is_none_or(|text| !text_ok(text))
                {
                    return Err("定时执行需要明确目标。".into());
                }
                rule["workspace_id"] = source["workspace_id"].clone();
                rule["work_item_id"] = Value::Null;
                rule["expected_plan_sha256"] = Value::Null;
                rule["start"] = json!({"client_run_id":id,"agent_id":agent,"workspace_id":source["workspace_id"],"project_ids":source["project_id"].as_str().map(|id|json!([id])).unwrap_or(json!([])),"provider_id":source["provider_id"],"authorization_id":query.authorization_id,"goal":proposal.goal});
                if let Some(ids) = source.get("office_reference_ids") {
                    rule["start"]["office_reference_ids"] = ids.clone();
                }
                self.schedules_read(
                    store,
                    "schedules.preview",
                    json!({"id":id,"rule":rule}),
                    now,
                )?
            }
            _ => return Err("请选择纯提醒或定时执行。".into()),
        };
        if !crate::groups::text_valid(rule["name"].as_str().unwrap_or(""), 120, true)
            || preview["slots"]
                .as_array()
                .is_none_or(|slots| slots.is_empty())
        {
            return Err("名称无效或没有未来触发时间，请继续补充。".into());
        }
        Ok(
            json!({"id":id,"source_sha256":sha,"origin":origin,"rule":rule,"preview":preview,"registered":null}),
        )
    }
    pub(super) fn confirm_automation(
        &mut self,
        store: &mut Store,
        input: Value,
        now: i64,
    ) -> Result<Value, OperationFailure> {
        let request = params::<Confirm>(input)?;
        let draft = self.preview_automation(
            store,
            json!({"turn_id":request.turn_id,"authorization_id":request.authorization_id}),
            now,
        )?;
        if draft["source_sha256"] != request.source_sha256 {
            return Err("来源内容已变化，请重新预览。".to_string().into());
        }
        if !draft["registered"].is_null() {
            return Ok(draft["registered"].clone());
        }
        let mut rule = draft["rule"].clone();
        let author = json!({"kind":"desktop","automation_origin":draft["origin"]});
        if rule["kind"] == "scheduled" {
            if request.expected_plan_sha256.is_none()
                || draft["preview"]["plan_sha256"] != json!(request.expected_plan_sha256)
            {
                return Err("权限计划已变化，请重新预览并确认。".to_string().into());
            }
            rule["expected_plan_sha256"] = draft["preview"]["plan_sha256"].clone();
            self.save_schedule_authored(
                store,
                json!({"id":draft["id"],"expected_revision":0,"rule":rule}),
                now,
                author,
            )
        } else {
            crate::reminders::save(
                store,
                json!({"id":draft["id"],"expected_revision":0,"rule":rule}),
                author,
                now,
            )
        }
    }
}
