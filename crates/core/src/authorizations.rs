use crate::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use troop_storage::Store;
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_settings: Option<crate::cli_settings::Binding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    credential_env_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shell: Option<crate::sandbox::ShellBinding>,
    #[serde(default = "host_environment")]
    environment: String,
    name: String,
    purpose: String,
    agent_id: i64,
    engine_id: String,
    workspace_id: i64,
    project_ids: Vec<String>,
    read_roots: Vec<String>,
    write_roots: Vec<String>,
    operations: Vec<String>,
    network: String,
    expires_at: i64,
    rule_id: Option<String>,
    program: Option<String>,
    #[serde(default)]
    read_all: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    prompt_hooks: Vec<PromptHookBinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    mcp_calls: Vec<McpCallBinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    command_hooks: Vec<CommandHookBinding>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CommandHookBinding {
    id: i64,
    revision: i64,
    host_access: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    program: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    program_sha256: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    command_sha256: String,
}
pub(crate) fn command_hooks_current(store: &Store, grant: &Value) -> Result<(), String> {
    let bindings: Vec<CommandHookBinding> =
        params(grant.get("command_hooks").cloned().unwrap_or(json!([])))?;
    if bindings.is_empty() {
        return Ok(());
    }
    let rules = store.hook_rules()?;
    let program = crate::tools::host_shell()?;
    for binding in bindings {
        let scoped = binding.host_access == "sandbox" && grant["shell"].is_object();
        if !(scoped || binding.host_access == "full_host" && grant["network"] == "any")
            || binding.program_sha256.len() != 64
            || Path::new(&binding.program) != program
            || !rules.iter().any(|rule| {
                rule["id"] == binding.id
                    && rule["revision"] == binding.revision
                    && rule["kind"] == "command"
                    && rule["enabled"] == true
                    && crate::tools::hash(rule["command"].as_str().unwrap_or("").as_bytes())
                        == binding.command_sha256
            })
        {
            return Err("命令 Hook 配置、程序身份或授权已变化。".into());
        }
    }
    Ok(())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct McpOperation {
    pub server_id: String,
    pub tool: String,
    pub arguments: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct McpCallBinding {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    sandbox_adapter: String,
    server_id: String,
    revision: i64,
    tool: String,
    arguments: Value,
    #[serde(default)]
    auth_binding: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host_access: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    program: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    program_sha256: String,
}
impl McpCallBinding {
    fn current_identity(&self, store: &Store, agent: i64) -> Result<String, String> {
        let server =
            store.mcp_authorize(&self.server_id, self.revision, agent, Some(&self.tool))?;
        if server.config["transport"] == "stdio" {
            if !(self.host_access.as_deref() == Some("full_host")
                && self.sandbox_adapter.is_empty()
                || self.host_access.as_deref() == Some("sandbox")
                    && self.sandbox_adapter == troop_mcp::containment::ADAPTER)
                || self.program.is_empty()
                || self.program_sha256.len() != 64
                || Path::new(server.config["command"].as_str().unwrap_or(""))
                    .canonicalize()
                    .ok()
                    .as_deref()
                    != Some(Path::new(&self.program))
            {
                return Err("stdio MCP 需要显式权限模式及固定主程序指纹。".into());
            }
        } else if !matches!(server.config["transport"].as_str(), Some("http" | "sse"))
            || self.host_access.is_some()
            || !self.program.is_empty()
            || !self.program_sha256.is_empty()
            || !self.sandbox_adapter.is_empty()
        {
            return Err("MCP 接入与宿主程序授权模式不匹配。".into());
        }
        crate::mcp::auth_binding(store, &server)
    }
}
pub(crate) fn mcp_grant_current(store: &Store, grant: &Value) -> Result<(), String> {
    let bindings: Vec<McpCallBinding> = params(grant["mcp_calls"].clone())?;
    if bindings.is_empty() || bindings.len() > 8 {
        return Err("MCP 服务操作授权缺少有效绑定。".into());
    }
    let agent = grant["agent_id"].as_i64().ok_or("MCP 授权身份无效。")?;
    if bindings
        .iter()
        .any(|binding| binding.host_access.as_deref() == Some("sandbox"))
    {
        let policy = crate::sandbox::stdio_config(grant)?;
        troop_mcp::containment::available()?;
        for binding in &bindings {
            if binding.host_access.as_deref() == Some("sandbox") {
                let server = store.mcp_server(&binding.server_id)?;
                policy.evidence(
                    Path::new(&binding.program),
                    Path::new(server.config["cwd"].as_str().ok_or("MCP 工作目录无效。")?),
                )?;
            }
        }
    }
    for binding in bindings {
        if binding.auth_binding.is_empty()
            || binding.current_identity(store, agent)? != binding.auth_binding
        {
            return Err("MCP 服务认证身份已变化，请重新确认授权。".into());
        }
    }
    Ok(())
}
pub(crate) fn mcp_operation_binding(
    store: &Store,
    grant: &Value,
    operation: &Value,
) -> Result<Value, String> {
    let action: McpOperation = params(operation.clone())?;
    let bindings: Vec<McpCallBinding> = params(grant["mcp_calls"].clone())?;
    let binding = bindings
        .iter()
        .find(|binding| {
            binding.server_id == action.server_id
                && binding.tool == action.tool
                && binding.arguments == action.arguments
        })
        .ok_or("MCP 服务、工具或完整参数超出授权。")?;
    let agent = grant["agent_id"].as_i64().ok_or("MCP 授权身份无效。")?;
    if binding.auth_binding.is_empty()
        || binding.current_identity(store, agent)? != binding.auth_binding
    {
        return Err("MCP 服务认证身份已变化，请重新确认授权。".into());
    }
    serde_json::to_value(binding).map_err(|error| error.to_string())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PromptHookBinding {
    id: i64,
    revision: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    id: Option<String>,
    expected_revision: i64,
    grant: Grant,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
    #[serde(default)]
    offset: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revoke {
    id: String,
    expected_revision: i64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Evaluation {
    #[serde(default = "host_environment")]
    environment: String,
    id: String,
    agent_id: i64,
    engine_id: String,
    workspace_id: i64,
    project_ids: Vec<String>,
    rule_id: Option<String>,
    operation: String,
    path: Option<String>,
    network: String,
    mcp: Option<McpOperation>,
}
fn host_environment() -> String {
    "windows-host".into()
}
fn roots(values: &mut [String]) -> Result<(), String> {
    for value in values {
        if !Path::new(value).is_absolute() {
            return Err("目录必须为绝对路径。".into());
        }
        let path = std::fs::canonicalize(&*value).map_err(|_| "授权目录不存在或不可访问。")?;
        if !path.is_dir() {
            return Err("授权根目录必须是文件夹。".into());
        }
        *value = path.to_str().ok_or("目录编码无效。")?.to_owned();
    }
    Ok(())
}
fn validate(store: &Store, g: &mut Grant) -> Result<(), String> {
    if !g.command_hooks.is_empty() {
        if !matches!(g.purpose.as_str(), "tool_call" | "mcp_call")
            || g.engine_id != "native"
            || g.command_hooks.len() > 32
        {
            return Err("命令 Hook 需要原生执行和显式权限模式，最多 32 项。".into());
        }
        let rules = store.hook_rules()?;
        let program = crate::tools::host_shell()?;
        let program_hash = troop_mcp::program::fingerprint(&program)?;
        let mut seen = std::collections::BTreeSet::new();
        for binding in &mut g.command_hooks {
            let rule = rules
                .iter()
                .find(|rule| {
                    rule["id"] == binding.id
                        && rule["revision"] == binding.revision
                        && rule["kind"] == "command"
                        && rule["enabled"] == true
                        && rule["supported"] == true
                        && rule["location"] == "windows-host"
                        && (rule["agent_id"].is_null() || rule["agent_id"] == g.agent_id)
                        && (rule["workspace_id"].is_null()
                            || rule["workspace_id"] == g.workspace_id)
                })
                .ok_or("命令 Hook 修订或执行范围无效。")?;
            let command_hash =
                crate::tools::hash(rule["command"].as_str().unwrap_or("").as_bytes());
            if binding.id < 1
                || binding.revision < 1
                || !(binding.host_access == "sandbox" && g.shell.is_some()
                    || binding.host_access == "full_host" && g.network == "any")
                || !seen.insert(binding.id)
                || (!binding.program.is_empty() && Path::new(&binding.program) != program)
                || (!binding.program_sha256.is_empty() && binding.program_sha256 != program_hash)
                || (!binding.command_sha256.is_empty() && binding.command_sha256 != command_hash)
            {
                return Err(
                    "命令 Hook 缺少显式权限确认、隔离绑定或网络许可，或固定指纹已变化。".into(),
                );
            }
            binding.program = program.to_str().ok_or("命令 Hook 主程序路径无效。")?.into();
            binding.program_sha256 = program_hash.clone();
            binding.command_sha256 = command_hash;
        }
    }
    if g.purpose == "mcp_call" {
        let scoped = g
            .mcp_calls
            .iter()
            .all(|binding| binding.host_access.as_deref() == Some("sandbox"));
        if g.engine_id != "native"
            || (!scoped
                && (g.network != "any" || !g.read_roots.is_empty() || !g.write_roots.is_empty()))
            || g.operations != ["call_mcp"]
            || g.mcp_calls.is_empty()
            || g.mcp_calls.len() > 8
        {
            return Err("MCP 服务授权需要固定操作绑定与网络许可，文件根目录须为空。".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut process_modes = std::collections::BTreeMap::new();
        for binding in &mut g.mcp_calls {
            if let Some(previous) =
                process_modes.insert(binding.server_id.clone(), binding.host_access.clone())
            {
                if previous != binding.host_access {
                    return Err("同一 MCP 服务的进程权限模式必须一致。".into());
                }
            }
            if binding.revision < 1
                || Uuid::parse_str(&binding.server_id).is_err()
                || binding.tool.is_empty()
                || binding.tool.len() > 128
                || binding.tool.chars().any(char::is_control)
                || !binding.arguments.is_object()
                || binding.arguments.to_string().len() > 4000
                || !seen.insert((
                    binding.server_id.clone(),
                    binding.tool.clone(),
                    binding.arguments.to_string(),
                ))
            {
                return Err("MCP 操作绑定重复或参数无效。".into());
            }
            let server = store.mcp_authorize(
                &binding.server_id,
                binding.revision,
                g.agent_id,
                Some(&binding.tool),
            )?;
            if server.config["transport"] == "stdio" {
                match binding.host_access.as_deref() {
                    Some("sandbox") => {
                        if !binding.sandbox_adapter.is_empty()
                            && binding.sandbox_adapter != troop_mcp::containment::ADAPTER
                        {
                            return Err("MCP 隔离运行时已变化，请重新确认。".into());
                        }
                        troop_mcp::containment::available()?;
                        binding.sandbox_adapter = troop_mcp::containment::ADAPTER.into();
                    }
                    Some("full_host") if binding.sandbox_adapter.is_empty() => {}
                    _ => {
                        return Err(
                            "stdio MCP 的初始化和运行需要显式 full_host 或 sandbox 授权。".into(),
                        )
                    }
                }
                let program = Path::new(server.config["command"].as_str().unwrap_or(""))
                    .canonicalize()
                    .map_err(|_| "MCP 主程序不可访问。")?;
                if !program
                    .extension()
                    .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
                {
                    return Err("stdio 预授权需要明确的原生可执行程序。".into());
                }
                let hash = troop_mcp::program::fingerprint(&program)?;
                if (!binding.program.is_empty() && Path::new(&binding.program) != program)
                    || (!binding.program_sha256.is_empty() && binding.program_sha256 != hash)
                {
                    return Err("MCP 主程序已变化，请重新确认程序身份。".into());
                }
                binding.program = program.to_str().ok_or("MCP 主程序路径编码无效。")?.into();
                binding.program_sha256 = hash;
            }
            let identity = binding.current_identity(store, g.agent_id)?;
            if !binding.auth_binding.is_empty() && binding.auth_binding != identity {
                return Err("MCP 认证身份已变化，请重新确认绑定。".into());
            }
            binding.auth_binding = identity;
        }
    } else if !g.mcp_calls.is_empty() {
        return Err("MCP 操作绑定需要独立的服务授权类别。".into());
    }
    if !g.prompt_hooks.is_empty() {
        if !matches!(g.purpose.as_str(), "tool_call" | "mcp_call")
            || g.engine_id != "native"
            || g.prompt_hooks.len() > 32
        {
            return Err("提示 Hook 绑定仅适用于原生工具授权，最多 32 项。".into());
        }
        let rules = store.hook_rules()?;
        let mut seen = std::collections::BTreeSet::new();
        for binding in &g.prompt_hooks {
            if binding.id < 1
                || binding.revision < 1
                || !seen.insert(binding.id)
                || !rules.iter().any(|rule| {
                    rule["id"] == binding.id
                        && rule["revision"] == binding.revision
                        && rule["kind"] == "prompt"
                        && rule["enabled"] == true
                        && rule["location"] == "windows-host"
                        && rule["supported"] == true
                        && (rule["agent_id"].is_null() || rule["agent_id"] == g.agent_id)
                        && (rule["workspace_id"].is_null()
                            || rule["workspace_id"] == g.workspace_id)
                })
            {
                return Err("提示 Hook 绑定重复、修订已变化或不属于此执行范围。".into());
            }
        }
    }
    if !g.credential_env_keys.is_empty()
        && (g.purpose != "cli_start"
            || !matches!(
                g.engine_id.as_str(),
                "pi" | "oh-my-pi" | "copilot" | "grok" | "opencode"
            ))
        || g.credential_env_keys.len() > 16
        || g.credential_env_keys.iter().any(|key| {
            key.len() > 64
                || !key.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
                || !key.bytes().all(|value| {
                    value.is_ascii_uppercase() || value.is_ascii_digit() || value == b'_'
                })
                || !(key.ends_with("_API_KEY") || key.ends_with("_TOKEN"))
        })
    {
        return Err(
            "凭据环境引用需用于支持的 CLI 启动授权，最多 16 个大写 API_KEY 或 TOKEN 名称。".into(),
        );
    }
    if let Some(binding) = &mut g.model_settings {
        if g.purpose != "cli_start" || !matches!(g.engine_id.as_str(), "claude" | "opencode") {
            return Err("模型配置文件引用当前用于 Claude 和 OpenCode 启动授权。".into());
        }
        binding.freeze()?;
    }
    if g.model_settings.is_some() {
        let grant = serde_json::to_value(&g).map_err(|error| error.to_string())?;
        if g.engine_id == "claude" {
            crate::claude::selection(&grant)?;
        } else {
            crate::opencode::selection(&grant)?;
        }
    }
    g.credential_env_keys.sort();
    g.credential_env_keys.dedup();
    if g.read_all && g.purpose != "cli_start" {
        return Err("全盘读取只适用于明确的 CLI 启动授权。".into());
    }
    if g.environment != "windows-host" {
        return Err("当前授权管理支持本机 Windows 执行环境。".into());
    }
    if g.name.trim().is_empty()
        || g.name.len() > 120
        || !matches!(
            g.purpose.as_str(),
            "rule_management" | "tool_call" | "cli_start" | "mcp_call"
        )
        || !matches!(
            g.engine_id.as_str(),
            "native" | "codex" | "claude" | "grok" | "opencode" | "oh-my-pi" | "pi" | "copilot"
        )
        || !matches!(g.network.as_str(), "none" | "any")
        || g.expires_at < 1
        || g.operations.is_empty()
        || g.operations.len() > 32
        || g.read_roots.len() > 8
        || g.write_roots.len() > 8
        || g.project_ids.len() > 16
        || g.rule_id
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 120)
    {
        return Err("授权名称、类别、范围或有效期无效。".into());
    }
    let known = [
        "propose_followup",
        "request_handoff",
        "group_reply",
        "read_file",
        "list_directory",
        "search_text",
        "write_file",
        "run_command",
        "git_status",
        "start_background",
        "create_rule",
        "edit_rule",
        "toggle_rule",
        "start",
        "call_mcp",
    ];
    if g.operations.iter().any(|op| {
        !known.contains(&op.as_str())
            || match g.purpose.as_str() {
                "rule_management" => {
                    !matches!(op.as_str(), "create_rule" | "edit_rule" | "toggle_rule")
                }
                "cli_start" => op != "start",
                "mcp_call" => op != "call_mcp",
                _ => matches!(
                    op.as_str(),
                    "create_rule" | "edit_rule" | "toggle_rule" | "start" | "call_mcp"
                ),
            }
    }) {
        return Err("操作与授权类别不匹配。".into());
    }
    store.memory_agent(g.agent_id)?;
    store.workspace_path(g.workspace_id)?;
    let projects = store.memory_projects(g.agent_id)?;
    if g.project_ids.iter().any(|p| {
        !projects
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["slug"] == p.as_str() && r["joined"] == true)
    }) {
        return Err("Agent 尚未加入指定项目。".into());
    }
    roots(&mut g.read_roots)?;
    roots(&mut g.write_roots)?;
    if g.mcp_calls
        .iter()
        .any(|binding| binding.host_access.as_deref() == Some("sandbox"))
    {
        let config = troop_mcp::containment::Config {
            adapter: troop_mcp::containment::ADAPTER.into(),
            read_roots: g.read_roots.clone(),
            write_roots: g.write_roots.clone(),
            network: g.network.clone(),
        };
        config.validate()?;
        for binding in &g.mcp_calls {
            if binding.host_access.as_deref() == Some("sandbox") {
                let server = store.mcp_server(&binding.server_id)?;
                config.evidence(
                    Path::new(&binding.program),
                    Path::new(server.config["cwd"].as_str().ok_or("MCP 工作目录无效。")?),
                )?;
            }
        }
    }
    if let Some(shell) = &mut g.shell {
        let shell_tools = g
            .operations
            .iter()
            .any(|op| matches!(op.as_str(), "run_command" | "start_background"));
        let scoped_hooks = g
            .command_hooks
            .iter()
            .any(|binding| binding.host_access == "sandbox");
        if !matches!(g.purpose.as_str(), "tool_call" | "mcp_call")
            || g.engine_id != "native"
            || !(g.purpose == "tool_call" && shell_tools || scoped_hooks)
        {
            return Err("Shell 隔离绑定需要原生 Shell 工具授权。".into());
        }
        crate::sandbox::bind(shell)?;
    }
    if let Some(program) = &mut g.program {
        if g.purpose != "cli_start" || program.len() > 4000 || !Path::new(program).is_absolute() {
            return Err("CLI 程序必须绑定到启动授权中的绝对文件路径。".into());
        }
        let resolved = std::fs::canonicalize(&*program).map_err(|_| "CLI 程序不存在。")?;
        if !resolved.is_file() {
            return Err("CLI 程序必须是文件。".into());
        }
        *program = resolved
            .to_str()
            .ok_or("CLI 程序路径编码无效。")?
            .to_owned();
    }
    if serde_json::to_vec(g).map_err(|e| e.to_string())?.len() > 8_000 {
        return Err("授权范围过长。".into());
    }
    g.name = g.name.trim().into();
    Ok(())
}
pub fn write(store: &Store, method: &str, input: Value) -> Result<Value, String> {
    match method {
        "authorizations.save" => {
            let mut a = params::<Save>(input)?;
            validate(store, &mut a.grant)?;
            if a.expected_revision < 0 || a.id.is_none() && a.expected_revision != 0 {
                return Err("授权修订无效。".into());
            }
            let id = a.id.unwrap_or_else(|| Uuid::new_v4().to_string());
            if Uuid::parse_str(&id).is_err() {
                return Err("授权标识无效。".into());
            }
            if a.expected_revision == 0 && store.authorization_get(&id).is_ok() {
                return Err("授权已存在。".into());
            }
            store.authorization_save(
                &id,
                a.expected_revision,
                serde_json::to_value(a.grant).map_err(|e| e.to_string())?,
                false,
            )
        }
        "authorizations.revoke" => {
            let a = params::<Revoke>(input)?;
            store.authorization_save(&a.id, a.expected_revision, Value::Null, true)
        }
        _ => Err("授权命令无效。".into()),
    }
}
fn resolved_target(raw: &str, workspace: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.len() > 4000 || raw.contains('\0') {
        return Err("目标路径无效。".into());
    }
    let path = Path::new(raw);
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("目标路径含上级跳转。".into());
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(workspace).join(path)
    };
    if absolute.exists() {
        return std::fs::canonicalize(absolute).map_err(|_| "目标无法解析。".into());
    }
    let parent = absolute.parent().ok_or("目标目录无效。")?;
    Ok(std::fs::canonicalize(parent)
        .map_err(|_| "目标父目录无法解析。")?
        .join(absolute.file_name().ok_or("目标文件名无效。")?))
}
pub fn read(store: &Store, method: &str, input: Value) -> Result<Value, String> {
    match method {
        "engines.capabilities" => Ok(json!({
            "engine_id": "native", "version": "native-files-v1", "environment": "windows-host",
            "controlled_tools": ["read_file", "write_file", "list_directory", "search_text"],
            "dispatch_gate": "supported", "workspace_relative_paths": "supported", "reparse_points": "rejected",
            "arbitrary_shell": "requires_explicit_mxc_binding", "cli_permissions": "unverified",
            "scoped_shell": {
                "adapter": "mxc-process-v1", "version": "1.0.1", "platform": "windows-x64",
                "tools": ["run_command", "start_background"], "command_hooks": true,
                "requires_explicit_binding": true, "evidence": "verification/mxc-boundary-2026-11-07/README.md"
            },
            "evidence": "verification/c3-execution-2026-11-07/README.md"
        })),
        "authorizations.list" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Page {
                #[serde(default)]
                offset: usize,
            }
            let a = params::<Page>(input)?;
            store.authorization_list(a.offset)
        }
        "authorizations.get" => {
            let a = params::<Id>(input)?;
            store.authorization_get(&a.id)
        }
        "authorizations.history" => {
            let a = params::<Id>(input)?;
            store.authorization_history(&a.id, a.offset)
        }
        "authorizations.evaluate" => evaluate(store, params::<Evaluation>(input)?),
        _ => Err("授权查询无效。".into()),
    }
}
fn evaluate(store: &Store, a: Evaluation) -> Result<Value, String> {
    if serde_json::to_vec(&a).map_err(|e| e.to_string())?.len() > 8_000 {
        return Err("评估参数过长。".into());
    }
    if !matches!(a.network.as_str(), "none" | "any") {
        return Err("网络范围无效。".into());
    }
    let mut g = store.authorization_get(&a.id)?;
    g.as_object_mut().unwrap().remove("last_evaluation");
    let grant: Grant = params(
        g.as_object()
            .unwrap()
            .iter()
            .filter(|(k, _)| {
                ![
                    "id",
                    "revision",
                    "revoked",
                    "created_at",
                    "updated_at",
                    "actor",
                ]
                .contains(&k.as_str())
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<serde_json::Map<_, _>>()
            .into(),
    )?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let mut decision = "deny";
    let mut reason = "授权范围或执行身份不匹配。".to_owned();
    let mut missing = vec![];
    let mut normalized_target = None;
    let mut mcp = Value::Null;
    let mut sandbox = Value::Null;
    if g["revoked"] == true {
        reason = "授权已撤销。".into();
    } else if grant.expires_at <= now {
        reason = "授权已过期。".into();
    } else if grant.environment == a.environment
        && grant.agent_id == a.agent_id
        && grant.engine_id == a.engine_id
        && grant.workspace_id == a.workspace_id
        && grant.rule_id == a.rule_id
        && (grant.project_ids.is_empty() || !a.project_ids.is_empty())
        && a.project_ids.iter().all(|p| grant.project_ids.contains(p))
    {
        let workspace = store.workspace_path(a.workspace_id)?;
        let members = store.memory_projects(a.agent_id)?;
        if a.project_ids.iter().any(|p| {
            !members
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["slug"] == p.as_str() && r["joined"] == true)
        }) {
            reason = "项目成员资格已变化。".into();
        } else if !grant.operations.contains(&a.operation) {
            decision = "needs_user";
            reason = "此操作超出已授予的操作集合。".into();
        } else if a.network != "none" && grant.network != "any" {
            reason = "此网络范围未获授权。".into();
        } else if grant.purpose == "mcp_call" {
            let checked = mcp_grant_current(store, &g).and_then(|_| {
                mcp_operation_binding(
                    store,
                    &g,
                    &serde_json::to_value(&a.mcp).map_err(|e| e.to_string())?,
                )
            });
            match checked {
                Ok(binding)
                    if a.operation == "call_mcp"
                        && (a.network == "any" || binding["host_access"] == "sandbox") =>
                {
                    if binding["host_access"] == "sandbox" {
                        let server = store
                            .mcp_server(binding["server_id"].as_str().ok_or("MCP 服务无效。")?)?;
                        sandbox = crate::sandbox::stdio_config(&g)?.evidence(
                            Path::new(binding["program"].as_str().ok_or("MCP 程序无效。")?),
                            Path::new(server.config["cwd"].as_str().ok_or("MCP 目录无效。")?),
                        )?;
                    }
                    mcp = binding;
                    decision = "allow";
                    reason = "指定服务修订、工具与完整参数符合当前授权。".into();
                }
                Ok(_) => reason = "MCP 服务操作与网络范围不匹配。".into(),
                Err(error) => reason = error,
            }
        } else if grant.engine_id == "native"
            && grant.purpose == "tool_call"
            && matches!(a.operation.as_str(), "propose_followup" | "request_handoff")
        {
            decision = "allow";
            reason = "预约提议由 Core 绑定当前工作、策略及来源执行，并在提交时重查。".into();
        } else if grant.engine_id == "native"
            && grant.purpose == "tool_call"
            && matches!(a.operation.as_str(), "run_command" | "start_background")
        {
            match crate::sandbox::plan(&g) {
                Ok(plan) => {
                    sandbox = plan;
                    decision = "allow";
                    reason = "已绑定原生隔离运行时，Shell 使用授权目录和网络范围。".into();
                }
                Err(error) => {
                    decision = "needs_user";
                    reason = error;
                    missing.push("shell_containment");
                }
            }
        } else if grant.engine_id != "native"
            || grant.purpose != "tool_call"
            || !matches!(
                a.operation.as_str(),
                "read_file" | "write_file" | "list_directory" | "search_text"
            )
        {
            decision = "needs_user";
            reason = "需要已验证的权限计划与执行能力。".into();
            missing.push("permission_enforcement");
        } else if let Some(raw) = &a.path {
            let roots = if a.operation == "write_file" {
                &grant.write_roots
            } else {
                &grant.read_roots
            };
            match resolved_target(raw, &workspace) {
                Ok(target) => {
                    normalized_target = target.to_str().map(str::to_owned);
                    let checked = roots
                        .iter()
                        .map(|root| {
                            std::fs::canonicalize(root)
                                .ok()
                                .filter(|current| current.as_path() == Path::new(root))
                        })
                        .collect::<Option<Vec<_>>>();
                    if checked
                        .is_some_and(|roots| roots.iter().any(|root| target.starts_with(root)))
                    {
                        decision = "allow";
                        reason = "动作符合当前授权范围，实际派发前须重新核验。".into();
                    } else {
                        reason = "目标超出授权根目录或目录目标已变化。".into();
                    }
                }
                Err(error) => reason = error,
            }
        } else {
            decision = "needs_user";
            reason = "缺少实际目标路径。".into();
        }
    }
    let result = json!({"decision":decision,"reason":reason,"grant_id":a.id,"grant_revision":g["revision"],"executable":false,"effective_scope":g,"missing_capabilities":missing,"required_action":if decision=="allow"{"recheck_at_dispatch"}else{"review_scope"},"evaluation_id":Uuid::new_v4().to_string(),"evaluated_at":now,"action":a,"normalized_target":normalized_target,"mcp":mcp,"sandbox":sandbox});
    store.authorization_record_evaluation(&a.id, g["revision"].as_i64().unwrap(), &result)?;
    Ok(result)
}
