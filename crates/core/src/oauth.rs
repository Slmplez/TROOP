//! Asynchronous OAuth control plane. No endpoint returns access/refresh/client-secret values.
use crate::{params, Store};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::{sync::mpsc, task::JoinHandle};
use troop_gateway::credentials::mcp as vault;
use troop_mcp::oauth::{self, Grant};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};
pub enum Update {
    Ready(String, i64, String),
    Done(String, i64, Result<Box<Grant>, String>),
    Revoked(String, i64, Result<bool, String>),
}
struct Live {
    epoch: i64,
    from: i64,
    server_revision: i64,
    kind: &'static str,
    url: Option<String>,
    handle: JoinHandle<()>,
}
pub struct Manager {
    jobs: HashMap<String, Live>,
    sender: mpsc::Sender<Update>,
    pub receiver: mpsc::Receiver<Update>,
}
impl Drop for Manager {
    fn drop(&mut self) {
        for j in self.jobs.values() {
            j.handle.abort();
        }
    }
}
#[derive(Deserialize)]
#[serde(transparent)]
struct Secret(String);
impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Begin {
    id: String,
    expected_revision: i64,
    auth_revision: i64,
    issuer: Option<String>,
    client_id: Option<String>,
    client_secret: Option<Secret>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    register: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    id: String,
    auth_revision: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}
fn number(d: &Value) -> i64 {
    d["revision"].as_i64().unwrap_or(0)
}
fn refs(d: &Value) -> bool {
    d["secret_refs"].as_object().is_some_and(|m| !m.is_empty())
}
pub(crate) fn binding(d: &Value) -> String {
    d["grant_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| crate::tools::hash(d["secret_refs"].to_string().as_bytes()))
}
fn public(mut d: Value) -> Value {
    d.as_object_mut().unwrap().remove("secret_refs");
    d
}
fn read_grant(d: &Value) -> Result<Grant, String> {
    let entries = d["secret_refs"]
        .as_object()
        .ok_or("Missing OAuth credential metadata")?;
    if entries.is_empty() || entries.len() > 32 {
        return Err("OAuth credentials missing; reconnect required".into());
    }
    let mut text = Zeroizing::new(String::new());
    for (index, (k, r)) in entries.iter().enumerate() {
        if k != &format!("chunk{index:03}") {
            return Err("OAuth credential chunks invalid".into());
        }
        let part = Zeroizing::new(vault::read(
            r.as_str().ok_or("Invalid OAuth credential reference")?,
        )?);
        if text.len() + part.len() > 65_536 {
            return Err("OAuth credential budget exceeded".into());
        }
        text.push_str(&part);
    }
    let mut grant: Grant =
        serde_json::from_str(&text).map_err(|_| "OAuth credential encoding invalid")?;
    let identity = binding(d);
    if grant.binding_id.is_empty() {
        grant.binding_id = identity.clone();
    }
    if grant.binding_id != identity {
        return Err("OAuth grant identity mismatch".into());
    }
    if d["resource"] != grant.resource
        || d["issuer"] != grant.metadata.issuer
        || d["metadata"]["token_endpoint"] != grant.metadata.token_endpoint
    {
        return Err("OAuth credential binding mismatch".into());
    }
    Ok(grant)
}
fn persist(
    store: &mut Store,
    id: &str,
    server_revision: i64,
    expected: i64,
    grant: Grant,
) -> Result<(), String> {
    let text = Zeroizing::new(
        serde_json::to_string(&grant).map_err(|_| "Cannot encode OAuth credentials")?,
    );
    if text.len() > 65_536 {
        return Err("OAuth credentials exceed storage budget".into());
    }
    let mut bindings = serde_json::Map::new();
    let mut start = 0;
    let mut index = 0;
    while start < text.len() {
        let mut end = (start + 2400).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let r = format!("TROOP/mcp/{id}/{}", Uuid::new_v4());
        store.mcp_prepare_secret(&r)?;
        vault::write(&r, &text[start..end])?;
        bindings.insert(format!("chunk{index:03}"), json!(r));
        index += 1;
        start = end;
    }
    let d = json!({"server_id":id,"server_revision":server_revision,"state":"connected","resource":grant.resource,"issuer":grant.metadata.issuer,"metadata":grant.metadata,"client_id":grant.client_id,"auth_method":grant.auth_method,"scopes":grant.scopes,"expires_at":grant.expires_at,"has_refresh_token":grant.refresh_token.is_some(),"updated_at":oauth::now(),"error":null});
    let mut d = d;
    d["grant_id"] = json!(grant.binding_id);
    store.oauth_save(id, server_revision, expected, &d, &json!(bindings))?;
    Ok(())
}
impl Manager {
    /// None waits for an existing/new refresh. Tokens remain internal to the transport path.
    pub(crate) fn mcp_access(
        &mut self,
        store: &mut Store,
        id: &str,
        revision: i64,
        identity: &str,
        allow_refresh: bool,
    ) -> Result<Option<(Zeroizing<String>, i64, bool)>, String> {
        let d = store.oauth_get(id)?;
        if d["server_revision"] != revision || binding(&d) != identity {
            return Err("OAuth grant changed; start a new task after connecting".into());
        }
        if d["state"] == "refreshing" {
            return Ok(None);
        }
        if d["state"] != "connected" {
            return Err(
                "OAuth connection unavailable; reconnect before starting a new task".into(),
            );
        }
        let expiring = d["expires_at"]
            .as_u64()
            .is_some_and(|e| e <= oauth::now() + 120);
        if expiring && d["has_refresh_token"] == true {
            if !allow_refresh {
                return Err("MCP automatic refresh budget exhausted".into());
            }
            if self.jobs.len() >= 4 {
                return Ok(None);
            }
            self.dispatch(
                store,
                "mcp.oauth.refresh",
                json!({"id":id,"auth_revision":number(&d)}),
            )?;
            return Ok(Some((Zeroizing::new(String::new()), number(&d), true)));
        }
        if d["expires_at"].as_u64().is_some_and(|e| e <= oauth::now()) {
            return Err("OAuth access token expired; reconnect required".into());
        }
        let grant = read_grant(&d)?;
        Ok(Some((
            Zeroizing::new(format!("Bearer {}", grant.access_token)),
            number(&d),
            false,
        )))
    }
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel(32);
        Self {
            jobs: HashMap::new(),
            sender,
            receiver,
        }
    }
    fn status(&self, store: &Store, id: &str) -> Result<Value, String> {
        let mut d = store.oauth_get(id)?;
        let server = store.mcp_server(id)?;
        if refs(&d) && (server.deleted || d["server_revision"] != server.revision) {
            d["state"] = json!("stale");
            d["error"] = json!("MCP definition changed; disconnect the old authorization");
        }
        if let Some(job) = self.jobs.get(id) {
            if number(&d) == job.epoch {
                d["authorization_url"] = json!(job.url);
            }
        }
        d["credential_cleanup_pending"] = json!(!store.mcp_gc()?.is_empty());
        Ok(public(d))
    }
    fn stop(&mut self, store: &mut Store, id: &str, expected: i64) -> Result<(), String> {
        let mut d = store.oauth_get(id)?;
        if number(&d) != expected {
            return Err("OAuth operation superseded".into());
        }
        if let Some(j) = self.jobs.remove(id) {
            j.handle.abort();
            d["state"] = json!(match j.kind {
                "refresh" => "refresh_uncertain",
                "revoke" => "revocation_unknown",
                _ => "cancelled",
            });
        } else {
            return Err("No pending OAuth operation".into());
        }
        d["error"] = json!("Operation cancelled locally; remote effects are not confirmed");
        let bindings = d["secret_refs"].clone();
        store.oauth_commit(id, expected, &d, &bindings)?;
        Ok(())
    }
    pub fn dispatch(&mut self, store: &mut Store, method: &str, p: Value) -> Result<Value, String> {
        let id = match method {
            "mcp.oauth.status" => {
                let a: Id = params(p)?;
                return self.status(store, &a.id);
            }
            "mcp.oauth.begin" => {
                let mut a: Begin = params(p)?;
                let server = store.mcp_server(&a.id)?;
                let old = store.oauth_get(&a.id)?;
                if server.deleted
                    || server.revision != a.expected_revision
                    || server.config["location"] != "remote"
                {
                    return Err("OAuth requires the current remote MCP definition".into());
                }
                if server.config["header_keys"]
                    .as_array()
                    .is_some_and(|v| v.contains(&json!("authorization")))
                {
                    return Err("Remove the manual Authorization header before OAuth login".into());
                }
                if matches!(
                    server.config["auth_mode"].as_str(),
                    Some("none" | "headers")
                ) {
                    return Err("Select automatic or OAuth authentication before login".into());
                }
                if number(&old) != a.auth_revision {
                    return Err("OAuth operation superseded".into());
                }
                if self.jobs.contains_key(&a.id) || refs(&old) {
                    return Err(
                        "Disconnect the existing authorization before starting a new login".into(),
                    );
                }
                if self.jobs.len() >= 4 {
                    return Err("OAuth operation capacity reached".into());
                }
                let mut d = json!({"server_id":a.id,"server_revision":server.revision,"state":"authorizing","updated_at":oauth::now(),"error":null});
                d = store.oauth_save(&a.id, server.revision, a.auth_revision, &d, &json!({}))?;
                let epoch = number(&d);
                let from = a.auth_revision;
                let options = oauth::Options {
                    resource: server.config["url"]
                        .as_str()
                        .ok_or("MCP resource missing")?
                        .into(),
                    issuer: a.issuer.take(),
                    client_id: a.client_id.take(),
                    client_secret: a.client_secret.as_mut().map(|s| std::mem::take(&mut s.0)),
                    scopes: a.scopes,
                    register: a.register,
                };
                let tx = self.sender.clone();
                let id = a.id.clone();
                let handle = tokio::spawn(async move {
                    let outcome = async {
                        let (flow, url) = tokio::time::timeout(
                            std::time::Duration::from_secs(45),
                            oauth::begin(options),
                        )
                        .await
                        .map_err(|_| "OAuth discovery/registration timed out; not retried")??;
                        if tx
                            .send(Update::Ready(id.clone(), epoch, url))
                            .await
                            .is_err()
                        {
                            return Err("OAuth controller closed".into());
                        }
                        flow.finish().await
                    }
                    .await;
                    let _ = tx
                        .send(Update::Done(id, epoch, outcome.map(Box::new)))
                        .await;
                });
                self.jobs.insert(
                    a.id.clone(),
                    Live {
                        epoch,
                        from,
                        server_revision: server.revision,
                        kind: "login",
                        url: None,
                        handle,
                    },
                );
                a.id
            }
            "mcp.oauth.cancel" => {
                let a: Operation = params(p)?;
                self.stop(store, &a.id, a.auth_revision)?;
                a.id
            }
            "mcp.oauth.refresh" => {
                let a: Operation = params(p)?;
                let mut d = store.oauth_get(&a.id)?;
                let server = store.mcp_server(&a.id)?;
                if let Some(j) = self.jobs.get(&a.id) {
                    if j.kind == "refresh"
                        && (a.auth_revision == j.from || a.auth_revision == j.epoch)
                    {
                        return self.status(store, &a.id);
                    }
                    return Err("An OAuth operation is already running".into());
                }
                if self.jobs.len() >= 4 {
                    return Err("OAuth operation capacity reached".into());
                }
                if number(&d) != a.auth_revision
                    || d["state"] != "connected"
                    || server.deleted
                    || d["server_revision"] != server.revision
                {
                    return Err("OAuth grant is stale or unavailable; reconnect required".into());
                }
                let grant = read_grant(&d)?;
                if grant.refresh_token.is_none() {
                    return Err("OAuth grant has no refresh token; reconnect required".into());
                }
                d["state"] = json!("refreshing");
                let bindings = d["secret_refs"].clone();
                let next =
                    store.oauth_save(&a.id, server.revision, a.auth_revision, &d, &bindings)?;
                let epoch = number(&next);
                let tx = self.sender.clone();
                let id = a.id.clone();
                let handle = tokio::spawn(async move {
                    let result = oauth::refresh(grant).await;
                    let _ = tx.send(Update::Done(id, epoch, result.map(Box::new))).await;
                });
                self.jobs.insert(
                    a.id.clone(),
                    Live {
                        epoch,
                        from: a.auth_revision,
                        server_revision: server.revision,
                        kind: "refresh",
                        url: None,
                        handle,
                    },
                );
                a.id
            }
            "mcp.oauth.disconnect" => {
                let a: Operation = params(p)?;
                let mut d = store.oauth_get(&a.id)?;
                if number(&d) != a.auth_revision {
                    return Err("OAuth operation superseded".into());
                }
                if let Some(j) = self.jobs.get(&a.id) {
                    if j.kind == "revoke" {
                        return self.status(store, &a.id);
                    }
                }
                let grant = if refs(&d) { Some(read_grant(&d)) } else { None };
                if let Some(j) = self.jobs.remove(&a.id) {
                    j.handle.abort();
                }
                d["state"] = json!(if grant.is_some() {
                    "revoking"
                } else {
                    "disconnected"
                });
                d["error"] = Value::Null;
                d["has_refresh_token"] = json!(false);
                d["expires_at"] = Value::Null;
                let next = store.oauth_commit(&a.id, a.auth_revision, &d, &json!({}))?;
                let epoch = number(&next);
                if let Some(grant) = grant {
                    let tx = self.sender.clone();
                    let id = a.id.clone();
                    let handle = tokio::spawn(async move {
                        let result = match grant {
                            Ok(g) => oauth::revoke(g).await,
                            Err(e) => Err(e),
                        };
                        let _ = tx.send(Update::Revoked(id, epoch, result)).await;
                    });
                    self.jobs.insert(
                        a.id.clone(),
                        Live {
                            epoch,
                            from: a.auth_revision,
                            server_revision: d["server_revision"].as_i64().unwrap_or(0),
                            kind: "revoke",
                            url: None,
                            handle,
                        },
                    );
                }
                crate::mcp::recover(store)?;
                a.id
            }
            _ => return Err("Unknown OAuth method".into()),
        };
        self.status(store, &id)
    }
    pub fn accept(&mut self, store: &mut Store, update: Update) -> Result<(), String> {
        let (id, epoch) = match &update {
            Update::Ready(id, e, _) | Update::Done(id, e, _) | Update::Revoked(id, e, _) => {
                (id.clone(), *e)
            }
        };
        let Some(job) = self.jobs.get_mut(&id).filter(|j| j.epoch == epoch) else {
            return Ok(());
        };
        let mut d = store.oauth_get(&id)?;
        if number(&d) != epoch {
            return Ok(());
        }
        if let Update::Ready(_, _, url) = update {
            job.url = Some(url);
            return Ok(());
        }
        let job = self.jobs.remove(&id).unwrap();
        match update {
            Update::Done(_, _, Ok(grant)) => {
                if let Err(e) = persist(store, &id, job.server_revision, epoch, *grant) {
                    d["state"] = json!(if job.kind == "refresh" {
                        "refresh_uncertain"
                    } else {
                        "error"
                    });
                    d["error"] = json!(e);
                    let bindings = d["secret_refs"].clone();
                    store.oauth_commit(&id, epoch, &d, &bindings)?;
                }
            }
            Update::Done(_, _, Err(e)) => {
                d["state"] = json!(if job.kind == "refresh" {
                    if e.contains("grant invalid") {
                        "reauth_required"
                    } else {
                        "refresh_uncertain"
                    }
                } else {
                    "error"
                });
                d["error"] = json!(e);
                let bindings = d["secret_refs"].clone();
                store.oauth_commit(&id, epoch, &d, &bindings)?;
            }
            Update::Revoked(_, _, result) => {
                d["state"] = json!(match &result {
                    Ok(true) => "revoked",
                    Ok(false) => "disconnected",
                    Err(_) => "revocation_unknown",
                });
                d["remote_revocation"] = json!(match &result {
                    Ok(true) => "confirmed",
                    Ok(false) => "unsupported",
                    Err(_) => "unknown",
                });
                d["error"] = json!(result.err());
                store.oauth_commit(&id, epoch, &d, &json!({}))?;
            }
            Update::Ready(..) => unreachable!(),
        }
        crate::mcp::recover(store)?;
        Ok(())
    }
    pub fn prune(&mut self, store: &mut Store) -> Result<(), String> {
        let ids = self
            .jobs
            .iter()
            .filter(|(_, j)| j.kind != "revoke")
            .filter_map(|(id, j)| {
                store
                    .mcp_server(id)
                    .ok()
                    .filter(|s| s.deleted || s.revision != j.server_revision)
                    .map(|_| id.clone())
            })
            .collect::<Vec<_>>();
        for id in ids {
            let d = store.oauth_get(&id)?;
            self.stop(store, &id, number(&d))?;
        }
        Ok(())
    }
    pub fn shutdown(&mut self, store: &mut Store) -> Result<(), String> {
        let ids = self.jobs.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let d = store.oauth_get(&id)?;
            self.stop(store, &id, number(&d))?;
        }
        Ok(())
    }
}
