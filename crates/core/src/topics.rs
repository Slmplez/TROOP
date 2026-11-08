use crate::{groups, params};
use serde::Deserialize;
use serde_json::{json, Value};
use troop_storage::{OperationFailure, Store};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: i64,
}

pub(crate) fn read(store: &Store, method: &str, input: Value) -> Result<Value, String> {
    match method {
        "topics.get" => {
            let id = params::<Id>(input)?.id;
            store.topic_document(id)?;
            let mut topic = groups::public_group(store, store.group(id)?);
            topic["source_message"] = groups::public_message(
                store,
                store.group_message(
                    topic["source_message_id"]
                        .as_i64()
                        .ok_or("话题来源无效。")?,
                )?,
            )?;
            let members = topic["members"].as_array().ok_or("话题成员无效。")?;
            topic["participant_agent_ids"] = json!(store
                .topic_participants(id)?
                .into_iter()
                .filter(|id| members.iter().any(|member| member["agent_id"] == *id))
                .collect::<Vec<_>>());
            Ok(topic)
        }
        "topics.list" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Query {
                group_id: i64,
                before: Option<i64>,
            }
            let query = params::<Query>(input)?;
            let parent = store.group(query.group_id)?;
            if parent["source_group_id"].is_i64() {
                return Err("话题只支持一层。".into());
            }
            groups::paginate(store.topics(query.group_id, query.before)?, |topic| {
                Ok(groups::public_group(store, topic))
            })
        }
        _ => Err("话题变更需要操作账本。".into()),
    }
}
pub(crate) fn write(store: &Store, method: &str, input: Value) -> Result<Value, OperationFailure> {
    if method != "topics.create" {
        return update(store, method, input);
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Create {
        source_group_id: i64,
        source_message_id: i64,
        expected_group_revision: i64,
        name: String,
    }
    let request = params::<Create>(input)?;
    let parent = store.group(request.source_group_id)?;
    let source = store.group_message(request.source_message_id)?;
    if parent["source_group_id"].is_i64() || source["group_id"] != request.source_group_id {
        return Err("话题必须从当前主群消息创建。".to_owned().into());
    }
    if let Some(topic) = store.topic_for_message(request.source_message_id)? {
        return Ok(groups::public_group(store, topic));
    }
    groups::check_revision(Some(&parent), request.expected_group_revision)?;
    if parent["archived"] == true || source["project_id"] != parent["project_id"] {
        return Err("来源已归档或项目范围已变化。".to_owned().into());
    }
    if !groups::text_valid(request.name.trim(), 240, true) {
        return Err("话题名称无效或超过容量。".to_owned().into());
    }
    let mut chain = crate::group_runtime::message_chain(
        store,
        request.source_group_id,
        Some(request.source_message_id),
        None,
    )?;
    if chain["revision"] == 0 {
        chain["root_message_id"] = json!(request.source_message_id);
        store.save_group_chain(chain.clone())?;
    }
    let topic=store.save_group(json!({"name":request.name.trim(),"rules":"","rules_override":null,"project_id":parent["project_id"],"paused":false,"archived":false,"members":[],"member_overrides":[],"source_group_id":request.source_group_id,"source_message_id":request.source_message_id,"source_chain_id":chain["id"],"scope_invalidated":false}),None)?;
    Ok(groups::public_group(
        store,
        store.group(topic["id"].as_i64().unwrap())?,
    ))
}

fn update(store: &Store, method: &str, input: Value) -> Result<Value, OperationFailure> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Save {
        #[serde(rename = "id")]
        _id: i64,
        expected_revision: i64,
        name: String,
        rules_override: Option<String>,
        paused: bool,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Member {
        #[serde(rename = "id")]
        _id: i64,
        expected_revision: i64,
        agent_id: i64,
        listen_mode: Option<String>,
        receiving: Option<bool>,
        #[serde(default)]
        inherit: bool,
        #[serde(default)]
        inherit_listen: bool,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Archive {
        #[serde(rename = "id")]
        _id: i64,
        expected_revision: i64,
        archived: bool,
    }
    let id = input["id"]
        .as_i64()
        .ok_or_else(|| "话题身份无效。".to_owned())?;
    let old = store.topic_document(id)?;
    let effective = store.group(id)?;
    let mut next = old.clone();
    match method {
        "topics.save" => {
            let request = params::<Save>(input)?;
            groups::check_revision(Some(&old), request.expected_revision)?;
            if effective["archived"] == true {
                return Err("请先核对源群范围并恢复话题。".to_owned().into());
            }
            if !groups::text_valid(request.name.trim(), 240, true)
                || request
                    .rules_override
                    .as_ref()
                    .is_some_and(|text| !groups::text_valid(text, 4000, false))
            {
                return Err("话题名称或规则无效。".to_owned().into());
            }
            next["name"] = json!(request.name.trim());
            next["rules_override"] = json!(request.rules_override);
            next["paused"] = json!(request.paused);
        }
        "topics.member" => {
            let request = params::<Member>(input)?;
            groups::check_revision(Some(&old), request.expected_revision)?;
            if effective["archived"] == true {
                return Err("话题或源群已归档。".to_owned().into());
            }
            let member = effective["members"]
                .as_array()
                .and_then(|members| {
                    members
                        .iter()
                        .find(|member| member["agent_id"] == request.agent_id)
                })
                .ok_or_else(|| "请先将 Agent 加入源群。".to_owned())?;
            if request
                .listen_mode
                .as_deref()
                .is_some_and(|value| !matches!(value, "active" | "passive"))
            {
                return Err("监听方式无效。".to_owned().into());
            }
            let overrides = next["member_overrides"]
                .as_array_mut()
                .ok_or_else(|| "话题设置无效。".to_owned())?;
            let previous = overrides
                .iter()
                .find(|entry| {
                    entry["agent_id"] == request.agent_id
                        && entry["parent_joined_revision"] == member["joined_revision"]
                })
                .cloned();
            overrides.retain(|entry| entry["agent_id"] != request.agent_id);
            if !request.inherit {
                let mut value=previous.unwrap_or(json!({"agent_id":request.agent_id,"listen_mode":null,"receiving":null,"parent_joined_revision":member["joined_revision"]}));
                if let Some(listen) = request.listen_mode {
                    value["listen_mode"] = json!(listen);
                }
                if request.inherit_listen {
                    value["listen_mode"] = Value::Null;
                }
                if let Some(receiving) = request.receiving {
                    value["receiving"] = json!(receiving);
                }
                overrides.push(value);
            }
        }
        "topics.archive" => {
            let request = params::<Archive>(input)?;
            groups::check_revision(Some(&old), request.expected_revision)?;
            if !request.archived {
                let parent = store.group(
                    old["source_group_id"]
                        .as_i64()
                        .ok_or_else(|| "来源身份无效。".to_owned())?,
                )?;
                if parent["archived"] == true || old["scope_invalidated"] == true {
                    return Err("源群已归档或项目范围已变化。".to_owned().into());
                }
            }
            next["archived"] = json!(request.archived);
        }
        _ => return Err("未知话题命令。".to_owned().into()),
    }
    store.save_group(next, Some(&old))?;
    let value = store.group(id)?;
    groups::invalidate_deliveries(store, &value, false)?;
    Ok(groups::public_group(store, value))
}
