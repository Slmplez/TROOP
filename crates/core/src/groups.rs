use crate::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use troop_storage::{OperationFailure, Store};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    name: String,
    #[serde(default)]
    rules: String,
    project_id: Option<String>,
    #[serde(default)]
    paused: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    id: Option<i64>,
    expected_revision: i64,
    group: Definition,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {
    id: i64,
    expected_revision: i64,
    archived: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Listen {
    Active,
    Passive,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Member {
    id: i64,
    expected_revision: i64,
    agent_id: i64,
    listen_mode: Option<Listen>,
    receiving: Option<bool>,
    #[serde(default)]
    remove: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Send {
    group_id: i64,
    expected_revision: i64,
    client_message_id: String,
    body: String,
    #[serde(default)]
    mention_agent_ids: Vec<i64>,
    #[serde(default)]
    broadcast: bool,
    reply_to: Option<i64>,
    work_item_id: Option<i64>,
    #[serde(default)]
    execute_work_item: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryDecision {
    id: i64,
    expected_revision: i64,
    action: Decision,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Decision {
    Resume,
    Cancel,
}

pub(crate) fn text_valid(text: &str, limit: usize, required: bool) -> bool {
    text.len() <= limit
        && (!required || !text.trim().is_empty())
        && !text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}
pub(crate) fn check_revision(
    record: Option<&Value>,
    expected: i64,
) -> Result<(), OperationFailure> {
    let current = record
        .and_then(|record| record["revision"].as_i64())
        .unwrap_or(0);
    if expected != current || expected < 0 {
        return Err(OperationFailure {
            kind: "revision_conflict",
            message: "群聊或投递已变化，请刷新后核对。".into(),
            current_revision: Some(current),
        });
    }
    Ok(())
}
fn project_valid(store: &Store, project: Option<&str>) -> Result<(), String> {
    if let Some(project) = project {
        if project.is_empty()
            || project.len() > 100
            || !store
                .memory_projects(1)?
                .as_array()
                .is_some_and(|projects| projects.iter().any(|entry| entry["slug"] == project))
        {
            return Err("群项目不存在。".into());
        }
    }
    Ok(())
}
fn project_member(store: &Store, group: &Value, agent: i64) -> Result<(), String> {
    store.memory_agent(agent)?;
    if let Some(project) = group["project_id"].as_str() {
        if !store
            .memory_projects(agent)?
            .as_array()
            .is_some_and(|projects| {
                projects
                    .iter()
                    .any(|entry| entry["slug"] == project && entry["joined"] == true)
            })
        {
            return Err("Agent 尚未加入群绑定的项目。".into());
        }
    }
    Ok(())
}
fn recipient_blocker(store: &Store, group: &Value, agent: i64) -> Option<String> {
    if group["archived"] == true {
        return Some("群聊已归档。".into());
    }
    if group["paused"] == true {
        return Some("群响应已暂停。".into());
    }
    let member = group["members"]
        .as_array()
        .and_then(|members| members.iter().find(|member| member["agent_id"] == agent));
    let Some(member) = member else {
        return Some("Agent 已移出群聊或不属于当前群。".into());
    };
    if member["receiving"] != true {
        return Some("该成员已关闭接收群消息。".into());
    }
    project_member(store, group, agent).err()
}
fn candidates(
    store: &Store,
    group: &Value,
    mentions: &[i64],
    broadcast: bool,
    reply_to: Option<i64>,
    sender: Option<i64>,
) -> Result<BTreeSet<i64>, String> {
    if mentions.len() > 32 || mentions.iter().any(|agent| *agent <= 0) {
        return Err("点名目标无效或超过容量。".into());
    }
    let mut targets = mentions.iter().copied().collect::<BTreeSet<_>>();
    if let Some(reply) = reply_to {
        let reply = store.group_message(reply)?;
        if reply["group_id"] != group["id"] {
            return Err("回复消息不属于当前群。".into());
        }
        if let Some(agent) = reply["sender_agent_id"].as_i64() {
            targets.insert(agent);
        }
    }
    if broadcast || (targets.is_empty() && sender.is_none()) {
        for member in group["members"].as_array().unwrap() {
            if broadcast || member["listen_mode"] == "active" {
                targets.insert(member["agent_id"].as_i64().unwrap());
            }
        }
    }
    if let Some(sender) = sender {
        targets.remove(&sender);
    }
    Ok(targets)
}
fn admission_blocker(store: &Store, group: &Value, agent: i64) -> Result<Option<String>, String> {
    let mut reason = recipient_blocker(store, group, agent);
    if reason.is_none() && store.group_pending_count(group["id"].as_i64().unwrap(), agent)? >= 128 {
        reason = Some("待处理投递已达到 128 条，请先处理旧消息。".into());
    }
    Ok(reason)
}
pub(crate) fn public_group(store: &Store, mut group: Value) -> Value {
    group.as_object_mut().unwrap().remove("member_overrides");
    let archived = group["archived"] == true;
    for member in group["members"].as_array_mut().unwrap() {
        let agent = member["agent_id"].as_i64().unwrap();
        member["agent_name"] = store
            .memory_agent(agent)
            .ok()
            .map(|agent| agent["name"].clone())
            .unwrap_or(json!(format!("Agent {agent}")));
    }
    let snapshot = group.clone();
    for member in group["members"].as_array_mut().unwrap() {
        let reason = recipient_blocker(store, &snapshot, member["agent_id"].as_i64().unwrap());
        member["receive_availability"] = json!({"allowed":reason.is_none(),"reason":reason});
    }
    let mut restore_error = project_valid(store, group["project_id"].as_str()).err();
    if let Some(id) = group["source_group_id"].as_i64() {
        restore_error = if group["scope_invalidated"] == true {
            Some("源群项目范围已变化，请从新范围消息创建话题。".into())
        } else if store
            .group(id)
            .is_ok_and(|parent| parent["archived"] == true)
        {
            Some("请先恢复源群。".into())
        } else {
            restore_error
        };
    }
    group["allowed_actions"] = json!({
        "save":{"allowed":!archived,"reason":if archived{Some("请先恢复群聊。")}else{None}},
        "member":{"allowed":!archived,"reason":if archived{Some("请先恢复群聊。")}else{None}},
        "send":{"allowed":!archived,"reason":if archived{Some("群聊已归档。")}else{None}},
        "archive":{"allowed":!archived,"reason":if archived{Some("群聊已归档。")}else{None}},
        "restore":{"allowed":archived&&restore_error.is_none(),"reason":if archived{restore_error}else{Some("群聊尚未归档。".to_owned())}}
    });
    group
}
pub(crate) fn public_message(store: &Store, mut message: Value) -> Result<Value, String> {
    message.as_object_mut().unwrap().remove("scope_ceiling");
    message["delivery_summary"] = store.group_delivery_summary(message["id"].as_i64().unwrap())?;
    Ok(message)
}
pub(crate) fn delivery_blocker(store: &Store, group: &Value, delivery: &Value) -> Option<String> {
    if let Some(id) = delivery["chain_id"].as_str() {
        match store.group_chain(id) {
            Ok(chain) => {
                if let Some(reason) = crate::group_runtime::chain_blocker(&chain) {
                    return Some(reason);
                }
                if delivery["run_id"].is_null()
                    && chain["wake_count"].as_i64().unwrap_or(0)
                        >= chain["wake_limit"]
                            .as_i64()
                            .unwrap_or(crate::group_runtime::WAKE_LIMIT)
                {
                    return Some("本次协作已达到自动唤醒上限，请明确交办新消息。".into());
                }
            }
            Err(error) => return Some(error),
        }
    }
    let agent = delivery["agent_id"].as_i64().unwrap();
    if let Some(reason) = recipient_blocker(store, group, agent) {
        return Some(reason);
    }
    let member = group["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["agent_id"] == agent)
        .unwrap();
    if member["listen_mode"] == "active" {
        return None;
    }
    let message = match store.group_message(delivery["message_id"].as_i64().unwrap()) {
        Ok(message) => message,
        Err(error) => return Some(error),
    };
    if message["broadcast"] == true
        || message["mention_agent_ids"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| *id == agent))
    {
        return None;
    }
    if message["reply_to"]
        .as_i64()
        .and_then(|id| store.group_message(id).ok())
        .is_some_and(|reply| reply["sender_agent_id"] == agent)
    {
        return None;
    }
    Some("该成员已改为被动监听，普通消息投递已停止。".into())
}
fn public_delivery(store: &Store, group: &Value, mut delivery: Value) -> Value {
    let blocker = delivery_blocker(store, group, &delivery);
    let pending = matches!(
        delivery["state"].as_str(),
        Some("queued" | "waiting_resume" | "blocked" | "awaiting_reconciliation" | "dispatched")
    );
    let linked = delivery["run_id"]
        .as_i64()
        .and_then(|id| store.agent_run(id).ok());
    let pending = pending
        || linked
            .as_ref()
            .is_some_and(|run| !troop_protocol::lifecycle::run_final(run));
    let resume = matches!(
        delivery["state"].as_str(),
        Some("waiting_resume" | "blocked")
    ) && blocker.is_none()
        && linked.is_none();
    delivery["run_state"] = linked
        .as_ref()
        .map(|run| run["state"].clone())
        .unwrap_or(Value::Null);
    delivery["run_id"] = linked
        .as_ref()
        .map(|run| run["id"].clone())
        .unwrap_or(Value::Null);
    delivery["adopted"] = json!(delivery["adopted"] == true);
    delivery["current_blocker"] = json!(blocker);
    delivery["allowed_actions"] = json!({
        "resume":{"allowed":resume,"reason":if resume{None}else{blocker.or(Some("投递不处于等待继续状态。".into()))}},
        "cancel":{"allowed":pending,"reason":if pending{None}else{Some("投递已结束。")}}
    });
    delivery
}
pub(crate) fn paginate(
    records: Vec<Value>,
    mut project: impl FnMut(Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let available = records.len();
    let mut items = Vec::new();
    let mut bytes = 0;
    for record in records.into_iter().take(20) {
        let item = project(record)?;
        let size = item.to_string().len();
        if bytes + size > 30_000 && !items.is_empty() {
            break;
        }
        bytes += size;
        items.push(item);
    }
    let next = if items.len() < available {
        items.last().map(|item| item["id"].clone())
    } else {
        None
    };
    Ok(json!({"items":items,"next_before":next}))
}
pub(crate) fn read(store: &Store, method: &str, input: Value) -> Result<Value, String> {
    match method {
        "groups.preview" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Address {
                group_id: i64,
                expected_revision: i64,
                #[serde(default)]
                mention_agent_ids: Vec<i64>,
                #[serde(default)]
                broadcast: bool,
                reply_to: Option<i64>,
            }
            let request = params::<Address>(input)?;
            let group = store.group(request.group_id)?;
            check_revision(Some(&group), request.expected_revision)
                .map_err(|error| error.message)?;
            let targets = candidates(
                store,
                &group,
                &request.mention_agent_ids,
                request.broadcast,
                request.reply_to,
                None,
            )?;
            let mut recipients = Vec::new();
            let mut ready = 0;
            for agent in targets {
                let reason = admission_blocker(store, &group, agent)?;
                if reason.is_none() {
                    ready += 1;
                }
                recipients.push(json!({"agent_id":agent,"agent_name":store.memory_agent(agent).ok().map(|agent|agent["name"].clone()).unwrap_or(json!(format!("Agent #{agent}"))),"availability":{"allowed":reason.is_none(),"reason":reason}}));
            }
            Ok(
                json!({"group_revision":group["revision"],"recipients":recipients,"ready_count":ready,"reason":if ready==0{Some("暂无可接收成员，消息仅保存并记录适用的拒绝原因。")}else{None}}),
            )
        }
        "groups.get" => Ok(public_group(store, store.group(params::<Id>(input)?.id)?)),
        "groups.list" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Query {
                before: Option<i64>,
                #[serde(default)]
                archived: bool,
            }
            let query = params::<Query>(input)?;
            paginate(store.groups(query.before, query.archived)?, |group| {
                Ok(public_group(store, group))
            })
        }
        "groups.messages" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Query {
                group_id: i64,
                before: Option<i64>,
            }
            let query = params::<Query>(input)?;
            store.group(query.group_id)?;
            paginate(
                store.group_messages(query.group_id, query.before)?,
                |message| public_message(store, message),
            )
        }
        "groups.deliveries" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Query {
                group_id: i64,
                message_id: Option<i64>,
                before: Option<i64>,
            }
            let query = params::<Query>(input)?;
            let group = store.group(query.group_id)?;
            if let Some(message) = query.message_id {
                if store.group_message(message)?["group_id"] != query.group_id {
                    return Err("消息不属于当前群。".into());
                }
            }
            paginate(
                store.group_deliveries(query.group_id, query.message_id, query.before)?,
                |delivery| Ok(public_delivery(store, &group, delivery)),
            )
        }
        _ => Err("群聊变更需要操作账本。".into()),
    }
}
pub(crate) fn invalidate_deliveries(
    store: &Store,
    group: &Value,
    scope_changed: bool,
) -> Result<(), String> {
    for mut delivery in store.group_pending_deliveries(group["id"].as_i64().unwrap())? {
        let reason = if scope_changed {
            Some("群项目范围已变更，请重新交办。".to_owned())
        } else {
            delivery_blocker(store, group, &delivery)
        };
        if let Some(reason) = reason {
            delivery["state"] = json!("cancelled");
            delivery["reason"] = json!(reason);
            store.save_group_delivery(delivery)?;
        }
    }
    Ok(())
}
pub(crate) fn send_message(
    store: &Store,
    input: Value,
    origin: Option<&Value>,
) -> Result<Value, OperationFailure> {
    let request = params::<Send>(input.clone())?;
    if Uuid::parse_str(&request.client_message_id).is_err()
        || !text_valid(&request.body, 6000, true)
        || request.mention_agent_ids.len() > 32
        || request.mention_agent_ids.iter().any(|agent| *agent <= 0)
    {
        return Err("消息正文、目标或幂等身份无效。".to_owned().into());
    }
    if let Some(message) =
        store.group_duplicate_message(request.group_id, &request.client_message_id, &input)?
    {
        return Ok(public_message(store, message)?);
    }
    let group = store.group(request.group_id)?;
    check_revision(Some(&group), request.expected_revision)?;
    if group["archived"] == true {
        return Err("群聊已归档。".to_owned().into());
    }
    let targets = candidates(
        store,
        &group,
        &request.mention_agent_ids,
        request.broadcast,
        request.reply_to,
        origin.and_then(|run| run["agent_id"].as_i64()),
    )?;
    let mut chain =
        crate::group_runtime::message_chain(store, request.group_id, request.reply_to, origin)?;
    let work_id = request
        .work_item_id
        .or_else(|| origin.and_then(|run| run["group_work_item_id"].as_i64()));
    if let Some(id) = work_id {
        let item = store.work_item(id)?;
        if item["project_id"] != group["project_id"] {
            return Err("工作项与群项目范围不一致。".to_owned().into());
        }
        if request.execute_work_item
            && (origin.is_some()
                || targets.len() != 1
                || !targets.contains(&item["owner_agent_id"].as_i64().unwrap()))
        {
            return Err("执行工作项需要明确点名其唯一负责人。".to_owned().into());
        }
    } else if request.execute_work_item {
        return Err("请选择关联工作项。".to_owned().into());
    }
    let message=store.insert_group_message(json!({
            "group_id":request.group_id,"client_message_id":request.client_message_id,"sender_agent_id":origin.map(|run|run["agent_id"].clone()),
            "body":request.body,"mention_agent_ids":request.mention_agent_ids,"broadcast":request.broadcast,
            "reply_to":request.reply_to,"recipient_agent_ids":targets,"group_revision":group["revision"],"rules":group["rules"],
            "chain_id":chain["id"],"chain_generation":chain["generation"],"source_run_id":origin.map(|run|run["id"].clone()),
            "scope_ceiling":origin.map(|run|run["group_scope_ceiling"].clone()),"project_id":group["project_id"],"work_item_id":work_id,"execute_work_item":request.execute_work_item,"source_group_revision":group["source_group_revision"]
            ,"topic_id":if group["source_group_id"].is_i64(){group["id"].clone()}else{Value::Null},"source_topic_id":origin.map(|run|run["group_topic_id"].clone()),"source_topic_message_id":origin.filter(|run|run["group_topic_id"].is_i64()).map(|run|run["group_message_id"].clone())
        }),&input)?;
    if chain["root_message_id"].is_null() {
        chain["root_message_id"] = message["id"].clone();
        store.save_group_chain(chain.clone())?;
    }
    for agent in targets {
        let reason = crate::group_runtime::chain_blocker(&chain)
            .or(admission_blocker(store, &group, agent)?);
        let member = group["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|member| member["agent_id"] == agent);
        store.save_group_delivery(json!({"group_id":request.group_id,"message_id":message["id"],"agent_id":agent,"group_revision":group["revision"],"member_revision":member.map(|member|member["revision"].clone()),"state":if reason.is_some(){"rejected"}else{"queued"},"reason":reason,"chain_id":chain["id"],"work_item_id":work_id}))?;
    }
    Ok(public_message(store, message)?)
}
pub(crate) fn write(store: &Store, method: &str, input: Value) -> Result<Value, OperationFailure> {
    if method == "groups.send" {
        return send_message(store, input, None);
    }
    if method == "groups.resolve_delivery" {
        let request = params::<DeliveryDecision>(input)?;
        let mut delivery = store.group_delivery(request.id)?;
        check_revision(Some(&delivery), request.expected_revision)?;
        let group = store.group(delivery["group_id"].as_i64().unwrap())?;
        let public = public_delivery(store, &group, delivery.clone());
        let action = match request.action {
            Decision::Resume => "resume",
            Decision::Cancel => "cancel",
        };
        if public["allowed_actions"][action]["allowed"] != true {
            return Err(public["allowed_actions"][action]["reason"]
                .as_str()
                .unwrap_or("投递已变化。")
                .to_owned()
                .into());
        }
        delivery["state"] = json!(if action == "resume" {
            "queued"
        } else {
            "cancelled"
        });
        delivery["reason"] = if action == "resume" {
            Value::Null
        } else {
            json!("用户取消投递。")
        };
        return Ok(public_delivery(
            store,
            &group,
            store.save_group_delivery(delivery)?,
        ));
    }
    let (mut group, old) = match method {
        "groups.save" => {
            let request = params::<Save>(input)?;
            let old = request.id.map(|id| store.group(id)).transpose()?;
            if old
                .as_ref()
                .is_some_and(|group| group["source_group_id"].is_i64())
            {
                return Err("请使用话题配置接口。".to_owned().into());
            }
            check_revision(old.as_ref(), request.expected_revision)?;
            if old.as_ref().is_some_and(|group| group["archived"] == true) {
                return Err("请先恢复群聊。".to_owned().into());
            }
            if !text_valid(request.group.name.trim(), 240, true)
                || !text_valid(&request.group.rules, 4000, false)
            {
                return Err("群名称或规则无效或超过容量。".to_owned().into());
            }
            project_valid(store, request.group.project_id.as_deref())?;
            let members = old
                .as_ref()
                .map(|group| group["members"].clone())
                .unwrap_or(json!([]));
            let group = json!({"name":request.group.name.trim(),"rules":request.group.rules,"project_id":request.group.project_id,"paused":request.group.paused,"members":members,"archived":false});
            if old
                .as_ref()
                .is_none_or(|old| old["project_id"] != group["project_id"])
            {
                for member in group["members"].as_array().unwrap() {
                    project_member(store, &group, member["agent_id"].as_i64().unwrap())?;
                }
            }
            (group, old)
        }
        "groups.archive" => {
            let request = params::<Archive>(input)?;
            let old = store.group(request.id)?;
            if old["source_group_id"].is_i64() {
                return Err("请使用话题归档接口。".to_owned().into());
            }
            check_revision(Some(&old), request.expected_revision)?;
            if !request.archived {
                project_valid(store, old["project_id"].as_str())?;
            }
            let mut group = old.clone();
            group["archived"] = json!(request.archived);
            (group, Some(old))
        }
        "groups.member" => {
            let request = params::<Member>(input)?;
            let old = store.group(request.id)?;
            if old["source_group_id"].is_i64() {
                return Err("请使用话题监听接口。".to_owned().into());
            }
            check_revision(Some(&old), request.expected_revision)?;
            if old["archived"] == true {
                return Err("请先恢复群聊。".to_owned().into());
            }
            let mut group = old.clone();
            let members = group["members"].as_array_mut().unwrap();
            if request.remove {
                members.retain(|member| member["agent_id"] != request.agent_id);
            } else {
                let index = members
                    .iter()
                    .position(|member| member["agent_id"] == request.agent_id);
                if index.is_none() || request.receiving != Some(false) {
                    project_member(store, &old, request.agent_id)?;
                }
                if index.is_none() && members.len() >= 32 {
                    return Err("每群最多 32 个成员。".to_owned().into());
                }
                let previous = index.map(|index| members[index].clone());
                let listen = match request.listen_mode {
                    Some(Listen::Active) => "active",
                    Some(Listen::Passive) => "passive",
                    None => previous
                        .as_ref()
                        .and_then(|member| member["listen_mode"].as_str())
                        .unwrap_or("passive"),
                };
                let receiving = request.receiving.unwrap_or_else(|| {
                    previous
                        .as_ref()
                        .is_none_or(|member| member["receiving"] == true)
                });
                let joined = previous
                    .as_ref()
                    .map(|member| {
                        member["joined_revision"]
                            .as_i64()
                            .or(member["revision"].as_i64())
                            .unwrap_or(0)
                    })
                    .unwrap_or(old["revision"].as_i64().unwrap() + 1);
                let member = json!({"agent_id":request.agent_id,"listen_mode":listen,"receiving":receiving,"revision":old["revision"].as_i64().unwrap()+1,"joined_revision":joined});
                if let Some(index) = index {
                    members[index] = member;
                } else {
                    members.push(member);
                }
            }
            (group, Some(old))
        }
        _ => return Err("未知群聊命令。".to_owned().into()),
    };
    let scope_changed = old
        .as_ref()
        .is_some_and(|old| old["project_id"] != group["project_id"]);
    group = store.save_group(group, old.as_ref())?;
    invalidate_deliveries(store, &group, scope_changed)?;
    for id in store.child_topic_ids(group["id"].as_i64().unwrap())? {
        invalidate_deliveries(store, &store.group(id)?, scope_changed)?;
    }
    Ok(public_group(store, group))
}
