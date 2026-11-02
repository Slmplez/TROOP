use super::*;
use troop_storage::public_task;

pub(super) struct TaskLive {
    pub cancel: Arc<AtomicBool>,
}
pub(super) fn active(t: &Value) -> bool {
    matches!(
        t["state"].as_str(),
        Some("queued" | "dispatched" | "running" | "cancelling")
    )
}
fn unresolved(t: &Value) -> bool {
    matches!(t["state"].as_str(), Some("indeterminate" | "interrupted")) && t["reviewed"] != true
}
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
        let mut initial = store.agent_run(id)?;
        let tasks = store.owned_tasks(Store::task_root(&initial))?;
        let mut ids = vec![id];
        loop {
            let old = ids.len();
            for task in &tasks {
                if ids.contains(&task["owner_run_id"].as_i64().unwrap()) {
                    if let Some(child) = task["child_run_id"].as_i64() {
                        if !ids.contains(&child) {
                            ids.push(child);
                        }
                    }
                }
            }
            if old == ids.len() {
                break;
            }
        }
        for run_id in &ids {
            if let Some(live) = self.live.get(run_id).filter(|l| l.model.is_some()) {
                let mut doc = store.agent_run(*run_id)?;
                doc["output"] = json!(live.text);
                doc["model_text"] = json!(live.text);
                Self::save(store, &mut doc, "model_text")?;
            }
        }
        // A failure is only terminal after all of its owned work has stopped.
        if initial["state"] == "failed"
            && tasks
                .iter()
                .any(|t| ids.contains(&t["owner_run_id"].as_i64().unwrap()) && active(t))
        {
            initial["state"] = json!("cancelling");
            Self::save(store, &mut initial, "failure_cleanup")?;
        }
        store.fence_runs(&ids, intent)?;
        for run_id in &ids {
            let doc = store.agent_run(*run_id)?;
            self.cancel_run_hooks(store, *run_id)?;
            if doc["state"] == "cancelling" {
                let live = self.live.entry(*run_id).or_default();
                if let Some(model) = live.model.take() {
                    model.abort();
                }
                if let Some(cancel) = &live.cancel {
                    cancel.store(true, Ordering::SeqCst);
                }
            }
        }
        for mut task in tasks {
            if !ids.contains(&task["owner_run_id"].as_i64().unwrap()) || !active(&task) {
                continue;
            }
            task["stop_requested"] = json!(true);
            if task["kind"] == "background" {
                if let Some(job) = self.jobs.get(&task["id"].as_i64().unwrap()) {
                    job.cancel.store(true, Ordering::SeqCst);
                    task["state"] = json!("cancelling");
                } else {
                    task["state"] = json!("cancelled");
                    task["stopped"] = json!(true);
                    task["result"] = json!({"ok":false,"error":"Cancelled before dispatch"});
                }
            }
            let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
            store.agent_commit(
                &mut owner,
                &mut [],
                std::slice::from_mut(&mut task),
                None,
                "owned_stop_requested",
            )?;
        }
        Ok(())
    }
    pub(super) fn check_resume_tasks(&self, store: &Store, doc: &Value) -> Result<(), String> {
        if let Some(task_id) = doc["owner_task_id"].as_i64() {
            let task = store.owned_task(task_id)?;
            let owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
            if terminal(&owner)
                || !owner["intent"].is_null()
                || task["consumed"] == true
                || task["reviewed"] == true
                || task["stop_requested"] == true
            {
                return Err("Resume the owner first; cancelled or acknowledged child work cannot be restarted".into());
            }
        }
        for task in owned(store, doc)? {
            if active(&task) || unresolved(&task) {
                return Err("Reconcile all owned tasks before continuing; previous jobs will not be replayed".into());
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
        Self::settle_tool(doc, inv)?;
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
            Err(error) => Self::finish_virtual(
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
                let expanded = Self::expand_workflows(store, &mut child, goal, None)?;
                child["history"] = json!([{"role":"user","content":expanded}]);
                Self::finish_virtual(
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
                Self::finish_virtual(
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
                Self::finish_virtual(
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
                Self::finish_virtual(
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
        task["stop_requested"] = json!(true);
        let child = task["child_run_id"].as_i64();
        let running = self.jobs.contains_key(&task["id"].as_i64().unwrap());
        if child.is_some() || running {
            task["state"] = json!("cancelling");
        } else {
            task["state"] = json!("cancelled");
            task["stopped"] = json!(true);
            task["result"] = json!({"ok":false,"error":"Cancelled before dispatch"});
        }
        let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
        store.agent_commit(
            &mut owner,
            &mut [],
            std::slice::from_mut(task),
            None,
            "owned_stop_requested",
        )?;
        if let Some(child) = child {
            self.stop_subtree(store, child, Some("cancel"))?;
        }
        if let Some(job) = self.jobs.get(&task["id"].as_i64().unwrap()) {
            job.cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    pub(super) fn task_rpc(
        &mut self,
        store: &mut Store,
        method: &str,
        p: Value,
    ) -> Result<Value, String> {
        if method == "agent.tasks" {
            let doc = store.agent_run(params::<Id>(p)?.id)?;
            return Ok(
                json!({"items":store.owned_tasks(Store::task_root(&doc))?.iter().map(public_task).collect::<Vec<_>>()}),
            );
        }
        if method == "agent.reconcile-task" {
            let a = params::<Reconcile>(p)?;
            let mut task = store.owned_task(a.id)?;
            let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
            if task["epoch"] != a.epoch || !unresolved(&task) || !terminal(&owner) {
                return Err("Task is not available for reconciliation".into());
            }
            if task["kind"] == "agent" {
                let child = store.agent_run(task["child_run_id"].as_i64().unwrap())?;
                if store
                    .agent_invocations(child["id"].as_i64().unwrap())?
                    .iter()
                    .any(|i| i["state"] == "indeterminate" && i["reviewed"] != true)
                    || owned(store, &child)?
                        .iter()
                        .any(|t| active(t) || unresolved(t))
                {
                    return Err("Reconcile the child invocations and owned work first".into());
                }
            }
            if a.source == "receipt" && task["kind"] == "background" {
                let path = self
                    .receipts
                    .join(format!("task-{}-{}.json", a.id, a.epoch));
                let raw = std::fs::read(path).map_err(|_| "No final task receipt")?;
                if raw.len() > 65_536 {
                    return Err("Task receipt exceeds limit".into());
                }
                let r: Value = serde_json::from_slice(&raw).map_err(|_| "Invalid task receipt")?;
                if r["id"] != a.id
                    || r["epoch"] != a.epoch
                    || r["status"] != "finished"
                    || r["result"]["stopped"] != true
                    || r["result"]["indeterminate"] == true
                    || !r["result"]["ok"].is_boolean()
                {
                    return Err("Receipt does not confirm both result and process-tree stop".into());
                }
                task["result"] = r["result"].clone();
                task["state"] = json!(if r["result"]["ok"] == true
                    && r["result"]["value"]["exit_code"] == 0
                {
                    "succeeded"
                } else {
                    "failed"
                });
            } else if a.source == "reviewed" && !a.note.trim().is_empty() && a.note.len() <= 2000 {
                task["result"] = json!({"ok":false,"indeterminate":true,"review_note":a.note});
                task["review_note"] = json!(a.note);
            } else {
                return Err(
                    "Provide a final receipt or a review of effects and process-tree stop".into(),
                );
            }
            task["reviewed"] = json!(true);
            task["stopped"] = json!(true);
            store.agent_commit(
                &mut owner,
                &mut [],
                std::slice::from_mut(&mut task),
                None,
                "owned_reconciled",
            )?;
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
    pub(super) fn pump_tasks(&mut self, store: &mut Store) -> Result<(), String> {
        for root in store.active_task_roots()? {
            for mut task in store.owned_tasks(root)? {
                if task["kind"] == "agent" && active(&task) {
                    let child = store.agent_run(task["child_run_id"].as_i64().unwrap())?;
                    let state = if child["state"] == "completed" {
                        "succeeded"
                    } else {
                        child["state"].as_str().unwrap_or("interrupted")
                    };
                    if terminal(&child) {
                        task["state"] = json!(state);
                        task["stopped"] = json!(true);
                        let full = child["output"].as_str().unwrap_or("");
                        let mut size = 0;
                        let output = full
                            .chars()
                            .take_while(|c| {
                                size += c.len_utf8();
                                size <= 6000
                            })
                            .collect::<String>();
                        task["result"] = json!({"ok":state=="succeeded","output":output,"output_truncated":output.len()<full.len(),"error":child["error"],"child_run_id":child["id"]});
                        let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
                        store.agent_commit(
                            &mut owner,
                            &mut [],
                            std::slice::from_mut(&mut task),
                            None,
                            "child_finished",
                        )?;
                        if state == "interrupted"
                            && !terminal(&owner)
                            && owner["state"] != "cancelling"
                        {
                            self.stop_subtree(store, owner["id"].as_i64().unwrap(), None)?;
                        }
                    }
                }
                if task["kind"] != "background" || task["state"] != "queued" {
                    continue;
                }
                let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
                if terminal(&owner) || !owner["intent"].is_null() || owner["state"] == "cancelling"
                {
                    continue;
                }
                if !self.jobs.is_empty()
                    || self.hook_commands_busy()
                    || store.hooks_quarantined()?
                    || self.live.values().any(|l| l.tool.is_some())
                    || store.agent_quarantined()?
                    || store.tasks_quarantined()?
                {
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
                store.agent_commit(
                    &mut owner,
                    &mut [],
                    std::slice::from_mut(&mut task),
                    None,
                    "background_dispatched",
                )?;
                let task_id = task["id"].as_i64().unwrap();
                let epoch = task["epoch"].as_i64().unwrap();
                let work = tools::Work {
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
                    },
                );
                let updates = self.sender.clone();
                std::thread::spawn(move || {
                    let ready = updates.clone();
                    let progress = updates.clone();
                    let result = tools::execute_with_progress(
                        work,
                        flag,
                        move |gate| {
                            let _ = ready.blocking_send(Update::TaskReady(task_id, epoch, gate));
                        },
                        move |output| {
                            let _ = progress.try_send(Update::TaskOutput(task_id, epoch, output));
                        },
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
            | Update::TaskDone(i, e, _) => (*i, *e),
            _ => unreachable!(),
        };
        let mut task = store.owned_task(id)?;
        if task["epoch"] != epoch || !self.jobs.contains_key(&id) {
            return Ok(());
        }
        let mut owner = store.agent_run(task["owner_run_id"].as_i64().unwrap())?;
        match update {
            Update::TaskReady(_, _, gate) => {
                if task["stop_requested"] == true
                    || !owner["intent"].is_null()
                    || owner["state"] == "cancelling"
                    || terminal(&owner)
                {
                    let _ = gate.send(false);
                    return Ok(());
                }
                task["state"] = json!("running");
                store.agent_commit(
                    &mut owner,
                    &mut [],
                    std::slice::from_mut(&mut task),
                    None,
                    "background_accepted",
                )?;
                let _ = gate.send(true);
            }
            Update::TaskOutput(_, _, output) => {
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
                self.jobs.remove(&id);
                task["stopped"] = result["stopped"].clone();
                task["state"] = json!(if result["indeterminate"] == true
                    || result["stopped"] != true
                {
                    "indeterminate"
                } else if result["ok"] == true && result["value"]["exit_code"] == 0 {
                    "succeeded"
                } else {
                    "failed"
                });
                task["result"] = result;
                store.agent_commit(
                    &mut owner,
                    &mut [],
                    std::slice::from_mut(&mut task),
                    None,
                    "background_finished",
                )?;
                if unresolved(&task) && !terminal(&owner) && owner["state"] != "cancelling" {
                    self.stop_subtree(store, owner["id"].as_i64().unwrap(), None)?;
                }
            }
            _ => unreachable!(),
        }
        Ok(())
    }
}
