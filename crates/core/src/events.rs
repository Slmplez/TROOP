mod consumer;
mod http;
mod normalize;
use crate::{params, tools};
use base64::{engine::general_purpose::STANDARD, Engine};
pub use consumer::Consumer;
use hmac::{Hmac, Mac};
pub use http::{Message, Receiver};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use troop_gateway::credentials;
use troop_storage::Store;
use uuid::Uuid;
use zeroize::Zeroize;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub name: String,
    pub kind: String,
    pub project: String,
    pub workspace_id: i64,
    pub enabled: bool,
    pub mode: String,
    pub api_base_url: String,
    pub consumer_id: String,
    #[serde(default)]
    pub project_ids: Vec<String>,
    pub receiver_url: Option<String>,
    pub receiver_instance: Option<String>,
    pub auth_mode: Option<String>,
    #[serde(default = "ttl")]
    pub ttl_seconds: i64,
}
fn ttl() -> i64 {
    86_400
}
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Secrets {
    pub webhook_secret: Option<String>,
    pub consumer_token: Option<String>,
    pub api_token: Option<String>,
}
impl Drop for Secrets {
    fn drop(&mut self) {
        self.webhook_secret.zeroize();
        self.consumer_token.zeroize();
        self.api_token.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    id: String,
    expected_revision: i64,
    definition: Definition,
    #[serde(default)]
    secrets: Secrets,
}

pub fn public_source(mut source: Value) -> Value {
    source.as_object_mut().unwrap().remove("secret_ref");
    source
}
pub fn secrets(source: &Value) -> Result<Secrets, String> {
    let mut raw =
        credentials::events::read(source["secret_ref"].as_str().ok_or("来源凭据不存在。")?)?;
    let result = serde_json::from_str(&raw).map_err(|_| "来源凭据损坏。".into());
    raw.zeroize();
    result
}
pub fn save_source(
    store: &mut Store,
    input: Value,
    operation: &str,
    receiver_only: bool,
) -> Result<Value, String> {
    let mut a = params::<Save>(input)?;
    Uuid::parse_str(&a.id).map_err(|_| "来源标识无效。")?;
    Uuid::parse_str(&a.definition.consumer_id).map_err(|_| "消费者标识无效。")?;
    let d = &a.definition;
    if d.name.trim().is_empty()
        || d.name.len() > 120
        || d.project.is_empty()
        || d.project.len() > 200
        || d.project.chars().any(char::is_control)
        || !matches!(d.kind.as_str(), "github" | "gitlab" | "webhook")
        || !matches!(d.mode.as_str(), "local" | "remote")
        || !(1..=86_400).contains(&d.ttl_seconds)
        || !matches!(d.auth_mode.as_deref(), None | Some("standard" | "token"))
    {
        return Err("来源配置无效。".into());
    }
    if d.project_ids.len() > 16
        || d.project_ids
            .iter()
            .any(|p| !troop_storage::memory::slug(p))
    {
        return Err("来源项目范围无效。".into());
    }
    checked_url(&d.api_base_url)?;
    if !receiver_only {
        store.workspace_path(d.workspace_id)?;
        if d.consumer_id != store.instance_id()? {
            return Err("消费者必须绑定当前存储实例。".into());
        }
    }
    if d.mode == "remote" {
        checked_url(d.receiver_url.as_deref().ok_or("远端接收器地址缺失。")?)?;
        Uuid::parse_str(
            d.receiver_instance
                .as_deref()
                .ok_or("远端接收器身份缺失。")?,
        )
        .map_err(|_| "远端接收器身份无效。")?;
    }
    let current = store.event_source(&a.id).ok();
    if current
        .as_ref()
        .map(|s| s["revision"].as_i64().unwrap_or(0))
        .unwrap_or(0)
        != a.expected_revision
    {
        return Err("来源修订冲突。".into());
    }
    if let Some(old) = &current {
        if old["kind"] != d.kind
            || old["project"] != d.project
            || old["api_base_url"].as_str().map(checked_url).transpose()?
                != Some(checked_url(&d.api_base_url)?)
            || old["consumer_id"] != d.consumer_id
            || old["workspace_id"] != d.workspace_id
            || old["project_ids"].as_array().cloned().unwrap_or_default()
                != d.project_ids.iter().map(|p| json!(p)).collect::<Vec<_>>()
        {
            return Err("来源身份与资源归属固定，变更时请新建来源。".into());
        }
        let old = match secrets(old) {
            Ok(value) => value,
            Err(_) => {
                if a.secrets.consumer_token.is_none()
                    || (old["has_webhook_secret"] == true && a.secrets.webhook_secret.is_none())
                    || (old["has_api_token"] == true && a.secrets.api_token.is_none())
                {
                    return Err("来源凭据不可用，请重新提供此前配置的完整凭据。".into());
                }
                Secrets::default()
            }
        };
        if a.secrets.webhook_secret.is_none() {
            a.secrets.webhook_secret = old.webhook_secret.clone();
        }
        if a.secrets.consumer_token.is_none() {
            a.secrets.consumer_token = old.consumer_token.clone();
        }
        if a.secrets.api_token.is_none() {
            a.secrets.api_token = old.api_token.clone();
        }
    }
    if a.secrets
        .consumer_token
        .as_ref()
        .is_none_or(|s| s.len() < 16 || s.len() > 512 || s.chars().any(char::is_control))
        || (d.mode == "local"
            && a.secrets
                .webhook_secret
                .as_ref()
                .is_none_or(|s| s.len() < 16 || s.len() > 512 || s.chars().any(char::is_control)))
        || a.secrets
            .api_token
            .as_ref()
            .is_some_and(|s| s.len() > 512 || s.chars().any(char::is_control))
    {
        return Err("请提供 16–512 字节的接收与消费凭据。".into());
    }
    if serde_json::to_vec(d).map_err(|e| e.to_string())?.len() > 4000 {
        return Err("来源配置超过 4KB。".into());
    }
    if let Some(token) = &a.secrets.consumer_token {
        if !token.is_ascii() || token.chars().any(char::is_whitespace) {
            return Err("消费令牌需要无空白的 ASCII 字符。".into());
        }
    }
    if a.secrets
        .api_token
        .as_ref()
        .is_some_and(|s| !s.is_ascii() || s.chars().any(char::is_whitespace))
    {
        return Err("平台 API 令牌格式无效。".into());
    }
    if let (Some(webhook), Some(consumer)) = (&a.secrets.webhook_secret, &a.secrets.consumer_token)
    {
        if bool::from(webhook.as_bytes().ct_eq(consumer.as_bytes())) {
            return Err("接收与消费凭据需要分开配置。".into());
        }
    }
    let reference = format!(
        "TROOP/events/{}/{}/{}",
        store.instance_id()?,
        a.id,
        operation
    );
    let mut encoded = serde_json::to_string(&a.secrets).map_err(|e| e.to_string())?;
    let written = credentials::events::write(&reference, &encoded);
    encoded.zeroize();
    written?;
    let mut source = serde_json::to_value(d).map_err(|e| e.to_string())?;
    source["secret_ref"] = json!(reference);
    source["has_webhook_secret"] = json!(a.secrets.webhook_secret.is_some());
    source["has_api_token"] = json!(a.secrets.api_token.is_some());
    source["authority"] = json!("webhook");
    match store.event_source_save(&a.id, a.expected_revision, source) {
        Ok(saved) => Ok(public_source(saved)),
        Err(error) => {
            let _ = credentials::events::delete(&reference);
            Err(error)
        }
    }
}
pub fn checked_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "事件服务地址无效。")?;
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    if raw.len() > 2048
        || (!loopback && url.scheme() != "https")
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("事件服务需要 HTTPS，loopback 可用 HTTP。".into());
    }
    Ok(url)
}
pub fn read(
    store: &Store,
    method: &str,
    input: Value,
    address: Option<&str>,
    receiver_only: bool,
) -> Result<Value, String> {
    match method {
        "events.health" => Ok(
            json!({"address":address,"receiver_only":receiver_only,"instance_id":store.instance_id()?,"max_body_bytes":48_000}),
        ),
        "events.sources" => {
            let offset = input["offset"].as_u64().unwrap_or(0) as usize;
            let items = store
                .event_sources()?
                .into_iter()
                .map(public_source)
                .skip(offset)
                .map(|s| s.to_string())
                .collect();
            store.event_source_page(items, offset)
        }
        "events.records" => {
            let mut page = store.source_events(
                input["source_id"].as_str().ok_or("来源标识无效。")?,
                input["after"].as_i64().unwrap_or(0),
            )?;
            for event in page["items"].as_array_mut().unwrap() {
                event["executions"] = store.event_executions(event["id"].as_i64().unwrap())?;
            }
            Ok(page)
        }
        "events.inbox" => {
            let id = input["source_id"].as_str().ok_or("来源标识无效。")?;
            store.event_source(id)?;
            store.event_inbox(id, input["after"].as_i64().unwrap_or(0), false)
        }
        "events.payload" => {
            let raw = store.event_payload(
                input["source_id"].as_str().ok_or("来源标识无效。")?,
                input["id"].as_i64().ok_or("正文标识无效。")?,
            )?;
            let offset = input["offset"].as_u64().unwrap_or(0) as usize;
            let page = raw.chars().skip(offset).take(4000).collect::<String>();
            Ok(
                json!({"content":page,"archived":raw.is_empty(),"next_offset":if offset+page.chars().count()<raw.chars().count(){Some(offset+page.chars().count())}else{None}}),
            )
        }
        _ => Err("事件写操作需要操作账本。".into()),
    }
}
fn header<'a>(headers: &'a hyper::HeaderMap, name: &str) -> Result<&'a str, String> {
    if headers.get_all(name).iter().count() != 1 {
        return Err("请求头缺失或重复。".into());
    }
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= 512)
        .ok_or("请求头无效。".into())
}
fn verify_hex(secret: &str, body: &[u8], signature: &str) -> bool {
    let Some(hex) = signature
        .strip_prefix("sha256=")
        .filter(|s| s.len() == 64 && s.is_ascii())
    else {
        return false;
    };
    let decoded = (0..32)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16))
        .collect::<Result<Vec<_>, _>>();
    let Ok(decoded) = decoded else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&decoded).is_ok()
}
pub fn handle_http(store: &mut Store, message: &Message) -> (u16, Value) {
    match route_http(store, message) {
        Ok((code, value)) => (code, value),
        Err((code, error)) => (code, json!({"error":error})),
    }
}
fn route_http(store: &mut Store, m: &Message) -> Result<(u16, Value), (u16, String)> {
    let path = m
        .path
        .trim_start_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    if path.len() < 2 {
        return Err((404, "接口不存在。".into()));
    }
    let id = path[1];
    Uuid::parse_str(id).map_err(|_| (404, "来源不存在。".into()))?;
    let source = store
        .event_source(id)
        .map_err(|_| (404, "来源不存在。".into()))?;
    if source["enabled"] != true || source["mode"] != "local" {
        return Err((403, "来源已停用。".into()));
    }
    let secret = secrets(&source).map_err(|_| (503, "来源凭据不可用。".into()))?;
    if path[0] == "webhooks" && path.len() == 2 && m.method == "POST" {
        let key = secret
            .webhook_secret
            .as_deref()
            .ok_or((503, "接收密钥不可用。".into()))?;
        let auth = (|| -> Result<(String, String), String> {
            match source["kind"].as_str().unwrap_or("") {
                "github" => {
                    if !verify_hex(key, &m.body, header(&m.headers, "x-hub-signature-256")?) {
                        return Err("签名无效。".into());
                    }
                    Ok((
                        header(&m.headers, "x-github-delivery")?.into(),
                        header(&m.headers, "x-github-event")?.into(),
                    ))
                }
                "gitlab" => {
                    if source["auth_mode"] == "token" {
                        if !bool::from(
                            key.as_bytes()
                                .ct_eq(header(&m.headers, "x-gitlab-token")?.as_bytes()),
                        ) {
                            return Err("接收令牌无效。".into());
                        }
                        Ok((
                            header(&m.headers, "x-gitlab-event-uuid")?.into(),
                            header(&m.headers, "x-gitlab-event")?.into(),
                        ))
                    } else {
                        let delivery = header(&m.headers, "webhook-id")?;
                        let timestamp = header(&m.headers, "webhook-timestamp")?;
                        let time = timestamp.parse::<i64>().map_err(|_| "签名时间无效。")?;
                        if (now() - time).unsigned_abs() > 300 {
                            return Err("签名时间已过期。".into());
                        }
                        let decoded = STANDARD
                            .decode(key.strip_prefix("whsec_").unwrap_or(key))
                            .map_err(|_| "签名密钥无效。")?;
                        let mut mac = Hmac::<Sha256>::new_from_slice(&decoded)
                            .map_err(|_| "签名密钥无效。")?;
                        mac.update(format!("{delivery}.{timestamp}.").as_bytes());
                        mac.update(&m.body);
                        let valid = header(&m.headers, "webhook-signature")?
                            .split_whitespace()
                            .filter_map(|v| v.strip_prefix("v1,"))
                            .filter_map(|v| STANDARD.decode(v).ok())
                            .any(|v| mac.clone().verify_slice(&v).is_ok());
                        if !valid {
                            return Err("签名无效。".into());
                        }
                        Ok((
                            delivery.into(),
                            header(&m.headers, "x-gitlab-event")?.into(),
                        ))
                    }
                }
                "webhook" => {
                    if !verify_hex(key, &m.body, header(&m.headers, "x-troop-signature")?) {
                        return Err("签名无效。".into());
                    }
                    Ok((
                        header(&m.headers, "x-troop-delivery")?.into(),
                        "webhook".into(),
                    ))
                }
                _ => Err("来源类型无效。".into()),
            }
        })()
        .map_err(|e| (401, e))?;
        let raw = std::str::from_utf8(&m.body).map_err(|_| (400, "正文需要 UTF-8。".into()))?;
        let payload: Value =
            serde_json::from_str(raw).map_err(|_| (400, "正文 JSON 无效。".into()))?;
        let normalized =
            normalize::event(&source, &auth.1, &auth.0, &payload).map_err(|e| (400, e))?;
        let result = store
            .event_receive(
                id,
                &auth.0,
                normalized["semantic_key"].as_str().unwrap(),
                &tools::hash(&m.body),
                &normalized,
                raw,
            )
            .map_err(|e| (503, e))?;
        return Ok((202, result));
    }
    if path[0] != "inbox" || path.len() != 3 {
        return Err((404, "接口不存在。".into()));
    }
    let bearer = header(&m.headers, "authorization")
        .map_err(|e| (401, e))?
        .strip_prefix("Bearer ")
        .ok_or((401, "消费者认证无效。".into()))?;
    if !bool::from(
        secret
            .consumer_token
            .as_deref()
            .unwrap_or("")
            .as_bytes()
            .ct_eq(bearer.as_bytes()),
    ) {
        return Err((401, "消费者认证无效。".into()));
    }
    let body: Value = if m.body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&m.body).map_err(|_| (400, "消费请求无效。".into()))?
    };
    if body["consumer_id"] != source["consumer_id"] {
        return Err((403, "消费者范围不匹配。".into()));
    }
    let consumer = source["consumer_id"].as_str().unwrap();
    let generation = body["generation"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or((400, "消费代次无效。".into()))?;
    if path[2] == "claim" && m.method == "POST" {
        if let Some(accepted) = body["accepted_through"].as_i64() {
            store.event_reconcile(id, accepted).map_err(|e| (422, e))?;
        }
        let lease = store
            .event_claim(id, consumer, generation)
            .map_err(|e| (409, e))?;
        return Ok((
            200,
            json!({"lease":lease,"receiver_instance":store.instance_id().map_err(|e|(503,e))?}),
        ));
    }
    store
        .event_check_lease(
            id,
            consumer,
            generation,
            body["epoch"]
                .as_i64()
                .ok_or((400, "消费租约无效。".into()))?,
        )
        .map_err(|e| (409, e))?;
    match (m.method.as_str(), path[2]) {
        ("POST", "next") => Ok((
            200,
            if let Some(accepted) = body["accepted_through"].as_i64() {
                store.event_reconcile(id, accepted).map_err(|e| (422, e))?
            } else {
                store.event_inbox(id, 0, true).map_err(|e| (503, e))?
            },
        )),
        ("POST", "ack") => Ok((
            200,
            store
                .event_ack(
                    id,
                    body["event_id"]
                        .as_i64()
                        .ok_or((400, "消息标识无效。".into()))?,
                )
                .map_err(|e| (503, e))?,
        )),
        _ => Err((404, "接口不存在。".into())),
    }
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
