mod authorizations;
mod claude;
mod cli_process;
mod cli_settings;
mod codex;
mod copilot;
mod engines;
mod events;
mod followups;
mod grok;
mod group_runtime;
mod groups;
mod office;
mod omp;
mod opencode;
mod pi;
mod reminders;
mod sandbox;
mod topics;
mod work_items;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, task::JoinHandle};
use troop_gateway::{self as gateway, Config, Message, Secret};
use troop_protocol::{error, result, Request, MAX_FRAME, METHODS, VERSION};
use troop_storage::Store;
use uuid::Uuid;
use zeroize::Zeroize;
mod agent;
mod mcp;
mod oauth;
mod tools;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    protocol: u32,
    client: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Add {
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rename {
    id: i64,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderId {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    #[serde(default)]
    offset: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveProvider {
    id: Option<String>,
    config: Config,
    api_key: Option<String>,
    #[serde(default)]
    clear_key: bool,
    expected_revision: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateChat {
    title: String,
    workspace_id: Option<i64>,
    agent_id: Option<i64>,
    project_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Messages {
    conversation_id: i64,
    before: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendChat {
    conversation_id: i64,
    provider_id: String,
    client_turn_id: String,
    text: String,
    #[serde(default)]
    automation: bool,
    #[serde(default)]
    office_reference_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel {
    turn_id: i64,
}
fn params<T: DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|_| "请求参数无效。".into())
}
fn value(v: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|_| "无法构建响应。".into())
}
fn write(v: Value) -> Result<(), String> {
    let mut out = io::stdout().lock();
    writeln!(out, "{v}").map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}
enum Input {
    Frame(Vec<u8>),
    TooLarge,
    Closed,
}
enum StreamUpdate {
    Text(String),
    Finished(Result<agent::model::ModelOutput, agent::model::ModelError>),
}
struct Update {
    turn: i64,
    body: StreamUpdate,
}
struct Active {
    conversation: i64,
    provider: String,
    handle: JoinHandle<()>,
    notified: Instant,
}
struct Core {
    model: std::sync::Arc<dyn agent::model::ModelProvider>,
    oauth: oauth::Manager,
    store: Store,
    generation: String,
    sequence: u64,
    active: HashMap<i64, Active>,
    updates: mpsc::Sender<Update>,
    agents: agent::Manager,
    events: events::Receiver,
    receiver_only: bool,
    event_consumer: events::Consumer,
    reminder_clock: reminders::Clock,
}
impl Core {
    fn notify(&mut self, turn: i64, conversation: i64, status: &str) -> Result<(), String> {
        self.sequence += 1;
        write(
            json!({"jsonrpc":"2.0","method":"chat.changed","params":{"generation":self.generation,"seq":self.sequence,"turn_id":turn,"conversation_id":conversation,"status":status}}),
        )
    }
    async fn stop_turn(&mut self, turn: i64, status: &str, message: &str) -> Result<bool, String> {
        let Some(active) = self.active.remove(&turn) else {
            return Ok(false);
        };
        active.handle.abort();
        let _ = active.handle.await;
        self.store
            .finish_turn(turn, status, Some(status), Some(message), None, None)?;
        self.notify(turn, active.conversation, status)?;
        Ok(true)
    }
    async fn stop_all(&mut self, status: &str, message: &str) -> Result<(), String> {
        let turns: Vec<_> = self.active.keys().copied().collect();
        for turn in turns {
            self.stop_turn(turn, status, message).await?;
        }
        Ok(())
    }
    fn accept(&mut self, update: Update) -> Result<(), String> {
        let Some(active) = self.active.get_mut(&update.turn) else {
            return Ok(());
        };
        let conversation = active.conversation;
        match update.body {
            StreamUpdate::Text(text) => {
                self.store.append_text(update.turn, &text)?;
                if active.notified.elapsed().as_millis() >= 100 {
                    active.notified = Instant::now();
                    self.notify(update.turn, conversation, "streaming")?;
                }
            }
            StreamUpdate::Finished(outcome) => {
                self.active.remove(&update.turn);
                let status = match outcome {
                    Ok(summary) => {
                        let status = if matches!(
                            summary.finish_reason.as_str(),
                            "length" | "content_filter" | "pause_turn"
                        ) {
                            "incomplete"
                        } else {
                            "completed"
                        };
                        self.store.finish_turn(
                            update.turn,
                            status,
                            None,
                            None,
                            Some(&json!(summary.usage)),
                            Some(&summary.finish_reason),
                        )?;
                        status
                    }
                    Err(failure) => {
                        self.store.finish_turn(
                            update.turn,
                            "failed",
                            Some(failure.kind),
                            Some(&failure.message),
                            None,
                            None,
                        )?;
                        "failed"
                    }
                };
                self.notify(update.turn, conversation, status)?;
            }
        }
        Ok(())
    }
    async fn dispatch(&mut self, method: &str, p: Value) -> Result<(Value, bool), String> {
        if method.starts_with("followups.") {
            return Ok((
                self.agents
                    .followups_read(&self.store, method, p, self.reminder_clock.now()?)?,
                false,
            ));
        }
        if method.starts_with("schedules.") {
            return Ok((
                self.agents
                    .schedules_read(&self.store, method, p, self.reminder_clock.now()?)?,
                false,
            ));
        }
        if method.starts_with("office.") {
            return Ok((office::read(&self.store, method, p)?, false));
        }
        if method == "automations.result" {
            return Ok((
                self.agents
                    .automation_result(&self.store, p, self.reminder_clock.now()?)?,
                false,
            ));
        }
        if method == "automations.preview" {
            return Ok((
                self.agents
                    .preview_automation(&self.store, p, self.reminder_clock.now()?)?,
                false,
            ));
        }
        if method == "reminders.preview" {
            return Ok((reminders::preview(p, self.reminder_clock.now()?)?, false));
        }
        if method.starts_with("reminders.") || method.starts_with("notifications.") {
            return Ok((reminders::read(&self.store, method, p)?, false));
        }
        if method.starts_with("topics.") {
            return Ok((topics::read(&self.store, method, p)?, false));
        }
        if method.starts_with("groups.") {
            if matches!(
                method,
                "groups.executor.get" | "groups.executor.preview" | "groups.chain"
            ) {
                return Ok((
                    self.agents.group_execution_read(&self.store, method, p)?,
                    false,
                ));
            }
            return Ok((groups::read(&self.store, method, p)?, false));
        }
        if method.starts_with("work_items.") {
            if method == "work_items.preview" {
                return Ok((self.agents.preview_work_item(&self.store, p)?, false));
            }
            return Ok((work_items::read(&self.store, method, p)?, false));
        }
        if method.starts_with("rules.") {
            if method == "rules.save" {
                return Err("规则变更需要操作账本。".into());
            }
            return Ok((self.agents.rules_rpc(&mut self.store, method, p)?, false));
        }
        if method.starts_with("events.") {
            let mut value = events::read(
                &self.store,
                method,
                p,
                self.events.address.as_deref(),
                self.receiver_only,
            )?;
            if method == "events.health" {
                value["sources"] = self.event_consumer.health();
            }
            return Ok((value, false));
        }
        if method == "engines.list" {
            return Ok((engines::list(p)?, false));
        }
        if method == "engines.capabilities" {
            return Ok((authorizations::read(&self.store, method, p)?, false));
        }
        if method.starts_with("authorizations.") {
            return Ok((authorizations::read(&self.store, method, p)?, false));
        }
        if method == "agent.follow" {
            return Ok((self.agents.follow(&self.store, p, &self.generation)?, false));
        }
        if method == "agent.follow-content" {
            return Ok((self.agents.follow_content(&self.store, p)?, false));
        }
        if method == "operations.execute" {
            let request = params::<troop_protocol::OperationRequest>(p)?;
            if self.receiver_only && request.method != "events.source.save" {
                return Err("独立接收器仅允许来源管理。".into());
            }
            if troop_protocol::EXTERNAL_OPERATION_COMMANDS.contains(&request.method.as_str()) {
                if request.instance_id != self.store.instance_id()?
                    || Uuid::parse_str(&request.operation_id).is_err()
                    || request.expected_revision.is_some()
                {
                    return Err(
                        "Invalid external operation identity; use the resource revision in input"
                            .into(),
                    );
                }
                let (receipt, fresh) = self.store.reserve_external_operation(
                    "desktop",
                    &request.operation_id,
                    &request.method,
                    &request.input,
                    None,
                )?;
                if !fresh {
                    return Ok((receipt, false));
                }
                let result = if request.method.starts_with("office.") {
                    self.agents
                        .office_host_available(&self.store)
                        .and_then(|()| {
                            office::write(
                                &self.store,
                                &request.method,
                                request.input,
                                Some(&request.operation_id),
                            )
                        })
                        .map(|value| (value, false))
                } else if request.method == "events.source.save" {
                    (|| -> Result<(Value, bool), String> {
                        let saved = events::save_source(
                            &mut self.store,
                            request.input,
                            &request.operation_id,
                            self.receiver_only,
                        )?;
                        let id = saved["id"].as_str().ok_or("来源标识无效。")?;
                        self.event_consumer.invalidate(id);
                        self.store.source_event_recheck(id)?;
                        Ok((saved, false))
                    })()
                } else {
                    Box::pin(self.dispatch(&request.method, request.input)).await
                }
                .map(|(v, _)| v);
                if request.method.starts_with("office.") {
                    return Ok((
                        self.store
                            .finish_office_operation(&request.operation_id, result)?,
                        false,
                    ));
                }
                return Ok((
                    self.store.finish_external_operation(
                        "desktop",
                        &request.operation_id,
                        result,
                    )?,
                    false,
                ));
            }
            let recheck_source = (request.method == "events.recheck")
                .then(|| request.input["source_id"].as_str().map(str::to_owned))
                .flatten();
            let receipt = self.agents.execute_operation(
                &mut self.store,
                request,
                self.reminder_clock.now()?,
            )?;
            if receipt["state"] == "committed" {
                if let Some(source) = recheck_source {
                    self.event_consumer.invalidate(&source);
                }
            }
            return Ok((receipt, false));
        }
        if method == "operations.get" {
            let query = params::<troop_protocol::OperationQuery>(p)?;
            if query.instance_id != self.store.instance_id()?
                || Uuid::parse_str(&query.operation_id).is_err()
            {
                return Err("Invalid operation identity or storage instance".into());
            }
            return Ok((
                self.store.operation_get("desktop", &query.operation_id)?,
                false,
            ));
        }
        if method.starts_with("mcp.oauth.") {
            return Ok((self.oauth.dispatch(&mut self.store, method, p)?, false));
        }
        if method.starts_with("mcp.") {
            if method == "mcp.remove" {
                let id = p["id"].as_str().ok_or("Invalid MCP server ID")?;
                let server = self.store.mcp_server(id)?;
                if p["expected_revision"] != server.revision {
                    return Err("MCP definition changed; refresh before deleting".into());
                }
                let auth = self.store.oauth_get(id)?;
                if let Some(revision) = auth["revision"].as_i64().filter(|v| *v > 0) {
                    self.oauth.dispatch(
                        &mut self.store,
                        "mcp.oauth.disconnect",
                        json!({"id":id,"auth_revision":revision}),
                    )?;
                }
            }
            return Ok((mcp::dispatch(&mut self.store, method, p)?, false));
        }
        if method.starts_with("agent.")
            || method.starts_with("cli.")
            || method.starts_with("memory.")
            || method.starts_with("skills.")
            || method.starts_with("hooks.")
        {
            return Ok((
                self.agents.dispatch(&mut self.store, method, p).await?,
                false,
            ));
        }
        let answer = match method {
            "system.ping" => json!({"ready":true}),
            "system.shutdown" => {
                self.oauth.shutdown(&mut self.store)?;
                self.agents.shutdown(&mut self.store).await?;
                self.stop_all("cancelled", "应用退出，已停止本次生成。部分文本已保留。")
                    .await?;
                return Ok((json!({"stopped":true}), true));
            }
            "workspace.list" => value(self.store.list(params::<List>(p)?.offset)?)?,
            "workspace.add" => value(self.store.add(&params::<Add>(p)?.path)?)?,
            "workspace.rename" => {
                let a = params::<Rename>(p)?;
                value(self.store.rename(a.id, &a.name)?)?
            }
            "workspace.remove" => {
                let id = params::<Id>(p)?.id;
                if self.agents.owns_workspace(&self.store, id) {
                    return Err("请先停止使用此工作区的任务。".into());
                }
                value(self.store.remove(id)?)?
            }
            "provider.list" => value(self.store.providers()?)?,
            "provider.save" => {
                let mut a = params::<SaveProvider>(p)?;
                a.config.endpoint()?;
                a.config.name = a.config.name.trim().to_owned();
                a.config.model = a.config.model.trim().to_owned();
                a.config.base_url = a.config.base_url.trim().trim_end_matches('/').to_owned();
                let old = match &a.id {
                    Some(id) => Some(self.store.provider(id)?),
                    None => None,
                };
                if a.expected_revision.is_some_and(|expected| {
                    old.as_ref().map(|p| p.revision).unwrap_or(0) != expected
                }) {
                    return Err("模型服务已变化，请刷新后再保存。".into());
                }
                if old.as_ref().is_some_and(|p| {
                    self.active.values().any(|a| a.provider == p.id)
                        || self.agents.owns_provider(&self.store, &p.id)
                }) {
                    return Err("请先停止使用此服务的生成，再编辑配置。".into());
                }
                if a.clear_key && a.api_key.is_some() {
                    return Err("保存新密钥和移除密钥不能同时进行。".into());
                }
                let id = a.id.unwrap_or_else(|| Uuid::new_v4().to_string());
                let fresh_ref = a
                    .api_key
                    .as_ref()
                    .map(|_| format!("TROOP/model/{}", Uuid::new_v4()));
                if let (Some(reference), Some(secret)) = (&fresh_ref, &mut a.api_key) {
                    gateway::credentials::write(reference, secret)?;
                    secret.zeroize();
                }
                let reference = if a.clear_key {
                    None
                } else {
                    fresh_ref
                        .clone()
                        .or_else(|| old.as_ref().and_then(|p| p.secret_ref.clone()))
                };
                let saved = self
                    .store
                    .save_provider(&id, &json!(a.config), reference.as_deref());
                if saved.is_err() {
                    if let Some(r) = &fresh_ref {
                        let _ = gateway::credentials::delete(r);
                    }
                }
                let saved = saved?;
                if let Some(r) = old
                    .and_then(|p| p.secret_ref)
                    .filter(|r| Some(r) != reference.as_ref())
                {
                    gateway::credentials::delete(&r)?;
                }
                value(saved)?
            }
            "provider.remove" => {
                let a = params::<ProviderId>(p)?;
                if self.active.values().any(|v| v.provider == a.id)
                    || self.agents.owns_provider(&self.store, &a.id)
                {
                    return Err("请先停止使用此服务的生成。".into());
                }
                let old = self.store.provider(&a.id)?;
                if let Some(r) = old.secret_ref {
                    gateway::credentials::delete(&r)?;
                }
                self.store.delete_provider(&a.id)?;
                Value::Null
            }
            "chat.list" => self.store.conversations(params::<List>(p)?.offset)?,
            "chat.create" => {
                let a = params::<CreateChat>(p)?;
                json!({"id":self.store.create_scoped_conversation(&a.title,a.workspace_id,a.agent_id.unwrap_or(1),a.project_id.as_deref())?})
            }
            "chat.remove" => {
                let a = params::<Id>(p)?;
                if self.active.values().any(|v| v.conversation == a.id) {
                    return Err("请先停止此对话的生成，再删除对话。".into());
                }
                self.store.delete_conversation(a.id)?;
                Value::Null
            }
            "chat.messages" => {
                let a = params::<Messages>(p)?;
                if a.before.is_some_and(|v| v <= 0) {
                    return Err("历史分页参数无效。".into());
                }
                value(self.store.messages(a.conversation_id, a.before)?)?
            }
            "chat.cancel" => {
                let a = params::<Cancel>(p)?;
                json!({"cancelled":self.stop_turn(a.turn_id,"cancelled","已停止生成，已接收的文本已保留。").await?})
            }
            "chat.send" => {
                let mut a = params::<SendChat>(p)?;
                let scope = self.store.chat_scope(a.conversation_id)?;
                let references = office::materialize_references(
                    &self.store,
                    &a.office_reference_ids,
                    scope["workspace_id"].as_i64(),
                    None,
                )?;
                a.text.push_str(&office::reference_context(&references));
                if self
                    .store
                    .chat_automation_mode(&a.client_turn_id)?
                    .is_some_and(|mode| mode != a.automation)
                {
                    return Err("同一消息身份不能改变自动化模式。".into());
                }
                if Uuid::parse_str(&a.client_turn_id).is_err()
                    || a.text.trim().is_empty()
                    || a.text.len() > 12_000
                    || a.text
                        .chars()
                        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                {
                    return Err("消息应为 1–12000 字节的有效文本。".into());
                }
                if let Some(previous) = self.store.duplicate_turn(
                    &a.client_turn_id,
                    a.conversation_id,
                    &a.provider_id,
                    &a.text,
                )? {
                    return Ok((value(previous)?, false));
                }
                if self.active.len() + self.agents.model_count() >= 4 {
                    return Err("最多同时生成 4 个回复，请先停止或等待已有生成。".into());
                }
                if self
                    .active
                    .values()
                    .any(|v| v.conversation == a.conversation_id)
                {
                    return Err("此对话已有生成，请先停止或等待完成。".into());
                }
                let provider = self.store.provider(&a.provider_id)?;
                let config: Config = serde_json::from_value(provider.config.clone())
                    .map_err(|_| "模型配置损坏，请重新保存。")?;
                config.endpoint()?;
                let secret = provider
                    .secret_ref
                    .as_ref()
                    .map(|r| gateway::credentials::read(r).map(Secret))
                    .transpose()?;
                let mut messages: Vec<Message> = self
                    .store
                    .context(a.conversation_id)?
                    .into_iter()
                    .map(|(role, content)| Message { role, content })
                    .collect();
                if a.automation {
                    let scope = self.store.chat_scope(a.conversation_id)?;
                    messages.insert(0,Message { role:"system".into(),content:format!("用户正在创建待人工确认的自动化。当前 UTC 毫秒时间 {}，对话范围 {}。时间参考默认 Asia/Shanghai，用户可指定其他 IANA 时区。信息不足时用自然语言补问，绝不猜测目标或具体时间。信息完整时只输出一个 JSON 对象，不使用代码围栏。格式为 {{\"troop_automation\":{{\"kind\":\"reminder\",\"name\":\"名称\",\"body\":\"提醒正文\",\"schedule\":{{\"kind\":\"once\",\"timezone\":\"Asia/Shanghai\",\"date\":\"YYYY-MM-DD\",\"time\":\"HH:MM\",\"weekdays\":[]}}}}}}。定时 Agent 执行使用 kind=scheduled，以 goal 替换 body。重复支持 daily（date=null，weekdays=[]）和 weekly（date=null，weekdays=ISO周一1至周日7）。只提出草稿，只有用户在确认卡片接纳后才登记。",self.reminder_clock.now()?,scope) });
                }
                messages.push(Message {
                    role: "user".into(),
                    content: a.text.clone(),
                });
                let receipt = self.store.begin_turn_mode(
                    &a.client_turn_id,
                    a.conversation_id,
                    &provider,
                    &a.text,
                    a.automation,
                    &a.office_reference_ids,
                )?;
                let request = agent::model::ModelRequest {
                    config,
                    secret,
                    context: agent::model::ModelContext::Conversation(messages),
                };
                let turn = receipt.turn_id;
                let updates = self.updates.clone();
                let provider = self.model.clone();
                let handle = tokio::spawn(async move {
                    let (tx, mut rx) = mpsc::channel(32);
                    let operation = provider.stream(request, tx);
                    tokio::pin!(operation);
                    loop {
                        tokio::select! {
                            text=rx.recv()=>{if let Some(text)=text{if updates.send(Update{turn,body:StreamUpdate::Text(text)}).await.is_err(){return;}}}
                            outcome=&mut operation=>{
                                while let Ok(text)=rx.try_recv(){if updates.send(Update{turn,body:StreamUpdate::Text(text)}).await.is_err(){return;}}
                                let _=updates.send(Update{turn,body:StreamUpdate::Finished(outcome)}).await;return;
                            }
                        }
                    }
                });
                self.active.insert(
                    turn,
                    Active {
                        conversation: a.conversation_id,
                        provider: a.provider_id,
                        handle,
                        notified: Instant::now() - std::time::Duration::from_secs(1),
                    },
                );
                value(receipt)?
            }
            _ => return Err("未知接口。".into()),
        };
        Ok((answer, false))
    }
}

async fn run() -> Result<(), String> {
    let mut args: Vec<_> = std::env::args().collect();
    let clock_file = if let Some(index) = args.iter().position(|arg| arg == "--test-clock-file") {
        if !cfg!(debug_assertions) || index + 1 >= args.len() {
            return Err("测试时钟仅供调试验收。".into());
        }
        let path = PathBuf::from(args.remove(index + 1));
        args.remove(index);
        if !path.is_absolute() {
            return Err("测试时钟路径必须为绝对路径。".into());
        }
        Some(path)
    } else {
        None
    };
    let reminder_clock = reminders::Clock::new(clock_file)?;
    let receiver_only = if let Some(index) = args.iter().position(|s| s == "--event-receiver") {
        args.remove(index);
        true
    } else {
        false
    };
    let address = if let Some(index) = args.iter().position(|s| s == "--event-listen") {
        if index + 1 >= args.len() {
            return Err("接收器缺少绑定地址。".into());
        }
        let address = args.remove(index + 1);
        args.remove(index);
        address.parse().map_err(|_| "接收器地址无效。")?
    } else {
        "127.0.0.1:0".parse().map_err(|_| "接收器地址无效。")?
    };
    if args.len() != 3 || args[1] != "--data-dir" {
        return Err("Usage: troop-core --data-dir <absolute directory>".into());
    }
    let store = Store::open(&PathBuf::from(&args[2]))?;
    if !receiver_only {
        store.event_recover_local_leases()?;
    }
    mcp::recover(&store)?;
    let generation = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "System clock invalid")?
            .as_nanos()
    );
    let (inputs, mut input) = mpsc::channel(32);
    let (updates, mut update) = mpsc::channel(64);
    std::thread::spawn(move || {
        let mut reader = io::stdin().lock();
        loop {
            let mut bytes = Vec::new();
            let n = (&mut reader)
                .take((MAX_FRAME + 1) as u64)
                .read_until(b'\n', &mut bytes);
            match n {
                Ok(0) | Err(_) => {
                    let _ = inputs.blocking_send(Input::Closed);
                    return;
                }
                Ok(n) if n > MAX_FRAME => {
                    let _ = inputs.blocking_send(Input::TooLarge);
                    return;
                }
                Ok(_) => {
                    if inputs.blocking_send(Input::Frame(bytes)).is_err() {
                        return;
                    }
                }
            }
        }
    });
    let providers = agent::providers::Providers::default();
    let mut core = Core {
        model: providers.model.clone(),
        oauth: oauth::Manager::new(),
        agents: agent::Manager::with_providers(PathBuf::from(&args[2]), providers)?,
        store,
        generation,
        sequence: 0,
        active: HashMap::new(),
        updates,
        events: events::Receiver::start(Some(address)).await?,
        receiver_only,
        reminder_clock,
        event_consumer: events::Consumer::new(),
    };
    let mut seen = HashSet::new();
    let mut handshaken = false;
    let mut event_retention = tokio::time::interval(std::time::Duration::from_secs(3600));
    let mut schedule = tokio::time::interval(std::time::Duration::from_millis(100));
    loop {
        tokio::select! {
            incoming=input.recv()=>{
                let bytes=match incoming {Some(Input::Frame(v))=>v,Some(Input::TooLarge)=>{write(error(Value::Null,&core.generation,-32600,"frame_too_large","Request frame too large"))?;break;},_=>break};
                let request=serde_json::from_slice::<Request>(&bytes);
                let (response,shutdown)=match request {
                    Err(_)=>(error(Value::Null,&core.generation,-32700,"invalid_request","Malformed request"),false),
                    Ok(r)=>{
                        let id=json!(r.id);
                        if let Err(message)=r.validate(){(error(id,&core.generation,-32600,"invalid_request",message),false)}
                        else if !seen.insert(r.id.clone()){(error(id,&core.generation,-32600,"duplicate_id","Request ID already used"),false)}
                        else if r.method=="system.hello"{match params::<Hello>(r.params){Ok(h)if h.protocol==VERSION&&h.client=="troop-desktop"=>{handshaken=true;(result(&r.id,&core.generation,json!({"protocol":VERSION,"core_version":env!("CARGO_PKG_VERSION"),"capabilities":METHODS,"follow_resources":["run","task","invocation"],"storage_instance":core.store.instance_id()?})),false)},_=>(error(id,&core.generation,-32001,"protocol_mismatch","Incompatible protocol or client"),false)}}
                        else if !handshaken{(error(id,&core.generation,-32002,"handshake_required","Handshake required"),false)}
                        else if r.generation.as_deref()!=Some(&core.generation){(error(id,&core.generation,-32003,"stale_generation","Core generation changed"),false)}
                        else if core.receiver_only && !r.method.starts_with("events.") && !r.method.starts_with("operations.") && !r.method.starts_with("system.") {(error(id,&core.generation,-32601,"receiver_only","独立接收器不执行任务"),false)}
                        else if !METHODS.contains(&r.method.as_str()){(error(id,&core.generation,-32601,"method_not_found","Unknown method"),false)}
                        else{match core.dispatch(&r.method,r.params).await{Ok((v,quit))=>(result(&r.id,&core.generation,v),quit),Err(m)=>(error(id,&core.generation,-32602,"request_rejected",&m),false)}}
                    }
                };
                let response=if response.to_string().len()>MAX_FRAME{error(response["id"].clone(),&core.generation,-32004,"response_too_large","Response exceeds frame limit")}else{response};write(response)?;
                if shutdown||seen.len()>=131_072{break;}
            }
            Some(update)=core.event_consumer.receiver.recv()=>{core.event_consumer.accept(&mut core.store,&core.generation,update)?;},
            Some(message)=core.events.messages.recv()=>{let result=events::handle_http(&mut core.store,&message);let _=message.answer.send(result);},
            Some(message)=update.recv()=>core.accept(message)?,
            Some(message)=core.agents.receiver.recv()=>core.agents.accept(&mut core.store,message)?,
            Some(message)=core.oauth.receiver.recv()=>core.oauth.accept(&mut core.store,message)?,
            _=event_retention.tick()=>{
                if let Err(error)=core.store.event_prune_payloads(){eprintln!("Event payload retention deferred: {error}");}
                if let Err(error)=core.store.retain_operation_receipts(){eprintln!("Operation receipt retention deferred: {error}");}
            },
            _=schedule.tick()=>{ if !core.receiver_only {reminders::pump(&mut core.store,&mut core.reminder_clock)?;core.agents.pump_schedules(&mut core.store,&core.reminder_clock)?;core.agents.pump_followups(&mut core.store,&core.reminder_clock)?;core.event_consumer.pump(&mut core.store,&core.generation)?;core.agents.pump_rules(&mut core.store)?;} },
        }
        if !core.receiver_only {
            core.agents.pump(
                &mut core.store,
                4usize.saturating_sub(core.active.len()),
                &mut core.oauth,
            )?;
            core.oauth.prune(&mut core.store)?;
        }
    }
    core.oauth.shutdown(&mut core.store)?;
    core.stop_all(
        "interrupted",
        "控制连接已断开；已保留接收的文本，不会自动续发。",
    )
    .await?;
    core.agents.shutdown(&mut core.store).await?;
    core.oauth.shutdown(&mut core.store)?;
    Ok(())
}
#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--mcp-stdio-worker") {
        let code = if troop_mcp::worker::run().is_ok() {
            0
        } else {
            1
        };
        std::process::exit(code);
    }
    if std::env::args().nth(1).as_deref() == Some("--tool-worker") {
        let code = match tools::worker() {
            Ok(()) => 0,
            Err(_) => 1,
        };
        std::process::exit(code);
    }
    if let Err(message) = run().await {
        eprintln!("TROOP Core: {message}");
        std::process::exit(1);
    }
}
