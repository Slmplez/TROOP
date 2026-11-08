//! Run-owned MCP connections. Discovery and calls share the host dispatch queue; idle sessions
//! retain protocol state. Admitted stdio services can carry a fixed containment policy.
use super::*;
use crate::mcp::auth_binding;
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
    StartupReady {
        run: i64,
        epoch: i64,
        session: i64,
        gate: oneshot::Sender<bool>,
    },
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
        run: i64,
        epoch: i64,
        session: i64,
        stopped: bool,
    },
}
async fn native_startup(
    updates: &mpsc::Sender<Update>,
    cancel: &mut watch::Receiver<bool>,
    entry: &Value,
    run: i64,
    epoch: i64,
    session: i64,
) -> Result<(), String> {
    if !entry["program_sha256"].is_string() {
        return Ok(());
    }
    let (gate, answer) = oneshot::channel();
    updates
        .send(Update::Mcp(Box::new(Event::StartupReady {
            run,
            epoch,
            session,
            gate,
        })))
        .await
        .map_err(|_| "MCP startup controller closed")?;
    tokio::select! { biased;
        _ = cancel.changed() => Err("MCP startup cancelled".into()),
        result = answer => if matches!(result, Ok(true)) { Ok(()) } else { Err("MCP startup authority revoked".into()) }
    }
}
fn server_id(e: &Value) -> Result<&str, String> {
    e["id"].as_str().ok_or("Invalid frozen MCP server".into())
}
fn digest(tools: &[Value]) -> String {
    let mut list = tools.to_vec();
    list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    tools::hash(json!(list).to_string().as_bytes())
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
                    sandbox: entry
                        .get("sandbox")
                        .map(|value| serde_json::from_value(value.clone()))
                        .transpose()
                        .map_err(|_| troop_mcp::Failure {
                            kind: "Invalid containment plan".into(),
                            indeterminate: false,
                        })?,
                    command: entry["program"]
                        .as_str()
                        .unwrap_or(config["command"].as_str().unwrap_or(""))
                        .into(),
                    program_sha256: entry["program_sha256"].as_str().map(str::to_owned),
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
    let grant = match doc["authorization_id"]
        .as_str()
        .map(|id| store.authorization_get(id))
        .transpose()
    {
        Ok(grant) => grant,
        Err(_) => return vec![],
    };
    doc["mcp_catalogue"].as_array().into_iter().flatten()
        .filter(|tool| grant.as_ref().is_none_or(|grant| grant["purpose"] != "mcp_call" || grant["mcp_calls"].as_array().is_some_and(|bindings|
            bindings.iter().any(|binding| binding["server_id"] == tool["server_id"] && binding["tool"] == tool["original_name"]))))
        .filter(|tool| entry(doc,tool["server_id"].as_str().unwrap_or("")).is_ok_and(|entry| permitted(store,doc,entry,tool["original_name"].as_str(),0).is_ok()))
        .map(|tool| json!({"name":tool["name"],"description":tool["description"],"parameters":tool["parameters"]})).collect()
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
pub(super) fn operation(doc: &Value, inv: &Value) -> Result<Value, String> {
    let selected = tool(doc, inv["name"].as_str().unwrap_or(""))?;
    Ok(
        json!({"server_id":selected["server_id"],"tool":selected["original_name"],"arguments":inv["arguments"]}),
    )
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
        let grant = doc["authorization_id"]
            .as_str()
            .map(|id| store.authorization_get(id))
            .transpose()?;
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
                    if grant.as_ref().is_some_and(|grant| {
                        grant["purpose"] == "mcp_call"
                            && !grant["mcp_calls"].as_array().is_some_and(|bindings| {
                                bindings.iter().any(|binding| binding["server_id"] == id)
                            })
                    }) {
                        continue;
                    }
                    let record = store.mcp_server(id)?;
                    let mut frozen = json!({"id":id,"revision":record.revision,"config":record.config,"agent_id":agent,"auth_binding":auth_binding(store,&record)?});
                    if let Some(binding) = grant
                        .as_ref()
                        .and_then(|grant| grant["mcp_calls"].as_array())
                        .and_then(|bindings| {
                            bindings.iter().find(|binding| {
                                binding["server_id"] == id
                                    && matches!(
                                        binding["host_access"].as_str(),
                                        Some("full_host" | "sandbox")
                                    )
                            })
                        })
                    {
                        frozen["program"] = binding["program"].clone();
                        frozen["program_sha256"] = binding["program_sha256"].clone();
                        frozen["host_access"] = binding["host_access"].clone();
                        if binding["host_access"] == "sandbox" {
                            frozen["sandbox"] = serde_json::to_value(crate::sandbox::stdio_config(
                                grant.as_ref().unwrap(),
                            )?)
                            .map_err(|_| "Invalid MCP containment plan")?;
                        }
                    }
                    selected.push(frozen);
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
    pub(super) fn resolve_mcp_action(
        &self,
        store: &mut Store,
        doc: &mut Value,
    ) -> Result<(), String> {
        if doc["kind"] != "tool_action" {
            return Ok(());
        }
        let Some(id) = doc["pending"]
            .as_array()
            .and_then(|items| items.first())
            .and_then(Value::as_i64)
        else {
            return Ok(());
        };
        let mut invocation = store.agent_invocation(id)?;
        if invocation["name"] != "call_mcp" || invocation["state"] != "prepared" {
            return Ok(());
        }
        let operation: crate::authorizations::McpOperation =
            params(invocation["arguments"].clone())?;
        let selected = doc["mcp_catalogue"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|tool| {
                tool["server_id"] == operation.server_id && tool["original_name"] == operation.tool
            });
        invocation["requested_action"] =
            json!({"name":"call_mcp","arguments":invocation["arguments"]});
        if let Some(selected) = selected {
            invocation["name"] = selected["name"].clone();
            invocation["arguments"] = operation.arguments;
            Self::bind_mcp(doc, &mut invocation);
        } else {
            invocation["state"] = json!("failed");
            invocation["result"] = json!({"ok":false,"not_dispatched":true,"error":"已授权工具未出现在本次 MCP 目录中。"});
            remove_pending(doc, id);
        }
        store.agent_save(
            doc,
            std::slice::from_mut(&mut invocation),
            "mcp_action_resolved",
        )
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
        !self.mcp_work.is_empty() || self.execution.closing(None)
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
        if self.execution.blocked(store)? {
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
        let epoch = doc["epoch"].as_i64().unwrap();
        if self
            .execution
            .dispatch(store, |store| {
                store.mcp_connection_create(&mut s)?;
                doc["waiting"] = json!(["mcp_discovery"]);
                Self::save(store, doc, "mcp_discovery_started")?;
                Ok(ExecutionOwner::new(
                    run,
                    epoch,
                    ExecutionWork::Discovery(s["id"].as_i64().unwrap()),
                ))
            })?
            .is_none()
        {
            Self::mcp_wait(store, doc, "host_resource")?;
            return Ok(false);
        }
        let session = s["id"].as_i64().unwrap();
        let (tx, mut cancel) = watch::channel(false);
        let updates = self.sender.clone();
        let e2 = e.clone();
        let handle = tokio::spawn(async move {
            let native = e2["config"]["transport"] == "stdio";
            let opened = match native_startup(&updates, &mut cancel, &e2, run, epoch, session).await
            {
                Err(error) => Err((error, true)),
                Ok(()) => {
                    tokio::select! {biased;_=cancel.changed()=>Err(("MCP connection startup cancelled".into(),!native)),r=open(&e2,credentials.0,credentials.1)=>r.map_err(|e|(e.kind,!e.indeterminate))}
                }
            };
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
        Ok(false)
    }
    fn close_mcp_connection(
        &mut self,
        store: &Store,
        session: i64,
        mut c: Box<Connection>,
    ) -> Result<(), String> {
        let mut s = store.mcp_connection(session)?;
        let run = s["run_id"].as_i64().unwrap();
        let epoch = s["epoch"].as_i64().unwrap();
        s["state"] = json!("closing");
        self.execution
            .close_session(run, epoch, session, || store.mcp_connection_save(&s))?;
        let tx = self.sender.clone();
        let handle = tokio::spawn(async move {
            let stopped = c.client.close().await.is_ok();
            let _ = tx
                .send(Update::Mcp(Box::new(Event::Closed {
                    run,
                    epoch,
                    session,
                    stopped,
                })))
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
    pub(super) fn mcp_run_busy(&self, _store: &Store, run: i64) -> bool {
        self.mcp_work.contains_key(&run) || self.execution.closing(Some(run))
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
            doc["error"] = json!("MCP initialization effects or process stop require reconciliation before continuing");
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
            self.settle_tool(doc, inv)?;
            store.agent_save(doc, std::slice::from_mut(inv), "mcp_artifact_read")?;
            return Ok(true);
        }
        let name = inv["name"].as_str().unwrap_or("");
        if !name.starts_with("mcp_") {
            return Ok(false);
        }
        if self.execution.blocked(store)? {
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
                self.settle_tool(doc, inv)?;
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
        match self.execution.dispatch(store, |store| {
            store.agent_save(doc, std::slice::from_mut(inv), "mcp_tool_dispatched")?;
            Ok(ExecutionOwner::new(
                run,
                epoch,
                ExecutionWork::Invocation(inv_id),
            ))
        }) {
            Ok(Some(_)) => {}
            Ok(None) => {
                if let Some(c) = connection {
                    self.mcp_clients.insert(session, c);
                }
                Self::mcp_wait(store, doc, "host_resource")?;
                return Ok(true);
            }
            Err(error) => {
                if let Some(c) = connection {
                    self.close_mcp_connection(store, session, c)?;
                }
                return Err(error);
            }
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
                    match native_startup(&updates, &mut cancel, &e2, run, epoch, session).await {
                        Err(error) => Err((error, true)),
                        Ok(()) => {
                            tokio::select! {biased;_=cancel.changed()=>Err(("MCP connection cancelled".into(),!native)),r=open(&e2,fresh_secrets.take().unwrap(),auth.1)=>r.map_err(|e|(e.kind,!e.indeterminate))}
                        }
                    }
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
            Event::StartupReady {
                run,
                epoch,
                session,
                gate,
            } => {
                let Some(work) = self
                    .mcp_work
                    .get(&run)
                    .filter(|work| work.session == session)
                else {
                    let _ = gate.send(false);
                    return Ok(());
                };
                let doc = store.agent_run(run)?;
                let mut connection = store.mcp_connection(session)?;
                let owner = ExecutionOwner::new(
                    run,
                    epoch,
                    work.inv
                        .map(ExecutionWork::Invocation)
                        .unwrap_or(ExecutionWork::Discovery(session)),
                );
                let frozen = entry(&doc, connection["server_id"].as_str().unwrap_or(""))?;
                let allowed = self.execution.owns(owner)
                    && doc["epoch"] == epoch
                    && doc["intent"].is_null()
                    && !terminal(&doc)
                    && !*work.cancel.borrow()
                    && self.authorization_blocker(store, &doc).is_none()
                    && permitted(store, &doc, frozen, None, work.auth_revision).is_ok()
                    && troop_mcp::program::admit(
                        std::path::Path::new(frozen["program"].as_str().unwrap_or("")),
                        frozen["program_sha256"].as_str().unwrap_or(""),
                    )
                    .is_ok();
                if allowed {
                    connection["startup_authorization"] = json!({
                        "grant_id": doc["authorization_id"],
                        "grant_revision": doc["authorization_revision"],
                        "server_revision": frozen["revision"],
                        "host_access": frozen["host_access"],
                        "program": frozen["program"],
                        "program_sha256": frozen["program_sha256"],
                        "enforcement": "Core startup gate and Worker pinned executable; current-user host access"
                    });
                    if frozen["host_access"] == "sandbox" {
                        let policy: troop_mcp::containment::Config =
                            params(frozen["sandbox"].clone())?;
                        connection["startup_authorization"]["sandbox"] = policy.evidence(
                            std::path::Path::new(
                                frozen["program"]
                                    .as_str()
                                    .ok_or("Native program unavailable")?,
                            ),
                            std::path::Path::new(
                                frozen["config"]["cwd"]
                                    .as_str()
                                    .ok_or("Native cwd unavailable")?,
                            ),
                        )?;
                        connection["startup_authorization"]["enforcement"] = json!("Core startup/Ready and exact-operation gates; Worker pins executable and applies MXC filesystem/network containment before initialization");
                    }
                } else {
                    connection["startup_error"] =
                        json!("Native startup authority or program identity changed");
                }
                store.mcp_connection_save(&connection)?;
                let _ = gate.send(allowed);
            }
            Event::Closed {
                run,
                epoch,
                session,
                stopped,
            } => {
                let mut s = store.mcp_connection(session)?;
                s["state"] = json!(if stopped { "closed" } else { "indeterminate" });
                s["stopped"] = json!(stopped);
                s["reviewed"] = json!(false);
                self.execution.finish(
                    ExecutionOwner::new(run, epoch, ExecutionWork::Closing(session)),
                    || store.mcp_connection_save(&s),
                )?;
            }
            Event::Discovered {
                run,
                epoch,
                session,
                result,
                stopped,
            } => {
                let execution = ExecutionOwner::new(run, epoch, ExecutionWork::Discovery(session));
                if !self.execution.owns(execution)
                    || self
                        .mcp_work
                        .get(&run)
                        .is_none_or(|w| w.session != session || w.inv.is_some())
                {
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
                        s["state"] = json!("open");
                        self.execution.finish(execution, || {
                            Self::save(store, &mut doc, "mcp_discovered")?;
                            store.mcp_connection_save(&s)
                        })?;
                        self.mcp_clients.insert(session, c);
                    }
                    Err(error) => {
                        let startup_unknown =
                            s["transport"] == "stdio" && s["startup_authorization"].is_object();
                        s["effect_unknown"] = json!(startup_unknown);
                        s["state"] = json!(if stopped && !startup_unknown {
                            "closed"
                        } else {
                            "indeterminate"
                        });
                        s["stopped"] = json!(stopped);
                        s["error"] = json!(error);
                        self.execution
                            .finish(execution, || store.mcp_connection_save(&s))?;
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
                    && self
                        .authorize_invocation(store, &doc, &mut invocation)
                        .is_ok()
                    && self
                        .providers
                        .tools
                        .validate(
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
                let allowed = self.execution.ready(
                    ExecutionOwner::new(run, epoch, ExecutionWork::Invocation(inv)),
                    valid,
                    || {
                        invocation["state"] = json!("running");
                        invocation["stopped"] = json!(false);
                        invocation["mcp_dispatched"] = json!(true);
                        store.agent_save(
                            &mut doc,
                            std::slice::from_mut(&mut invocation),
                            "mcp_call_accepted",
                        )
                    },
                )?;
                let _ = gate.send(allowed);
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
                if !self.execution.owns(ExecutionOwner::new(
                    run,
                    epoch,
                    ExecutionWork::Invocation(inv),
                )) || self
                    .mcp_work
                    .get(&run)
                    .is_none_or(|w| w.session != session || w.inv != Some(inv))
                {
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
                    let startup_unknown = s["transport"] == "stdio"
                        && s["state"] == "starting"
                        && s["startup_authorization"].is_object()
                        && result["not_dispatched"] == true;
                    s["effect_unknown"] = json!(startup_unknown);
                    s["state"] = json!(if stopped && !startup_unknown {
                        "closed"
                    } else {
                        "indeterminate"
                    });
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
