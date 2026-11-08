use super::*;
use troop_storage::public_task;

pub(super) struct TaskLive {
    pub cancel: Arc<AtomicBool>,
    pub external: bool,
}
pub(super) use troop_protocol::lifecycle::{task_active as active, task_unresolved as unresolved};
fn owned(store: &Store, doc: &Value) -> Result<Vec<Value>, String> {
    Ok(store
        .owned_tasks(Store::task_root(doc))?
        .into_iter()
        .filter(|t| t["owner_run_id"] == doc["id"])
        .collect())
}
impl Manager {
    pub(super) fn has_owned_work(&self, store: &Store, doc: &Value) -> Result<bool, String> {
        Ok(owned(store, doc)?
            .iter()
            .any(|t| active(t) || unresolved(t)))
    }
    pub(super) fn has_unconsumed(&self, store: &Store, doc: &Value) -> Result<bool, String> {
        Ok(owned(store, doc)?
            .iter()
            .any(|t| !active(t) && t["consumed"] != true))
    }
    pub(super) fn retire(&mut self, store: &mut Store, id: i64) -> Result<(), String> {
        if self.begin_mcp_cleanup(store, id)? {
            return Ok(());
        }
        let doc = store.agent_run(id)?;
        self.queue_memory(store, &doc)?;
        if owned(store, &doc)?.iter().any(active) {
            self.stop_subtree(
                store,
                id,
                if doc["intent"] == "failure" {
                    Some("failure")
                } else if doc["intent"] == "cancel" {
                    Some("cancel")
                } else {
                    None
                },
            )?;
        } else {
            self.live.remove(&id);
        }
        Ok(())
    }
    pub(super) fn stop_subtree(
        &mut self,
        store: &mut Store,
        id: i64,
        intent: Option<&str>,
    ) -> Result<(), String> {
        self.flush_subtree_output(store, id)?;
        let running = self.jobs.keys().copied().collect::<Vec<_>>();
        let plan = store.stop_tree(id, intent, &running)?;
        self.cancel_stop_plan(store, plan)
    }
    pub(super) fn flush_subtree_output(&self, store: &mut Store, id: i64) -> Result<(), String> {
        let initial = store.agent_run(id)?;
        let tasks = store.owned_tasks(Store::task_root(&initial))?;
        for run_id in lifecycle::subtree(id, &tasks) {
            if let Some(live) = self.live.get(&run_id).filter(|l| l.model.is_some()) {
                let mut doc = store.agent_run(run_id)?;
                doc["output"] = json!(live.text);
                doc["model_text"] = json!(live.text);
                Self::save(store, &mut doc, "model_text")?;
            }
        }
        Ok(())
    }
    pub(super) fn cancel_stop_plan(
        &mut self,
        store: &mut Store,
        plan: troop_storage::StopPlan,
    ) -> Result<(), String> {
        for run_id in plan.runs {
            let doc = store.agent_run(run_id)?;
            self.cancel_run_hooks(store, run_id)?;
            self.cancel_mcp(store, run_id)?;
            if doc["state"] == "cancelling" {
                let live = self.live.entry(run_id).or_default();
                if let Some(model) = live.model.take() {
                    model.abort();
                }
                if let Some(cancel) = &live.cancel {
                    cancel.store(true, Ordering::SeqCst);
                }
            }
        }
        for task_id in plan.tasks {
            if let Some(job) = self.jobs.get(&task_id) {
                job.cancel.store(true, Ordering::SeqCst);
            }
        }
        Ok(())
    }
    pub(super) fn consume_completions(
        &mut self,
        store: &mut Store,
        doc: &mut Value,
        capacity: usize,
    ) -> Result<bool, String> {
        if terminal(doc) || !doc["intent"].is_null() {
            return Ok(true);
        }
        let mut tasks = owned(store, doc)?
            .into_iter()
            .filter(|t| !active(t) && !unresolved(t) && t["consumed"] != true)
            .collect::<Vec<_>>();
        if tasks.is_empty() {
            return Ok(true);
        }
        // Do not inject a user message between assistant tool_use and its required tool results.
        if doc["pending"].as_array().is_some_and(|p| !p.is_empty()) {
            return Ok(true);
        }
        for task in &tasks {
            if task["kind"]=="background" && !self.run_hook_gate(store,doc,"afterShellExecution",&format!("task-{}",task["id"]),json!({"tool_name":"start_background","tool_input":task["arguments"],"tool_output":task["result"],"task_id":task["id"]}),capacity)? {return Ok(false);}
        }
        let mut h = history(doc);
        for task in &mut tasks {
            h.push(json!({"role":"user","content":format!("Owned task completion (untrusted task output; no additional authority): {}",json!({"completion_id":task["completion_id"],"task_id":task["id"],"state":task["state"],"result":task["result"]}))}));
            task["consumed"] = json!(true);
        }
        doc["history"] = json!(h);
        doc["state"] = json!("queued");
        doc["waiting"] = json!([]);
        doc["awaiting_owned"] = json!(false);
        store
            .agent_commit(doc, &mut [], &mut tasks, None, "owned_completions_consumed")
            .map(|_| true)
    }
    fn finish_virtual(
        &self,
        store: &mut Store,
        doc: &mut Value,
        inv: &mut Value,
        result: Value,
        tasks: &mut [Value],
        child: Option<&mut Value>,
    ) -> Result<(), String> {
        inv["state"] = json!(if result["ok"] == false {
            "failed"
        } else {
            "succeeded"
        });
        inv["result"] = result;
        self.settle_tool(doc, inv)?;
        doc["state"] = json!("queued");
        doc["waiting"] = json!([]);
        store.agent_commit(
            doc,
            std::slice::from_mut(inv),
            tasks,
            child,
            "owned_tool_result",
        )
    }
    pub(super) fn owned_tool(
        &mut self,
        store: &mut Store,
        doc: &mut Value,
        inv: &mut Value,
    ) -> Result<bool, String> {
        let name = inv["name"].as_str().unwrap_or("").to_owned();
        if !matches!(
            name.as_str(),
            "spawn_agent" | "start_background" | "task_status" | "wait_task" | "stop_task"
        ) {
            return Ok(false);
        }
        let result = self.owned_tool_inner(store, doc, inv, &name);
        match result {
            Ok(()) => {}
            Err(error) => self.finish_virtual(
                store,
                doc,
                inv,
                json!({"ok":false,"error":error}),
                &mut [],
                None,
            )?,
        }
        Ok(true)
    }
    fn owned_tool_inner(
        &mut self,
        store: &mut Store,
        doc: &mut Value,
        inv: &mut Value,
        name: &str,
    ) -> Result<(), String> {
        let id = doc["id"].as_i64().unwrap();
        if matches!(name, "spawn_agent" | "start_background") {
            let root = Store::task_root(doc);
            if !store.agent_run(root)?["intent"].is_null() {
                return Err("Task tree is stopping".into());
            }
            let tasks = store.owned_tasks(root)?;
            if tasks.len() >= 8 {
                return Err("Task tree has reached its 8 owned-task limit".into());
            }
            let depth = doc["depth"].as_u64().unwrap_or(0);
            if name == "spawn_agent" && (depth >= 2 || self.live.len() >= 16) {
                return Err("Child depth or active-run capacity reached".into());
            }
            let task_id = inv["id"].as_i64().unwrap();
            let mut task = json!({"id":task_id,"owner_run_id":id,"root_run_id":root,"parent_task_id":doc["owner_task_id"],"epoch":doc["epoch"],"kind":if name=="spawn_agent"{"agent"}else{"background"},"state":"queued","arguments":inv["arguments"],"completion_id":Uuid::new_v4().to_string(),"consumed":false,"stopped":true,"reviewed":false,"stop_requested":false,"result":null});
            if inv["permission_plan"].is_object() {
                task["permission_plan"] = inv["permission_plan"].clone();
            }
            task["title"] = json!(inv["arguments"][if name == "spawn_agent" {
                "goal"
            } else {
                "command"
            }]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(100)
            .collect::<String>());
            task["stopped"] = json!(name != "spawn_agent");
            if name == "spawn_agent" {
                let goal = inv["arguments"]["goal"].as_str().unwrap();
                let mut child = json!({"state":"queued","epoch":1,"revision":0,"step":0,"intent":null,"workspace_id":doc["workspace_id"],"workspace":doc["workspace"],"provider_id":doc["provider_id"],"config":doc["config"],"secret_ref":doc["secret_ref"],"goal":goal,"history":[{"role":"user","content":goal}],"pending":[],"output":"","model_text":"","supplements":[],"waiting":[],"error":null,"owner_task_id":task_id,"root_run_id":root,"depth":depth+1,"read_only":doc["read_only"]==true||inv["arguments"]["access"]=="read_only"});
                child["agent_id"] = doc["agent_id"].as_i64().map_or(json!(1), |id| json!(id));
                child["skill_versions"] = doc["skill_versions"].clone();
                child["hook_snapshot"] = doc["hook_snapshot"].clone();
                child["mcp_snapshot"] = if child["read_only"] == true {
                    json!([])
                } else {
                    doc["mcp_snapshot"].clone()
                };
                child["mcp_catalogue"] = if child["read_only"] == true {
                    json!([])
                } else {
                    doc["mcp_catalogue"].clone()
                };
                let expanded = Self::expand_workflows(store, &mut child, goal, None)?;
                child["history"] = json!([{"role":"user","content":expanded}]);
                self.finish_virtual(
                    store,
                    doc,
                    inv,
                    json!({"ok":true,"task_id":task_id,"state":"queued"}),
                    std::slice::from_mut(&mut task),
                    Some(&mut child),
                )?;
                self.live
                    .insert(child["id"].as_i64().unwrap(), Live::default());
            } else {
                self.finish_virtual(
                    store,
                    doc,
                    inv,
                    json!({"ok":true,"task_id":task_id,"state":"queued"}),
                    std::slice::from_mut(&mut task),
                    None,
                )?;
            }
        } else {
            let task_id = inv["arguments"]["task_id"]
                .as_str()
                .unwrap()
                .parse::<i64>()
                .map_err(|_| "Invalid task ID")?;
            let mut task = store.owned_task(task_id)?;
            if task["owner_run_id"] != id {
                return Err("This run does not own the requested task".into());
            }
            if name == "stop_task" {
                self.stop_one_task(store, &mut task)?;
                self.finish_virtual(
                    store,
                    doc,
                    inv,
                    json!({"ok":true,"task":public_task(&task)}),
                    &mut [],
                    None,
                )?;
            } else if name == "wait_task" && (active(&task) || unresolved(&task)) {
                if doc["waiting"] != json!(["background"]) {
                    doc["state"] = json!("waiting");
                    doc["waiting"] = json!(["background"]);
                    Self::save(store, doc, "waiting_owned")?;
                }
            } else {
                let result = json!({"ok":true,"task":public_task(&task),"output":task["output"],"result":task["result"]});
                if name == "wait_task" {
                    task["consumed"] = json!(true);
                }
                self.finish_virtual(
                    store,
                    doc,
                    inv,
                    result,
                    if name == "wait_task" {
                        std::slice::from_mut(&mut task)
                    } else {
                        &mut []
                    },
                    None,
                )?;
            }
        }
        Ok(())
    }
    fn stop_one_task(&mut self, store: &mut Store, task: &mut Value) -> Result<(), String> {
        if !active(task) {
            return Ok(());
        }
        let id = task["id"].as_i64().unwrap();
        if let Some(child) = task["child_run_id"].as_i64() {
            self.flush_subtree_output(store, child)?;
        }
        let running = self.jobs.keys().copied().collect::<Vec<_>>();
        let (stopped, plan) = store.stop_owned_task(id, &running)?;
        *task = stopped;
        self.cancel_stop_plan(store, plan)
    }
    pub(super) fn task_rpc(
        &mut self,
        store: &mut Store,
        method: &str,
        p: Value,
    ) -> Result<Value, String> {
        if method == "agent.task" {
            return self.task_snapshot(store, params::<Id>(p)?.id);
        }
        if method == "agent.tasks" {
            let doc = store.agent_run(params::<Id>(p)?.id)?;
            return Ok(
                json!({"items":store.owned_tasks(Store::task_root(&doc))?.iter().map(public_task).collect::<Vec<_>>()}),
            );
        }
        if method == "agent.reconcile-task" {
            let a = params::<Reconcile>(p)?;
            let mut record = store.owned_task(a.id)?;
            let evidence = if a.source == "receipt"
                && !matches!(record["kind"].as_str(), Some("background" | "external_cli"))
            {
                Evidence::Invalid
            } else {
                self.reconciliation_evidence(&a, true)?
            };
            if record["kind"] == "external_cli" && a.source == "receipt" {
                let mut owner = store.agent_run(
                    record["owner_run_id"]
                        .as_i64()
                        .ok_or("作业缺少执行归属。")?,
                )?;
                lifecycle::reconcile_task(&owner, &mut record, a.epoch, true, evidence)?;
                record["receipt_reconciled"] = json!(true);
                record["reviewed"] = json!(false);
                let result = record["result"].clone();
                Self::finish_external(store, &mut owner, &mut record, result)?;
                return Ok(public_task(&record));
            }
            let task = store.reconcile_task(a.id, a.epoch, evidence)?;
            return Ok(public_task(&task));
        }
        let mut task = store.owned_task(params::<Id>(p)?.id)?;
        if method == "agent.stop-task" {
            self.stop_one_task(store, &mut task)?;
        }
        if !task["result"].is_null() && task["result"]["value"].is_object() {
            task.as_object_mut().unwrap().remove("output");
        }
        Ok(task)
    }
    pub(super) fn pump_tasks(
        &mut self,
        store: &mut Store,
        model_capacity: usize,
    ) -> Result<(), String> {
        for root in store.active_task_roots()? {
            for mut task in store.owned_tasks(root)? {
                if task["kind"] == "agent" && active(&task) {
                    let child = store.agent_run(task["child_run_id"].as_i64().unwrap())?;
                    if lifecycle::complete_child(&mut task, &child) {
                        let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
                        store.agent_commit(
                            &mut owner,
                            &mut [],
                            std::slice::from_mut(&mut task),
                            None,
                            "child_finished",
                        )?;
                        if task["state"] == "interrupted"
                            && !terminal(&owner)
                            && owner["state"] != "cancelling"
                        {
                            self.stop_subtree(store, owner["id"].as_i64().unwrap(), None)?;
                        }
                    }
                }
                if task["kind"] == "external_cli" && task["state"] == "queued" {
                    if self.model_count() >= model_capacity {
                        continue;
                    }
                    let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
                    if !terminal(&owner)
                        && owner["intent"].is_null()
                        && owner["state"] != "cancelling"
                    {
                        self.pump_external_task(store, &mut owner, &mut task)?;
                    }
                    continue;
                }
                if task["kind"] != "background" || task["state"] != "queued" {
                    continue;
                }
                let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
                if terminal(&owner) || !owner["intent"].is_null() || owner["state"] == "cancelling"
                {
                    continue;
                }
                if self.execution.blocked(store)? {
                    continue;
                }
                let current = std::fs::canonicalize(
                    store.workspace_path(owner["workspace_id"].as_i64().unwrap())?,
                );
                if current.as_ref().ok()
                    != Some(&PathBuf::from(owner["workspace"].as_str().unwrap()))
                {
                    task["state"] = json!("failed");
                    task["result"] =
                        json!({"ok":false,"error":"Workspace target changed; nothing dispatched"});
                    store.agent_commit(
                        &mut owner,
                        &mut [],
                        std::slice::from_mut(&mut task),
                        None,
                        "background_rejected",
                    )?;
                    continue;
                }
                task["state"] = json!("dispatched");
                task["stopped"] = json!(false);
                let task_id = task["id"].as_i64().unwrap();
                let epoch = task["epoch"].as_i64().unwrap();
                let execution = ExecutionOwner::new(
                    owner["id"].as_i64().unwrap(),
                    epoch,
                    ExecutionWork::Task(task_id),
                );
                if self
                    .execution
                    .dispatch(store, |store| {
                        store.agent_commit(
                            &mut owner,
                            &mut [],
                            std::slice::from_mut(&mut task),
                            None,
                            "background_dispatched",
                        )?;
                        Ok(execution)
                    })?
                    .is_none()
                {
                    continue;
                }
                let work = tools::Work {
                    sandbox: task["permission_plan"]["sandbox"].clone(),
                    id: task_id,
                    epoch,
                    workspace: owner["workspace"].as_str().unwrap().into(),
                    name: "start_background".into(),
                    arguments: task["arguments"].clone(),
                    receipt: self.receipts.join(format!("task-{task_id}-{epoch}.json")),
                    job_handle: 0,
                };
                let flag = Arc::new(AtomicBool::new(false));
                self.jobs.insert(
                    task_id,
                    TaskLive {
                        cancel: flag.clone(),
                        external: false,
                    },
                );
                let updates = self.sender.clone();
                let provider = self.providers.tools.clone();
                std::thread::spawn(move || {
                    let ready = updates.clone();
                    let progress = updates.clone();
                    let result = provider.execute(
                        work,
                        flag,
                        Box::new(move |gate| {
                            let _ = ready.blocking_send(Update::TaskReady(task_id, epoch, gate));
                        }),
                        Box::new(move |output| {
                            let _ = progress.try_send(Update::TaskOutput(task_id, epoch, output));
                        }),
                    );
                    let _ = updates.blocking_send(Update::TaskDone(task_id, epoch, result));
                });
            }
        }
        Ok(())
    }
    pub(super) fn accept_task(&mut self, store: &mut Store, update: Update) -> Result<(), String> {
        let (id, epoch) = match &update {
            Update::TaskReady(i, e, _)
            | Update::TaskOutput(i, e, _)
            | Update::TaskDone(i, e, _)
            | Update::TaskInteraction(i, e, ..) => (*i, *e),
            _ => unreachable!(),
        };
        let mut task = store.owned_task(id)?;
        if task["epoch"] != epoch || !self.jobs.contains_key(&id) {
            return Ok(());
        }
        let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
        let execution = ExecutionOwner::new(
            owner["id"].as_i64().unwrap(),
            epoch,
            ExecutionWork::Task(id),
        );
        if !self.execution.owns(execution) {
            return Ok(());
        }
        match update {
            Update::TaskInteraction(_, _, request, sender) => {
                return self.receive_interaction(store, id, epoch, request, sender)
            }
            Update::TaskReady(_, _, gate) => {
                if task["stop_requested"] == true
                    || !owner["intent"].is_null()
                    || owner["state"] == "cancelling"
                    || terminal(&owner)
                {
                    let _ = gate.send(false);
                    return Ok(());
                }
                if let Some(reason) = self.authorization_blocker(store, &owner) {
                    task["dispatch_denied"] = json!(reason);
                    store.agent_commit(
                        &mut owner,
                        &mut [],
                        std::slice::from_mut(&mut task),
                        None,
                        "task_dispatch_denied",
                    )?;
                    let _ = gate.send(false);
                    return Ok(());
                }
                if task["kind"] == "external_cli" {
                    let authorized = Self::external_authorized(store, &owner).and_then(|_| {
                        let plan = &task["permission_plan"];
                        let program =
                            PathBuf::from(plan["program"].as_str().ok_or("CLI 程序计划无效。")?);
                        if program.canonicalize().ok() != Some(program.clone())
                            || external::program_hash(&program)? != plan["program_sha256"]
                        {
                            return Err("CLI 程序身份在派发前发生变化。".into());
                        }
                        Ok(())
                    });
                    if let Err(reason) = authorized {
                        task["dispatch_denied"] = json!(reason);
                        store.agent_commit(
                            &mut owner,
                            &mut [],
                            std::slice::from_mut(&mut task),
                            None,
                            "cli_dispatch_denied",
                        )?;
                        let _ = gate.send(false);
                        return Ok(());
                    }
                }
                task["state"] = json!("running");
                let allowed = self.execution.ready(execution, true, || {
                    store.agent_commit(
                        &mut owner,
                        &mut [],
                        std::slice::from_mut(&mut task),
                        None,
                        "background_accepted",
                    )
                })?;
                let _ = gate.send(allowed);
            }
            Update::TaskOutput(_, _, output) => {
                if let Some(key) = output["interaction_sent"].as_str() {
                    return self.interaction_sent(store, &mut task, &mut owner, key, false);
                }
                if let Some(key) = output["interaction_host_ack"].as_str() {
                    return self.interaction_sent(store, &mut task, &mut owner, key, true);
                }
                if task["kind"] == "external_cli" {
                    if let Some(text) = output["text"].as_str() {
                        owner["output"] = json!(text);
                    }
                }
                task["output"] = output;
                store.agent_commit(
                    &mut owner,
                    &mut [],
                    std::slice::from_mut(&mut task),
                    None,
                    "background_output",
                )?;
            }
            Update::TaskDone(_, _, result) => {
                if task["kind"] == "external_cli" {
                    self.cli_waiters.remove(&id);
                    let mut result = result;
                    if !task["dispatch_denied"].is_null() && result["stopped"] == true {
                        result["indeterminate"] = json!(false);
                        result["error"] = task["dispatch_denied"].clone();
                    }
                    self.execution.finish(execution, || {
                        Self::finish_external(store, &mut owner, &mut task, result)
                    })?;
                    self.jobs.remove(&id);
                    return Ok(());
                }
                let mut result = result;
                if task["dispatch_denied"].is_string() && result["stopped"] == true {
                    result["indeterminate"] = json!(false);
                    result["ok"] = json!(false);
                    result["error"] = task["dispatch_denied"].clone();
                }
                lifecycle::complete_background(&mut task, result);
                self.execution.finish(execution, || {
                    store.agent_commit(
                        &mut owner,
                        &mut [],
                        std::slice::from_mut(&mut task),
                        None,
                        "background_finished",
                    )
                })?;
                self.jobs.remove(&id);
                if unresolved(&task) && !terminal(&owner) && owner["state"] != "cancelling" {
                    self.stop_subtree(store, owner["id"].as_i64().unwrap(), None)?;
                }
            }
            _ => unreachable!(),
        }
        Ok(())
    }
}
