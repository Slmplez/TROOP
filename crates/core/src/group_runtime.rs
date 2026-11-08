use serde_json::{json, Value};
use troop_storage::Store;
use uuid::Uuid;

pub(crate) const WAKE_LIMIT: i64 = 16;
pub(crate) const PARALLEL_LIMIT: usize = 2;
pub(crate) fn usage(store: &Store, run: &Value) -> Result<(u64, usize), String> {
    let root = if run["group_chain_id"].is_null() {
        run["root_run_id"]
            .as_i64()
            .map(|id| store.agent_run(id))
            .transpose()?
            .unwrap_or(Value::Null)
    } else {
        run.clone()
    };
    let group = root["group_chain_id"]
        .as_str()
        .map(|chain| chain_usage(store, chain))
        .transpose()?
        .unwrap_or((0, 0));
    let followup = crate::followups::usage(store, run)?;
    Ok((group.0.max(followup.0), group.1.max(followup.1)))
}
pub(crate) fn chain_usage(store: &Store, chain: &str) -> Result<(u64, usize), String> {
    let mut steps = 0;
    let mut tools = 0;
    for delivery in store.group_chain_deliveries(chain)? {
        if let Some(id) = delivery["run_id"].as_i64() {
            for run in store.tree_runs(id)? {
                steps += run["step"].as_u64().unwrap_or(0);
                tools += store
                    .agent_invocations(run["id"].as_i64().ok_or("执行身份无效。")?)?
                    .len();
            }
        }
    }
    Ok((steps, tools))
}
pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub(crate) fn new_chain(group: i64) -> Value {
    json!({"id":Uuid::new_v4().to_string(),"group_id":group,"root_message_id":null,"revision":0,"generation":0,"stopped":false,"wake_count":0,"wake_limit":WAKE_LIMIT,"parallel_limit":PARALLEL_LIMIT,"expires_at":now()+1800})
}
pub(crate) fn chain_blocker(chain: &Value) -> Option<String> {
    if chain["stopped"] == true {
        Some("本次协作已停止。".into())
    } else if chain["expires_at"].as_i64().unwrap_or(0) <= now() {
        Some("本次协作期限已到。".into())
    } else {
        None
    }
}
pub(crate) fn message_chain(
    store: &Store,
    group: i64,
    reply: Option<i64>,
    origin: Option<&Value>,
) -> Result<Value, String> {
    if let Some(run) = origin {
        return store.group_chain(run["group_chain_id"].as_str().ok_or("执行缺少协作链。")?);
    }
    if let Some(id) = reply {
        let source = store.group_message(id)?;
        if let Some(id) = source["chain_id"].as_str() {
            return store.group_chain(id);
        }
        if let Some(chain) = store.group_chain_for_message(id)? {
            return Ok(chain);
        }
    }
    let current = store.group(group)?;
    if let Some(chain) = current["source_chain_id"].as_str() {
        return store.group_chain(chain);
    }
    Ok(new_chain(group))
}
pub(crate) fn scope(grant: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "workspace_id",
        "project_ids",
        "read_roots",
        "write_roots",
        "read_all",
        "network",
        "operations",
        "shell",
        "command_hooks",
        "prompt_hooks",
        "mcp_calls",
    ] {
        result[key] = grant[key].clone();
    }
    result
}
pub(crate) fn run_blocker(store: &Store, run: &Value) -> Option<String> {
    let root = if run["group_delivery_id"].is_null() {
        run["root_run_id"]
            .as_i64()
            .and_then(|id| store.agent_run(id).ok())
            .unwrap_or(Value::Null)
    } else {
        run.clone()
    };
    let id = root["group_delivery_id"].as_i64()?;
    let check = || -> Result<(), String> {
        let delivery = store.group_delivery(id)?;
        if delivery["run_id"] != root["id"]
            || delivery["state"] == "cancelled"
            || delivery["state"] == "rejected"
        {
            return Err("群投递已取消或执行关联已变化。".into());
        }
        let chain =
            store.group_chain(root["group_chain_id"].as_str().ok_or("执行缺少协作链。")?)?;
        if let Some(reason) = chain_blocker(&chain) {
            return Err(reason);
        }
        if chain["generation"] != root["group_chain_generation"] {
            return Err("协作代次已失效。".into());
        }
        let group = store.group(root["group_id"].as_i64().ok_or("执行缺少群身份。")?)?;
        if group["archived"] == true || group["project_id"] != root["group_project_id"] {
            return Err("群范围已变更或归档。".into());
        }
        let member = group["members"]
            .as_array()
            .and_then(|members| {
                members
                    .iter()
                    .find(|member| member["agent_id"] == root["agent_id"])
            })
            .ok_or("Agent 已退出群聊。")?;
        if member["receiving"] != true {
            return Err("Agent 已停止接收群消息。".into());
        }
        if let Some(project) = group["project_id"].as_str() {
            if !store
                .memory_projects(root["agent_id"].as_i64().ok_or("Agent 身份无效。")?)?
                .as_array()
                .is_some_and(|projects| {
                    projects
                        .iter()
                        .any(|entry| entry["slug"] == project && entry["joined"] == true)
                })
            {
                return Err("群项目成员资格已撤销。".into());
            }
        }
        if !delivery["adopted"].as_bool().unwrap_or(false) && root["group_adoption"].is_null() {
            if let Some(reason) = crate::groups::delivery_blocker(store, &group, &delivery) {
                return Err(reason);
            }
        }
        if let Some(id) = root["work_item_id"].as_i64() {
            if store.work_item(id)?["cancelled"] == true {
                return Err("关联工作项已取消。".into());
            }
        }
        Ok(())
    };
    check().err()
}
