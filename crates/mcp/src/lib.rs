//! Serial, bounded MCP sessions. Reconnection creates a new Client; requests are never replayed.
//! This module grants no task permission. Its caller owns approval, revisions and effect receipts.
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    redirect::Policy,
    Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    time::timeout,
};
pub mod oauth;
pub mod schema;
mod sse;
pub mod worker;
pub const LIMIT: usize = 65_536;
const VERSION: &str = "2025-06-18";
const WIRE_BUDGET: usize = 2 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StdioConfig {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}
impl StdioConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !self.command.is_absolute()
            || !self.cwd.is_absolute()
            || !self.cwd.is_dir()
            || self.args.len() > 64
            || self.env.len() > 64
            || serde_json::to_vec(self)
                .map_err(|_| "Invalid MCP command")?
                .len()
                > 32_000
            || self.args.iter().any(|s| s.contains('\0'))
            || self
                .env
                .iter()
                .any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0'))
        {
            return Err(
                "MCP command/cwd must be absolute; arguments and environment must be bounded"
                    .into(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct Failure {
    pub kind: String,
    pub indeterminate: bool,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.kind)
    }
}
impl std::error::Error for Failure {}
fn failure(kind: &str, indeterminate: bool) -> Failure {
    Failure {
        kind: kind.into(),
        indeterminate,
    }
}
fn url(input: &str) -> Result<Url, String> {
    let u = Url::parse(input).map_err(|_| "Invalid MCP URL")?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || !(u.scheme() == "https"
            || (u.scheme() == "http"
                && matches!(
                    u.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                )))
    {
        return Err(
            "MCP requires HTTPS (HTTP is allowed only on loopback), without userinfo or fragment"
                .into(),
        );
    }
    Ok(u)
}
pub fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let u = url(endpoint)?;
    if u.query().is_some() {
        return Err("MCP endpoint query must be removed; pass credentials through headers".into());
    }
    Ok(())
}
pub fn validate_header_names(names: &[String]) -> Result<(), String> {
    let entries = names.iter().map(|s| (s.clone(), "value".into())).collect();
    headers(&entries).map(|_| ())
}
fn headers(input: &BTreeMap<String, String>) -> Result<HeaderMap, String> {
    let mut out = HeaderMap::new();
    if input.len() > 32 || input.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > 16_000 {
        return Err("MCP headers exceed budget".into());
    }
    for (k, v) in input {
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|_| "Invalid MCP header")?;
        if matches!(
            name.as_str(),
            "host"
                | "content-length"
                | "connection"
                | "transfer-encoding"
                | "content-type"
                | "accept"
                | "mcp-session-id"
                | "mcp-protocol-version"
        ) {
            return Err("Reserved MCP header".into());
        }
        let mut val = HeaderValue::from_str(v).map_err(|_| "Invalid MCP header value")?;
        val.set_sensitive(true);
        out.insert(name, val);
    }
    Ok(out)
}
struct Events {
    response: reqwest::Response,
    decoder: sse::Decoder,
    ready: VecDeque<sse::Event>,
}
impl Events {
    async fn next(&mut self, budget: &mut usize) -> Result<sse::Event, String> {
        loop {
            if let Some(e) = self.ready.pop_front() {
                return Ok(e);
            }
            let chunk = self
                .response
                .chunk()
                .await
                .map_err(|_| "MCP stream disconnected")?
                .ok_or("MCP stream ended before response")?;
            *budget = budget
                .checked_sub(chunk.len())
                .ok_or("MCP stream exceeds traffic budget")?;
            self.ready.extend(self.decoder.push(&chunk)?);
        }
    }
}
struct Http {
    client: reqwest::Client,
    url: Url,
    headers: HeaderMap,
    session: Option<HeaderValue>,
    version: String,
    legacy: Option<Events>,
    changed: bool,
}
enum Wire {
    Http(Box<Http>),
    Stdio {
        child: Box<Child>,
        input: ChildStdin,
        output: BufReader<ChildStdout>,
    },
}
pub struct Client {
    wire: Wire,
    sequence: u64,
    healthy: bool,
    pending: Option<u64>,
    pub server: Value,
    pub tools_changed: bool,
}
impl Client {
    pub fn replace_headers(&mut self, values: BTreeMap<String, String>) -> Result<(), String> {
        match &mut self.wire {
            Wire::Http(h) => {
                h.headers = headers(&values)?;
                Ok(())
            }
            Wire::Stdio { .. } => Err("Cannot replace stdio credentials".into()),
        }
    }
    pub async fn http(
        endpoint: &str,
        extra_headers: BTreeMap<String, String>,
        legacy: bool,
        deadline: Duration,
    ) -> Result<Self, Failure> {
        let setup = async {
            let mut h = Http {
                client: reqwest::Client::builder()
                    .redirect(Policy::none())
                    .build()
                    .map_err(|_| "Cannot create MCP HTTP client")?,
                url: url(endpoint)?,
                headers: headers(&extra_headers)?,
                session: None,
                version: VERSION.into(),
                legacy: None,
                changed: false,
            };
            if legacy {
                let response = h
                    .client
                    .get(h.url.clone())
                    .headers(h.headers.clone())
                    .header("Accept", "text/event-stream")
                    .send()
                    .await
                    .map_err(|_| "MCP SSE connection failed")?;
                status(&response)?;
                content_type(&response, "text/event-stream")?;
                let mut events = Events {
                    response,
                    decoder: Default::default(),
                    ready: Default::default(),
                };
                let mut budget = WIRE_BUDGET;
                let e = events.next(&mut budget).await?;
                if e.name != "endpoint" {
                    return Err("Missing legacy MCP endpoint".into());
                }
                let endpoint = h
                    .url
                    .join(&e.data)
                    .map_err(|_| "Invalid legacy MCP endpoint")?;
                if endpoint.origin() != h.url.origin()
                    || !endpoint.username().is_empty()
                    || endpoint.password().is_some()
                    || endpoint.fragment().is_some()
                {
                    return Err("Cross-origin MCP endpoint rejected".into());
                }
                h.url = endpoint;
                h.legacy = Some(events);
            }
            Ok::<_, String>(Self {
                wire: Wire::Http(Box::new(h)),
                sequence: 0,
                healthy: true,
                pending: None,
                server: Value::Null,
                tools_changed: false,
            })
        };
        let mut c = timeout(deadline, setup)
            .await
            .map_err(|_| failure("MCP connection timed out", false))?
            .map_err(|e| failure(&e, false))?;
        if let Err(e) = c.initialize(deadline).await {
            c.close().await?;
            return Err(e);
        }
        Ok(c)
    }
    /// worker_exe must dispatch --mcp-stdio-worker to worker::run and exit immediately afterwards.
    pub async fn stdio(
        worker_exe: &Path,
        config: StdioConfig,
        deadline: Duration,
    ) -> Result<Self, Failure> {
        config.validate().map_err(|e| failure(&e, false))?;
        let mut command = tokio::process::Command::new(worker_exe);
        command
            .arg("--mcp-stdio-worker")
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| failure("Cannot start MCP Worker", false))?;
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| failure("Missing Worker stdin", false))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| failure("Missing Worker stdout", false))?,
        );
        let mut payload =
            serde_json::to_vec(&config).map_err(|_| failure("Invalid MCP startup", false))?;
        payload.push(b'\n');
        timeout(deadline, input.write_all(&payload))
            .await
            .map_err(|_| failure("MCP startup timed out", false))?
            .map_err(|_| failure("MCP Worker startup failed", false))?;
        let mut c = Self {
            wire: Wire::Stdio {
                child: Box::new(child),
                input,
                output,
            },
            sequence: 0,
            healthy: true,
            pending: None,
            server: Value::Null,
            tools_changed: false,
        };
        if let Err(e) = c.initialize(deadline).await {
            c.close().await?;
            return Err(e);
        }
        Ok(c)
    }
    async fn initialize(&mut self, deadline: Duration) -> Result<(), Failure> {
        let result=self.request("initialize",json!({"protocolVersion":VERSION,"capabilities":{},"clientInfo":{"name":"TROOP","version":env!("CARGO_PKG_VERSION")}}),deadline).await?;
        let v = result["protocolVersion"]
            .as_str()
            .ok_or_else(|| failure("Missing MCP protocol version", false))?;
        if !matches!(v, "2024-11-05" | "2025-03-26" | VERSION) {
            self.healthy = false;
            return Err(failure("Unsupported MCP protocol version", false));
        }
        if let Wire::Http(h) = &mut self.wire {
            h.version = v.into();
        }
        self.server = result;
        self.notify("notifications/initialized", json!({}), deadline)
            .await
    }
    pub async fn notify(
        &mut self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<(), Failure> {
        if !self.healthy {
            return Err(failure("MCP session requires reconnection", false));
        }
        self.healthy = false;
        let message = json!({"jsonrpc":"2.0","method":method,"params":params});
        let r = timeout(deadline, self.send(&message))
            .await
            .map_err(|_| failure("MCP notification timed out", false))?
            .map_err(|e| failure(&e, false));
        if r.is_ok() {
            self.healthy = true;
        }
        r.map(|_| ())
    }
    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, Failure> {
        if !self.healthy {
            return Err(failure("MCP session requires reconnection", false));
        }
        if !matches!(method, "initialize" | "tools/list" | "tools/call" | "ping")
            || params.to_string().len() > 32_000
        {
            return Err(failure("Unsupported or oversized MCP request", false));
        }
        self.sequence += 1;
        let id = self.sequence;
        self.healthy = false; // Also remains false if the caller drops this future after dispatch.
        self.pending = Some(id);
        let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let result = match timeout(deadline, self.exchange(&message)).await {
            Ok(r) => r.map_err(|e| failure(&e, method == "tools/call")),
            Err(_) => {
                // Best effort only: delivery of this notification is not stop/effect proof.
                let cancel = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"Client deadline reached"}});
                let _ = timeout(Duration::from_millis(200), self.send(&cancel)).await;
                Err(failure("MCP request timed out", method == "tools/call"))
            }
        };
        self.pending = None;
        if result.is_ok() {
            self.healthy = true;
        }
        if let Wire::Http(h) = &mut self.wire {
            self.tools_changed |= h.changed;
            h.changed = false;
        }
        result
    }
    async fn exchange(&mut self, message: &Value) -> Result<Value, String> {
        let mut response = self.send(message).await?;
        let mut budget = WIRE_BUDGET;
        for _ in 0..1024 {
            let v = if let Some(v) = response.take() {
                v
            } else {
                self.receive(&mut budget).await?
            };
            if v["jsonrpc"] != "2.0" || !v.is_object() {
                return Err("Invalid MCP envelope".into());
            }
            if let Some(method) = v["method"].as_str() {
                if !v["id"].is_null() {
                    let reply = if method == "ping" {
                        json!({"jsonrpc":"2.0","id":v["id"],"result":{}})
                    } else {
                        json!({"jsonrpc":"2.0","id":v["id"],"error":{"code":-32601,"message":"Client capability not supported"}})
                    };
                    self.send(&reply).await?;
                } else if method == "notifications/tools/list_changed" {
                    self.tools_changed = true;
                }
                continue;
            }
            if v["id"] != message["id"] {
                return Err("MCP response identity mismatch".into());
            }
            if v.get("error").is_some() {
                return Err("MCP server rejected request".into());
            }
            return v.get("result").cloned().ok_or("Missing MCP result".into());
        }
        Err("MCP notification budget exhausted".into())
    }
    async fn send(&mut self, message: &Value) -> Result<Option<Value>, String> {
        let mut payload = serde_json::to_vec(message).map_err(|_| "Invalid MCP request")?;
        if payload.len() >= LIMIT {
            return Err("MCP request exceeds frame limit".into());
        }
        match &mut self.wire {
            Wire::Stdio { input, .. } => {
                payload.push(b'\n');
                input
                    .write_all(&payload)
                    .await
                    .map_err(|_| "MCP stdin disconnected")?;
                input.flush().await.map_err(|_| "MCP stdin disconnected")?;
                Ok(None)
            }
            Wire::Http(h) => {
                let mut response = post(h, payload).await?;
                status(&response)?;
                if message["method"] == "initialize" {
                    if let Some(s) = response.headers().get("mcp-session-id") {
                        if s.as_bytes().is_empty()
                            || s.as_bytes().len() > 512
                            || s.as_bytes().iter().any(|b| !(0x21..=0x7e).contains(b))
                        {
                            return Err("Invalid MCP session ID".into());
                        }
                        let mut s = s.clone();
                        s.set_sensitive(true);
                        h.session = Some(s);
                    }
                }
                if message.get("id").is_none()
                    || message.get("method").is_none()
                    || h.legacy.is_some()
                {
                    return Ok(None);
                }
                let ct = response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .split(';')
                    .next()
                    .unwrap_or("");
                if ct == "text/event-stream" {
                    // POST streams can contain server requests before the response; process below.
                    let mut stream = Events {
                        response,
                        decoder: Default::default(),
                        ready: Default::default(),
                    };
                    let mut budget = WIRE_BUDGET;
                    for _ in 0..1024 {
                        let e = stream.next(&mut budget).await?;
                        let v: Value =
                            serde_json::from_str(&e.data).map_err(|_| "Invalid MCP SSE JSON")?;
                        if v.get("method").is_some() {
                            if v["jsonrpc"] != "2.0" {
                                return Err("Invalid MCP envelope".into());
                            }
                            if !v["id"].is_null() {
                                let reply = if v["method"] == "ping" {
                                    json!({"jsonrpc":"2.0","id":v["id"],"result":{}})
                                } else {
                                    json!({"jsonrpc":"2.0","id":v["id"],"error":{"code":-32601,"message":"Client capability not supported"}})
                                };
                                let response = post(
                                    h,
                                    serde_json::to_vec(&reply)
                                        .map_err(|_| "Invalid MCP response")?,
                                )
                                .await?;
                                status(&response)?;
                            } else if v["method"] == "notifications/tools/list_changed" {
                                h.changed = true;
                            }
                            continue;
                        }
                        return Ok(Some(v));
                    }
                    Err("MCP SSE notification budget exhausted".into())
                } else if ct == "application/json" {
                    let mut bytes = vec![];
                    while let Some(chunk) = response
                        .chunk()
                        .await
                        .map_err(|_| "MCP JSON disconnected")?
                    {
                        if bytes.len() + chunk.len() > LIMIT {
                            return Err("MCP JSON exceeds frame limit".into());
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    serde_json::from_slice(&bytes)
                        .map(Some)
                        .map_err(|_| "Invalid MCP JSON response".into())
                } else {
                    Err("Unsupported MCP response content type".into())
                }
            }
        }
    }
    async fn receive(&mut self, budget: &mut usize) -> Result<Value, String> {
        match &mut self.wire {
            Wire::Stdio { output, .. } => {
                let mut line = vec![];
                let n = output
                    .take((LIMIT + 1) as u64)
                    .read_until(b'\n', &mut line)
                    .await
                    .map_err(|_| "MCP stdout disconnected")?;
                if n == 0 || n > LIMIT || line.last() != Some(&b'\n') {
                    return Err("Invalid MCP stdout frame".into());
                }
                *budget = budget
                    .checked_sub(n)
                    .ok_or("MCP stdout traffic budget exhausted")?;
                serde_json::from_slice(&line).map_err(|_| "Invalid MCP stdout JSON".into())
            }
            Wire::Http(h) => {
                let stream = h.legacy.as_mut().ok_or("MCP HTTP response missing")?;
                loop {
                    let e = stream.next(budget).await?;
                    if e.name == "message" || e.name.is_empty() {
                        return serde_json::from_str(&e.data)
                            .map_err(|_| "Invalid MCP SSE JSON".into());
                    }
                }
            }
        }
    }
    pub async fn tools(&mut self, deadline: Duration) -> Result<Vec<Value>, Failure> {
        let mut all = vec![];
        let mut cursor = Value::Null;
        let mut seen = std::collections::HashSet::new();
        let mut names = std::collections::HashSet::new();
        for _ in 0..10 {
            let p = if cursor.is_null() {
                json!({})
            } else {
                json!({"cursor":cursor})
            };
            let r = self.request("tools/list", p, deadline).await?;
            let list = r["tools"]
                .as_array()
                .ok_or_else(|| failure("Invalid MCP catalogue", false))?;
            for t in list {
                let name = t["name"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                    .ok_or_else(|| failure("Invalid MCP tool name", false))?;
                if t["inputSchema"]["type"] != "object"
                    || !names.insert(name.to_owned())
                    || t.to_string().len() > 32_000
                {
                    return Err(failure("Invalid or duplicate MCP tool schema", false));
                }
                schema::compile(&t["inputSchema"])
                    .map_err(|_| failure("Unsupported MCP inputSchema", false))?;
                all.push(t.clone());
                if all.len() > 500 {
                    return Err(failure("MCP catalogue exceeds capacity", false));
                }
            }
            cursor = r["nextCursor"].clone();
            if cursor.is_null() {
                self.tools_changed = false;
                return Ok(all);
            }
            if !cursor.is_string()
                || cursor.as_str().unwrap().len() > 2000
                || !seen.insert(cursor.clone())
            {
                return Err(failure("Invalid MCP pagination cursor", false));
            }
        }
        Err(failure("MCP catalogue exceeds page budget", false))
    }
    pub async fn call(
        &mut self,
        name: &str,
        arguments: Value,
        deadline: Duration,
    ) -> Result<Value, Failure> {
        if name.is_empty() || name.len() > 256 || !arguments.is_object() {
            return Err(failure("Invalid MCP tool call", false));
        }
        self.request(
            "tools/call",
            json!({"name":name,"arguments":arguments}),
            deadline,
        )
        .await
    }
    pub async fn close(&mut self) -> Result<(), Failure> {
        self.healthy = false;
        if let Some(id) = self.pending.take() {
            let cancel = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"Client session closing"}});
            let _ = timeout(Duration::from_millis(200), self.send(&cancel)).await;
        }
        match &mut self.wire {
            Wire::Stdio { child, .. } => {
                let _ = child.start_kill();
                timeout(Duration::from_secs(3), child.wait())
                    .await
                    .map_err(|_| failure("MCP Worker stop unconfirmed", true))?
                    .map_err(|_| failure("MCP Worker stop unconfirmed", true))?;
            }
            Wire::Http(h) => {
                h.legacy = None;
                if let Some(session) = h.session.take() {
                    let _ = timeout(
                        Duration::from_secs(3),
                        h.client
                            .delete(h.url.clone())
                            .headers(h.headers.clone())
                            .header("Mcp-Session-Id", session)
                            .header("MCP-Protocol-Version", &h.version)
                            .send(),
                    )
                    .await;
                }
            }
        }
        Ok(())
    }
}
fn status(r: &reqwest::Response) -> Result<(), String> {
    match r.status().as_u16() {
        200..=299 => Ok(()),
        401 | 403 => Err("MCP authentication required; request not replayed".into()),
        404 => Err("MCP session expired; request not replayed".into()),
        _ => Err("MCP HTTP request rejected; request not replayed".into()),
    }
}
async fn post(h: &Http, payload: Vec<u8>) -> Result<reqwest::Response, String> {
    let mut r = h
        .client
        .post(h.url.clone())
        .headers(h.headers.clone())
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .header("MCP-Protocol-Version", &h.version);
    if let Some(session) = &h.session {
        r = r.header("Mcp-Session-Id", session);
    }
    r.body(payload)
        .send()
        .await
        .map_err(|_| "MCP HTTP request disconnected".into())
}
fn content_type(r: &reqwest::Response, kind: &str) -> Result<(), String> {
    if r.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        == Some(kind)
    {
        Ok(())
    } else {
        Err("Invalid MCP stream content type".into())
    }
}
