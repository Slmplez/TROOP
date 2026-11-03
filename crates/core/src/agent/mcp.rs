//! Run-owned MCP connections. Discovery and calls share the host dispatch queue; idle sessions
//! retain protocol state. Configured servers remain unsandboxed host capabilities.
use super::*;
use std::collections::BTreeMap;
use tokio::sync::{oneshot, watch};
use troop_gateway::credentials::mcp as vault;
use troop_mcp::Client;
use zeroize::Zeroize;
mod artifacts;
pub(crate) struct Connection {
    client: Client,
    secrets: Secrets,
    server: String,
    revision: i64,
    auth_revision: i64,
    binding: String,
}
struct Secrets {
    env: BTreeMap<String, String>,
    headers: BTreeMap<String, String>,
    values: Vec<String>,
}
impl Drop for Secrets {
    fn drop(&mut self) {
        for v in self
            .env
            .values_mut()
            .chain(self.headers.values_mut())
            .chain(self.values.iter_mut())
        {
            v.zeroize();
        }
    }
}
pub(super) struct Work {
    cancel: watch::Sender<bool>,
    session: i64,
    inv: Option<i64>,
    auth_revision: i64,
    pub(super) handle: JoinHandle<()>,
}
impl Drop for Work {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}
pub(crate) enum Event {
    Discovered {
        run: i64,
        epoch: i64,
        session: i64,
        result: Result<(Vec<Value>, Box<Connection>), String>,
        stopped: bool,
    },
    Ready {
        run: i64,
        epoch: i64,
        session: i64,
        inv: i64,
        gate: oneshot::Sender<bool>,
    },
    Finished {
        run: i64,
        epoch: i64,
        session: i64,
        inv: i64,
        result: Value,
        connection: Option<Box<Connection>>,
        stopped: bool,
    },
    Closed {
        session: i64,
        stopped: bool,
    },
}
fn server_id(e: &Value) -> Result<&str, String> {
    e["id"].as_str().ok_or("Invalid frozen MCP server".into())
}
fn digest(tools: &[Value]) -> String {
    let mut list = tools.to_vec();
    list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    tools::hash(json!(list).to_string().as_bytes())
}
fn auth_binding(store: &Store, server: &troop_storage::McpServer) -> Result<String, String> {
    let mode = server.config["auth_mode"].as_str().unwrap_or("automatic");
    if server.config["transport"] == "stdio" || matches!(mode, "none" | "headers") {
        return Ok("configured".into());
    }
    let d = store.oauth_get(&server.id)?;
    if mode == "oauth" || d["revision"].as_i64().unwrap_or(0) > 0 {
        Ok(format!("oauth:{}", crate::oauth::binding(&d)))
    } else {
        Ok("configured".into())
    }
}
fn credentials(
    store: &mut Store,
    broker: &mut crate::oauth::Manager,
    e: &Value,
    allow_refresh: bool,
) -> Result<Option<(Secrets, i64, bool)>, String> {
    let s = store.mcp_authorize(
        server_id(e)?,
        e["revision"].as_i64().ok_or("Invalid MCP revision")?,
        e["agent_id"].as_i64().unwrap_or(1),
        None,
    )?;
    if auth_binding(store, &s)? != e["auth_binding"].as_str().unwrap_or("") {
        return Err("MCP authorization identity changed; start a new task".into());
    }
    let mut secrets = Secrets {
        env: BTreeMap::new(),
        headers: BTreeMap::new(),
        values: vec![],
    };
    let mut auth_revision = 0;
    if let Some(identity) = e["auth_binding"]
        .as_str()
        .and_then(|s| s.strip_prefix("oauth:"))
    {
        let Some((header, revision, started)) =
            broker.mcp_access(store, &s.id, s.revision, identity, allow_refresh)?
        else {
            return Ok(None);
        };
        if started {
            return Ok(Some((secrets, revision, true)));
        }
        secrets
            .values
            .push(header.strip_prefix("Bearer ").unwrap_or(&header).into());
        secrets
            .headers
            .insert("authorization".into(), header.to_string());
        auth_revision = revision;
    }
    for (key, reference) in s
        .secret_refs
        .as_object()
        .ok_or("Invalid MCP credential bindings")?
    {
        let value = vault::read(
            reference
                .as_str()
                .ok_or("Invalid MCP credential reference")?,
        )?;
        if let Some(k) = key.strip_prefix("env:") {
            secrets.env.insert(k.into(), value.clone());
        } else if let Some(k) = key.strip_prefix("header:") {
            if k == "authorization" && secrets.headers.contains_key(k) {
                return Err("MCP has conflicting authorization methods".into());
            }
            secrets.headers.insert(k.into(), value.clone());
        } else {
            return Err("Invalid MCP secret purpose".into());
        }
        if !value.is_empty() {
            secrets.values.push(value);
        }
    }
    Ok(Some((secrets, auth_revision, false)))
}
fn permitted(
    store: &Store,
    doc: &Value,
    entry: &Value,
    tool: Option<&str>,
    auth_revision: i64,
) -> Result<(), String> {
    if doc["read_only"] == true {
        return Err("Read-only child agents cannot execute MCP capabilities".into());
    }
    let s = store.mcp_authorize(
        server_id(entry)?,
        entry["revision"].as_i64().ok_or("Invalid MCP revision")?,
        doc["agent_id"].as_i64().unwrap_or(1),
        tool,
    )?;
    if auth_binding(store, &s)? != entry["auth_binding"].as_str().unwrap_or("") {
        return Err("MCP authorization revoked".into());
    }
    if auth_revision > 0 {
        let a = store.oauth_get(&s.id)?;
        if a["revision"] != auth_revision || a["state"] != "connected" {
            return Err("MCP OAuth credential revision revoked".into());
        }
    }
    Ok(())
}
async fn open(
    entry: &Value,
    secrets: Secrets,
    auth_revision: i64,
) -> Result<Box<Connection>, troop_mcp::Failure> {
    let config = &entry["config"];
    let deadline =
        std::time::Duration::from_secs(config["startup_timeout_seconds"].as_u64().unwrap_or(30));
    let connect = async {
        let client = if config["transport"] == "stdio" {
            Client::stdio(
                &std::env::current_exe().map_err(|_| troop_mcp::Failure {
                    kind: "Cannot locate MCP worker".into(),
                    indeterminate: false,
                })?,
                troop_mcp::StdioConfig {
                    command: config["command"].as_str().unwrap_or("").into(),
                    args: serde_json::from_value(config["args"].clone()).unwrap_or_default(),
                    cwd: config["cwd"].as_str().unwrap_or("").into(),
                    env: secrets.env.clone(),
                },
                deadline,
            )
            .await?
        } else {
            Client::http(
                config["url"].as_str().unwrap_or(""),
                secrets.headers.clone(),
                config["transport"] == "sse",
                deadline,
            )
            .await?
        };
        Ok::<_, troop_mcp::Failure>(client)
    };
    let client = tokio::time::timeout(deadline, connect)
        .await
        .map_err(|_| troop_mcp::Failure {
            kind: "MCP connection startup timed out".into(),
            indeterminate: config["transport"] == "stdio",
        })??;
    Ok(Box::new(Connection {
        client,
        secrets,
        server: server_id(entry).unwrap_or("").into(),
        revision: entry["revision"].as_i64().unwrap_or(0),
        auth_revision,
        binding: entry["auth_binding"].as_str().unwrap_or("").into(),
    }))
}
async fn catalogue(c: &mut Connection, entry: &Value) -> Result<Vec<Value>, String> {
    let deadline = std::time::Duration::from_secs(
        entry["config"]["startup_timeout_seconds"]
            .as_u64()
            .unwrap_or(30),
    );
    let tools = tokio::time::timeout(deadline, c.client.tools(deadline))
        .await
        .map_err(|_| "MCP directory discovery timed out")?
        .map_err(|e| e.kind)?;
    let text = json!(tools).to_string();
    if tools.iter().any(|t| {
        t["name"]
            .as_str()
            .is_none_or(|name| name.chars().any(char::is_control))
    }) {
        return Err("Invalid MCP tool name".into());
    }
    if c.secrets
        .values
        .iter()
        .any(|s| !s.is_empty() && text.contains(s))
    {
        return Err("MCP directory contains credential values; not exposed".into());
    }
    Ok(tools)
}
fn entry<'a>(doc: &'a Value, id: &str) -> Result<&'a Value, String> {
    doc["mcp_snapshot"]
        .as_array()
        .and_then(|a| a.iter().find(|e| e["id"] == id))
        .ok_or("MCP server is outside this Run's frozen selection".into())
}
fn tool<'a>(doc: &'a Value, name: &str) -> Result<&'a Value, String> {
    doc["mcp_catalogue"]
        .as_array()
        .and_then(|a| a.iter().find(|t| t["name"] == name))
        .ok_or("MCP tool is outside this Run's frozen directory".into())
}
pub(super) fn definitions(doc: &Value, store: &Store) -> Vec<Value> {
    doc["mcp_catalogue"].as_array().into_iter().flatten().filter(|t|entry(doc,t["server_id"].as_str().unwrap_or("")).is_ok_and(|e|permitted(store,doc,e,t["original_name"].as_str(),0).is_ok())).map(|t|json!({"name":t["name"],"description":t["description"],"parameters":t["parameters"]})).collect()
}
impl Manager {
    fn mcp_wait(store: &mut Store, doc: &mut Value, reason: &str) -> Result<(), String> {
        let waiting = json!([reason]);
        if doc["waiting"] != waiting {
            doc["waiting"] = waiting;
            Self::save(store, doc, "mcp_wait")?;
        }
        Ok(())
    }
    pub(super) fn freeze_mcp(store: &Store, doc: &mut Value) -> Result<(), String> {
        let agent = doc["agent_id"].as_i64().unwrap_or(1);
        let mut selected = vec![];
        let mut offset = 0;
        loop {
            let p = store.mcp_list(offset)?;
            for s in p["items"].as_array().into_iter().flatten() {
                if s["config"]["enabled"] == true
                    && s["config"]["agent_ids"]
                        .as_array()
                        .is_some_and(|a| a.contains(&json!(agent)))
                {
                    let id = s["id"].as_str().ok_or("Invalid MCP ID")?;
                    let record = store.mcp_server(id)?;
                    selected.push(json!({"id":id,"revision":record.revision,"config":record.config,"agent_id":agent,"auth_binding":auth_binding(store,&record)?}));
                }
            }
            match p["next_offset"].as_u64() {
                Some(n) => offset = n as usize,
                None => break,
            }
        }
        if selected.len() > 8 {
            return Err("Agent exceeds its eight MCP server budget; adjust assignments".into());
        }
        doc["mcp_snapshot"] = json!(selected);
        doc["mcp_catalogue"] = json!([]);
        Ok(())
    }
    pub(super) fn validate_tool(
        store: &Store,
        doc: &Value,
        name: &str,
        args: &Value,
    ) -> Result<(), String> {
        if !name.starts_with("mcp_") {
            return tools::validate(name, args);
        }
        if args.to_string().len() > 12_000 {
            return Err("MCP arguments exceed 12KB task budget".into());
        }
        let t = tool(doc, name)?;
        let e = entry(doc, t["server_id"].as_str().unwrap_or(""))?;
        permitted(store, doc, e, t["original_name"].as_str(), 0)?;
        troop_mcp::schema::validate(&t["parameters"], args)
    }
    pub(super) fn bind_mcp(doc: &Value, inv: &mut Value) {
        if let Ok(t) = tool(doc, inv["name"].as_str().unwrap_or("")) {
            if let Ok(e) = entry(doc, t["server_id"].as_str().unwrap_or("")) {
                inv["operation"] = json!({"server_id":e["id"],"server":e["config"]["name"],"server_revision":e["revision"],"location":e["config"]["location"],"transport":e["config"]["transport"],"tool":t["original_name"],"arguments":inv["arguments"]});
                inv["mcp"] = json!({"server_id":e["id"],"revision":e["revision"],"tool":t["original_name"],"schema_hash":tools::hash(t["parameters"].to_string().as_bytes())});
            }
        }
    }
    pub(super) fn mcp_busy(&self) -> bool {
        !self.mcp_work.is_empty() || !self.mcp_closing.is_empty()
    }
    fn mcp_host_busy(&self, store: &Store) -> Result<bool, String> {
        Ok(self.mcp_busy()
            || self.live.values().any(|l| l.tool.is_some())
            || self.hook_commands_busy()
            || !self.jobs.is_empty()
            || store.hooks_quarantined()?
            || store.agent_quarantined()?
            || store.tasks_quarantined()?
            || store.mcp_quarantined()?)
    }
    fn mcp_auth(
        &mut self,
        store: &mut Store,
        doc: &mut Value,
        e: &Value,
        broker: &mut crate::oauth::Manager,
    ) -> Result<Option<(Secrets, i64)>, String> {
        let id = server_id(e)?;
        let attempts = doc["mcp_refresh_attempts"][id].as_u64().unwrap_or(0);
        let Some((secrets, revision, started)) = credentials(store, broker, e, attempts < 4)?
        else {
            return Ok(None);
        };
        if started {
            if !doc["mcp_refresh_attempts"].is_object() {
                doc["mcp_refresh_attempts"] = json!({});
            }
            doc["mcp_refresh_attempts"][id] = json!(attempts + 1);
            Self::save(store, doc, "mcp_refresh_requested")?;
            return Ok(None);
        }
        Ok(Some((secrets, revision)))
    }
    pub(super) fn ensure_mcp(
        &mut self,
        store: &mut Store,
        doc: &mut Value,
        broker: &mut crate::oauth::Manager,
    ) -> Result<bool, String> {
        if doc["read_only"] == true {
            return Ok(true);
        }
        let Some(e) = doc["mcp_snapshot"]
            .as_array()
            .and_then(|a| a.iter().find(|e| e["directory_hash"].is_null()))
            .cloned()
        else {
            return Ok(true);
        };
        let run = doc["id"].as_i64().unwrap();
        if self.mcp_host_busy(store)? {
            Self::mcp_wait(store, doc, "host_resource")?;
            return Ok(false);
        }
        let auth = self.mcp_auth(store, doc, &e, broker);
        let credentials = match auth {
            Ok(Some(a)) => a,
            Ok(None) => {
                Self::mcp_wait(store, doc, "authentication")?;
                return Ok(false);
            }
            Err(error) => {
                doc["state"] = json!("interrupted");
                doc["error"] = json!(error);
                Self::save(store, doc, "mcp_discovery_failed")?;
                self.retire(store, run)?;
                return Ok(false);
            }
        };
        let mut s = json!({"run_id":run,"epoch":doc["epoch"],"server_id":e["id"],"server_revision":e["revision"],"transport":e["config"]["transport"],"location":e["config"]["location"],"state":"starting","stopped":false,"reviewed":false,"auth_binding":e["auth_binding"],"auth_revision":credentials.1});
        store.mcp_connection_create(&mut s)?;
        let session = s["id"].as_i64().unwrap();
        let epoch = doc["epoch"].as_i64().unwrap();
        let (tx, mut cancel) = watch::channel(false);
        let updates = self.sender.clone();
        let e2 = e.clone();
        let handle = tokio::spawn(async move {
            let native = e2["config"]["transport"] == "stdio";
            let opened = tokio::select! {biased;_=cancel.changed()=>Err(("MCP connection startup cancelled".into(),!native)),r=open(&e2,credentials.0,credentials.1)=>r.map_err(|e|(e.kind,!e.indeterminate))};
            let (result, stopped) = match opened {
                Err((error, stopped)) => (Err(error), stopped),
                Ok(mut c) => {
                    let list = tokio::select! {biased;_=cancel.changed()=>Err("MCP discovery cancelled".into()),r=catalogue(&mut c,&e2)=>r};
                    match list {
                        Ok(list) => (Ok((list, c)), false),
                        Err(error) => {
                            let stopped = c.client.close().await.is_ok();
                            (Err(error), stopped)
                        }
                    }
                }
            };
            let _ = updates
                .send(Update::Mcp(Box::new(Event::Discovered {
                    run,
                    epoch,
                    session,
                    result,
                    stopped,
                })))
                .await;
        });
        self.mcp_work.insert(
            run,
            Work {
                cancel: tx,
                session,
                inv: None,
                auth_revision: credentials.1,
                handle,
            },
        );
        doc["waiting"] = json!(["mcp_discovery"]);
        Self::save(store, doc, "mcp_discovery_started")?;
        Ok(false)
    }
    fn close_mcp_connection(
        &mut self,
        store: &Store,
        session: i64,
        mut c: Box<Connection>,
    ) -> Result<(), String> {
        let mut s = store.mcp_connection(session)?;
        s["state"] = json!("closing");
        store.mcp_connection_save(&s)?;
        self.mcp_closing.insert(session);
        let tx = self.sender.clone();
        let handle = tokio::spawn(async move {
            let stopped = c.client.close().await.is_ok();
            let _ = tx
                .send(Update::Mcp(Box::new(Event::Closed { session, stopped })))
                .await;
        });
        self.mcp_cleanup.push(handle);
        Ok(())
    }
    pub(super) fn cancel_mcp(&mut self, store: &Store, run: i64) -> Result<(), String> {
        if let Some(w) = self.mcp_work.get(&run) {
            let _ = w.cancel.send(true);
        }
        let ids = self
            .mcp_clients
            .keys()
            .copied()
            .filter(|id| store.mcp_connection(*id).is_ok_and(|s| s["run_id"] == run))
            .collect::<Vec<_>>();
        for id in ids {
            let c = self.mcp_clients.remove(&id).unwrap();
            self.close_mcp_connection(store, id, c)?;
        }
        Ok(())
    }
    pub(super) fn mcp_run_busy(&self, store: &Store, run: i64) -> bool {
        self.mcp_work.contains_key(&run)
            || self
                .mcp_closing
                .iter()
                .any(|id| store.mcp_connection(*id).is_ok_and(|s| s["run_id"] == run))
    }
    pub(super) fn begin_mcp_cleanup(
        &mut self,
        store: &mut Store,
        run: i64,
    ) -> Result<bool, String> {
        let owned = self
            .mcp_clients
            .keys()
            .any(|id| store.mcp_connection(*id).is_ok_and(|s| s["run_id"] == run));
        if !owned && !self.mcp_run_busy(store, run) {
            return Ok(false);
        }
        let mut d = store.agent_run(run)?;
        if d["mcp_terminal"].is_null() {
            d["mcp_terminal"] = d["state"].clone();
            d["state"] = json!("waiting");
            d["waiting"] = json!(["mcp_cleanup"]);
            Self::save(store, &mut d, "mcp_cleanup_requested")?;
        }
        self.cancel_mcp(store, run)?;
        Ok(true)
    }
    pub(super) fn finish_mcp_cleanup(
        &mut self,
        store: &mut Store,
        doc: &mut Value,
    ) -> Result<bool, String> {
        if doc["mcp_terminal"].is_null() {
            return Ok(false);
        }
        let run = doc["id"].as_i64().unwrap();
        if self.mcp_run_busy(store, run) {
            return Ok(true);
        }
        let unknown = store
            .mcp_connections(run)?
            .iter()
            .any(|s| s["state"] == "indeterminate" && s["reviewed"] != true);
        doc["state"] = if unknown {
            json!("interrupted")
        } else {
            doc["mcp_terminal"].clone()
        };
        doc["mcp_terminal"] = Value::Null;
        doc["waiting"] = json!([]);
        if unknown {
            doc["error"] = json!("MCP process stop requires reconciliation before continuing");
        }
        Self::save(store, doc, "mcp_cleanup_finished")?;
        self.retire(store, run)?;
        Ok(true)
    }
    pub(super) fn prune_mcp(&mut self, store: &mut Store) -> Result<(), String> {
        for (run, w) in &self.mcp_work {
            let doc = store.agent_run(*run)?;
            let s = store.mcp_connection(w.session)?;
            let allowed = entry(&doc, s["server_id"].as_str().unwrap_or(""))
                .is_ok_and(|e| permitted(store, &doc, e, None, w.auth_revision).is_ok());
            if !allowed || !doc["intent"].is_null() {
                let _ = w.cancel.send(true);
            }
        }
        let invalid = self
            .mcp_clients
            .iter()
            .filter_map(|(id, c)| {
                let s = store.mcp_connection(*id).ok()?;
                let d = store.agent_run(s["run_id"].as_i64()?).ok()?;
                let valid =
                    entry(&d, &c.server).is_ok_and(|e| permitted(store, &d, e, None, 0).is_ok());
                let auth = if c.auth_revision > 0 {
                    store.oauth_get(&c.server).is_ok_and(|a| {
                        matches!(a["state"].as_str(), Some("connected" | "refreshing"))
                            && format!("oauth:{}", crate::oauth::binding(&a)) == c.binding
                    })
                } else {
                    true
                };
                (!valid || !auth || terminal(&d) || !d["intent"].is_null()).then_some(*id)
            })
            .collect::<Vec<_>>();
        for id in invalid {
            let c = self.mcp_clients.remove(&id).unwrap();
            self.close_mcp_connection(store, id, c)?;
        }
        Ok(())
    }
    pub(super) fn mcp_tool(
        &mut self,
        store: &mut Store,
        doc: &mut Value,
        inv: &mut Value,
        broker: &mut crate::oauth::Manager,
    ) -> Result<bool, String> {
        if inv["name"] == "read_mcp_artifact" {
            let result = artifacts::read(
                store,
                doc["id"].as_i64().unwrap(),
                inv["arguments"]["artifact_id"].as_str().unwrap_or(""),
                inv["arguments"]["offset"]
                    .as_str()
                    .unwrap_or("0")
                    .parse()
                    .unwrap_or(usize::MAX),
                true,
            );
            inv["state"] = json!(if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            });
            inv["result"] = match result {
                Ok(v) => json!({"ok":true,"value":v}),
                Err(e) => json!({"ok":false,"error":e}),
            };
            Self::settle_tool(doc, inv)?;
            store.agent_save(doc, std::slice::from_mut(inv), "mcp_artifact_read")?;
            return Ok(true);
        }
        let name = inv["name"].as_str().unwrap_or("");
        if !name.starts_with("mcp_") {
            return Ok(false);
        }
        if self.mcp_host_busy(store)? {
            Self::mcp_wait(store, doc, "host_resource")?;
            return Ok(true);
        }
        let t = tool(doc, name)?.clone();
        let e = entry(doc, t["server_id"].as_str().unwrap_or(""))?.clone();
        let auth = match self.mcp_auth(store, doc, &e, broker) {
            Ok(Some(a)) => a,
            Ok(None) => {
                Self::mcp_wait(store, doc, "authentication")?;
                return Ok(true);
            }
            Err(error) => {
                inv["state"] = json!("failed");
                inv["result"] = json!({"ok":false,"not_dispatched":true,"error":error});
                Self::settle_tool(doc, inv)?;
                store.agent_save(doc, std::slice::from_mut(inv), "mcp_not_dispatched")?;
                return Ok(true);
            }
        };
        let run = doc["id"].as_i64().unwrap();
        let epoch = doc["epoch"].as_i64().unwrap();
        let inv_id = inv["id"].as_i64().unwrap();
        let existing = self.mcp_clients.iter().find_map(|(id, c)| {
            (c.server == t["server_id"]
                && c.revision == e["revision"].as_i64().unwrap_or(-1)
                && store.mcp_connection(*id).is_ok_and(|s| s["run_id"] == run))
            .then_some(*id)
        });
        let mut fresh_secrets = Some(auth.0);
        let (session, connection) = if let Some(id) = existing {
            let mut c = self.mcp_clients.remove(&id).unwrap();
            if e["config"]["transport"] != "stdio" {
                c.client
                    .replace_headers(fresh_secrets.as_ref().unwrap().headers.clone())?;
            }
            c.secrets = fresh_secrets.take().unwrap();
            c.auth_revision = auth.1;
            (id, Some(c))
        } else {
            let mut s = json!({"run_id":run,"epoch":epoch,"server_id":e["id"],"server_revision":e["revision"],"transport":e["config"]["transport"],"location":e["config"]["location"],"state":"starting","stopped":false,"reviewed":false,"auth_binding":e["auth_binding"],"auth_revision":auth.1});
            store.mcp_connection_create(&mut s)?;
            (s["id"].as_i64().unwrap(), None)
        };
        let mut s = store.mcp_connection(session)?;
        s["auth_revision"] = json!(auth.1);
        s["invocation_id"] = json!(inv_id);
        store.mcp_connection_save(&s)?;
        inv["state"] = json!("dispatched");
        inv["mcp_session"] = json!(session);
        doc["state"] = json!("waiting");
        doc["waiting"] = json!(["tool"]);
        // No task starts before its immutable invocation and approval are committed.
        if let Err(error) = store.agent_save(doc, std::slice::from_mut(inv), "mcp_tool_dispatched")
        {
            if let Some(c) = connection {
                self.close_mcp_connection(store, session, c)?;
            }
            return Err(error);
        }
        self.live.get_mut(&run).unwrap().tool = Some(inv_id);
        let (tx, mut cancel) = watch::channel(false);
        let updates = self.sender.clone();
        let e2 = e.clone();
        let args = inv["arguments"].clone();
        let handle = tokio::spawn(async move {
            let native = e2["config"]["transport"] == "stdio";
            let opened = match connection {
                Some(c) => Ok(c),
                None => {
                    tokio::select! {biased;_=cancel.changed()=>Err(("MCP connection cancelled".into(),!native)),r=open(&e2,fresh_secrets.take().unwrap(),auth.1)=>r.map_err(|e|(e.kind,!e.indeterminate))}
                }
            };
            let (mut connection, mut result, mut stopped) = match opened {
                Err((error, stopped)) => (
                    None,
                    json!({"ok":false,"not_dispatched":true,"error":error,"indeterminate":!stopped}),
                    stopped,
                ),
                Ok(mut c) => {
                    let preflight = tokio::select! {biased;_=cancel.changed()=>Err("MCP request cancelled before dispatch".into()),r=catalogue(&mut c,&e2)=>r.and_then(|list|if digest(&list)==e2["directory_hash"].as_str().unwrap_or(""){Ok(())}else{Err("MCP directory changed; frozen plan revoked".into())})};
                    let preflight = if preflight.is_ok() {
                        let (gate, answer) = oneshot::channel();
                        if updates
                            .send(Update::Mcp(Box::new(Event::Ready {
                                run,
                                epoch,
                                session,
                                inv: inv_id,
                                gate,
                            })))
                            .await
                            .is_err()
                        {
                            Err("MCP controller closed".into())
                        } else {
                            tokio::select! {biased;_=cancel.changed()=>Err("MCP dispatch cancelled".into()),v=answer=>if matches!(v,Ok(true)){Ok(())}else{Err("MCP dispatch authority revoked".into())}}
                        }
                    } else {
                        preflight
                    };
                    if let Err(error) = preflight {
                        let stopped = c.client.close().await.is_ok();
                        (
                            None,
                            json!({"ok":false,"not_dispatched":true,"error":error,"indeterminate":!stopped}),
                            stopped,
                        )
                    } else {
                        let response = tokio::select! {biased;_=cancel.changed()=>Err(troop_mcp::Failure{kind:"MCP request cancelled; inspect external effects".into(),indeterminate:true}),r=c.client.call(t["original_name"].as_str().unwrap(),args,std::time::Duration::from_secs(e2["config"]["timeout_seconds"].as_u64().unwrap_or(180)))=>r};
                        match response {
                            Ok(value) => {
                                let result =
                                    artifacts::prepare(run, inv_id, value, &c.secrets.values);
                                (Some(c), result, true)
                            }
                            Err(error) => {
                                let stopped = c.client.close().await.is_ok();
                                (
                                    None,
                                    json!({"ok":false,"error":error.kind,"indeterminate":error.indeterminate||!stopped,"auth_required":error.kind.contains("authentication required")}),
                                    stopped,
                                )
                            }
                        }
                    }
                }
            };
            if *cancel.borrow() && connection.is_some() {
                let mut c = connection.take().unwrap();
                stopped = c.client.close().await.is_ok();
                if !stopped {
                    result["indeterminate"] = json!(true);
                }
            }
            let _ = updates
                .send(Update::Mcp(Box::new(Event::Finished {
                    run,
                    epoch,
                    session,
                    inv: inv_id,
                    result,
                    connection,
                    stopped,
                })))
                .await;
        });
        self.mcp_work.insert(
            run,
            Work {
                cancel: tx,
                session,
                inv: Some(inv_id),
                auth_revision: auth.1,
                handle,
            },
        );
        Ok(true)
    }
    pub(super) fn accept_mcp(&mut self, store: &mut Store, event: Event) -> Result<(), String> {
        match event {
            Event::Closed { session, stopped } => {
                self.mcp_closing.remove(&session);
                let mut s = store.mcp_connection(session)?;
                s["state"] = json!(if stopped { "closed" } else { "indeterminate" });
                s["stopped"] = json!(stopped);
                s["reviewed"] = json!(false);
                store.mcp_connection_save(&s)?;
            }
            Event::Discovered {
                run,
                epoch,
                session,
                result,
                stopped,
            } => {
                if self.mcp_work.get(&run).is_none_or(|w| w.session != session) {
                    if let Ok((_, c)) = result {
                        self.close_mcp_connection(store, session, c)?;
                    }
                    return Ok(());
                }
                let w = self.mcp_work.remove(&run).unwrap();
                let mut doc = store.agent_run(run)?;
                let mut s = store.mcp_connection(session)?;
                match result {
                    Ok((tools, c)) => {
                        let sid = s["server_id"].as_str().unwrap();
                        let e = entry(&doc, sid)?.clone();
                        if doc["epoch"] != epoch
                            || !doc["intent"].is_null()
                            || permitted(store, &doc, &e, None, w.auth_revision).is_err()
                        {
                            self.close_mcp_connection(store, session, c)?;
                            return Ok(());
                        }
                        let mut catalog =
                            doc["mcp_catalogue"].as_array().cloned().unwrap_or_default();
                        for t in &tools {
                            let name = t["name"].as_str().ok_or("Invalid MCP name")?;
                            if e["config"]["disabled_tools"]
                                .as_array()
                                .is_some_and(|a| a.contains(&json!(name)))
                            {
                                continue;
                            }
                            let model_name = format!(
                                "mcp_{}_{}",
                                sid.replace('-', ""),
                                &tools::hash(name.as_bytes())[..16]
                            );
                            let description = t["description"]
                                .as_str()
                                .unwrap_or("")
                                .chars()
                                .take(1500)
                                .collect::<String>();
                            catalog.push(json!({"name":model_name,"description":format!("MCP {} / {}. Requires exact approval. {}",e["config"]["name"].as_str().unwrap_or("server"),name,description),"parameters":t["inputSchema"],"server_id":sid,"original_name":name}));
                        }
                        if catalog.len() > 128 || json!(catalog).to_string().len() > 128_000 {
                            self.close_mcp_connection(store, session, c)?;
                            doc["state"] = json!("interrupted");
                            doc["error"]=json!("MCP catalog exceeds task budget; disable tools or reduce assignments");
                            Self::save(store, &mut doc, "mcp_catalogue_budget")?;
                            self.retire(store, run)?;
                            return Ok(());
                        }
                        let hash = digest(&tools);
                        for e in doc["mcp_snapshot"].as_array_mut().unwrap() {
                            if e["id"] == sid {
                                e["directory_hash"] = json!(hash);
                            }
                        }
                        doc["mcp_catalogue"] = json!(catalog);
                        doc["waiting"] = json!([]);
                        Self::save(store, &mut doc, "mcp_discovered")?;
                        s["state"] = json!("open");
                        store.mcp_connection_save(&s)?;
                        self.mcp_clients.insert(session, c);
                    }
                    Err(error) => {
                        s["state"] = json!(if stopped { "closed" } else { "indeterminate" });
                        s["stopped"] = json!(stopped);
                        s["error"] = json!(error);
                        store.mcp_connection_save(&s)?;
                        if doc["intent"].is_null() {
                            doc["state"] = json!("interrupted");
                            doc["error"] = s["error"].clone();
                            Self::save(store, &mut doc, "mcp_discovery_failed")?;
                            self.retire(store, run)?;
                        }
                    }
                }
            }
            Event::Ready {
                run,
                epoch,
                session,
                inv,
                gate,
            } => {
                let Some(w) = self
                    .mcp_work
                    .get(&run)
                    .filter(|w| w.session == session && w.inv == Some(inv))
                else {
                    let _ = gate.send(false);
                    return Ok(());
                };
                let mut doc = store.agent_run(run)?;
                let mut invocation = store.agent_invocation(inv)?;
                let valid = doc["epoch"] == epoch
                    && doc["intent"].is_null()
                    && invocation["approval"] == true
                    && invocation["state"] == "dispatched"
                    && Self::validate_tool(
                        store,
                        &doc,
                        invocation["name"].as_str().unwrap_or(""),
                        &invocation["arguments"],
                    )
                    .is_ok()
                    && entry(&doc, invocation["mcp"]["server_id"].as_str().unwrap_or(""))
                        .is_ok_and(|e| {
                            permitted(
                                store,
                                &doc,
                                e,
                                invocation["mcp"]["tool"].as_str(),
                                w.auth_revision,
                            )
                            .is_ok()
                        })
                    && !*w.cancel.borrow();
                if valid {
                    invocation["state"] = json!("running");
                    invocation["stopped"] = json!(false);
                    invocation["mcp_dispatched"] = json!(true);
                    store.agent_save(
                        &mut doc,
                        std::slice::from_mut(&mut invocation),
                        "mcp_call_accepted",
                    )?;
                }
                let _ = gate.send(valid);
            }
            Event::Finished {
                run,
                epoch,
                session,
                inv,
                mut result,
                connection,
                stopped,
            } => {
                if self.mcp_work.get(&run).is_none_or(|w| w.session != session) {
                    if let Some(c) = connection {
                        self.close_mcp_connection(store, session, c)?;
                    }
                    return Ok(());
                }
                let w = self.mcp_work.remove(&run).unwrap();
                let mut s = store.mcp_connection(session)?;
                let doc = store.agent_run(run)?;
                if result["auth_required"] == true && w.auth_revision > 0 {
                    let id = s["server_id"].as_str().unwrap();
                    let mut auth = store.oauth_get(id)?;
                    if auth["revision"] == w.auth_revision && auth["state"] == "connected" {
                        auth["expires_at"] = json!(0);
                        auth["error"] = json!(
                            "MCP rejected credentials; refresh before a new approved request"
                        );
                        let bindings = auth["secret_refs"].clone();
                        store.oauth_commit(id, w.auth_revision, &auth, &bindings)?;
                    }
                }
                if let Some(c) = connection {
                    let valid = doc["intent"].is_null()
                        && entry(&doc, &c.server).is_ok_and(|e| {
                            permitted(store, &doc, e, None, w.auth_revision).is_ok()
                        });
                    if valid {
                        s["state"] = json!("open");
                        store.mcp_connection_save(&s)?;
                        self.mcp_clients.insert(session, c);
                    } else {
                        self.close_mcp_connection(store, session, c)?;
                    }
                } else {
                    s["state"] = json!(if stopped { "closed" } else { "indeterminate" });
                    s["stopped"] = json!(stopped);
                    store.mcp_connection_save(&s)?;
                }

                result["stopped"] = json!(
                    stopped && (result["indeterminate"] != true || s["transport"] == "stdio")
                );
                self.accept(store, Update::Tool(run, epoch, inv, result))?;
            }
        }
        Ok(())
    }
    pub(super) fn mcp_dispatch(
        &mut self,
        store: &mut Store,
        method: &str,
        p: Value,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Page {
            run_id: i64,
            #[serde(default)]
            offset: usize,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Review {
            id: i64,
            note: String,
            stopped: bool,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Artifact {
            run_id: i64,
            id: String,
            #[serde(default)]
            offset: usize,
        }
        match method {
            "agent.mcp-catalogue" => {
                let a: Page = params(p)?;
                if a.offset > 1_000_000 {
                    return Err("Invalid page offset".into());
                }
                let d = store.agent_run(a.run_id)?;
                let list = d["mcp_catalogue"].as_array().cloned().unwrap_or_default();
                let item = list.get(a.offset).cloned();
                Ok(
                    json!({"items":item.into_iter().collect::<Vec<_>>(),"total":list.len(),"next_offset":if a.offset+1<list.len(){Some(a.offset+1)}else{None}}),
                )
            }
            "agent.mcp-sessions" => {
                let a: Page = params(p)?;
                if a.offset > 1_000_000 {
                    return Err("Invalid page offset".into());
                }
                let list = store.mcp_connections(a.run_id)?;
                Ok(
                    json!({"items":list.iter().skip(a.offset).take(20).collect::<Vec<_>>(),"next_offset":if a.offset+20<list.len(){Some(a.offset+20)}else{None}}),
                )
            }
            "agent.mcp-reconcile" => {
                let a: Review = params(p)?;
                let mut s = store.mcp_connection(a.id)?;
                let d = store.agent_run(s["run_id"].as_i64().unwrap())?;
                if !terminal(&d)
                    || s["state"] != "indeterminate"
                    || !a.stopped
                    || a.note.trim().is_empty()
                    || a.note.len() > 2000
                    || self.mcp_run_busy(store, d["id"].as_i64().unwrap())
                {
                    return Err(
                        "Inspect process stop and record a note after the Run terminates".into(),
                    );
                }
                s["stopped"] = json!(true);
                s["reviewed"] = json!(true);
                s["state"] = json!("closed");
                s["note"] = json!(a.note);
                store.mcp_connection_save(&s)?;
                Ok(s)
            }
            "agent.mcp-artifact" => {
                let a: Artifact = params(p)?;
                artifacts::read(store, a.run_id, &a.id, a.offset, false)
            }
            _ => Err("Unknown MCP task method".into()),
        }
    }
}
