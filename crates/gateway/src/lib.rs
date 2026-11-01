pub mod credentials;
mod sse;

use futures_util::StreamExt;
use reqwest::{redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::mpsc;
use zeroize::Zeroize;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    ChatCompletions,
    Responses,
    Anthropic,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub name: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub model: String,
    pub max_output_tokens: u32,
    pub idle_timeout_secs: u64,
    #[serde(default)]
    pub legacy_max_tokens: bool,
}
impl Config {
    pub fn endpoint(&self) -> Result<Url, String> {
        if self.name.trim().is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
            || self.model.trim().is_empty()
            || self.model.len() > 200
            || self.model.chars().any(char::is_control)
        {
            return Err("服务名称或模型 ID 无效。".into());
        }
        if !(64..=8192).contains(&self.max_output_tokens)
            || !(5..=300).contains(&self.idle_timeout_secs)
        {
            return Err("输出上限应为 64–8192 token，等待时限应为 5–300 秒。".into());
        }
        let mut url =
            Url::parse(self.base_url.trim()).map_err(|_| "请输入完整的模型服务基础地址。")?;
        let host = url.host_str().unwrap_or("");
        let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
        if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
            return Err("模型服务需使用 HTTPS；本机 loopback 服务可使用 HTTP。".into());
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || host.is_empty()
            || self.base_url.len() > 2000
            || self.base_url.chars().any(char::is_control)
        {
            return Err("基础地址不能包含用户名、密码、查询参数或片段。".into());
        }
        if ["/chat/completions", "/responses", "/messages"]
            .iter()
            .any(|suffix| url.path().trim_end_matches('/').ends_with(suffix))
        {
            return Err(
                "请填写基础地址，不要包含 chat/completions、responses 或 messages 接口后缀。"
                    .into(),
            );
        }
        let suffix = match self.protocol {
            Protocol::ChatCompletions => "chat/completions",
            Protocol::Responses => "responses",
            Protocol::Anthropic => "messages",
        };
        let path = format!("{}/{}", url.path().trim_end_matches('/'), suffix);
        url.set_path(&path);
        Ok(url)
    }
}
pub struct Secret(pub String);
impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
#[derive(Clone, Serialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}
pub struct Request {
    pub config: Config,
    pub secret: Option<Secret>,
    pub messages: Vec<Message>,
}
#[derive(Default, Clone, Serialize)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
pub struct Summary {
    pub usage: Usage,
    pub finish_reason: String,
}
pub struct Failure {
    pub kind: &'static str,
    pub message: String,
}
impl Failure {
    fn new(kind: &'static str, message: &str) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

struct Parser {
    protocol: Protocol,
    usage: Usage,
    finish_reason: Option<String>,
    complete: bool,
}
impl Parser {
    fn consume(&mut self, event: sse::Event) -> Result<Option<String>, Failure> {
        if self.protocol == Protocol::ChatCompletions && event.data.trim() == "[DONE]" {
            self.complete = true;
            return Ok(None);
        }
        let v: Value = serde_json::from_str(&event.data)
            .map_err(|_| Failure::new("invalid_stream", "模型服务返回了无效的流数据。"))?;
        if v.get("error").is_some() || event.event == "error" || v["type"] == "error" {
            return Err(Failure::new(
                "provider_error",
                "模型服务在输出期间报告错误；已接收文本已保留。",
            ));
        }
        let text = match self.protocol {
            Protocol::ChatCompletions => {
                if let Some(usage) = v.get("usage").filter(|u| !u.is_null()) {
                    self.usage.input_tokens = usage["prompt_tokens"].as_u64();
                    self.usage.output_tokens = usage["completion_tokens"].as_u64();
                }
                let choice = &v["choices"][0];
                if choice["delta"].get("tool_calls").is_some_and(|calls| {
                    !calls.is_null() && calls.as_array().is_none_or(|items| !items.is_empty())
                }) || choice["delta"]
                    .get("function_call")
                    .is_some_and(|call| !call.is_null())
                {
                    return Err(Failure::new(
                        "unsupported_capability",
                        "此版本尚未接入 Agent 工具调用。",
                    ));
                }
                if let Some(reason) = choice["finish_reason"].as_str() {
                    if reason == "tool_calls" || reason == "function_call" {
                        return Err(Failure::new(
                            "unsupported_capability",
                            "此版本尚未接入 Agent 工具调用。",
                        ));
                    }
                    self.finish_reason = Some(reason.into());
                }
                choice["delta"]["content"]
                    .as_str()
                    .or_else(|| choice["delta"]["refusal"].as_str())
            }
            Protocol::Responses => match v["type"].as_str().unwrap_or(&event.event) {
                "response.output_text.delta" | "response.refusal.delta" => v["delta"].as_str(),
                "response.output_item.added"
                    if v["item"]["type"] != "message" && v["item"]["type"] != "reasoning" =>
                {
                    return Err(Failure::new(
                        "unsupported_capability",
                        "此响应需要尚未接入的工具或内容类型。",
                    ))
                }
                "response.failed" | "response.cancelled" => {
                    return Err(Failure::new("provider_error", "模型服务未能完成本次响应。"))
                }
                "response.completed" | "response.incomplete" => {
                    self.complete = true;
                    self.usage.input_tokens = v["response"]["usage"]["input_tokens"].as_u64();
                    self.usage.output_tokens = v["response"]["usage"]["output_tokens"].as_u64();
                    self.finish_reason = Some(
                        if v["type"] == "response.incomplete" {
                            "length"
                        } else {
                            "stop"
                        }
                        .into(),
                    );
                    None
                }
                _ => None,
            },
            Protocol::Anthropic => match v["type"].as_str().unwrap_or(&event.event) {
                "content_block_start" if v["content_block"]["type"] == "text" => {
                    v["content_block"]["text"].as_str()
                }
                "message_start" => {
                    self.usage.input_tokens = v["message"]["usage"]["input_tokens"].as_u64();
                    None
                }
                "content_block_start"
                    if !matches!(
                        v["content_block"]["type"].as_str(),
                        Some("text" | "thinking" | "redacted_thinking")
                    ) =>
                {
                    return Err(Failure::new(
                        "unsupported_capability",
                        "此版本尚未接入 Agent 工具或该内容类型。",
                    ))
                }
                "content_block_delta" if v["delta"]["type"] == "text_delta" => {
                    v["delta"]["text"].as_str()
                }
                "message_delta" => {
                    if let Some(reason) = v["delta"]["stop_reason"].as_str() {
                        self.finish_reason = Some(
                            if reason == "max_tokens" {
                                "length"
                            } else {
                                reason
                            }
                            .into(),
                        );
                    }
                    if let Some(tokens) = v["usage"]["output_tokens"].as_u64() {
                        self.usage.output_tokens = Some(tokens);
                    }
                    None
                }
                "message_stop" => {
                    self.complete = true;
                    None
                }
                _ => None,
            },
        };
        if let Some(text) = text {
            if text
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(Failure::new(
                    "invalid_stream",
                    "文本流包含不支持的控制字符。",
                ));
            }
            return Ok((!text.is_empty()).then(|| text.to_owned()));
        }
        Ok(None)
    }
}

pub async fn stream(request: Request, output: mpsc::Sender<String>) -> Result<Summary, Failure> {
    let endpoint = request.config.endpoint().map_err(|m| Failure {
        kind: "invalid_config",
        message: m,
    })?;
    let local = matches!(
        endpoint.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    let mut builder = reqwest::Client::builder()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600));
    if local {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|_| Failure::new("transport", "无法初始化模型连接。"))?;
    let config = &request.config;
    let mut body = match config.protocol {
        Protocol::ChatCompletions => {
            json!({"model":config.model,"messages":request.messages,"stream":true,"stream_options":{"include_usage":true},"max_completion_tokens":config.max_output_tokens})
        }
        Protocol::Responses => {
            json!({"model":config.model,"input":request.messages,"stream":true,"store":false,"max_output_tokens":config.max_output_tokens})
        }
        Protocol::Anthropic => {
            json!({"model":config.model,"messages":request.messages,"stream":true,"max_tokens":config.max_output_tokens})
        }
    };
    if config.protocol == Protocol::ChatCompletions && config.legacy_max_tokens {
        body.as_object_mut()
            .expect("request body is an object")
            .remove("max_completion_tokens");
        body["max_tokens"] = json!(config.max_output_tokens);
    }
    let mut http = client
        .post(endpoint)
        .header("Accept", "text/event-stream")
        .json(&body);
    if config.protocol == Protocol::Anthropic {
        http = http.header("anthropic-version", "2023-06-01");
    }
    if let Some(secret) = &request.secret {
        http = if config.protocol == Protocol::Anthropic {
            http.header("x-api-key", &secret.0)
        } else {
            http.bearer_auth(&secret.0)
        };
    }
    let response = http.send().await.map_err(|e| {
        if e.is_timeout() {
            Failure::new("timeout", "连接模型服务超时。")
        } else {
            Failure::new(
                "transport",
                "无法连接模型服务，请检查地址、网络代理和证书。",
            )
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        let (kind, message) = match status.as_u16() {
            401 | 403 => (
                "authentication",
                "模型服务拒绝认证，请检查 API 密钥和模型权限。",
            ),
            429 => ("rate_limited", "模型服务限流或额度不足，请稍后手动重试。"),
            300..=399 => (
                "redirect_rejected",
                "模型服务返回重定向；请直接配置最终服务地址。",
            ),
            400 | 404 | 422 => ("provider_request", "服务地址、模型 ID 或请求参数不受支持。"),
            _ => ("provider_http", "模型服务返回错误，本次请求未自动重试。"),
        };
        return Err(Failure {
            kind,
            message: format!("{message}（HTTP {}）", status.as_u16()),
        });
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("text/event-stream"))
        })
    {
        return Err(Failure::new(
            "invalid_stream",
            "服务没有返回 text/event-stream 流。",
        ));
    }
    let mut input = response.bytes_stream();
    let mut decoder = sse::Decoder::default();
    let mut parser = Parser {
        protocol: config.protocol,
        usage: Usage::default(),
        finish_reason: None,
        complete: false,
    };
    let mut received = 0usize;
    let mut text_bytes = 0usize;
    loop {
        let chunk =
            tokio::time::timeout(Duration::from_secs(config.idle_timeout_secs), input.next())
                .await
                .map_err(|_| {
                    Failure::new(
                        "timeout",
                        "模型流长时间没有数据，已停止等待；部分文本已保留。",
                    )
                })?;
        let Some(chunk) = chunk else {
            break;
        };
        let chunk =
            chunk.map_err(|_| Failure::new("disconnected", "模型流连接中断；部分文本已保留。"))?;
        received += chunk.len();
        if received > 2_000_000 {
            return Err(Failure::new("output_limit", "模型流超过本版本的接收上限。"));
        }
        for event in decoder.push(&chunk).map_err(|m| Failure {
            kind: "invalid_stream",
            message: m,
        })? {
            if let Some(text) = parser.consume(event)? {
                text_bytes += text.len();
                if text_bytes > 24_000 {
                    return Err(Failure::new(
                        "output_limit",
                        "单次回复达到 24 KB 文本上限；部分文本已保留。",
                    ));
                }
                output
                    .send(text)
                    .await
                    .map_err(|_| Failure::new("cancelled", "请求已停止。"))?;
            }
            if parser.complete {
                return Ok(Summary {
                    usage: parser.usage,
                    finish_reason: parser.finish_reason.unwrap_or_else(|| "stop".into()),
                });
            }
        }
    }
    Err(Failure::new(
        "incomplete_stream",
        "连接已结束，但未收到完成标记；部分文本已保留。",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            name: "local".into(),
            protocol: Protocol::ChatCompletions,
            base_url: "http://127.0.0.1:9000/v1".into(),
            model: "fixture".into(),
            max_output_tokens: 1024,
            idle_timeout_secs: 60,
            legacy_max_tokens: false,
        }
    }
    #[test]
    fn only_explicit_safe_endpoint_schemes_and_no_url_secrets() {
        assert_eq!(config().endpoint().unwrap().path(), "/v1/chat/completions");
        for base_url in [
            "http://example.org/v1",
            "https://user:secret@example.org/v1",
            "https://example.org/v1?key=secret",
            "file:///tmp",
        ] {
            let mut c = config();
            c.base_url = base_url.into();
            assert!(c.endpoint().is_err());
        }
    }
}
