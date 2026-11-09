use serde_json::{json, Value};
use std::collections::HashSet;
use troop_storage::Store;

pub(crate) fn now_ms() -> i64 {
    crate::group_runtime::now().saturating_mul(1000)
}
pub(crate) fn policy(store: &Store, id: &str) -> Result<Value, String> {
    let value = store.rule_get(id)?;
    if value["kind"] != "followup" {
        return Err("该规则不是跟进策略。".into());
    }
    Ok(value)
}
pub(crate) fn root(store: &Store, run: &Value) -> Result<Value, String> {
    if run["followup_chain_id"].is_string() {
        return Ok(run.clone());
    }
    run["root_run_id"]
        .as_i64()
        .map(|id| store.agent_run(id))
        .transpose()
        .map(|value| value.unwrap_or(Value::Null))
}
pub(crate) fn usage(store: &Store, run: &Value) -> Result<(u64, usize), String> {
    let root = root(store, run)?;
    let Some(id) = root["followup_chain_id"].as_str() else {
        return Ok((0, 0));
    };
    let mut seen = HashSet::new();
    let mut steps = 0;
    let mut tools = 0;
    for origin in store.followup_runs(id)? {
        for run in store.tree_runs(origin["id"].as_i64().ok_or("执行身份无效。")?)? {
            let id = run["id"].as_i64().ok_or("执行身份无效。")?;
            if seen.insert(id) {
                steps += run["step"].as_u64().unwrap_or(0);
                tools += store.agent_invocations(id)?.len();
            }
        }
    }
    Ok((steps, tools))
}
pub(crate) fn run_blocker(store: &Store, run: &Value) -> Option<String> {
    let check = || -> Result<(), String> {
        let root = root(store, run)?;
        let Some(id) = root["followup_chain_id"].as_str() else {
            return Ok(());
        };
        let chain = store.followup_chain(id)?;
        if chain["stopped"] == true || chain["generation"] != root["followup_chain_generation"] {
            return Err("跟进协作链已停止或代次已失效。".into());
        }
        if chain["expires_at_ms"].as_i64().unwrap_or(0) <= now_ms() {
            return Err("跟进协作链期限已到。".into());
        }
        let item = store.work_item(
            root["work_item_id"]
                .as_i64()
                .ok_or("跟进执行缺少工作项。")?,
        )?;
        if item["cancelled"] == true
            || item["generation"].as_i64().unwrap_or(0)
                != root["followup_work_generation"].as_i64().unwrap_or(0)
            || crate::work_items::definition_revision(&item)
                != root["work_definition_revision"].as_i64().unwrap_or(0)
        {
            return Err("跟进工作已取消或定义已变化。".into());
        }
        if root["followup_expires_at_ms"]
            .as_i64()
            .is_some_and(|expiry| expiry <= now_ms())
        {
            return Err("本次跟进执行的冻结期限已到。".into());
        }
        if let Some(origin) = chain["upstream_group_run_id"].as_i64() {
            if let Some(reason) =
                crate::group_runtime::run_blocker(store, &store.agent_run(origin)?)
            {
                return Err(reason);
            }
        }
        Ok(())
    };
    check().err()
}
pub(crate) fn definition(value: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "name",
        "enabled",
        "work_item_id",
        "agent_id",
        "workspace_id",
        "project_id",
        "start",
        "expected_plan_sha256",
        "expires_at_ms",
        "min_interval_ms",
        "max_runs",
        "handoff_policy_ids",
    ] {
        result[key] = value[key].clone();
    }
    if result["handoff_policy_ids"].is_null() {
        result["handoff_policy_ids"] = json!([]);
    }
    result
}
