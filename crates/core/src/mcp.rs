//! Library management only. Configuration/import never starts an executable or network session.
use crate::{params, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use troop_gateway::credentials::mcp as vault;
use uuid::Uuid;
use zeroize::Zeroize;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Definition {
    #[serde(default = "automatic_auth")]
    auth_mode: String,
    name: String,
    #[serde(default = "manual_source")]
    source_kind: String,
    transport: String,
    location: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    env_keys: Vec<String>,
    #[serde(default)]
    header_keys: Vec<String>,
    #[serde(default)]
    agent_ids: Vec<i64>,
    #[serde(default)]
    disabled_tools: Vec<String>,
    #[serde(default = "call_timeout")]
    timeout_seconds: u64,
    #[serde(default = "startup_timeout")]
    startup_timeout_seconds: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportInput {
    json: SecretText,
    location: String,
    cwd: String,
    #[serde(default)]
    offset: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyImport {
    source: ImportInput,
    digest: String,
    index: usize,
    id: Option<String>,
    expected_revision: i64,
}
fn parse_import(a: &ImportInput, store: &Store) -> Result<(String, Vec<Save>), String> {
    if a.json.0.len() > 32_000 || !matches!(a.location.as_str(), "windows-host" | "legacy-linux") {
        return Err("Invalid MCP import size or location".into());
    }
    let mut raw: Value = serde_json::from_str(&a.json.0).map_err(|_| "Invalid MCP import JSON")?;
    let parsed: Result<Vec<Save>, String> = (|| {
        let root = raw
            .get("mcpServers")
            .or_else(|| raw.get("servers"))
            .unwrap_or(&raw)
            .as_object()
            .ok_or("MCP import requires a server map")?;
        if root.is_empty() || root.len() > 64 {
            return Err("MCP import requires 1-64 entries".into());
        }
        let mut result = vec![];
        for (name, entry) in root {
            let map = entry.as_object().ok_or("Invalid MCP import entry")?;
            if map.keys().any(|k| {
                !matches!(
                    k.as_str(),
                    "command"
                        | "args"
                        | "cwd"
                        | "env"
                        | "url"
                        | "headers"
                        | "type"
                        | "transport"
                        | "disabled"
                        | "timeout_seconds"
                )
            }) {
                return Err(
                    "Unsupported MCP import field; convert explicitly before import".into(),
                );
            }
            let string = |key: &str| -> Result<String, String> {
                match entry.get(key) {
                    None => Ok(String::new()),
                    Some(Value::String(s)) => Ok(s.clone()),
                    _ => Err("MCP import field must be text".into()),
                }
            };
            let endpoint = string("url")?;
            for field in ["type", "transport"] {
                let t = string(field)?;
                if !matches!(
                    t.as_str(),
                    "" | "stdio" | "http" | "streamable-http" | "sse"
                ) || endpoint.is_empty() && !matches!(t.as_str(), "" | "stdio")
                    || !endpoint.is_empty() && t == "stdio"
                {
                    return Err("Unsupported MCP import transport".into());
                }
            }
            if entry.get("disabled").is_some_and(|v| !v.is_boolean()) {
                return Err("MCP disabled field must be boolean".into());
            }
            let transport = if !endpoint.is_empty() {
                match string("type")?.as_str() {
                    "sse" => "sse",
                    _ => match string("transport")?.as_str() {
                        "sse" => "sse",
                        _ => "http",
                    },
                }
            } else {
                "stdio"
            };
            let mut secrets = BTreeMap::new();
            let mut env_keys = vec![];
            let mut header_keys = vec![];
            for (field, prefix, keys) in [
                ("env", "env:", &mut env_keys),
                ("headers", "header:", &mut header_keys),
            ] {
                if let Some(values) = entry.get(field) {
                    for (k, v) in values
                        .as_object()
                        .ok_or("MCP import env/headers must be objects")?
                    {
                        let key = if field == "headers" {
                            k.to_ascii_lowercase()
                        } else {
                            k.clone()
                        };
                        keys.push(key.clone());
                        secrets.insert(
                            format!("{prefix}{key}"),
                            SecretText(
                                v.as_str()
                                    .ok_or("MCP import env/header values must be text")?
                                    .into(),
                            ),
                        );
                    }
                }
            }
            let command = string("command")?;
            let args = match entry.get("args") {
                None => vec![],
                Some(v) => serde_json::from_value::<Vec<String>>(v.clone())
                    .map_err(|_| "MCP import args must be text array")?,
            };
            let cwd = if transport == "stdio" {
                let cwd = string("cwd")?;
                if cwd.is_empty() {
                    a.cwd.clone()
                } else {
                    cwd
                }
            } else {
                String::new()
            };
            let definition = Definition {
                auth_mode: "automatic".into(),
                name: name.clone(),
                source_kind: "json-import".into(),
                transport: transport.into(),
                location: if transport == "stdio" {
                    a.location.clone()
                } else {
                    "remote".into()
                },
                enabled: false,
                command,
                args,
                cwd,
                url: endpoint,
                env_keys,
                header_keys,
                agent_ids: vec![],
                disabled_tools: vec![],
                timeout_seconds: entry
                    .get("timeout_seconds")
                    .map(|v| v.as_u64().ok_or("MCP timeout must be an integer"))
                    .transpose()?
                    .unwrap_or(180),
                startup_timeout_seconds: 30,
            };
            definition.validate(store)?;
            result.push(Save {
                id: None,
                expected_revision: 0,
                definition,
                secrets,
            });
        }
        Ok(result)
    })();
    fn wipe(v: &mut Value) {
        match v {
            Value::String(s) => s.zeroize(),
            Value::Array(a) => a.iter_mut().for_each(wipe),
            Value::Object(m) => m.values_mut().for_each(wipe),
            _ => {}
        }
    }
    wipe(&mut raw);
    let digest = crate::tools::hash(json!([a.json.0, a.location, a.cwd]).to_string().as_bytes());
    Ok((digest, parsed?))
}
fn call_timeout() -> u64 {
    180
}
fn manual_source() -> String {
    "manual".into()
}
fn automatic_auth() -> String {
    "automatic".into()
}
fn startup_timeout() -> u64 {
    30
}
fn unique<T: std::hash::Hash + Eq>(v: &[T]) -> bool {
    v.iter().collect::<HashSet<_>>().len() == v.len()
}
impl Definition {
    fn validate(&self, store: &Store) -> Result<(), String> {
        if !matches!(
            self.auth_mode.as_str(),
            "automatic" | "none" | "headers" | "oauth"
        ) || self.transport == "stdio" && self.auth_mode == "oauth"
            || !matches!(self.source_kind.as_str(), "manual" | "json-import")
            || self.name.trim().is_empty()
            || self.name.len() > 160
            || self.name.chars().any(char::is_control)
            || json!(self).to_string().len() > 16_000
            || self.agent_ids.len() > 64
            || !unique(&self.agent_ids)
            || self.disabled_tools.len() > 500
            || !unique(&self.disabled_tools)
            || self
                .disabled_tools
                .iter()
                .any(|s| s.is_empty() || s.len() > 256)
            || self.env_keys.len() > 64
            || self.header_keys.len() > 32
            || !unique(&self.env_keys)
            || !unique(&self.header_keys)
            || !(1..=3600).contains(&self.timeout_seconds)
            || !(1..=180).contains(&self.startup_timeout_seconds)
        {
            return Err("Invalid MCP definition or capacity exceeded".into());
        }
        for id in &self.agent_ids {
            store.memory_agent(*id)?;
        }
        if self
            .env_keys
            .iter()
            .any(|s| s.is_empty() || s.len() > 200 || s.contains(['=', '\0']) || !s.is_ascii())
            || !unique(
                &self
                    .env_keys
                    .iter()
                    .map(|s| s.to_ascii_uppercase())
                    .collect::<Vec<_>>(),
            )
        {
            return Err("Invalid or ambiguous MCP environment keys".into());
        }
        if self
            .header_keys
            .iter()
            .any(|s| s != &s.to_ascii_lowercase())
        {
            return Err("MCP header names must be lowercase".into());
        }
        troop_mcp::validate_header_names(&self.header_keys)?;
        match (self.transport.as_str(), self.location.as_str()) {
            ("stdio", "windows-host") => {
                troop_mcp::StdioConfig {
                    command: self.command.clone().into(),
                    args: self.args.clone(),
                    cwd: self.cwd.clone().into(),
                    env: BTreeMap::new(),
                }
                .validate()?;
                if !self.url.is_empty() || !self.header_keys.is_empty() {
                    return Err("stdio cannot contain remote endpoint fields".into());
                }
            }
            ("stdio", "legacy-linux") => {
                if self.enabled
                    || self.command.is_empty()
                    || !self.url.is_empty()
                    || !self.header_keys.is_empty()
                {
                    return Err("Legacy Linux MCP must remain disabled".into());
                }
            }
            ("http" | "sse", "remote") => {
                troop_mcp::validate_endpoint(&self.url)?;
                if !self.command.is_empty()
                    || !self.cwd.is_empty()
                    || !self.args.is_empty()
                    || !self.env_keys.is_empty()
                {
                    return Err("Remote MCP cannot contain host execution fields".into());
                }
            }
            _ => return Err("Invalid MCP transport or execution location".into()),
        }
        Ok(())
    }
    fn keys(&self) -> Vec<String> {
        self.env_keys
            .iter()
            .map(|s| format!("env:{s}"))
            .chain(self.header_keys.iter().map(|s| format!("header:{s}")))
            .collect()
    }
}
#[derive(Deserialize)]
#[serde(transparent)]
struct SecretText(String);
impl Drop for SecretText {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    id: Option<String>,
    expected_revision: i64,
    definition: Definition,
    #[serde(default)]
    secrets: BTreeMap<String, SecretText>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Remove {
    id: String,
    expected_revision: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    #[serde(default)]
    offset: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    id: String,
    #[serde(default)]
    offset: usize,
}
fn id_ok(id: &str) -> Result<(), String> {
    if Uuid::parse_str(id).is_ok() {
        Ok(())
    } else {
        Err("Invalid MCP server ID".into())
    }
}
fn cleanup(store: &Store) -> Result<(), String> {
    for r in store.mcp_gc()? {
        if vault::delete(&r).is_ok() {
            store.mcp_gc_done(&r)?;
        }
    }
    Ok(())
}
pub(crate) fn recover(store: &Store) -> Result<(), String> {
    cleanup(store)
}
fn save(store: &mut Store, a: Save) -> Result<Value, String> {
    a.definition.validate(store)?;
    let id = a.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    id_ok(&id)?;
    let old = if a.id.is_some() {
        Some(store.mcp_server(&id)?)
    } else {
        None
    };
    if old
        .as_ref()
        .is_some_and(|s| s.revision != a.expected_revision || s.deleted)
        || old.is_none() && a.expected_revision != 0
    {
        return Err("MCP definition changed; refresh before editing".into());
    }
    let keys = a.definition.keys();
    if a.secrets.keys().any(|k| !keys.contains(k)) {
        return Err("Secret does not belong to this MCP definition".into());
    }
    // Validate everything before changing the vault; journal every fresh reference first.
    if a.secrets.iter().any(|(key, s)| {
        s.0.len() > 2500
            || s.0.contains('\0')
            || key.starts_with("header:") && s.0.chars().any(char::is_control)
    }) {
        return Err("Invalid MCP secret value".into());
    }
    if keys.iter().any(|key| {
        !a.secrets.contains_key(key) && old.as_ref().and_then(|s| s.secret_refs.get(key)).is_none()
    }) {
        return Err("Missing MCP secret; supply each newly declared key".into());
    }
    let mut refs = serde_json::Map::new();
    for key in keys {
        if let Some(secret) = a.secrets.get(&key) {
            let r = format!("TROOP/mcp/{id}/{}", Uuid::new_v4());
            store.mcp_prepare_secret(&r)?;
            if let Err(e) = vault::write(&r, &secret.0) {
                cleanup(store)?;
                return Err(e);
            }
            refs.insert(key, json!(r));
        } else if let Some(r) = old.as_ref().and_then(|s| s.secret_refs.get(&key)) {
            refs.insert(key, r.clone());
        }
    }
    let result = store.mcp_save(
        &id,
        a.expected_revision,
        &json!(a.definition),
        &json!(refs),
        false,
    );
    cleanup(store)?;
    serde_json::to_value(result?).map_err(|_| "Cannot encode MCP definition".into())
}
pub(crate) fn dispatch(store: &mut Store, method: &str, p: Value) -> Result<Value, String> {
    cleanup(store)?;
    let mut answer = match method {
        "mcp.list" => {
            let a: Page = params(p)?;
            if a.offset > 10000 {
                return Err("Invalid MCP page".into());
            }
            store.mcp_list(a.offset)
        }
        "mcp.get" => {
            let a: Id = params(p)?;
            id_ok(&a.id)?;
            serde_json::to_value(store.mcp_server(&a.id)?)
                .map_err(|_| "Cannot encode MCP definition".into())
        }
        "mcp.save" => save(store, params(p)?),
        "mcp.preview" => {
            let a: ImportInput = params(p)?;
            let (digest, entries) = parse_import(&a, store)?;
            if a.offset > entries.len() {
                return Err("Invalid MCP preview offset".into());
            }
            let mut items = vec![];
            let mut bytes = 0;
            for (index, e) in entries.iter().enumerate().skip(a.offset).take(10) {
                let item = json!({"index":index,"definition":e.definition,"secret_keys":e.definition.keys()});
                bytes += item.to_string().len();
                if bytes > 40_000 {
                    break;
                }
                items.push(item);
            }
            let end = a.offset + items.len();
            Ok(
                json!({"digest":digest,"items":items,"total":entries.len(),"next_offset":if end<entries.len(){Some(end)}else{None}}),
            )
        }
        "mcp.import" => {
            let a: ApplyImport = params(p)?;
            let (digest, mut entries) = parse_import(&a.source, store)?;
            if digest != a.digest || a.index >= entries.len() {
                return Err("MCP import preview changed; preview again".into());
            }
            let mut entry = entries.remove(a.index);
            entry.id = a.id;
            entry.expected_revision = a.expected_revision;
            save(store, entry)
        }
        "mcp.remove" => {
            let a: Remove = params(p)?;
            id_ok(&a.id)?;
            let old = store.mcp_server(&a.id)?;
            let mut config = old.config;
            config["enabled"] = json!(false);
            let result = store.mcp_save(&a.id, a.expected_revision, &config, &json!({}), true)?;
            cleanup(store)?;
            serde_json::to_value(result).map_err(|_| "Cannot encode MCP definition".into())
        }
        "mcp.revisions" => {
            let a: History = params(p)?;
            id_ok(&a.id)?;
            if a.offset > 10000 {
                return Err("Invalid MCP page".into());
            }
            store.mcp_revisions(&a.id, a.offset)
        }
        _ => Err("Unknown MCP library method".into()),
    }?;
    answer["credential_cleanup_pending"] = json!(!store.mcp_gc()?.is_empty());
    Ok(answer)
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn orphaned_credentials_are_reclaimed_and_namespaces_do_not_cross() {
        let base = std::env::temp_dir();
        let dir = base.join(format!("troop-mcp-unit-{}", Uuid::new_v4()));
        let store = Store::open(&dir).unwrap();
        let r = format!("TROOP/mcp/{}/{}", Uuid::new_v4(), Uuid::new_v4());
        store.mcp_prepare_secret(&r).unwrap();
        vault::write(&r, "owned-native-secret").unwrap();
        assert_eq!(vault::read(&r).unwrap(), "owned-native-secret");
        vault::write(&r, "").unwrap();
        assert_eq!(vault::read(&r).unwrap(), "");
        assert!(troop_gateway::credentials::read(&r).is_err());
        assert!(vault::read(&format!("TROOP/model/{}", Uuid::new_v4())).is_err());
        drop(store);
        let mut store = Store::open(&dir).unwrap();
        dispatch(&mut store, "mcp.list", json!({})).unwrap();
        assert!(vault::read(&r).is_err());
        assert!(store.mcp_gc().unwrap().is_empty());
        drop(store);
        assert!(dir.starts_with(base));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn frozen_assignment_revision_and_disabled_tool_are_enforced() {
        let base = std::env::temp_dir();
        let dir = base.join(format!("troop-mcp-unit-{}", Uuid::new_v4()));
        let mut store = Store::open(&dir).unwrap();
        let a=save(&mut store,params(json!({"expected_revision":0,"definition":{"name":"Owned permission","transport":"http","location":"remote","url":"http://127.0.0.1:1/mcp","enabled":true,"agent_ids":[1],"disabled_tools":["send"]}})).unwrap()).unwrap();
        let id = a["id"].as_str().unwrap();
        assert!(store.mcp_authorize(id, 1, 1, Some("echo")).is_ok());
        assert!(store.mcp_authorize(id, 1, 1, Some("send")).is_err());
        assert!(store.mcp_authorize(id, 2, 1, None).is_err());
        let mut definition = a["config"].clone();
        definition["agent_ids"] = json!([]);
        save(
            &mut store,
            params(json!({"id":id,"expected_revision":1,"definition":definition})).unwrap(),
        )
        .unwrap();
        assert!(store.mcp_authorize(id, 1, 1, None).is_err());
        assert!(store.mcp_authorize(id, 2, 1, None).is_err());
        drop(store);
        assert!(dir.starts_with(base));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
