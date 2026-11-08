use crate::{params, tools};
use model::{ModelCall as ToolCall, ModelContext, ModelRequest};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc as blocking, Arc,
    },
};
use tokio::{sync::mpsc, task::JoinHandle};
use troop_gateway::{self as gateway, Config, Secret};
use troop_protocol::lifecycle::{self, run_terminal as terminal, Evidence};
use troop_storage::{public_run, Store};
use uuid::Uuid;
mod actions;
mod cli_interactions;
mod commands;
pub(crate) mod context;
mod execution;
pub(crate) mod external;
mod follow;
mod followups;
mod group_runtime;
mod maintenance_settings;
pub(crate) mod model;
mod permissions;
pub(crate) mod providers;
mod rules;
mod schedules;
pub(crate) mod tool_provider;
mod work_items;
use execution::{Gate as ExecutionGate, Owner as ExecutionOwner, Work as ExecutionWork};
mod mcp;
mod tasks;
use tasks::TaskLive;
pub(crate) mod hooks;
pub(crate) mod memory;
pub(crate) mod skills;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    client_run_id: String,
    workspace_id: i64,
    provider_id: Option<String>,
    action: Option<Value>,
    goal: String,
    #[serde(default = "default_agent")]
    agent_id: i64,
    workflow_id: Option<String>,
    authorization_id: Option<String>,
    #[serde(default)]
    project_ids: Vec<String>,
    rule_id: Option<String>,
    rule_management_authorization_id: Option<String>,
}
fn default_agent() -> i64 {
    1
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    #[serde(default)]
    offset: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Content {
    id: i64,
    field: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Events {
    id: i64,
    before: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    id: i64,
    epoch: i64,
    approved: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Steer {
    id: i64,
    client_input_id: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reconcile {
    id: i64,
    epoch: i64,
    source: String,
    note: String,
}
pub enum Update {
    Mcp(Box<mcp::Event>),
    HookReady(i64, i64, blocking::Sender<bool>),
    HookDone(i64, i64, Value),
    Text(i64, i64, String),
    Model(i64, i64, Result<model::ModelOutput, model::ModelError>),
    Ready(i64, i64, i64, blocking::Sender<bool>),
    Tool(i64, i64, i64, Value),
    TaskReady(i64, i64, blocking::Sender<bool>),
    TaskOutput(i64, i64, Value),
    TaskInteraction(i64, i64, Value, blocking::Sender<Value>),
    TaskDone(i64, i64, Value),
    Compacted(i64, i64, usize, String, Result<String, String>),
    MemoryFinished(i64, u64, bool, Result<(String, Value), String>),
}
#[derive(Default)]
struct Live {
    model: Option<JoinHandle<()>>,
    tool: Option<i64>,
    cancel: Option<Arc<AtomicBool>>,
    text: String,
    flushed: Option<std::time::Instant>,
}
pub struct Manager {
    providers: providers::Providers,
    execution: ExecutionGate,
    live: HashMap<i64, Live>,
    sender: mpsc::Sender<Update>,
    pub receiver: mpsc::Receiver<Update>,
    receipts: PathBuf,
    jobs: HashMap<i64, TaskLive>,
    cli_waiters: HashMap<i64, (String, blocking::Sender<Value>)>,
    maintenance: HashMap<i64, JoinHandle<()>>,
    memory_queue: std::collections::BTreeSet<i64>,
    hook_live: HashMap<i64, hooks::HookLive>,
    mcp_work: HashMap<i64, mcp::Work>,
    mcp_clients: HashMap<i64, Box<mcp::Connection>>,
    mcp_cleanup: Vec<JoinHandle<()>>,
}
fn text_ok(text: &str) -> bool {
    !text.trim().is_empty()
        && text.len() <= 12000
        && !text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}
fn history(doc: &Value) -> Vec<Value> {
    doc["history"].as_array().cloned().unwrap_or_default()
}
fn remove_pending(doc: &mut Value, id: i64) {
    let ids = doc["pending"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|v| v.as_i64() != Some(id))
        .collect::<Vec<_>>();
    doc["pending"] = json!(ids);
}
impl Manager {
    pub fn model_count(&self) -> usize {
        self.live.values().filter(|l| l.model.is_some()).count()
            + self.jobs.values().filter(|job| job.external).count()
            + self.maintenance.len()
            + self.hook_models()
    }
    pub fn with_providers(
        directory: PathBuf,
        providers: providers::Providers,
    ) -> Result<Self, String> {
        let receipts = directory.join("worker-receipts");
        std::fs::create_dir_all(&receipts).map_err(|_| "无法建立 Worker 账本目录。")?;
        let (sender, receiver) = mpsc::channel(64);
        Ok(Self {
            providers,
            execution: ExecutionGate::default(),
            live: HashMap::new(),
            sender,
            receiver,
            receipts,
            jobs: HashMap::new(),
            cli_waiters: HashMap::new(),
            maintenance: HashMap::new(),
            memory_queue: std::collections::BTreeSet::new(),
            hook_live: HashMap::new(),
            mcp_work: HashMap::new(),
            mcp_clients: HashMap::new(),
            mcp_cleanup: vec![],
        })
    }
    pub fn owns_provider(&self, store: &Store, provider: &str) -> bool {
        self.memory_queue.iter().any(|id| {
            store
                .memory_job(*id)
                .is_ok_and(|j| j["provider_id"] == provider)
        }) || self.live.keys().any(|id| {
            store
                .agent_run(*id)
                .is_ok_and(|r| r["provider_id"] == provider)
        })
    }
    pub fn owns_workspace(&self, store: &Store, workspace: i64) -> bool {
        self.live.keys().any(|id| {
            store
                .agent_run(*id)
                .is_ok_and(|r| r["workspace_id"] == workspace)
        })
    }
    fn save(store: &mut Store, doc: &mut Value, kind: &str) -> Result<(), String> {
        store.agent_save(doc, &mut [], kind)
    }
    async fn stop(&mut self, store: &mut Store, id: i64, intent: bool) -> Result<Value, String> {
        self.stop_subtree(store, id, if intent { Some("cancel") } else { None })?;
        let mut doc = store.request_run_stop(id, intent)?;
        if lifecycle::run_final(&doc) || doc["state"] == "interrupted" {
            return Ok(public_run(&doc, false));
        }
        if let Some(live) = self.live.get_mut(&id) {
            if let Some(handle) = live.model.take() {
                handle.abort();
                let _ = handle.await;
            }
            if let Some(cancel) = &live.cancel {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        self.finish_stop(store, &mut doc)?;
        Ok(public_run(&doc, false))
    }
    fn finish_stop(&mut self, store: &mut Store, doc: &mut Value) -> Result<(), String> {
        let id = doc["id"].as_i64().unwrap();
        let busy = self.live.get(&id).is_some_and(|l| l.tool.is_some())
            || self.mcp_run_busy(store, id)
            || self.hook_live.values().any(|h| h.run == id);
        if let Some(stopped) = store.finish_run_stop(id, busy)? {
            *doc = stopped;
            self.live.remove(&id);
        }
        Ok(())
    }
    fn reconciliation_evidence(&self, a: &Reconcile, task: bool) -> Result<Evidence, String> {
        match a.source.as_str() {
            "reviewed" => Ok(Evidence::Reviewed(a.note.clone())),
            "receipt" => {
                let name = if task {
                    format!("task-{}-{}.json", a.id, a.epoch)
                } else {
                    format!("{}-{}.json", a.id, a.epoch)
                };
                let bytes = std::fs::read(self.receipts.join(name)).map_err(|_| {
                    if task {
                        "No final task receipt"
                    } else {
                        "没有可核对的 Worker 结果回执。"
                    }
                })?;
                if bytes.len() > 65_536 {
                    return Err(if task {
                        "Task receipt exceeds limit"
                    } else {
                        "Worker 回执超过限制。"
                    }
                    .into());
                }
                let receipt = serde_json::from_slice(&bytes).map_err(|_| {
                    if task {
                        "Invalid task receipt"
                    } else {
                        "Worker 回执不完整。"
                    }
                })?;
                Ok(Evidence::Receipt(receipt))
            }
            _ => Ok(Evidence::Invalid),
        }
    }
    pub async fn dispatch(
        &mut self,
        store: &mut Store,
        method: &str,
        p: Value,
    ) -> Result<Value, String> {
        if matches!(
            method,
            "memory.maintenance.save"
                | "memory.restore"
                | "memory.resolve"
                | "cli.start"
                | "cli.review"
                | "cli.respond"
        ) {
            return Err("该记忆写操作需要操作账本。".into());
        }
        if method == "agent.start" && !p["action"].is_null() {
            return Err("直接动作必须通过 operations.execute 提交。".into());
        }
        if matches!(
            method,
            "agent.start" | "agent.approve" | "agent.steer" | "agent.reconcile" | "agent.resume"
        ) {
            let value = self.apply_record_command(store, method, p)?;
            self.activate_committed_command(method, &value);
            return Ok(value);
        }
        if method == "cli.preview" {
            return self.preview_external(store, p);
        }
        if matches!(method, "cli.interaction" | "cli.interactions") {
            return self.interaction_read(store, method, p);
        }
        if method.starts_with("agent.mcp-") {
            return self.mcp_dispatch(store, method, p);
        }
        if method.starts_with("hooks.") {
            return self.hooks_rpc(store, method, p);
        }
        if method.starts_with("skills.") {
            return self.skills_rpc(store, method, p);
        }
        if method.starts_with("memory.") || matches!(method, "agent.compact" | "agent.checkpoints")
        {
            return self.memory_rpc(store, method, p);
        }
        match method {
            "agent.tasks" | "agent.task" | "agent.stop-task" | "agent.reconcile-task" => {
                self.task_rpc(store, method, p)
            }
            "agent.events" => {
                let a = params::<Events>(p)?;
                if a.before.is_some_and(|b| b <= 0) {
                    return Err("事件分页无效。".into());
                }
                store.agent_events(a.id, a.before)
            }
            "agent.event" => store.agent_event(params::<Id>(p)?.id),
            "agent.list" => store.agent_list(params::<Page>(p)?.offset),
            "agent.content" => {
                let a = params::<Content>(p)?;
                if !matches!(a.field.as_str(), "goal" | "output") {
                    return Err("内容字段无效。".into());
                }
                Ok(json!({"text":store.agent_run(a.id)?[&a.field]}))
            }
            "agent.get" => self.run_snapshot(store, params::<Id>(p)?.id),
            "agent.invocation" => self.invocation_snapshot(store, params::<Id>(p)?.id),
            "agent.cancel" => self.stop(store, params::<Id>(p)?.id, true).await,
            _ => Err("未知 Agent 接口。".into()),
        }
    }
    pub(super) fn run_snapshot(&self, store: &Store, id: i64) -> Result<Value, String> {
        let run = store.agent_run(id)?;
        let invocations = store.agent_invocations(id)?.iter().map(|i| {
            Ok(json!({"id":i["id"],"name":i["name"],"state":i["state"],"epoch":i["epoch"],"approval":i["approval"],"reviewed":i["reviewed"],"stopped":i["stopped"],"hook_ask":i["hook_ask"],"revision":store.execution_revision("invocation",i["id"].as_i64().unwrap())?,"allowed_actions":self.invocation_actions(store,i)?}))
        }).collect::<Result<Vec<Value>,String>>()?;
        let tasks = store
            .owned_tasks(Store::task_root(&run))?
            .iter()
            .map(|task| {
                let mut value = troop_storage::public_task(task);
                value["allowed_actions"] = self.task_actions(store, task)?;
                value["revision"] =
                    json!(store.execution_revision("task", task["id"].as_i64().unwrap())?);
                Ok(value)
            })
            .collect::<Result<Vec<Value>, String>>()?;
        Ok(
            json!({"run":public_run(&run,false),"allowed_actions":self.run_actions(store,&run)?,"invocations":invocations,"tasks":tasks,"hooks_unresolved":store.hook_calls(id)?.iter().any(|h|h["state"]=="indeterminate"&&h["reviewed"]!=true),"mcp_unresolved":store.mcp_connections(id)?.iter().any(|s|s["state"]=="indeterminate"&&s["reviewed"]!=true)}),
        )
    }
    fn apply_inputs(&self, store: &mut Store, doc: &mut Value) -> Result<(), String> {
        let mut inputs = doc["supplements"].as_array().cloned().unwrap_or_default();
        if !inputs.iter().any(|i| i["applied"] != true) {
            return Ok(());
        }
        let pending = doc["pending"].as_array().cloned().unwrap_or_default();
        let mut invocations = store.agent_invocations(doc["id"].as_i64().unwrap())?;
        for inv in &mut invocations {
            if pending.contains(&inv["id"]) {
                inv["state"] = json!("cancelled");
                inv["result"] = json!({"ok":false,"error":"收到补充指令，尚未执行的计划已失效。"});
                self.providers.model.append_result(doc, inv)?;
            }
        }
        let mut h = history(doc);
        for input in &mut inputs {
            if input["applied"] != true {
                let expanded = match Self::expand_workflows(
                    store,
                    doc,
                    input["text"].as_str().unwrap_or(""),
                    None,
                ) {
                    Ok(text) => text,
                    Err(error) => {
                        input["workflow_error"] = json!(error);
                        format!(
                            "{}\n\n[Local workflow expansion failed; no recipe was applied: {}]",
                            input["text"].as_str().unwrap_or(""),
                            error
                        )
                    }
                };
                h.push(json!({"role":"user","content":expanded}));
                input["applied"] = json!(true);
            }
        }
        doc["history"] = json!(h);
        doc["supplements"] = json!(inputs);
        if let Some(contexts) = doc.as_object_mut().unwrap().remove("queued_hook_contexts") {
            let mut h = history(doc);
            for context in contexts.as_array().into_iter().flatten() {
                h.push(json!({"role":"user","content":context}));
            }
            doc["history"] = json!(h);
        }
        doc["pending"] = json!([]);
        doc["state"] = json!("queued");
        doc["awaiting_owned"] = json!(false);
        store.agent_save(doc, &mut invocations, "input_applied")
    }
    pub fn pump(
        &mut self,
        store: &mut Store,
        model_capacity: usize,
        oauth: &mut crate::oauth::Manager,
    ) -> Result<(), String> {
        self.pump_interactions(store)?;
        self.pump_groups(store)?;
        self.prune_mcp(store)?;
        self.mcp_cleanup.retain(|h| !h.is_finished());
        self.poll_hook_deadlines();
        self.pump_tasks(store, model_capacity)?;
        let mut ids = self.live.keys().copied().collect::<Vec<_>>();
        ids.sort_unstable();
        for id in ids {
            let authorization_run = store.agent_run(id)?;
            if let Some(reason) = self.authorization_blocker(store, &authorization_run) {
                if authorization_run["intent"].is_null() && !terminal(&authorization_run) {
                    self.stop_subtree(store, id, Some("failure"))?;
                    let mut stopped = store.agent_run(id)?;
                    stopped["error"] = json!(reason);
                    Self::save(store, &mut stopped, "authorization_revoked")?;
                }
            }
            let available = model_capacity.saturating_sub(self.model_count());
            if self
                .live
                .get(&id)
                .is_none_or(|l| l.model.is_some() || l.tool.is_some())
            {
                continue;
            }
            let mut doc = store.agent_run(id)?;
            if self.finish_mcp_cleanup(store, &mut doc)? {
                continue;
            }
            if doc["state"] == "failed" && self.has_owned_work(store, &doc)? {
                self.stop_subtree(store, id, Some("failure"))?;
                continue;
            }
            if terminal(&doc) {
                self.retire(store, id)?;
                continue;
            }
            if !doc["intent"].is_null() || doc["state"] == "cancelling" {
                self.finish_stop(store, &mut doc)?;
                continue;
            }
            if doc["kind"] == "external_cli" {
                continue;
            }
            if let Some(id) = doc["pending"]
                .as_array()
                .and_then(|v| v.first())
                .and_then(Value::as_i64)
            {
                let mut inv = store.agent_invocation(id)?;
                if inv["post_pending"] == true {
                    self.post_hooks(store, &mut doc, &mut inv, model_capacity)?;
                    continue;
                }
            }
            if !self.initial_hooks(store, &mut doc, model_capacity)? {
                continue;
            }
            if !self.ensure_mcp(store, &mut doc, oauth)? {
                continue;
            }
            self.resolve_mcp_action(store, &mut doc)?;
            self.apply_inputs(store, &mut doc)?;
            if !self.consume_completions(store, &mut doc, model_capacity)? {
                continue;
            }
            if !self.model_response_hooks(store, &mut doc, model_capacity)? {
                continue;
            }
            if !doc["finishing_step"].is_null()
                && !self.has_owned_work(store, &doc)?
                && !self.has_unconsumed(store, &doc)?
            {
                self.finishing_hooks(store, &mut doc, model_capacity)?;
                continue;
            }
            if let Some(inv_id) = doc["pending"]
                .as_array()
                .and_then(|p| p.first())
                .and_then(Value::as_i64)
            {
                let mut inv = store.agent_invocation(inv_id)?;
                if inv["post_pending"] == true {
                    self.post_hooks(store, &mut doc, &mut inv, model_capacity)?;
                    continue;
                }
                let name = inv["name"].as_str().unwrap_or("").to_owned();
                if self
                    .providers
                    .tools
                    .validate(store, &doc, &name, &inv["arguments"])
                    .is_ok()
                    && (doc["read_only"] != true || self.providers.tools.read_only(&name))
                    && !self.pre_hooks(store, &mut doc, &mut inv, model_capacity)?
                {
                    continue;
                }
                let permission_error = self.authorize_invocation(store, &doc, &mut inv).err();
                if permission_error.is_none()
                    && (self.providers.tools.needs_approval(&name) || inv["hook_ask"] == true)
                    && self
                        .providers
                        .tools
                        .validate(store, &doc, &name, &inv["arguments"])
                        .is_ok()
                    && inv["approval"].is_null()
                    && (doc["read_only"] != true || self.providers.tools.read_only(&name))
                {
                    if doc["waiting"] != json!(["approval"]) {
                        doc["state"] = json!("waiting");
                        doc["waiting"] = json!(["approval"]);
                        Self::save(store, &mut doc, "waiting_approval")?;
                    }
                    continue;
                }
                let rejected = if let Some(error) = permission_error {
                    Some(error)
                } else if inv["approval"] == false {
                    Some("用户拒绝此操作。".into())
                } else {
                    self.providers
                        .tools
                        .validate(store, &doc, &name, &inv["arguments"])
                        .err()
                        .or_else(|| {
                            (doc["read_only"] == true && !self.providers.tools.read_only(&name))
                                .then(|| {
                                    "Read-only child agents cannot execute this capability".into()
                                })
                        })
                };
                if let Some(error) = rejected {
                    inv["state"] = json!("failed");
                    inv["result"] = json!({"ok":false,"error":error});
                    if doc["kind"] != "tool_action" {
                        self.providers.model.append_result(&mut doc, &inv)?;
                    }
                    remove_pending(&mut doc, inv_id);
                    store.agent_save(&mut doc, std::slice::from_mut(&mut inv), "tool_rejected")?;
                    continue;
                }
                if self.group_reply_tool(store, &mut doc, &mut inv)? {
                    continue;
                }
                if self.rules_tool(store, &mut doc, &mut inv)? {
                    continue;
                }
                if self.followup_tool(store, &mut doc, &mut inv)? {
                    continue;
                }
                if self.owned_tool(store, &mut doc, &mut inv)? {
                    continue;
                }
                if self.memory_tool(store, &mut doc, &mut inv)? {
                    continue;
                }
                if self.skill_tool(store, &mut doc, &mut inv)? {
                    continue;
                }
                if self.mcp_tool(store, &mut doc, &mut inv, oauth)? {
                    continue;
                }
                if self.execution.blocked(store)? {
                    if doc["waiting"] != json!(["resource"]) {
                        doc["state"] = json!("waiting");
                        doc["waiting"] = json!(["resource"]);
                        Self::save(store, &mut doc, "waiting_resource")?;
                    }
                    continue;
                }
                let current = std::fs::canonicalize(
                    store.workspace_path(doc["workspace_id"].as_i64().unwrap())?,
                );
                if current.as_ref().ok() != Some(&PathBuf::from(doc["workspace"].as_str().unwrap()))
                {
                    doc["state"] = json!("failed");
                    doc["intent"] = json!("failure");
                    doc["error"] =
                        json!("工作区目标已变化或不可用，未执行后续工具；请创建新任务。");
                    let mut old = store.agent_invocations(id)?;
                    for inv in &mut old {
                        if inv["state"] == "prepared" {
                            inv["state"] = json!("cancelled");
                            inv["result"] = json!({"ok":false,"error":"工作区不可用，未派发。"});
                        }
                    }
                    store.agent_save(&mut doc, &mut old, "workspace_unavailable")?;
                    self.retire(store, id)?;
                    continue;
                }
                inv["state"] = json!("dispatched");
                doc["state"] = json!("waiting");
                doc["waiting"] = json!(["tool"]);
                let epoch = doc["epoch"].as_i64().unwrap();
                if self
                    .execution
                    .dispatch(store, |store| {
                        store.agent_save(
                            &mut doc,
                            std::slice::from_mut(&mut inv),
                            "tool_dispatched",
                        )?;
                        Ok(ExecutionOwner::new(
                            id,
                            epoch,
                            ExecutionWork::Invocation(inv_id),
                        ))
                    })?
                    .is_none()
                {
                    continue;
                }
                let cancel = Arc::new(AtomicBool::new(false));
                let flag = cancel.clone();
                let updates = self.sender.clone();
                let work = tools::Work {
                    sandbox: inv["permission_plan"]["sandbox"].clone(),
                    id: inv_id,
                    epoch,
                    workspace: doc["workspace"].as_str().unwrap().into(),
                    name,
                    arguments: inv["arguments"].clone(),
                    receipt: self.receipts.join(format!("{inv_id}-{epoch}.json")),
                    job_handle: 0,
                };
                let live = self.live.get_mut(&id).unwrap();
                live.tool = Some(inv_id);
                live.cancel = Some(cancel);
                let provider = self.providers.tools.clone();
                std::thread::spawn(move || {
                    let ready = updates.clone();
                    let result = provider.execute(
                        work,
                        flag,
                        Box::new(move |gate| {
                            let _ = ready.blocking_send(Update::Ready(id, epoch, inv_id, gate));
                        }),
                        Box::new(|_| {}),
                    );
                    let _ = updates.blocking_send(Update::Tool(id, epoch, inv_id, result));
                });
            } else if doc["kind"] == "tool_action" {
                if self.has_owned_work(store, &doc)? {
                    if doc["waiting"] != json!(["background"]) {
                        doc["state"] = json!("waiting");
                        doc["waiting"] = json!(["background"]);
                        Self::save(store, &mut doc, "action_waiting_owned")?;
                    }
                    continue;
                }
                let invocations = store.agent_invocations(id)?;
                let tasks = store.owned_tasks(Store::task_root(&doc))?;
                let succeeded = invocations.iter().all(|inv| inv["state"] == "succeeded")
                    && tasks.iter().all(|task| task["state"] == "succeeded");
                doc["finishing_step"] =
                    json!({"state": if succeeded { "completed" } else { "failed" }});
                doc["output"] = json!(tasks
                    .last()
                    .or_else(|| invocations.last())
                    .map(|record| record["result"].to_string())
                    .unwrap_or_default());
                Self::save(store, &mut doc, "action_finishing")?;
                self.finishing_hooks(store, &mut doc, model_capacity)?;
            } else if available > 0 {
                if doc["awaiting_owned"] == true && self.has_owned_work(store, &doc)? {
                    if doc["waiting"] != json!(["background"]) {
                        doc["state"] = json!("waiting");
                        doc["waiting"] = json!(["background"]);
                        Self::save(store, &mut doc, "waiting_owned")?;
                    }
                    continue;
                }
                let tree = store.tree_runs(Store::task_root(&doc))?;
                let tree_steps: u64 = tree.iter().map(|r| r["step"].as_u64().unwrap_or(0)).sum();
                let tree_tools: usize = tree
                    .iter()
                    .map(|r| {
                        store
                            .agent_invocations(r["id"].as_i64().unwrap())
                            .map(|i| i.len())
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .iter()
                    .sum();
                let (chain_steps, chain_tools) = crate::group_runtime::usage(store, &doc)?;
                if doc["step"].as_u64().unwrap_or(0) >= 16
                    || store.agent_invocations(id)?.len() >= 32
                    || tree_steps >= 64
                    || tree_tools >= 128
                    || chain_steps >= 64
                    || chain_tools >= 128
                {
                    doc["state"] = json!("failed");
                    doc["intent"] = json!("failure");
                    doc["error"] =
                        json!("任务已达到模型步骤、工具数量或上下文预算；记录与产物已保留。");
                    Self::save(store, &mut doc, "budget_exhausted")?;
                    self.retire(store, id)?;
                    continue;
                }
                if self.maybe_compact(store, &mut doc)? {
                    continue;
                }
                let context = self.providers.context.build(store, &mut doc)?;
                let config: Config =
                    serde_json::from_value(doc["config"].clone()).map_err(|_| "模型配置损坏。")?;
                let secret = doc["secret_ref"]
                    .as_str()
                    .map(|r| gateway::credentials::read(r).map(Secret))
                    .transpose();
                let secret = match secret {
                    Ok(secret) => secret,
                    Err(_) => {
                        doc["state"] = json!("failed");
                        doc["intent"] = json!("failure");
                        doc["error"] =
                            json!("无法读取此任务的模型凭据，请检查服务配置后创建新任务。");
                        Self::save(store, &mut doc, "credential_unavailable")?;
                        self.retire(store, id)?;
                        continue;
                    }
                };
                doc["step"] = json!(doc["step"].as_i64().unwrap() + 1);
                doc["attempt"] = json!(Uuid::new_v4().to_string());
                doc["state"] = json!("running");
                doc["waiting"] = json!([]);
                doc["output"] = json!("");
                doc["model_text"] = json!("");
                doc["workflow_write_revisions"] = Self::workflow_revisions(store, &doc)?;
                Self::save(store, &mut doc, "model_started")?;
                let epoch = doc["epoch"].as_i64().unwrap();
                let request = ModelRequest {
                    config,
                    secret,
                    context: ModelContext::Agent {
                        history: context,
                        definitions: self.providers.tools.catalogue(store, &doc),
                    },
                };
                let provider = self.providers.model.clone();
                let updates = self.sender.clone();
                let handle = tokio::spawn(async move {
                    let (tx, mut rx) = mpsc::channel(32);
                    let operation = provider.stream(request, tx);
                    tokio::pin!(operation);
                    loop {
                        tokio::select! {text=rx.recv()=>{if let Some(text)=text{if updates.send(Update::Text(id,epoch,text)).await.is_err(){return;}}},result=&mut operation=>{while let Ok(text)=rx.try_recv(){if updates.send(Update::Text(id,epoch,text)).await.is_err(){return;}}let _=updates.send(Update::Model(id,epoch,result)).await;return;}}
                    }
                });
                let live = self.live.get_mut(&id).unwrap();
                live.model = Some(handle);
                live.text.clear();
                live.flushed = None;
            }
        }
        self.pump_memory(store, model_capacity)?;
        Ok(())
    }
    pub fn accept(&mut self, store: &mut Store, update: Update) -> Result<(), String> {
        if let Update::Mcp(e) = update {
            return self.accept_mcp(store, *e);
        }
        if matches!(&update, Update::HookReady(..) | Update::HookDone(..)) {
            return self.accept_hook(store, update);
        }
        if let Update::MemoryFinished(id, attempt, validating, result) = update {
            return self.accept_memory(store, id, attempt, validating, result);
        }
        if let Update::Compacted(id, epoch, count, fingerprint, result) = update {
            return self.accept_compaction(store, id, epoch, count, fingerprint, result);
        }
        if matches!(
            &update,
            Update::TaskReady(..)
                | Update::TaskOutput(..)
                | Update::TaskDone(..)
                | Update::TaskInteraction(..)
        ) {
            return self.accept_task(store, update);
        }
        let (id, epoch) = match &update {
            Update::Text(i, e, _)
            | Update::Model(i, e, _)
            | Update::Ready(i, e, ..)
            | Update::Tool(i, e, ..) => (*i, *e),
            _ => unreachable!(),
        };
        let mut doc = store.agent_run(id)?;
        if !self.live.contains_key(&id) || doc["epoch"] != epoch {
            return Ok(());
        }
        match update {
            Update::Text(_, _, text) => {
                if doc["state"] != "running" {
                    return Ok(());
                }
                let live = self.live.get_mut(&id).unwrap();
                if live.text.len() + text.len() > 24_000 {
                    return Err("模型文本超出限制。".into());
                }
                live.text.push_str(&text);
                if live.flushed.is_some_and(|t| t.elapsed().as_millis() < 100) {
                    return Ok(());
                }
                live.flushed = Some(std::time::Instant::now());
                doc["output"] = json!(live.text);
                doc["model_text"] = json!(live.text);
                Self::save(store, &mut doc, "model_text")?;
            }
            Update::Model(_, _, outcome) => {
                let live = self.live.get_mut(&id).unwrap();
                live.model = None;
                doc["model_text"] = json!(live.text);
                doc["output"] = json!(live.text);
                if doc["state"] != "running" {
                    return Ok(());
                }
                match outcome {
                    Err(error) => {
                        doc["state"] = json!("failed");
                        doc["intent"] = json!("failure");
                        doc["error"] = json!({"kind":error.kind,"message":error.message});
                        Self::save(store, &mut doc, "model_failed")?;
                        self.retire(store, id)?;
                    }
                    Ok(summary) => {
                        if doc["group_delivery_id"].is_i64() {
                            doc["group_adoption"] =
                                json!({"source":"native_model_response","epoch":doc["epoch"]});
                        }
                        self.providers.model.append_assistant(&mut doc, &summary)?;
                        if doc["hook_snapshot"]
                            .as_array()
                            .is_some_and(|v| !v.is_empty())
                        {
                            doc["model_hook_step"] = doc["step"].clone();
                            doc["hook_thought_present"] =
                                json!(summary.output_items.iter().any(|v| matches!(
                                    v["type"].as_str(),
                                    Some("thinking" | "redacted_thinking" | "reasoning")
                                )));
                        }
                        if serde_json::to_string(&Self::context_view(&doc))
                            .unwrap()
                            .len()
                            > 192_000
                        {
                            doc["state"] = json!("failed");
                            doc["intent"] = json!("failure");
                            doc["error"] = json!("模型输出使任务上下文超过 192KB；未派发工具。");
                            Self::save(store, &mut doc, "context_exhausted")?;
                            self.retire(store, id)?;
                            return Ok(());
                        }
                        doc["last_model"] = json!({"finish_reason":summary.finish_reason,"usage":summary.usage,"call_count":summary.calls.len()});
                        if summary.calls.is_empty() {
                            let has_input = doc["supplements"]
                                .as_array()
                                .is_some_and(|items| items.iter().any(|i| i["applied"] != true));
                            doc["state"] = json!(if matches!(
                                summary.finish_reason.as_str(),
                                "length" | "content_filter" | "pause_turn"
                            ) {
                                "failed"
                            } else if has_input {
                                "queued"
                            } else if self.has_owned_work(store, &doc)?
                                || self.has_unconsumed(store, &doc)?
                            {
                                "waiting"
                            } else {
                                "completed"
                            });
                            if doc["state"] == "waiting" {
                                doc["awaiting_owned"] = json!(true);
                                doc["waiting"] = json!(["background"]);
                            }
                            if doc["state"] == "failed" {
                                doc["intent"] = json!("failure");
                                doc["error"] = json!("模型输出未完整结束，未执行后续操作。");
                            }
                            if doc["state"] == "completed"
                                && doc["hook_snapshot"]
                                    .as_array()
                                    .is_some_and(|v| !v.is_empty())
                            {
                                doc["finishing_step"] = doc["step"].clone();
                                doc["state"] = json!("queued");
                                doc["hook_thought_present"] =
                                    json!(summary.output_items.iter().any(|v| matches!(
                                        v["type"].as_str(),
                                        Some("thinking" | "redacted_thinking" | "reasoning")
                                    )));
                            }
                            Self::save(store, &mut doc, "model_finished")?;
                            if terminal(&doc) {
                                self.retire(store, id)?;
                            }
                        } else {
                            let tree_tools: usize = store
                                .tree_runs(Store::task_root(&doc))?
                                .iter()
                                .map(|r| {
                                    store
                                        .agent_invocations(r["id"].as_i64().unwrap())
                                        .map(|i| i.len())
                                })
                                .collect::<Result<Vec<_>, _>>()?
                                .iter()
                                .sum();
                            if store.agent_invocations(id)?.len() + summary.calls.len() > 32
                                || tree_tools + summary.calls.len() > 128
                                || crate::group_runtime::usage(store, &doc)?.1 + summary.calls.len()
                                    > 128
                            {
                                doc["state"] = json!("failed");
                                doc["intent"] = json!("failure");
                                doc["error"] =
                                    json!("工具计划超过单次任务 32 次或执行树／协作链 128 次调用预算，未派发。");
                                Self::save(store, &mut doc, "budget_exhausted")?;
                                self.retire(store, id)?;
                                return Ok(());
                            }
                            let mut invocations=summary.calls.into_iter().map(|c:ToolCall|{let git=c.name=="git_status";let mut inv=json!({"run_id":id,"epoch":epoch,"call_id":c.id,"name":c.name,"arguments":c.arguments,"state":"prepared","approval":null,"result":null,"reviewed":false,"stopped":true});if git{inv["operation"]=tools::git_preview();}inv}).collect::<Vec<_>>();
                            for inv in &mut invocations {
                                Self::bind_mcp(&doc, inv);
                            }
                            doc["state"] = json!("waiting");
                            doc["waiting"] = json!(["tool"]);
                            doc["reset_pending"] = json!(true);
                            store.agent_save(&mut doc, &mut invocations, "model_finished")?;
                        }
                    }
                }
            }
            Update::Ready(_, _, inv_id, gate) => {
                let mut inv = store.agent_invocation(inv_id)?;
                if !doc["intent"].is_null()
                    || doc["state"] == "cancelling"
                    || self.live[&id].tool != Some(inv_id)
                {
                    let _ = gate.send(false);
                    return Ok(());
                }
                if self.authorize_invocation(store, &doc, &mut inv).is_err() {
                    let _ = gate.send(false);
                    return Ok(());
                }
                inv["state"] = json!("running");
                inv["stopped"] = json!(false);
                let allowed = self.execution.ready(
                    ExecutionOwner::new(id, epoch, ExecutionWork::Invocation(inv_id)),
                    true,
                    || {
                        store.agent_save(
                            &mut doc,
                            std::slice::from_mut(&mut inv),
                            "worker_accepted",
                        )
                    },
                )?;
                let _ = gate.send(allowed);
            }
            Update::Tool(_, _, inv_id, mut result) => {
                let owner = ExecutionOwner::new(id, epoch, ExecutionWork::Invocation(inv_id));
                if self.live[&id].tool != Some(inv_id) || !self.execution.owns(owner) {
                    return Ok(());
                }
                let mut inv = store.agent_invocation(inv_id)?;
                if let Some(a) = result.as_object_mut().and_then(|m| m.remove("_artifacts")) {
                    inv["_mcp_artifacts"] = a;
                }
                let unknown = result["indeterminate"] == true;
                let stop_confirmed = result["stopped"] == true;
                let succeeded = result["ok"] == true
                    && result["value"]["exit_code"].as_i64().is_none_or(|n| n == 0);
                inv["state"] = json!(if unknown {
                    "indeterminate"
                } else if succeeded {
                    "succeeded"
                } else {
                    "failed"
                });
                inv["result"] = result;
                inv["stopped"] = json!(stop_confirmed);
                let stopping = doc["state"] == "cancelling";
                let kind = if !stop_confirmed {
                    doc["state"] = json!("interrupted");
                    doc["waiting"] = json!([]);
                    doc["error"] =
                        json!("stop_unconfirmed：未确认整棵受管进程树停止，资源继续隔离。");
                    "stop_unconfirmed"
                } else if stopping {
                    "tool_stopped"
                } else if unknown {
                    doc["state"] = json!("interrupted");
                    doc["waiting"] = json!([]);
                    doc["error"] = json!("工具结果不明，已停止受管 Worker；请核对后手动继续。");
                    "tool_indeterminate"
                } else {
                    self.settle_tool(&mut doc, &mut inv)?;
                    doc["state"] = json!("queued");
                    doc["waiting"] = json!([]);
                    "tool_result"
                };
                self.execution.finish(owner, || {
                    store.agent_save(&mut doc, std::slice::from_mut(&mut inv), kind)
                })?;
                let live = self.live.get_mut(&id).unwrap();
                live.tool = None;
                live.cancel = None;
                if !stop_confirmed {
                    self.retire(store, id)?;
                } else if stopping {
                    self.finish_stop(store, &mut doc)?;
                } else if unknown {
                    self.retire(store, id)?;
                }
            }
            _ => unreachable!(),
        }
        Ok(())
    }
    pub async fn shutdown(&mut self, store: &mut Store) -> Result<(), String> {
        for id in self.memory_queue.iter().copied().collect::<Vec<_>>() {
            let mut job = store.memory_job(id)?;
            if matches!(job["state"].as_str(), Some("running" | "validating")) {
                job["state"] = json!("interrupted");
                job["error"] = json!("Application exited; manual maintenance retry required");
                store.memory_job_save(&job)?;
            }
        }
        self.memory_queue.clear();
        for (_, handle) in self.maintenance.drain() {
            handle.abort();
        }
        let ids = self.live.keys().copied().collect::<Vec<_>>();
        for id in ids {
            let run = store.agent_run(id)?;
            if run["kind"] == "external_cli"
                && run["waiting"] == json!(["review"])
                && run["intent"].is_null()
            {
                self.live.remove(&id);
                continue;
            }
            self.stop(store, id, false).await?;
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while self.live.values().any(|l| l.tool.is_some())
            || self.mcp_busy()
            || !self.jobs.is_empty()
            || !self.hook_live.is_empty()
        {
            match tokio::time::timeout_at(deadline, self.receiver.recv()).await {
                Ok(Some(update)) => self.accept(store, update)?,
                _ => return Err("无法确认工具停止；记录将保留以供重启核对。".into()),
            }
        }
        for _ in 0..4 {
            self.pump_tasks(store, 0)?;
            for id in self.live.keys().copied().collect::<Vec<_>>() {
                let mut doc = store.agent_run(id)?;
                if doc["state"] == "cancelling" {
                    self.finish_stop(store, &mut doc)?;
                }
            }
        }
        Ok(())
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        for w in self.mcp_work.values() {
            w.handle.abort();
        }
        for h in &self.mcp_cleanup {
            h.abort();
        }
        for h in self.hook_live.values_mut() {
            if let Some(model) = h.model.take() {
                model.abort();
            }
            if let Some(flag) = &h.cancel {
                flag.store(true, Ordering::SeqCst);
            }
        }
        for (_, handle) in self.maintenance.drain() {
            handle.abort();
        }
        for job in self.jobs.values() {
            job.cancel.store(true, Ordering::SeqCst);
        }
        for live in self.live.values_mut() {
            if let Some(model) = live.model.take() {
                model.abort();
            }
            if let Some(cancel) = &live.cancel {
                cancel.store(true, Ordering::SeqCst);
            }
        }
    }
}
