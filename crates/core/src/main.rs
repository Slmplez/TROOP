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
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateChat {
    title: String,
    workspace_id: Option<i64>,
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
    Finished(Result<gateway::Summary, gateway::Failure>),
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
    store: Store,
    generation: String,
    sequence: u64,
    active: HashMap<i64, Active>,
    updates: mpsc::Sender<Update>,
    agents: agent::Manager,
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
        if method.starts_with("agent.") {
            return Ok((
                self.agents.dispatch(&mut self.store, method, p).await?,
                false,
            ));
        }
        let answer = match method {
            "system.ping" => json!({"ready":true}),
            "system.shutdown" => {
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
                json!({"id":self.store.create_conversation(&a.title,a.workspace_id)?})
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
                let a = params::<SendChat>(p)?;
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
                messages.push(Message {
                    role: "user".into(),
                    content: a.text.clone(),
                });
                let receipt = self.store.begin_turn(
                    &a.client_turn_id,
                    a.conversation_id,
                    &provider,
                    &a.text,
                )?;
                let request = gateway::Request {
                    config,
                    secret,
                    messages,
                    tools: None,
                };
                let turn = receipt.turn_id;
                let updates = self.updates.clone();
                let handle = tokio::spawn(async move {
                    let (tx, mut rx) = mpsc::channel(32);
                    let operation = gateway::stream(request, tx);
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
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--data-dir" {
        return Err("Usage: troop-core --data-dir <absolute directory>".into());
    }
    let store = Store::open(&PathBuf::from(&args[2]))?;
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
    let mut core = Core {
        agents: agent::Manager::new(PathBuf::from(&args[2]))?,
        store,
        generation,
        sequence: 0,
        active: HashMap::new(),
        updates,
    };
    let mut seen = HashSet::new();
    let mut handshaken = false;
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
                        else if r.method=="system.hello"{match params::<Hello>(r.params){Ok(h)if h.protocol==VERSION&&h.client=="troop-desktop"=>{handshaken=true;(result(&r.id,&core.generation,json!({"protocol":VERSION,"core_version":env!("CARGO_PKG_VERSION"),"capabilities":METHODS})),false)},_=>(error(id,&core.generation,-32001,"protocol_mismatch","Incompatible protocol or client"),false)}}
                        else if !handshaken{(error(id,&core.generation,-32002,"handshake_required","Handshake required"),false)}
                        else if r.generation.as_deref()!=Some(&core.generation){(error(id,&core.generation,-32003,"stale_generation","Core generation changed"),false)}
                        else if !METHODS.contains(&r.method.as_str()){(error(id,&core.generation,-32601,"method_not_found","Unknown method"),false)}
                        else{match core.dispatch(&r.method,r.params).await{Ok((v,quit))=>(result(&r.id,&core.generation,v),quit),Err(m)=>(error(id,&core.generation,-32602,"request_rejected",&m),false)}}
                    }
                };
                let response=if response.to_string().len()>MAX_FRAME{error(response["id"].clone(),&core.generation,-32004,"response_too_large","Response exceeds frame limit")}else{response};write(response)?;
                if shutdown||seen.len()>=131_072{break;}
            }
            Some(message)=update.recv()=>core.accept(message)?,
            Some(message)=core.agents.receiver.recv()=>core.agents.accept(&mut core.store,message)?,
            _=schedule.tick()=>{},
        }
        core.agents
            .pump(&mut core.store, 4usize.saturating_sub(core.active.len()))?;
    }
    core.stop_all(
        "interrupted",
        "控制连接已断开；已保留接收的文本，不会自动续发。",
    )
    .await?;
    core.agents.shutdown(&mut core.store).await?;
    Ok(())
}
#[tokio::main]
async fn main() {
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
