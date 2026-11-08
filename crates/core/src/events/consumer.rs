use super::*;
use std::{collections::HashMap, time::Duration};
use tokio::{sync::mpsc, task::JoinHandle};

pub struct Failure {
    pub temporary: bool,
    pub message: String,
    pub retry_after: i64,
}
enum WorkResult {
    Pull {
        events: Vec<Value>,
        epoch: i64,
    },
    Ack,
    Review {
        event_id: i64,
        review_generation: i64,
        state: String,
        reason: String,
    },
}
pub struct Update {
    key: String,
    ticket: u64,
    source: Value,
    result: Result<WorkResult, Failure>,
}
struct Active {
    source_id: String,
    ticket: u64,
    task: JoinHandle<()>,
}
pub struct Consumer {
    sender: mpsc::Sender<Update>,
    pub receiver: mpsc::Receiver<Update>,
    active: HashMap<String, Active>,
    next_pull: HashMap<String, i64>,
    health: HashMap<String, Value>,
    round: usize,
    serial: u64,
}
impl Drop for Consumer {
    fn drop(&mut self) {
        for (_, active) in self.active.drain() {
            active.task.abort();
        }
    }
}
impl Consumer {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel(32);
        Self {
            sender,
            receiver,
            active: HashMap::new(),
            next_pull: HashMap::new(),
            health: HashMap::new(),
            round: 0,
            serial: 0,
        }
    }
    pub fn health(&self) -> Value {
        json!(self.health)
    }
    pub fn invalidate(&mut self, source: &str) {
        let keys = self
            .active
            .iter()
            .filter(|(_, active)| active.source_id == source)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(active) = self.active.remove(&key) {
                active.task.abort();
            }
        }
        self.next_pull.remove(source);
        self.health.remove(source);
    }
    fn spawn(
        &mut self,
        key: String,
        source: Value,
        future: impl std::future::Future<Output = Result<WorkResult, Failure>> + Send + 'static,
    ) {
        self.serial += 1;
        let ticket = self.serial;
        let sender = self.sender.clone();
        let source_id = source["id"].as_str().unwrap_or("").to_owned();
        let update_key = key.clone();
        let task = tokio::spawn(async move {
            let result = future.await;
            let _ = sender
                .send(Update {
                    key: update_key,
                    ticket,
                    source,
                    result,
                })
                .await;
        });
        self.active.insert(
            key,
            Active {
                source_id,
                ticket,
                task,
            },
        );
    }
    pub fn pump(&mut self, store: &mut Store, generation: &str) -> Result<(), String> {
        let sources = store.event_sources()?;
        for source in &sources {
            if source["enabled"] != true
                || source["mode"] != "local"
                || source["consumer_id"] != store.instance_id()?
            {
                continue;
            }
            let id = source["id"].as_str().unwrap();
            if let Err(error) =
                store.event_claim(id, source["consumer_id"].as_str().unwrap(), generation)
            {
                self.health.insert(
                    id.into(),
                    json!({"state":"waiting_consumer","last_error":error}),
                );
                continue;
            }
            for event in store.event_inbox(id, 0, true)?["items"].as_array().unwrap() {
                let accepted = store.source_event_accept(source, event);
                let result =
                    accepted.and_then(|_| store.event_ack(id, event["inbox_id"].as_i64().unwrap()));
                if let Err(error) = result {
                    self.health.insert(id.into(), json!({"state":"needs_attention","last_error":error,"inbox_id":event["inbox_id"]}));
                    break;
                }
            }
        }
        for event in store.source_event_due()? {
            if self.active.len() >= 4 {
                break;
            }
            let id = event["id"].as_i64().unwrap();
            let key = format!("review:{id}");
            if self.active.contains_key(&key) {
                continue;
            }
            let source =
                store.event_source(event["source_id"].as_str().ok_or("来源事件身份无效。")?)?;
            if source["consumer_id"] != store.instance_id()? {
                continue;
            }
            let mut event = event;
            let expiry = event["expires_at"].as_i64().unwrap_or(0).min(
                event["received_at"]
                    .as_i64()
                    .unwrap_or(0)
                    .saturating_add(source["ttl_seconds"].as_i64().unwrap_or(0)),
            );
            event["expires_at"] = json!(expiry);
            if expiry <= now() {
                store.source_event_save(event, "expired", "事件已过期。", 0)?;
                continue;
            }
            let snapshot = source.clone();
            self.spawn(key, source, async move { review(snapshot, event).await });
        }
        if !sources.is_empty() {
            self.round = (self.round + 1) % sources.len();
        }
        for source in sources.iter().cycle().skip(self.round).take(sources.len()) {
            if self.active.len() >= 4 {
                break;
            }
            let id = source["id"].as_str().unwrap();
            let key = format!("pull:{id}");
            if source["enabled"] != true
                || source["mode"] != "remote"
                || source["consumer_id"] != store.instance_id()?
                || self.active.contains_key(&key)
                || self.next_pull.get(id).is_some_and(|time| *time > now())
            {
                continue;
            }
            let snapshot = source.clone();
            let generation = generation.to_owned();
            let boundary = store.source_event_boundary(source)?;
            self.spawn(key, source.clone(), async move {
                pull(snapshot, generation, boundary).await
            });
        }
        Ok(())
    }
    pub fn accept(
        &mut self,
        store: &mut Store,
        generation: &str,
        update: Update,
    ) -> Result<(), String> {
        if self
            .active
            .get(&update.key)
            .is_none_or(|active| active.ticket != update.ticket)
        {
            return Ok(());
        }
        self.active.remove(&update.key);
        let id = update.source["id"].as_str().ok_or("消费来源身份无效。")?;
        let current = store.event_source(id)?;
        if current["revision"] != update.source["revision"] || current["enabled"] != true {
            return Ok(());
        }
        match update.result {
            Ok(WorkResult::Pull { events, epoch }) => {
                let mut ids = Vec::new();
                for event in events {
                    if let Err(error) = store.source_event_accept(&current, &event) {
                        self.next_pull.insert(id.into(), now() + 30);
                        self.health.insert(
                            id.into(),
                            json!({"state":"needs_attention","last_error":error}),
                        );
                        return Ok(());
                    }
                    ids.push(event["inbox_id"].as_i64().ok_or("消息身份无效。")?);
                }
                self.next_pull.insert(id.into(), now() + 1);
                self.health
                    .insert(id.into(), json!({"state":"connected","last_error":null}));
                if !ids.is_empty() {
                    let source = current.clone();
                    let generation = generation.to_owned();
                    self.spawn(format!("pull:{id}"), current, async move {
                        ack(source, generation, epoch, ids).await
                    });
                }
            }
            Ok(WorkResult::Review {
                event_id,
                review_generation,
                state,
                reason,
            }) => {
                let event = store.source_event(event_id)?;
                if event["review_generation"].as_i64().unwrap_or(0) != review_generation {
                    return Ok(());
                }
                let state = if event["expires_at"].as_i64().unwrap_or(0) <= now() {
                    "expired"
                } else {
                    state.as_str()
                };
                store.source_event_save(event, state, &reason, 0)?;
            }
            Ok(WorkResult::Ack) => {}
            Err(error) => {
                if !update.key.starts_with("review:") {
                    self.next_pull.insert(id.into(), now() + error.retry_after);
                }
                self.health.insert(id.into(),json!({"state":if error.temporary{"waiting_recheck"}else{"needs_attention"},"last_error":error.message}));
                if let Some(event) = update
                    .key
                    .strip_prefix("review:")
                    .and_then(|s| s.parse::<i64>().ok())
                {
                    let mut event = store.source_event(event)?;
                    let count = event["recheck_attempt"].as_u64().unwrap_or(0) + 1;
                    event["recheck_attempt"] = json!(count);
                    let delay = (30_i64.saturating_mul(1_i64 << count.min(5))).min(900);
                    store.source_event_save(
                        event,
                        if error.temporary {
                            "waiting_recheck"
                        } else {
                            "needs_attention"
                        },
                        &error.message,
                        now() + delay.max(error.retry_after),
                    )?;
                }
            }
        }
        Ok(())
    }
}
fn failure(message: impl Into<String>, temporary: bool) -> Failure {
    Failure {
        temporary,
        message: message.into(),
        retry_after: 30,
    }
}
async fn request(
    url: reqwest::Url,
    token: Option<&str>,
    method: reqwest::Method,
    body: Option<Value>,
    gitlab: bool,
) -> Result<Value, Failure> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none());
    if matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    ) {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|_| failure("事件查询客户端不可用。", false))?;
    let mut request = client
        .request(method, url)
        .header("user-agent", "TROOP/events")
        .header("accept", "application/json");
    if let Some(token) = token {
        request = if gitlab {
            request.header("private-token", token)
        } else {
            request.bearer_auth(token)
        };
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| failure("事件服务连接失败，等待复核。", true))?;
    let status = response.status();
    if !status.is_success() {
        let rate_limited = status.as_u16() == 403
            && response
                .headers()
                .get("x-ratelimit-remaining")
                .is_some_and(|h| h == "0");
        let mut error = failure(
            format!("事件查询返回 HTTP {}。", status.as_u16()),
            status.is_server_error() || matches!(status.as_u16(), 429 | 408 | 409) || rate_limited,
        );
        if status.as_u16() == 409 {
            error.retry_after = 1;
        }
        if let Some(delay) = response
            .headers()
            .get("retry-after")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|n| (1..=900).contains(n))
        {
            error.retry_after = delay;
        }
        return Err(error);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| failure("事件响应中断。", true))?
    {
        if bytes.len() + chunk.len() > 128_000 {
            return Err(failure("事件响应超过上限。", false));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| failure("事件响应不是有效 JSON。", false))
}
fn endpoint(base: &str, segments: &[&str]) -> Result<reqwest::Url, Failure> {
    let mut url = checked_url(base).map_err(|e| failure(e, false))?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| failure("事件服务地址无效。", false))?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    Ok(url)
}
async fn remote_call(
    source: &Value,
    generation: &str,
    action: &str,
    epoch: Option<i64>,
    event: Option<i64>,
    accepted: Option<i64>,
) -> Result<Value, Failure> {
    let secret = secrets(source).map_err(|e| failure(e, false))?;
    let url = endpoint(
        source["receiver_url"]
            .as_str()
            .ok_or_else(|| failure("接收服务地址缺失。", false))?,
        &["inbox", source["id"].as_str().unwrap(), action],
    )?;
    request(url,secret.consumer_token.as_deref(),reqwest::Method::POST,Some(json!({"consumer_id":source["consumer_id"],"generation":generation,"epoch":epoch,"event_id":event,"accepted_through":accepted})),false).await
}
async fn pull(source: Value, generation: String, boundary: i64) -> Result<WorkResult, Failure> {
    let claim = remote_call(&source, &generation, "claim", None, None, Some(boundary)).await?;
    if claim["receiver_instance"] != source["receiver_instance"] {
        return Err(failure("接收器身份与登记不匹配。", false));
    }
    let epoch = claim["lease"]["epoch"]
        .as_i64()
        .ok_or_else(|| failure("接收器租约无效。", false))?;
    let response = remote_call(
        &source,
        &generation,
        "next",
        Some(epoch),
        None,
        Some(boundary),
    )
    .await?;
    let events = response["items"]
        .as_array()
        .filter(|items| items.len() <= 10)
        .ok_or_else(|| failure("交付批次无效。", false))?
        .clone();
    Ok(WorkResult::Pull { events, epoch })
}
async fn ack(
    source: Value,
    generation: String,
    epoch: i64,
    events: Vec<i64>,
) -> Result<WorkResult, Failure> {
    for event in events {
        remote_call(&source, &generation, "ack", Some(epoch), Some(event), None).await?;
    }
    Ok(WorkResult::Ack)
}
async fn review(source: Value, event: Value) -> Result<WorkResult, Failure> {
    let secret = secrets(&source).map_err(|e| failure(e, false))?;
    let base = source["api_base_url"]
        .as_str()
        .ok_or_else(|| failure("状态复核地址未配置。", false))?;
    let subject = event["subject_id"]
        .as_str()
        .ok_or_else(|| failure("复核对象缺失。", false))?;
    let project = source["project"].as_str().unwrap();
    let kind = event["kind"].as_str().unwrap_or("");
    let (mut segments, identity_field, version_field, state_field, phase) = match kind {
        "github.workflow.completed" => (
            vec!["actions", "runs", subject],
            "id",
            "run_attempt",
            "conclusion",
            Some(("status", "completed")),
        ),
        "github.issue.changed" => (
            vec!["issues", subject],
            "number",
            "updated_at",
            "state",
            None,
        ),
        "github.pull_request.changed" => (
            vec!["pulls", subject],
            "number",
            "updated_at",
            "state",
            None,
        ),
        "gitlab.pipeline.changed" => {
            let field = event["version_field"]
                .as_str()
                .filter(|f| matches!(*f, "updated_at" | "finished_at"))
                .ok_or_else(|| failure("事件缺少可复核的 Pipeline 版本。", false))?;
            (
                vec!["projects", project, "pipelines", subject],
                "id",
                field,
                "status",
                None,
            )
        }
        "gitlab.issue.changed" => (
            vec!["projects", project, "issues", subject],
            "iid",
            "updated_at",
            "state",
            None,
        ),
        "gitlab.merge_request.changed" => (
            vec!["projects", project, "merge_requests", subject],
            "iid",
            "updated_at",
            "state",
            None,
        ),
        "webhook.changed" => (
            vec!["subjects", subject],
            "subject_id",
            "subject_version",
            "state",
            None,
        ),
        _ => return Err(failure("事件复核能力未登记。", false)),
    };
    if source["kind"] == "github" {
        let parts = project.split('/').collect::<Vec<_>>();
        if parts.len() != 2 {
            return Err(failure("GitHub 仓库身份无效。", false));
        }
        segments.splice(0..0, ["repos", parts[0], parts[1]]);
    }
    let data = request(
        endpoint(base, &segments)?,
        secret.api_token.as_deref(),
        reqwest::Method::GET,
        None,
        source["kind"] == "gitlab",
    )
    .await?;
    let scalar = |value: &Value| {
        value
            .as_str()
            .map(str::to_owned)
            .or_else(|| value.as_u64().map(|n| n.to_string()))
    };
    let identity = scalar(&data[identity_field]);
    let version = scalar(&data[version_field]);
    let phase_matches = phase.is_none_or(|(field, expected)| data[field] == expected);
    if identity.is_none()
        || version.is_none()
        || phase.is_some_and(|(field, _)| !data[field].is_string())
        || (phase_matches && !data[state_field].is_string())
    {
        return Err(failure("来源查询未提供可复核的身份、版本或状态。", false));
    }
    let matches = identity.as_deref() == Some(subject)
        && version.as_deref() == event["subject_version"].as_str()
        && phase_matches
        && data[state_field] == event["state"];
    Ok(WorkResult::Review {
        event_id: event["id"].as_i64().unwrap(),
        review_generation: event["review_generation"].as_i64().unwrap_or(0),
        state: if matches { "valid" } else { "invalid" }.into(),
        reason: if matches {
            "来源当前状态与事件一致。"
        } else {
            "来源已变化、修复或不再匹配该事件。"
        }
        .into(),
    })
}
