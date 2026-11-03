use crate::{params, tools};
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
use troop_gateway::{
    self as gateway,
    agent::{ToolCall, ToolWire},
    Config, Secret,
};
use troop_storage::{public_run, Store};
use uuid::Uuid;
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
    provider_id: String,
    goal: String,
    #[serde(default = "default_agent")]
    agent_id: i64,
    workflow_id: Option<String>,
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
    Model(i64, i64, Result<gateway::Summary, gateway::Failure>),
    Ready(i64, i64, i64, blocking::Sender<bool>),
    Tool(i64, i64, i64, Value),
    TaskReady(i64, i64, blocking::Sender<bool>),
    TaskOutput(i64, i64, Value),
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
    live: HashMap<i64, Live>,
    sender: mpsc::Sender<Update>,
    pub receiver: mpsc::Receiver<Update>,
    receipts: PathBuf,
    jobs: HashMap<i64, TaskLive>,
    maintenance: HashMap<i64, JoinHandle<()>>,
    memory_queue: std::collections::BTreeSet<i64>,
    hook_live: HashMap<i64, hooks::HookLive>,
    mcp_work: HashMap<i64, mcp::Work>,
    mcp_clients: HashMap<i64, Box<mcp::Connection>>,
    mcp_closing: std::collections::HashSet<i64>,
    mcp_cleanup: Vec<JoinHandle<()>>,
}
fn terminal(doc: &Value) -> bool {
    matches!(
        doc["state"].as_str(),
        Some("completed" | "failed" | "cancelled" | "interrupted")
    )
}
fn text_ok(text: &str) -> bool {
    !text.trim().is_empty()
        && text.len() <= 12000
        && !text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}
fn protocol(doc: &Value) -> Result<gateway::Protocol, String> {
    serde_json::from_value(doc["config"]["protocol"].clone()).map_err(|_| "模型协议无效。".into())
}
fn history(doc: &Value) -> Vec<Value> {
    doc["history"].as_array().cloned().unwrap_or_default()
}
fn append_result(doc: &mut Value, inv: &Value) -> Result<(), String> {
    let mut h = history(doc);
    gateway::agent::tool_result(
        protocol(doc)?,
        &mut h,
        inv["call_id"].as_str().ok_or("工具标识损坏。")?,
        &inv["result"],
        inv["state"] != "succeeded",
    );
    doc["history"] = json!(h);
    Ok(())
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
            + self.maintenance.len()
            + self.hook_models()
    }
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        let receipts = directory.join("worker-receipts");
        std::fs::create_dir_all(&receipts).map_err(|_| "无法建立 Worker 账本目录。")?;
        let (sender, receiver) = mpsc::channel(64);
        Ok(Self {
            live: HashMap::new(),
            sender,
            receiver,
            receipts,
            jobs: HashMap::new(),
            maintenance: HashMap::new(),
            memory_queue: std::collections::BTreeSet::new(),
            hook_live: HashMap::new(),
            mcp_work: HashMap::new(),
            mcp_clients: HashMap::new(),
            mcp_closing: Default::default(),
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
        let mut doc = store.agent_run(id)?;
        if let Some(live) = self.live.get(&id).filter(|l| l.model.is_some()) {
            doc["model_text"] = json!(live.text);
            doc["output"] = json!(live.text);
        }
        if matches!(
            doc["state"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            return Ok(public_run(&doc, false));
        }
        if intent && doc["intent"].is_null() {
            doc["intent"] = json!("cancel");
        }
        if doc["state"] == "interrupted"
            && store.agent_invocations(id)?.iter().any(|i| {
                i["state"] == "indeterminate" && i["stopped"] != true && i["reviewed"] != true
            })
        {
            Self::save(store, &mut doc, "stop_unconfirmed")?;
            return Ok(public_run(&doc, false));
        }
        doc["state"] = json!("cancelling");
        doc["waiting"] = json!([]);
        Self::save(store, &mut doc, "stop_requested")?;
        if let Some(live) = self.live.get_mut(&id) {
            if let Some(handle) = live.model.take() {
                handle.abort();
                let _ = handle.await;
            }
            if let Some(cancel) = &live.cancel {
                cancel.store(true, Ordering::SeqCst);
            }
            if live.tool.is_none() {
                self.finish_stop(store, &mut doc)?;
            }
        } else {
            self.finish_stop(store, &mut doc)?;
        }
        Ok(public_run(&doc, false))
    }
    fn finish_stop(&mut self, store: &mut Store, doc: &mut Value) -> Result<(), String> {
        let id = doc["id"].as_i64().unwrap();
        if self.mcp_run_busy(store, id) {
            return Ok(());
        }
        if self.hook_live.values().any(|h| h.run == id) {
            return Ok(());
        }
        let tasks = store.owned_tasks(Store::task_root(doc))?;
        let owned = tasks
            .iter()
            .filter(|t| t["owner_run_id"] == id)
            .collect::<Vec<_>>();
        if owned.iter().any(|t| tasks::active(t)) {
            return Ok(());
        }
        let unresolved = store
            .mcp_connections(id)?
            .iter()
            .any(|s| s["state"] == "indeterminate" && s["reviewed"] != true)
            || store
                .hook_calls(id)?
                .iter()
                .any(|h| h["state"] == "indeterminate" && h["reviewed"] != true)
            || owned.iter().any(|t| {
                matches!(t["state"].as_str(), Some("indeterminate" | "interrupted"))
                    && t["reviewed"] != true
            })
            || store.agent_invocations(id)?.iter().any(|i| {
                i["state"] == "indeterminate" && i["stopped"] != true && i["reviewed"] != true
            });
        let mut invocations = store.agent_invocations(id)?;
        for inv in &mut invocations {
            if inv["state"] == "prepared" {
                inv["state"] = json!("cancelled");
                inv["result"] = json!({"ok":false,"error":"未派发，任务已停止。"});
            }
        }
        doc["state"] = json!(if unresolved {
            "interrupted"
        } else if doc["intent"] == "failure" {
            "failed"
        } else if doc["intent"] == "cancel" {
            "cancelled"
        } else {
            "interrupted"
        });
        doc["waiting"] = json!([]);
        if doc["intent"] != "failure" {
            doc["error"] = json!(if unresolved {
                "Owned work or process stop requires reconciliation; previous work will not be replayed."
            } else if doc["intent"] == "cancel" {
                "任务已停止；已发生的效果和文件保留。"
            } else {
                "应用退出或执行中断；请核对记录后手动继续。"
            });
        }
        store.agent_save(doc, &mut invocations, "stopped")?;
        self.live.remove(&id);
        Ok(())
    }
    pub async fn dispatch(
        &mut self,
        store: &mut Store,
        method: &str,
        p: Value,
    ) -> Result<Value, String> {
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
            "agent.get" => {
                let id = params::<Id>(p)?.id;
                let run = store.agent_run(id)?;
                let invocations=store.agent_invocations(id)?.iter().map(|i|json!({"id":i["id"],"name":i["name"],"state":i["state"],"epoch":i["epoch"],"approval":i["approval"],"reviewed":i["reviewed"],"stopped":i["stopped"],"hook_ask":i["hook_ask"]})).collect::<Vec<_>>();
                let tasks = store
                    .owned_tasks(Store::task_root(&run))?
                    .iter()
                    .map(troop_storage::public_task)
                    .collect::<Vec<_>>();
                Ok(
                    json!({"run":public_run(&run,false),"invocations":invocations,"tasks":tasks,"hooks_unresolved":store.hook_calls(id)?.iter().any(|h|h["state"]=="indeterminate"&&h["reviewed"]!=true),"mcp_unresolved":store.mcp_connections(id)?.iter().any(|s|s["state"]=="indeterminate"&&s["reviewed"]!=true)}),
                )
            }
            "agent.invocation" => store.agent_invocation(params::<Id>(p)?.id),
            "agent.start" => {
                let a = params::<Start>(p.clone())?;
                if Uuid::parse_str(&a.client_run_id).is_err() || !text_ok(&a.goal) {
                    return Err("任务输入或幂等标识无效。".into());
                }
                if let Some(mut doc) = store.agent_duplicate(&a.client_run_id, &p)? {
                    doc["duplicate"] = json!(true);
                    return Ok(json!({"run":public_run(&doc,false),"duplicate":true}));
                }
                if self.live.len() >= 16 {
                    return Err("最多保留 16 个活动任务，请先停止或完成已有任务。".into());
                }
                let workspace = store.workspace_path(a.workspace_id)?;
                store.memory_agent(a.agent_id)?;
                let provider = store.provider(&a.provider_id)?;
                let config: Config = serde_json::from_value(provider.config.clone())
                    .map_err(|_| "模型配置损坏。")?;
                config.endpoint()?;
                let mut doc = json!({"state":"queued","epoch":1,"revision":0,"step":0,"intent":null,"workspace_id":a.workspace_id,"workspace":workspace,"provider_id":a.provider_id,"config":provider.config,"secret_ref":provider.secret_ref,"goal":a.goal,"history":[{"role":"user","content":a.goal}],"pending":[],"output":"","model_text":"","supplements":[],"waiting":[],"error":null});
                doc["agent_id"] = json!(a.agent_id);
                Self::freeze_mcp(store, &mut doc)?;
                Self::freeze_hooks(store, &mut doc)?;
                self.prepare_skills(store, &mut doc)?;
                let expanded =
                    Self::expand_workflows(store, &mut doc, &a.goal, a.workflow_id.as_deref())?;
                doc["history"] = json!([{"role":"user","content":expanded}]);
                store.agent_create(&a.client_run_id, &p, &mut doc)?;
                let id = doc["id"].as_i64().unwrap();
                self.live.insert(id, Live::default());
                Ok(json!({"run":public_run(&doc,false),"duplicate":false}))
            }
            "agent.cancel" => self.stop(store, params::<Id>(p)?.id, true).await,
            "agent.approve" => {
                let a = params::<Approval>(p)?;
                let mut inv = store.agent_invocation(a.id)?;
                let mut doc = store.agent_run(inv["run_id"].as_i64().unwrap())?;
                if inv["epoch"] != a.epoch {
                    return Err("审批版本已过期。".into());
                }
                if let Some(previous) = inv["approval"].as_bool() {
                    if previous != a.approved {
                        return Err("审批已作出不同决定。".into());
                    }
                    return Ok(json!({"accepted":true,"duplicate":true}));
                }
                if terminal(&doc)
                    || !doc["intent"].is_null()
                    || doc["epoch"] != a.epoch
                    || inv["state"] != "prepared"
                    || !(tools::needs_approval(inv["name"].as_str().unwrap_or(""))
                        || inv["hook_ask"] == true)
                {
                    return Err("此审批已失效。".into());
                }
                inv["approval"] = json!(a.approved);
                store.agent_save(&mut doc, std::slice::from_mut(&mut inv), "approval_decided")?;
                Ok(json!({"accepted":true,"duplicate":false}))
            }
            "agent.steer" => {
                let a = params::<Steer>(p)?;
                if !text_ok(&a.text) || Uuid::parse_str(&a.client_input_id).is_err() {
                    return Err("补充指令无效。".into());
                }
                let mut doc = store.agent_run(a.id)?;
                let mut inputs = doc["supplements"].as_array().cloned().unwrap_or_default();
                if let Some(previous) = inputs.iter().find(|v| v["id"] == a.client_input_id) {
                    if previous["text"] != a.text {
                        return Err("补充指令标识冲突。".into());
                    }
                    return Ok(json!({"accepted":true,"duplicate":true}));
                }
                if terminal(&doc) || !doc["intent"].is_null() {
                    return Err("任务已停止或中断，不能接收补充指令。".into());
                }
                if inputs.len() >= 8 {
                    return Err("本次任务补充指令已达到 8 条上限。".into());
                }
                Self::expand_workflows(store, &mut doc.clone(), &a.text, None)?;
                inputs.push(json!({"id":a.client_input_id,"text":a.text,"applied":false}));
                doc["supplements"] = json!(inputs);
                Self::save(store, &mut doc, "input_received")?;
                Ok(json!({"accepted":true}))
            }
            "agent.reconcile" => {
                let a = params::<Reconcile>(p)?;
                let mut inv = store.agent_invocation(a.id)?;
                let mut doc = store.agent_run(inv["run_id"].as_i64().unwrap())?;
                if inv["epoch"] != a.epoch || inv["state"] != "indeterminate" || !terminal(&doc) {
                    return Err("此调用当前不需要核对或仍在运行。".into());
                }
                if a.source == "receipt" {
                    let receipt = self.receipts.join(format!("{}-{}.json", a.id, a.epoch));
                    let bytes =
                        std::fs::read(receipt).map_err(|_| "没有可核对的 Worker 结果回执。")?;
                    if bytes.len() > 65_536 {
                        return Err("Worker 回执超过限制。".into());
                    }
                    let r: Value =
                        serde_json::from_slice(&bytes).map_err(|_| "Worker 回执不完整。")?;
                    if r["id"] != a.id
                        || r["epoch"] != a.epoch
                        || r["status"] != "finished"
                        || !r["result"]["ok"].is_boolean()
                    {
                        return Err("Worker 尚无已提交的最终结果。".into());
                    }
                    if r["result"]["indeterminate"] == true {
                        return Err("Worker 回执仍标记效果不明，请人工核对后填写结论。".into());
                    }
                    if r["result"]["stopped"] != true {
                        return Err("此回执尚未确认进程树已退出，请人工核对停止状态。".into());
                    }
                    inv["result"] = r["result"].clone();
                    inv["state"] = json!(if r["result"]["ok"] == true
                        && r["result"]["value"]["exit_code"]
                            .as_i64()
                            .is_none_or(|n| n == 0)
                    {
                        "succeeded"
                    } else {
                        "failed"
                    });
                } else if a.source == "reviewed"
                    && !a.note.trim().is_empty()
                    && a.note.len() <= 2000
                {
                    inv["review_note"] = json!(a.note);
                    inv["result"] = json!({"ok":false,"indeterminate":true,"review_note":a.note,"error":"操作效果由用户核对，禁止自动重放此调用。"});
                } else {
                    return Err("请选择有效回执，或填写已核对效果与停止状态的说明。".into());
                }
                inv["reviewed"] = json!(true);
                inv["stopped"] = json!(true);
                store.agent_save(&mut doc, std::slice::from_mut(&mut inv), "reconciled")?;
                Ok(json!({"accepted":true}))
            }
            "agent.resume" => {
                if self.live.len() >= 16 {
                    return Err("活动任务已达到 16 个上限，请先停止或完成已有任务。".into());
                }
                let id = params::<Id>(p)?.id;
                let mut doc = store.agent_run(id)?;
                if store
                    .mcp_connections(id)?
                    .iter()
                    .any(|s| s["state"] == "indeterminate" && s["reviewed"] != true)
                {
                    return Err("Reconcile MCP process stops before continuing".into());
                }
                self.check_resume_tasks(store, &doc)?;
                if store
                    .hook_calls(id)?
                    .iter()
                    .any(|h| h["state"] == "indeterminate" && h["reviewed"] != true)
                {
                    return Err(
                        "Reconcile interrupted Hooks before continuing; no old Hook will replay"
                            .into(),
                    );
                }
                if doc["state"] != "interrupted" || !doc["intent"].is_null() {
                    return Err("只有没有终止意图的中断任务可以手动继续。".into());
                }
                store.workspace_path(doc["workspace_id"].as_i64().unwrap())?;
                let mut invocations = store.agent_invocations(id)?;
                if invocations
                    .iter()
                    .any(|i| i["state"] == "indeterminate" && i["reviewed"] != true)
                {
                    return Err("请先核对所有结果不明的工具；不会自动重放旧操作。".into());
                }
                let pending = doc["pending"].as_array().cloned().unwrap_or_default();
                for inv in &mut invocations {
                    if pending.contains(&inv["id"]) {
                        if inv["state"] == "prepared" || inv["state"] == "cancelled" {
                            inv["state"] = json!("cancelled");
                            inv["result"] = json!({"ok":false,"error":"旧计划在中断时失效，未派发；需要重新评估。"});
                        }
                        append_result(&mut doc, inv)?;
                    }
                }
                doc["epoch"] = json!(doc["epoch"].as_i64().unwrap() + 1);
                doc["pending"] = json!([]);
                doc["state"] = json!("queued");
                doc["waiting"] = json!([]);
                doc["error"] = Value::Null;
                store.agent_save(&mut doc, &mut invocations, "manual_resume")?;
                self.live.insert(id, Live::default());
                Ok(public_run(&doc, false))
            }
            _ => Err("未知 Agent 接口。".into()),
        }
    }
    fn apply_inputs(store: &mut Store, doc: &mut Value) -> Result<(), String> {
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
                append_result(doc, inv)?;
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
        self.prune_mcp(store)?;
        self.mcp_cleanup.retain(|h| !h.is_finished());
        self.poll_hook_deadlines();
        self.pump_tasks(store)?;
        let mut ids = self.live.keys().copied().collect::<Vec<_>>();
        ids.sort_unstable();
        for id in ids {
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
            Self::apply_inputs(store, &mut doc)?;
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
                if Self::validate_tool(store, &doc, &name, &inv["arguments"]).is_ok()
                    && (doc["read_only"] != true || tools::read_only(&name))
                    && !self.pre_hooks(store, &mut doc, &mut inv, model_capacity)?
                {
                    continue;
                }
                if (tools::needs_approval(&name) || inv["hook_ask"] == true)
                    && Self::validate_tool(store, &doc, &name, &inv["arguments"]).is_ok()
                    && inv["approval"].is_null()
                    && (doc["read_only"] != true || tools::read_only(&name))
                {
                    if doc["waiting"] != json!(["approval"]) {
                        doc["state"] = json!("waiting");
                        doc["waiting"] = json!(["approval"]);
                        Self::save(store, &mut doc, "waiting_approval")?;
                    }
                    continue;
                }
                let rejected = if inv["approval"] == false {
                    Some("用户拒绝此操作。".into())
                } else {
                    Self::validate_tool(store, &doc, &name, &inv["arguments"])
                        .err()
                        .or_else(|| {
                            (doc["read_only"] == true && !tools::read_only(&name)).then(|| {
                                "Read-only child agents cannot execute this capability".into()
                            })
                        })
                };
                if let Some(error) = rejected {
                    inv["state"] = json!("failed");
                    inv["result"] = json!({"ok":false,"error":error});
                    append_result(&mut doc, &inv)?;
                    remove_pending(&mut doc, inv_id);
                    store.agent_save(&mut doc, std::slice::from_mut(&mut inv), "tool_rejected")?;
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
                if self.live.values().any(|l| l.tool.is_some())
                    || self.mcp_busy()
                    || store.mcp_quarantined()?
                    || self.hook_commands_busy()
                    || store.hooks_quarantined()?
                    || !self.jobs.is_empty()
                    || store.agent_quarantined()?
                    || store.tasks_quarantined()?
                {
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
                store.agent_save(&mut doc, std::slice::from_mut(&mut inv), "tool_dispatched")?;
                let epoch = doc["epoch"].as_i64().unwrap();
                let cancel = Arc::new(AtomicBool::new(false));
                let flag = cancel.clone();
                let updates = self.sender.clone();
                let work = tools::Work {
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
                std::thread::spawn(move || {
                    let ready = updates.clone();
                    let result = tools::execute(work, flag, move |gate| {
                        let _ = ready.blocking_send(Update::Ready(id, epoch, inv_id, gate));
                    });
                    let _ = updates.blocking_send(Update::Tool(id, epoch, inv_id, result));
                });
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
                if doc["step"].as_u64().unwrap_or(0) >= 16
                    || store.agent_invocations(id)?.len() >= 32
                    || tree_steps >= 64
                    || tree_tools >= 128
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
                let memory = Self::memory_snapshot(store, &mut doc)?;
                let mut context = Self::context_view(&doc);
                let skills = Self::skill_catalog(store, &doc)?;
                if !skills.is_empty() {
                    context.insert(0, json!({"role":"system","content":skills}));
                }
                if !memory.is_empty() {
                    context.insert(0, json!({"role":"system","content":memory}));
                }
                if serde_json::to_string(&context).unwrap().len() > 192_000 {
                    return Err(
                        "Model context exceeds the bounded memory and history budget".into(),
                    );
                }
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
                let request = gateway::Request {
                    config,
                    secret,
                    messages: vec![],
                    tools: Some(ToolWire {
                        history: context,
                        definitions: tools::definitions()
                            .into_iter()
                            .filter(|d| {
                                doc["read_only"] != true
                                    || tools::read_only(d["name"].as_str().unwrap())
                            })
                            .chain(mcp::definitions(&doc, store))
                            .collect(),
                    }),
                };
                let updates = self.sender.clone();
                let handle = tokio::spawn(async move {
                    let (tx, mut rx) = mpsc::channel(32);
                    let operation = gateway::stream(request, tx);
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
            Update::TaskReady(..) | Update::TaskOutput(..) | Update::TaskDone(..)
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
                        let mut h = history(&doc);
                        gateway::agent::assistant(
                            protocol(&doc)?,
                            &mut h,
                            doc["model_text"].as_str().unwrap_or(""),
                            &summary.calls,
                            &summary.output_items,
                        );
                        doc["history"] = json!(h);
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
                            {
                                doc["state"] = json!("failed");
                                doc["intent"] = json!("failure");
                                doc["error"] =
                                    json!("工具计划超过本次任务的 32 次调用预算，未派发。");
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
                inv["state"] = json!("running");
                inv["stopped"] = json!(false);
                store.agent_save(&mut doc, std::slice::from_mut(&mut inv), "worker_accepted")?;
                let _ = gate.send(true);
            }
            Update::Tool(_, _, inv_id, mut result) => {
                if self.live[&id].tool != Some(inv_id) {
                    return Ok(());
                }
                let live = self.live.get_mut(&id).unwrap();
                live.tool = None;
                live.cancel = None;
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
                if !stop_confirmed {
                    doc["state"] = json!("interrupted");
                    doc["waiting"] = json!([]);
                    doc["error"] =
                        json!("stop_unconfirmed：未确认整棵受管进程树停止，资源继续隔离。");
                    store.agent_save(
                        &mut doc,
                        std::slice::from_mut(&mut inv),
                        "stop_unconfirmed",
                    )?;
                    self.retire(store, id)?;
                } else if doc["state"] == "cancelling" {
                    store.agent_save(&mut doc, std::slice::from_mut(&mut inv), "tool_stopped")?;
                    self.finish_stop(store, &mut doc)?;
                } else if unknown {
                    doc["state"] = json!("interrupted");
                    doc["waiting"] = json!([]);
                    doc["error"] = json!("工具结果不明，已停止受管 Worker；请核对后手动继续。");
                    store.agent_save(
                        &mut doc,
                        std::slice::from_mut(&mut inv),
                        "tool_indeterminate",
                    )?;
                    self.retire(store, id)?;
                } else {
                    Self::settle_tool(&mut doc, &mut inv)?;
                    doc["state"] = json!("queued");
                    doc["waiting"] = json!([]);
                    store.agent_save(&mut doc, std::slice::from_mut(&mut inv), "tool_result")?;
                }
            }
            _ => unreachable!(),
        }
        Ok(())
    }
    pub async fn shutdown(&mut self, store: &mut Store) -> Result<(), String> {
        for id in self.memory_queue.iter().copied().collect::<Vec<_>>() {
            let mut job = store.memory_job(id)?;
            job["state"] = json!("interrupted");
            job["error"] = json!("Application exited; manual maintenance retry required");
            store.memory_job_save(&job)?;
        }
        self.memory_queue.clear();
        for (_, handle) in self.maintenance.drain() {
            handle.abort();
        }
        let ids = self.live.keys().copied().collect::<Vec<_>>();
        for id in ids {
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
            self.pump_tasks(store)?;
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
