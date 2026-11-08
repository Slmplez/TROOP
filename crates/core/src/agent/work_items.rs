use super::*;
use crate::work_items as work;
use troop_storage::{OperationFailure, StopPlan};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    id: i64,
    expected_revision: i64,
    execution: Launch,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Launch {
    Agent {
        provider_id: String,
        authorization_id: Option<String>,
    },
    Cli {
        engine_id: String,
        authorization_id: String,
        tool_mode: Option<String>,
        approval_mode: Option<String>,
        expected_plan_sha256: Option<String>,
        native_transport: Option<String>,
    },
}
fn launch_input(item: &Value, execution: &Launch, client_id: &str) -> (String, Value) {
    let mut input = json!({
        "client_run_id": client_id,
        "workspace_id": item["workspace_id"],
        "agent_id": item["owner_agent_id"],
        "project_ids": item["project_id"].as_str().map(|id|vec![id]).unwrap_or_default(),
        "goal": format!("{}\n\n验收条件\n{}",item["goal"].as_str().unwrap_or(""),item["acceptance"].as_str().unwrap_or(""))
    });
    let mut launch = serde_json::to_value(execution).unwrap();
    let method = if matches!(execution, Launch::Cli { .. }) {
        "cli.start"
    } else {
        "agent.start"
    };
    launch.as_object_mut().unwrap().remove("kind");
    input.as_object_mut().unwrap().extend(
        launch
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, value)| !value.is_null())
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    (method.into(), input)
}
impl Manager {
    pub(crate) fn preview_work_item(&self, store: &Store, input: Value) -> Result<Value, String> {
        let request = params::<Request>(input)?;
        let item = store.work_item(request.id)?;
        work::check_revision(Some(&item), request.expected_revision)
            .map_err(|error| error.message)?;
        if let Some(reason) = work::start_blocker(store, &item) {
            return Err(reason);
        }
        let (method, input) = launch_input(&item, &request.execution, &Uuid::new_v4().to_string());
        if method != "cli.start" {
            return Err("原生执行使用所选模型与既有工具授权。".into());
        }
        self.preview_external(store, input)
    }
    pub(super) fn execute_work_item(
        &mut self,
        store: &mut Store,
        method: &str,
        input: Value,
    ) -> Result<(Value, Option<i64>, Option<StopPlan>), OperationFailure> {
        if method == "work_items.start" {
            let (item, id) = self.start_linked_work(store, input, None)?;
            return Ok((item, Some(id), None));
        }
        self.decide_work_item(store, method, input)
    }
    pub(super) fn start_linked_work(
        &mut self,
        store: &mut Store,
        input: Value,
        context: Option<&str>,
    ) -> Result<(Value, i64), OperationFailure> {
        let request = params::<Request>(input)?;
        let old = store.work_item(request.id)?;
        work::check_revision(Some(&old), request.expected_revision)?;
        if let Some(reason) = work::start_blocker(store, &old) {
            return Err(reason.into());
        }
        let (method, mut launch) =
            launch_input(&old, &request.execution, &Uuid::new_v4().to_string());
        if let Some(context) = context {
            launch["goal"] = json!(format!(
                "{}\n\n{}",
                launch["goal"].as_str().unwrap_or(""),
                context
            ));
        }
        if method == "cli.start" && launch["expected_plan_sha256"].as_str().is_none() {
            return Err("请先预览并确认 CLI 权限计划。".to_owned().into());
        }
        let started = self.apply_record_command(store, &method, launch)?;
        let id = started["run"]["id"]
            .as_i64()
            .ok_or_else(|| "执行身份缺失。".to_owned())?;
        let item = self.link_started_work(store, &old, id)?;
        Ok((item, id))
    }
    pub(super) fn link_started_work(
        &self,
        store: &mut Store,
        old: &Value,
        id: i64,
    ) -> Result<Value, OperationFailure> {
        let mut run = store.agent_run(id)?;
        run["work_item_id"] = old["id"].clone();
        run["work_definition_revision"] = json!(work::definition_revision(old));
        store.agent_save(&mut run, &mut [], "work_item_linked")?;
        store.save_work_item_run(&json!({"run_id":id,"work_item_id":old["id"],"definition_revision":work::definition_revision(old),"generation":old["generation"].as_i64().unwrap_or(0),"acceptance":null}))?;
        let mut item = old.clone();
        item["current_run_id"] = json!(id);
        item["accepted"] = Value::Null;
        let item = store.save_work_item(item, Some(old))?;
        Ok(work::public(store, item))
    }
    fn decide_work_item(
        &mut self,
        store: &mut Store,
        method: &str,
        input: Value,
    ) -> Result<(Value, Option<i64>, Option<StopPlan>), OperationFailure> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Decision {
            id: i64,
            expected_revision: i64,
            run_id: Option<i64>,
            expected_run_revision: Option<i64>,
            evidence_sha256: Option<String>,
            note: Option<String>,
        }
        let request = params::<Decision>(input)?;
        let old = store.work_item(request.id)?;
        work::check_revision(Some(&old), request.expected_revision)?;
        let mut item = old.clone();
        let mut stop = None;
        match method {
            "work_items.accept" => {
                let run_id = request
                    .run_id
                    .ok_or_else(|| "请选择结果执行。".to_owned())?;
                let mut link = store.work_item_run(run_id)?;
                if link["work_item_id"] != old["id"] {
                    return Err("结果不属于此工作项。".to_owned().into());
                }
                let result = work::result(store, &old, &link)?;
                if result["allowed_actions"]["accept"]["allowed"] != true
                    || result["run"]["revision"].as_i64() != request.expected_run_revision
                    || result["evidence_sha256"].as_str() != request.evidence_sha256.as_deref()
                {
                    return Err("结果证据或执行版本已变化。".to_owned().into());
                }
                let note = request
                    .note
                    .filter(|note| text_ok(note) && note.len() <= 2000)
                    .ok_or_else(|| "请填写不超过 2000 字节的验收说明。".to_owned())?;
                let acceptance = json!({"run_id":run_id,"definition_revision":work::definition_revision(&old),"run_revision":request.expected_run_revision,"evidence_sha256":request.evidence_sha256,"note":note});
                link["acceptance"] = acceptance.clone();
                store.save_work_item_run(&link)?;
                item["accepted"] = acceptance;
            }
            "work_items.cancel" => {
                if work::public(store, old.clone())["allowed_actions"]["cancel"]["allowed"] != true
                {
                    return Err("工作项已结束或归档。".to_owned().into());
                }
                item["cancelled"] = json!(true);
                item["generation"] = json!(old["generation"].as_i64().unwrap_or(0) + 1);
                if let Some(run) = work::current_run(store, &old)? {
                    let id = run["id"].as_i64().unwrap();
                    if !lifecycle::run_final(&run) {
                        self.flush_subtree_output(store, id)?;
                        stop = Some(store.stop_tree(
                            id,
                            Some("cancel"),
                            &self.jobs.keys().copied().collect::<Vec<_>>(),
                        )?);
                        store.request_run_stop(id, true)?;
                    }
                }
            }
            _ => return Err("未知工作执行命令。".to_owned().into()),
        }
        let item = store.save_work_item(item, Some(&old))?;
        if method == "work_items.accept" {
            store.record_work_acceptance(&item)?;
        }
        Ok((work::public(store, item), None, stop))
    }
}
