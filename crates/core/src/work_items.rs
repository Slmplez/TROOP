use crate::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use troop_storage::{OperationFailure, Store};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    title: String,
    goal: String,
    acceptance: String,
    owner_agent_id: i64,
    workspace_id: i64,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    dependency_ids: Vec<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    id: Option<i64>,
    expected_revision: i64,
    item: Definition,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {
    id: i64,
    expected_revision: i64,
    archived: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: i64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Query {
    before: Option<i64>,
    owner_agent_id: Option<i64>,
    workspace_id: Option<i64>,
    project_id: Option<String>,
    #[serde(default)]
    archived: bool,
}
fn references_current(store: &Store, item: &Value) -> Result<(), String> {
    let owner = item["owner_agent_id"].as_i64().ok_or("负责 Agent 无效。")?;
    store.memory_agent(owner)?;
    store.workspace_path(item["workspace_id"].as_i64().ok_or("工作区无效。")?)?;
    if let Some(project) = item["project_id"].as_str() {
        if !store
            .memory_projects(owner)?
            .as_array()
            .is_some_and(|projects| {
                projects
                    .iter()
                    .any(|entry| entry["slug"] == project && entry["joined"] == true)
            })
        {
            return Err("负责 Agent 尚未加入指定项目。".into());
        }
    }
    Ok(())
}
pub(crate) fn check_revision(
    previous: Option<&Value>,
    expected: i64,
) -> Result<(), OperationFailure> {
    let current = previous
        .and_then(|item| item["revision"].as_i64())
        .unwrap_or(0);
    if expected < 0 || expected != current {
        return Err(OperationFailure {
            kind: "revision_conflict",
            message: "工作项已变化，请刷新并核对草稿。".into(),
            current_revision: Some(current),
        });
    }
    Ok(())
}
pub(crate) fn completed(item: &Value) -> bool {
    item["cancelled"] != true
        && item["accepted"]["definition_revision"]
            .as_i64()
            .is_some_and(|revision| revision == definition_revision(item))
}
pub(crate) fn definition_revision(item: &Value) -> i64 {
    item["definition_revision"].as_i64().unwrap_or(1)
}
pub(crate) fn current_run(store: &Store, item: &Value) -> Result<Option<Value>, String> {
    item["current_run_id"]
        .as_i64()
        .map(|id| store.agent_run(id))
        .transpose()
}
fn run_blocks(run: &Value) -> bool {
    !troop_protocol::lifecycle::run_final(run)
}
pub(crate) fn start_blocker(store: &Store, item: &Value) -> Option<String> {
    start_blocker_with_policy(store, item, false)
}
pub(crate) fn followup_start_blocker(store: &Store, item: &Value) -> Option<String> {
    if current_run(store, item)
        .ok()
        .flatten()
        .is_some_and(|run| matches!(run["state"].as_str(), Some("failed" | "cancelled")))
    {
        return Some("前次执行已失败或取消，请明确重新交办。".into());
    }
    start_blocker_with_policy(store, item, true)
}
fn start_blocker_with_policy(store: &Store, item: &Value, continuing: bool) -> Option<String> {
    if item["cancelled"] == true {
        return Some("工作项已取消。".into());
    }
    if item["archived"] == true {
        return Some("请先恢复已归档的工作项。".into());
    }
    if completed(item) {
        return Some("当前目标已接纳完成。修改目标后可重新执行。".into());
    }
    if let Err(error) = references_current(store, item) {
        return Some(error);
    }
    match current_run(store, item) {
        Err(error) => return Some(error),
        Ok(Some(run)) if run_blocks(&run) => {
            return Some("当前执行尚未结束或等待核对／结果审核。".into())
        }
        Ok(Some(run))
            if !continuing
                && run["state"] == "completed"
                && run["work_definition_revision"] == definition_revision(item)
                && item["accepted"].is_null() =>
        {
            return Some("当前结果等待工作验收。".into())
        }
        _ => {}
    }
    dependency_blocker(store, item)
}
pub(crate) fn dependency_blocker(store: &Store, item: &Value) -> Option<String> {
    for id in item["dependency_ids"].as_array().into_iter().flatten() {
        let dependency = id.as_i64().and_then(|id| store.work_item(id).ok());
        if !dependency.as_ref().is_some_and(completed) {
            return Some(format!("等待前置工作项 #{id} 接纳完成。"));
        }
    }
    None
}
pub(crate) fn result(store: &Store, item: &Value, link: &Value) -> Result<Value, String> {
    let run = store.agent_run(link["run_id"].as_i64().ok_or("执行关联损坏。")?)?;
    let task = if run["kind"] == "external_cli" {
        store
            .owned_tasks(run["id"].as_i64().unwrap())?
            .into_iter()
            .find(|task| task["owner_run_id"] == run["id"] && task["kind"] == "external_cli")
    } else {
        None
    };
    let evidence = task.as_ref().map(|task|task["evidence"]["sha256"].clone()).unwrap_or_else(|| json!(crate::tools::hash(json!({"run_id":run["id"],"epoch":run["epoch"],"revision":run["revision"],"output":run["output"]}).to_string().as_bytes())));
    let valid_external = run["kind"] != "external_cli"
        || task.as_ref().is_some_and(|task| {
            task["reviewed"] == true
                && task["review"]["accepted"] == true
                && task["review"]["evidence_sha256"] == evidence
                && task["stopped"] == true
        });
    let allowed = item["cancelled"] != true
        && item["archived"] != true
        && item["current_run_id"] == run["id"]
        && link["generation"].as_i64().unwrap_or(0) == item["generation"].as_i64().unwrap_or(0)
        && link["definition_revision"] == definition_revision(item)
        && run["state"] == "completed"
        && run["intent"].is_null()
        && valid_external
        && evidence.as_str().is_some_and(|hash| hash.len() == 64)
        && references_current(store, item).is_ok()
        && dependency_blocker(store, item).is_none()
        && !completed(item);
    let text = task
        .as_ref()
        .map(|task| task["evidence"]["result"]["text"].as_str().unwrap_or(""))
        .unwrap_or_else(|| run["output"].as_str().unwrap_or(""));
    let mut summary = json!({});
    for key in [
        "id", "state", "epoch", "revision", "kind", "intent", "waiting",
    ] {
        summary[key] = run[key].clone();
    }
    if summary["kind"].is_null() {
        summary["kind"] = json!("agent");
    }
    summary["title"] = json!(run["goal"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(80)
        .collect::<String>());
    Ok(
        json!({"run":summary,"work_item_id":link["work_item_id"],"definition_revision":link["definition_revision"],"generation":link["generation"],"task_id":task.as_ref().map(|task|task["id"].clone()),"evidence_sha256":evidence,"text":text.chars().take(500).collect::<String>(),"text_truncated":text.chars().count()>500,"acceptance":link["acceptance"],"allowed_actions":{"accept":{"allowed":allowed,"reason":if allowed {None} else {Some("请核对当前工作、执行版本及外部固定证据审核。")}}}}),
    )
}
pub(crate) fn public(store: &Store, mut item: Value) -> Value {
    if item["dependency_ids"].is_null() {
        item["dependency_ids"] = json!([]);
    }
    item["definition_revision"] = json!(definition_revision(&item));
    item["cancelled"] = json!(item["cancelled"] == true);
    item["generation"] = json!(item["generation"].as_i64().unwrap_or(0));
    let run = current_run(store, &item).ok().flatten();
    let blocker = start_blocker(store, &item);
    let busy = run.as_ref().is_some_and(run_blocks);
    let state = if item["cancelled"] == true {
        "cancelled"
    } else if completed(&item) {
        "completed"
    } else if let Some(run) = run
        .as_ref()
        .filter(|run| run["work_definition_revision"] == definition_revision(&item))
    {
        match run["state"].as_str() {
            Some("completed") => "awaiting_acceptance",
            Some("failed" | "cancelled") => "failed",
            Some("interrupted") => "reconciliation",
            _ if run["waiting"]
                .as_array()
                .is_some_and(|wait| !wait.is_empty()) =>
            {
                "waiting"
            }
            _ => "running",
        }
    } else if blocker.is_some() {
        "blocked"
    } else {
        "ready"
    };
    item["progress"] = json!({"state":state,"reason":blocker});
    let archived = item["archived"] == true;
    let restore_error = references_current(store, &item).err();
    item["allowed_actions"] = json!({
        "save":{"allowed":!archived && !busy && item["cancelled"] != true,"reason":if archived || busy || item["cancelled"] == true {Some("请先处理归档、取消或当前执行。") } else {None}},
        "archive":{"allowed":!archived && !busy,"reason":if archived || busy {Some("工作项已归档或当前执行尚未结束。") } else {None}},
        "restore":{"allowed":archived && restore_error.is_none(),"reason":if !archived {Some("工作项尚未归档。".to_owned())} else {restore_error}},
        "start":{"allowed":blocker.is_none(),"reason":blocker},
        "cancel":{"allowed":item["cancelled"] != true && !archived && !completed(&item),"reason":if item["cancelled"] == true || archived || completed(&item) {Some("工作项已结束或归档。") } else {None}}
    });
    item
}
pub(crate) fn read(store: &Store, method: &str, input: Value) -> Result<Value, String> {
    match method {
        "work_items.runs" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Runs {
                id: i64,
                before: Option<i64>,
            }
            let query = params::<Runs>(input)?;
            let item = store.work_item(query.id)?;
            let mut page = store.work_item_runs(query.id, query.before)?;
            let links = page["items"].as_array().unwrap();
            let mut results = Vec::new();
            let mut bytes = 0;
            for link in links {
                let projected = result(store, &item, link)?;
                let size = projected.to_string().len();
                if bytes + size > 30_000 && !results.is_empty() {
                    break;
                }
                bytes += size;
                results.push(projected);
            }
            if results.len() < links.len() {
                page["next_before"] = results.last().unwrap()["run"]["id"].clone();
            }
            page["items"] = json!(results);
            Ok(page)
        }
        "work_items.get" => {
            let query = params::<Id>(input)?;
            Ok(public(store, store.work_item(query.id)?))
        }
        "work_items.list" => {
            let query = params::<Query>(input)?;
            if [query.before, query.owner_agent_id, query.workspace_id]
                .into_iter()
                .flatten()
                .any(|id| id <= 0)
                || query
                    .project_id
                    .as_ref()
                    .is_some_and(|id| id.is_empty() || id.len() > 100)
            {
                return Err("工作项筛选无效。".into());
            }
            let mut page = store
                .work_items(&serde_json::to_value(query).map_err(|error| error.to_string())?)?;
            for item in page["items"].as_array_mut().unwrap() {
                *item = public(store, item.clone());
            }
            Ok(page)
        }
        _ => Err("工作项变更需要操作账本。".into()),
    }
}
pub(crate) fn write(
    store: &mut Store,
    method: &str,
    input: Value,
) -> Result<Value, OperationFailure> {
    let (item, previous) = match method {
        "work_items.save" => {
            let request = params::<Save>(input)?;
            let previous = request.id.map(|id| store.work_item(id)).transpose()?;
            check_revision(previous.as_ref(), request.expected_revision)?;
            if previous.as_ref().is_some_and(|item| {
                public(store, item.clone())["allowed_actions"]["save"]["allowed"] != true
            }) {
                return Err("请先处理归档、取消或当前执行。".to_owned().into());
            }
            let mut definition = request.item;
            definition.title = definition.title.trim().to_owned();
            definition.goal = definition.goal.trim().to_owned();
            definition.acceptance = definition.acceptance.trim().to_owned();
            if definition.title.is_empty()
                || definition.title.len() > 480
                || definition.goal.is_empty()
                || definition.goal.len() > 4000
                || definition.acceptance.is_empty()
                || definition.acceptance.len() > 4000
                || definition
                    .project_id
                    .as_ref()
                    .is_some_and(|id| id.is_empty() || id.len() > 100)
            {
                return Err("工作项标题、目标或验收条件无效或超过容量。"
                    .to_owned()
                    .into());
            }
            let mut item = serde_json::to_value(definition).map_err(|error| error.to_string())?;
            validate_dependencies(store, request.id, &item)?;
            references_current(store, &item)?;
            item["archived"] = json!(false);
            item["definition_revision"] =
                json!(previous.as_ref().map(definition_revision).unwrap_or(0) + 1);
            for key in ["current_run_id", "generation", "cancelled", "accepted"] {
                item[key] = previous
                    .as_ref()
                    .map(|old| old[key].clone())
                    .unwrap_or(Value::Null);
            }
            (item, previous)
        }
        "work_items.archive" => {
            let request = params::<Archive>(input)?;
            let previous = store.work_item(request.id)?;
            check_revision(Some(&previous), request.expected_revision)?;
            if request.archived
                && public(store, previous.clone())["allowed_actions"]["archive"]["allowed"] != true
            {
                return Err("当前执行尚未结束或已归档。".to_owned().into());
            }
            let mut item = previous.clone();
            if !request.archived {
                references_current(store, &item)?;
            }
            item["archived"] = json!(request.archived);
            (item, Some(previous))
        }
        _ => return Err("未知工作项命令。".to_owned().into()),
    };
    let saved = store.save_work_item(item, previous.as_ref())?;
    Ok(public(store, saved))
}
fn validate_dependencies(store: &Store, id: Option<i64>, item: &Value) -> Result<(), String> {
    use std::collections::HashSet;
    let dependencies = item["dependency_ids"].as_array().ok_or("依赖无效。")?;
    if dependencies.len() > 32 {
        return Err("最多关联 32 个前置工作项。".into());
    }
    let mut direct = HashSet::new();
    let mut pending = Vec::new();
    for dependency in dependencies {
        let dependency = dependency
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or("依赖身份无效。")?;
        if !direct.insert(dependency) {
            return Err("依赖不能重复。".into());
        }
        pending.push(dependency);
    }
    let mut visited = HashSet::new();
    while let Some(dependency) = pending.pop() {
        if Some(dependency) == id {
            return Err("工作项依赖不能成环。".into());
        }
        if !visited.insert(dependency) {
            continue;
        }
        if visited.len() > 4096 {
            return Err("依赖图超过核对容量。".into());
        }
        let target = store.work_item(dependency)?;
        pending.extend(
            target["dependency_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_i64),
        );
    }
    Ok(())
}
