use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct StartExternal {
    client_run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    continuation_of: Option<Continuation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_plan_sha256: Option<String>,
    workspace_id: i64,
    engine_id: String,
    #[serde(default = "default_tool_mode")]
    tool_mode: String,
    authorization_id: String,
    goal: String,
    #[serde(default = "default_agent")]
    agent_id: i64,
    #[serde(default)]
    project_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    office_reference_ids: Vec<String>,
    rule_id: Option<String>,
    #[serde(default = "default_timeout")]
    timeout_seconds: u64,
    #[serde(default = "default_human_wait")]
    human_wait_seconds: u64,
    #[serde(default = "default_startup_timeout")]
    startup_timeout_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    collaboration_mode: Option<String>,
    #[serde(default = "default_approval_mode")]
    approval_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_transport: Option<String>,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Continuation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    interaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    evidence_sha256: Option<String>,
    task_id: i64,
    task_epoch: i64,
    expected_task_revision: i64,
}
fn plan_basis(plan: &Value) -> Value {
    let mut value = json!({"contract_version":1});
    for key in [
        "adapter",
        "required_version",
        "program",
        "program_sha256",
        "grant_id",
        "grant_revision",
        "read_roots",
        "write_roots",
        "read_all",
        "network",
        "scope",
        "extensions",
        "tool_mode",
        "native_tools",
        "native_shell",
        "model_selection",
        "credential_env_keys",
        "approval_mode",
        "human_wait_seconds",
        "startup_timeout_seconds",
        "collaboration_mode",
        "interaction_extension_sha256",
        "native_transport",
        "interaction_capabilities",
    ] {
        value[key] = plan[key].clone();
    }
    if let Some(digest) = plan.get("office_references_sha256") {
        value["office_references_sha256"] = digest.clone();
    }
    value
}
fn default_approval_mode() -> String {
    "preauthorized".into()
}
fn default_human_wait() -> u64 {
    900
}
fn default_startup_timeout() -> u64 {
    60
}
fn default_timeout() -> u64 {
    3600
}
fn default_tool_mode() -> String {
    "native".into()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewExternal {
    id: i64,
    epoch: i64,
    expected_task_revision: i64,
    evidence_sha256: String,
    accepted: bool,
    note: String,
}

pub(crate) fn program_hash(path: &std::path::Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "CLI 程序无法读取。")?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 512 * 1024 * 1024 {
        return Err("CLI 程序超过验证上限。".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    let mut bytes = 0;
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes += n;
        if bytes > 512 * 1024 * 1024 {
            return Err("CLI 程序超过验证上限。".into());
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn default_program(engine: &str) -> Result<PathBuf, String> {
    if engine == "grok" {
        return crate::engines::launcher("grok").ok_or("请先安装 Grok CLI。".into());
    }
    if engine == "opencode" {
        let launcher = crate::engines::launcher("opencode").ok_or("请先安装 OpenCode。")?;
        if launcher
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            return Ok(launcher);
        }
        return launcher
            .parent()
            .ok_or("OpenCode 安装目录无效。")?
            .join("node_modules/opencode-ai/bin/opencode.exe")
            .canonicalize()
            .map_err(|_| "未找到 OpenCode 原生程序。".into());
    }
    if engine == "claude" {
        let launcher = crate::engines::launcher("claude").ok_or("请先安装 Claude Code。")?;
        if launcher
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            return Ok(launcher);
        }
        return launcher
            .parent()
            .ok_or("Claude 安装目录无效。")?
            .join("node_modules/@anthropic-ai/claude-code/bin/claude.exe")
            .canonicalize()
            .map_err(|_| "未找到 Claude 原生程序。".into());
    }
    if engine == "copilot" {
        let launcher = crate::engines::launcher("copilot").ok_or("请先安装 Copilot CLI。")?;
        if launcher
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            return Ok(launcher);
        }
        let platform = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        return launcher.parent().ok_or("CLI 安装目录无效。")?
            .join(format!("node_modules/@github/copilot/node_modules/@github/copilot-win32-{platform}/copilot.exe"))
            .canonicalize().map_err(|_| "未找到 Copilot 原生程序。".into());
    }
    if matches!(engine, "oh-my-pi" | "pi") {
        let launcher = if engine == "pi" { "pi" } else { "omp" };
        return crate::engines::launcher(launcher)
            .ok_or_else(|| format!("请先安装 {engine}。"))
            .and_then(|path| {
                if path
                    .extension()
                    .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
                {
                    Ok(path)
                } else {
                    Err(format!(
                        "当前 {engine} Adapter 需要原生可执行程序，请在启动授权中选择。"
                    ))
                }
            });
    }
    let launcher = crate::engines::launcher("codex").ok_or("请先安装 Codex CLI。")?;
    if launcher
        .extension()
        .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
    {
        return Ok(launcher);
    }
    let (package, target) = if cfg!(target_arch = "aarch64") {
        ("codex-win32-arm64", "aarch64-pc-windows-msvc")
    } else {
        ("codex-win32-x64", "x86_64-pc-windows-msvc")
    };
    launcher.parent().ok_or("CLI 安装目录无效。")?.join(format!("node_modules/@openai/codex/node_modules/@openai/{package}/vendor/{target}/bin/codex.exe")).canonicalize().map_err(|_|"未找到 Codex 原生程序，请在启动授权中选择程序。".into())
}
fn workspace_files(
    root: &std::path::Path,
    plan: &Value,
) -> Result<(BTreeMap<String, Value>, bool), String> {
    let allowed = ["read_roots", "write_roots"]
        .into_iter()
        .flat_map(|key| plan[key].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let whole_workspace =
        plan["read_all"] == true || allowed.iter().any(|path| root.starts_with(path));
    let mut pending = if whole_workspace {
        vec![root.to_path_buf()]
    } else {
        allowed
            .into_iter()
            .filter(|path| path.starts_with(root))
            .collect()
    };
    let mut visited = BTreeSet::new();
    let mut files = BTreeMap::new();
    let mut complete = whole_workspace;
    let mut scanned = 0;
    while let Some(directory) = pending.pop() {
        if !visited.insert(directory.clone()) {
            continue;
        }
        if fs::canonicalize(&directory).ok().as_deref() != Some(directory.as_path())
            || tools::reparse(&directory)?
        {
            complete = false;
            continue;
        }
        for entry in fs::read_dir(directory).map_err(|_| "无法封存工作区证据。")? {
            scanned += 1;
            if scanned > 500 {
                return Ok((files, false));
            }
            let path = entry.map_err(|e| e.to_string())?.path();
            if tools::reparse(&path)? {
                complete = false;
                continue;
            }
            if path
                .file_name()
                .is_some_and(|name| name == ".git" || name == "node_modules")
            {
                complete = false;
                continue;
            }
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "产物越出工作区。")?
                .to_string_lossy()
                .replace('\\', "/");
            if relative.len() > 1000 {
                complete = false;
                continue;
            }
            let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
            if metadata.len() > 8000 {
                complete = false;
                continue;
            }
            let content = tools::bounded_file(&path)?;
            let entry = json!({"path":relative,"sha256":tools::hash(&content),"bytes":content.len(),"text":String::from_utf8(content).ok()});
            files.insert(relative, entry);
            if files.len() >= 100 {
                return Ok((files, false));
            }
        }
    }
    Ok((files, complete))
}

fn pi_model_selection(grant: &Value) -> Result<Value, String> {
    let directory = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".pi/agent"))
        });
    let Some(directory) = directory.and_then(|path| path.canonicalize().ok()) else {
        return Ok(Value::Null);
    };
    let visible = ["read_roots", "write_roots"]
        .into_iter()
        .flat_map(|key| grant[key].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .any(|root| directory.starts_with(root));
    if !visible {
        return Ok(Value::Null);
    }
    if directory.join("models.json").exists() {
        return Err(
            "当前 Pi 隔离接入使用原有内置模型选择与显式环境凭据，尚不能导入自定义 models.json。"
                .into(),
        );
    }
    let file = directory.join("settings.json");
    if !file.exists() {
        return Ok(Value::Null);
    }
    if file.canonicalize().ok().as_deref() != Some(file.as_path()) || tools::reparse(&file)? {
        return Err("Pi 模型选择文件目标已变化。".into());
    }
    let mut text = String::new();
    fs::File::open(&file)
        .and_then(|file| file.take(32_001).read_to_string(&mut text))
        .map_err(|_| "无法读取 Pi 模型选择。")?;
    if text.len() > 32_000 {
        return Err("Pi 模型选择文件超过容量。".into());
    }
    let settings: Value = serde_json::from_str(&text).map_err(|_| "Pi 模型选择文件无效。")?;
    let provider = settings["defaultProvider"]
        .as_str()
        .ok_or("Pi 未配置默认提供方。")?;
    let model = settings["defaultModel"]
        .as_str()
        .ok_or("Pi 未配置默认模型。")?;
    if provider.len() > 100
        || model.len() > 200
        || [provider, model].iter().any(|value| {
            value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control)
        })
    {
        return Err("Pi 默认提供方或模型无效。".into());
    }
    Ok(
        json!({"provider":provider,"model":model,"source":file,"source_sha256":tools::hash(text.as_bytes()),"configuration":"nonsecret_selection_only"}),
    )
}

impl Manager {
    pub(super) fn external_authorized(store: &Store, run: &Value) -> Result<(), String> {
        if let Some(reason) = crate::group_runtime::run_blocker(store, run) {
            return Err(reason);
        }
        crate::engines::require_enabled(run["engine_id"].as_str().unwrap_or_default())?;
        if let Some(sources) = run["memory_snapshot"].get("sources").filter(|_| {
            !run["waiting"]
                .as_array()
                .is_some_and(|waiting| waiting.contains(&json!("review")))
        }) {
            store.memory_delivery_current(
                run["agent_id"].as_i64().ok_or("CLI 身份无效。")?,
                sources,
            )?;
        }
        let grant = store.authorization_get(
            run["authorization_id"]
                .as_str()
                .ok_or("外部执行缺少启动授权。")?,
        )?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs() as i64;
        if grant["revision"] != run["authorization_revision"]
            || grant["revoked"] == true
            || grant["expires_at"].as_i64().unwrap_or(0) <= now
            || grant["purpose"] != "cli_start"
            || grant["engine_id"] != run["engine_id"]
            || grant["agent_id"] != run["agent_id"]
            || grant["workspace_id"] != run["workspace_id"]
            || grant["rule_id"] != run["rule_id"]
            || !grant["operations"]
                .as_array()
                .is_some_and(|ops| ops.contains(&json!("start")))
        {
            return Err("CLI 启动授权已变化、到期或被撤销。".into());
        }
        if run["engine_id"] == "claude" {
            crate::claude::selection(&grant)?;
        }
        if run["engine_id"] == "opencode" {
            crate::opencode::selection(&grant)?;
            crate::opencode::check_ancestors(
                std::path::Path::new(run["workspace"].as_str().ok_or("OpenCode 工作区缺失。")?),
                &grant,
            )?;
        }
        let selected = run["project_ids"].as_array().ok_or("执行项目范围无效。")?;
        let allowed = grant["project_ids"]
            .as_array()
            .ok_or("授权项目范围无效。")?;
        let members = store.memory_projects(run["agent_id"].as_i64().ok_or("执行身份无效。")?)?;
        if (!allowed.is_empty() && selected.is_empty())
            || selected.iter().any(|project| {
                !allowed.contains(project)
                    || !members
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|row| row["slug"] == *project && row["joined"] == true)
            })
        {
            return Err("CLI 项目范围或成员资格已失效。".into());
        }
        let current =
            fs::canonicalize(store.workspace_path(run["workspace_id"].as_i64().unwrap())?)
                .map_err(|_| "工作区不可用。")?;
        if Some(current.as_path()) != run["workspace"].as_str().map(std::path::Path::new) {
            return Err("工作区目标已变化。".into());
        }
        for key in ["read_roots", "write_roots"] {
            for root in grant[key].as_array().ok_or("授权目录无效。")? {
                let raw = root.as_str().ok_or("授权目录无效。")?;
                if fs::canonicalize(raw).ok() != Some(PathBuf::from(raw)) {
                    return Err("授权目录目标已变化。".into());
                }
            }
        }
        Ok(())
    }

    pub(super) fn start_external(
        &mut self,
        store: &mut Store,
        input: Value,
    ) -> Result<Value, String> {
        let request = params::<StartExternal>(input.clone())?;
        if let Some(run) = store.agent_duplicate(&request.client_run_id, &input)? {
            return Ok(json!({"run":public_run(&run,false),"duplicate":true}));
        }
        let (mut run, plan) = self.prepare_external(store, &request)?;
        let basis = plan_basis(&plan);
        let digest = tools::hash(basis.to_string().as_bytes());
        if request
            .expected_plan_sha256
            .as_ref()
            .is_some_and(|expected| expected != &digest)
            || request.continuation_of.is_some() && request.expected_plan_sha256.is_none()
        {
            return Err("权限计划已变化，请重新检查并明确确认。".into());
        }
        run["confirmed_permission_plan_sha256"] = json!(digest);
        run["continuation_of"] = self.continuation_basis(store, &request, &basis)?;
        let text_only = request.tool_mode == "disabled";
        let workspace = PathBuf::from(run["workspace"].as_str().ok_or("工作区无效。")?);
        let goal = format!(
            "{}{}",
            request.goal,
            crate::office::reference_context(&run["office_references"])
        );
        let arguments = json!({"goal":goal,"permission_plan":plan,"timeout_seconds":request.timeout_seconds.to_string()});
        if arguments.to_string().len() > 20_000 {
            return Err("CLI 目标与权限计划的组合超过传输容量。".into());
        }
        let (files, mut complete) = if text_only {
            (BTreeMap::new(), true)
        } else {
            workspace_files(&workspace, &plan)?
        };
        let mut baseline = BTreeMap::new();
        for (path, value) in files {
            baseline.insert(path.clone(), value["sha256"].clone());
            if serde_json::to_vec(&baseline)
                .map_err(|error| error.to_string())?
                .len()
                > 16_000
            {
                baseline.remove(&path);
                complete = false;
                break;
            }
        }
        store.agent_create(&request.client_run_id, &input, &mut run)?;
        let mut invocation = json!({"run_id":run["id"],"epoch":1,"name":"cli.start","arguments":{"engine_id":request.engine_id},"state":"succeeded","approval":true,"result":{},"stopped":true,"reviewed":false});
        store.agent_save(
            &mut run,
            std::slice::from_mut(&mut invocation),
            "cli_accepted",
        )?;
        let mut task = json!({"id":invocation["id"],"owner_run_id":run["id"],"root_run_id":run["id"],"parent_task_id":null,"kind":"external_cli","engine_id":request.engine_id,"state":"queued","epoch":1,"title":request.goal.chars().take(100).collect::<String>(),"arguments":arguments,"permission_plan":plan,"baseline":baseline,"baseline_complete":complete,"completion_id":Uuid::new_v4().to_string(),"consumed":false,"stopped":true,"reviewed":false,"stop_requested":false,"result":null});
        task["continuation_of"] = run["continuation_of"].clone();
        invocation["result"] = json!({"ok":true,"task_id":task["id"]});
        store.agent_commit(
            &mut run,
            std::slice::from_mut(&mut invocation),
            std::slice::from_mut(&mut task),
            None,
            "cli_queued",
        )?;
        Ok(json!({"run":public_run(&run,false),"task_id":task["id"],"duplicate":false}))
    }

    pub(super) fn preview_external(&self, store: &Store, input: Value) -> Result<Value, String> {
        let request = params::<StartExternal>(input)?;
        let (_, plan) = self.prepare_external(store, &request)?;
        let basis = plan_basis(&plan);
        let continuation = self.continuation_basis(store, &request, &basis)?;
        Ok(
            json!({"plan":basis,"plan_sha256":tools::hash(basis.to_string().as_bytes()),"continuation_of":continuation}),
        )
    }

    fn continuation_basis(
        &self,
        store: &Store,
        request: &StartExternal,
        basis: &Value,
    ) -> Result<Value, String> {
        let Some(previous) = &request.continuation_of else {
            return Ok(Value::Null);
        };
        let task = store.owned_task(previous.task_id)?;
        let run = store.agent_run(task["owner_run_id"].as_i64().ok_or("旧作业归属无效。")?)?;
        if request.rule_id.is_some()
            || task["kind"] != "external_cli"
            || task["epoch"] != previous.task_epoch
            || store.execution_revision("task", previous.task_id)?
                != previous.expected_task_revision
            || task["stopped"] != true
            || task["reviewed"] != true
            || tasks::active(&task)
            || self.jobs.contains_key(&previous.task_id)
            || run["workspace_id"] != request.workspace_id
            || run["agent_id"] != request.agent_id
            || run["engine_id"] != request.engine_id
        {
            return Err("先停止并核对同一身份、工作区和引擎的旧作业，再创建关联执行。".into());
        }
        if task["scope_change_interaction_id"].is_string()
            && previous.interaction_id.as_deref() != task["scope_change_interaction_id"].as_str()
        {
            return Err("关联执行需要绑定旧作业的权限变更请求。".into());
        }
        if previous
            .evidence_sha256
            .as_ref()
            .is_some_and(|digest| task["evidence"]["sha256"] != *digest)
        {
            return Err("旧作业证据已变化。".into());
        }
        let interaction = if let Some(id) = &previous.interaction_id {
            let value = store.cli_interaction(id)?;
            if value["task_id"] != previous.task_id || value["task_epoch"] != previous.task_epoch {
                return Err("交互与旧作业身份不匹配。".into());
            }
            value
        } else {
            Value::Null
        };
        let old = plan_basis(&task["permission_plan"]);
        let changes = basis
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, value)| old[*key] != **value)
            .map(|(key, value)| json!({"field":key,"previous":old[key],"requested":value}))
            .collect::<Vec<_>>();
        Ok(
            json!({"run_id":run["id"],"task_id":previous.task_id,"task_epoch":previous.task_epoch,"task_revision":previous.expected_task_revision,"interaction_id":interaction["interaction_id"],"interaction_request_sha256":interaction["request_sha256"],"old_authorization_id":run["authorization_id"],"old_authorization_revision":run["authorization_revision"],"changes":changes,"evidence_sha256":task["evidence"]["sha256"],"reconciliation":task["reconciliation"],"review":task["review"]}),
        )
    }

    pub(super) fn external_start_definition(input: Value) -> Result<Value, String> {
        let request = params::<StartExternal>(input)?;
        crate::engines::require_enabled(&request.engine_id)?;
        serde_json::to_value(request).map_err(|error| error.to_string())
    }

    pub(super) fn external_rule_plan(&self, store: &Store, input: Value) -> Result<Value, String> {
        let request = params::<StartExternal>(input)?;
        self.prepare_external(store, &request).map(|(_, plan)| plan)
    }

    fn prepare_external(
        &self,
        store: &Store,
        request: &StartExternal,
    ) -> Result<(Value, Value), String> {
        crate::engines::require_enabled(&request.engine_id)?;
        let text_only = request.tool_mode == "disabled";
        if request
            .native_transport
            .as_deref()
            .is_some_and(|transport| {
                request.engine_id != "copilot"
                    || request.tool_mode != "native"
                    || !matches!(transport, "acp" | "sdk_questions")
            })
        {
            return Err("当前引擎不支持所选原生交互通道。".into());
        }
        if !matches!(
            (request.engine_id.as_str(), request.tool_mode.as_str()),
            ("codex", "native")
                | ("oh-my-pi", "native" | "disabled")
                | ("pi", "native" | "disabled")
                | ("copilot", "native" | "disabled")
                | ("claude", "native" | "disabled")
                | ("opencode", "native" | "disabled")
                | ("grok", "native" | "disabled")
        ) {
            return Err("此引擎的所选工具模式缺少已验证的接入。".into());
        }
        if !matches!(request.approval_mode.as_str(), "preauthorized" | "manual")
            || request.approval_mode == "manual"
                && (!matches!(
                    request.engine_id.as_str(),
                    "copilot" | "claude" | "opencode" | "pi" | "oh-my-pi"
                ) || request.tool_mode != "native")
        {
            return Err("此引擎与工具模式的人工审批尚未完成接入。".into());
        }
        if !text_ok(&request.goal)
            || Uuid::parse_str(&request.client_run_id).is_err()
            || !(1..=3600).contains(&request.timeout_seconds)
            || !(1..=3600).contains(&request.human_wait_seconds)
            || !(1..=3600).contains(&request.startup_timeout_seconds)
            || request.collaboration_mode.as_deref().is_some_and(|mode| {
                request.engine_id != "codex" || !matches!(mode, "default" | "plan")
            })
        {
            return Err("CLI 目标、标识或执行时限无效。".into());
        }
        if self.live.len() >= 16 {
            return Err("活动执行已达到上限。".into());
        }
        store.memory_agent(request.agent_id)?;
        let workspace = fs::canonicalize(store.workspace_path(request.workspace_id)?)
            .map_err(|_| "工作区不可用。")?;
        let grant = store.authorization_get(&request.authorization_id)?;
        let program = grant["program"]
            .as_str()
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(|| default_program(&request.engine_id))?;
        let mut run = json!({"kind":"external_cli","engine_id":request.engine_id,"state":"queued","epoch":1,"revision":0,"step":0,"intent":null,"workspace_id":request.workspace_id,"workspace":workspace,"agent_id":request.agent_id,"authorization_id":request.authorization_id,"authorization_revision":grant["revision"],"project_ids":request.project_ids,"rule_id":request.rule_id,"goal":request.goal,"pending":[],"history":[],"output":"","model_text":"","waiting":["external_cli"],"error":null,"hook_snapshot":[],"mcp_snapshot":[]});
        Self::external_authorized(store, &run)?;
        run["office_references"] = crate::office::materialize_references(
            store,
            &request.office_reference_ids,
            Some(request.workspace_id),
            Some(&grant),
        )?;
        if request.engine_id == "codex" && grant["network"] == "none" {
            return Err("Codex 0.166.0 的 Windows 原生工具仍可访问本机网络，无法落实网络关闭授权；已阻止启动。请使用具备完整断网能力的执行环境。".into());
        }
        let mut plan = json!({"id":Uuid::new_v4().to_string(),"adapter":"codex-app-server-v1","required_version":"0.166.0","program":program,"program_sha256":program_hash(&program)?,"grant_id":request.authorization_id,"grant_revision":grant["revision"],"read_roots":grant["read_roots"],"write_roots":grant["write_roots"],"read_all":grant["read_all"]==true,"network":grant["network"],"approval_policy":"never","scope":"native_commands_and_file_tools","extensions":"disabled","tool_mode":request.tool_mode});
        if !request.office_reference_ids.is_empty() {
            plan["office_references_sha256"] =
                json!(tools::hash(run["office_references"].to_string().as_bytes()));
        }
        plan["interaction_capabilities"] = crate::engines::interactions(&request.engine_id);
        plan["native_transport"] = json!(request.native_transport);
        plan["approval_mode"] = json!(request.approval_mode);
        plan["human_wait_seconds"] = json!(request.human_wait_seconds);
        plan["startup_timeout_seconds"] = json!(request.startup_timeout_seconds);
        plan["collaboration_mode"] = json!(request.collaboration_mode);
        if text_only
            && !matches!(
                request.engine_id.as_str(),
                "copilot" | "claude" | "opencode" | "grok"
            )
        {
            let (adapter, version) = if request.engine_id == "pi" {
                ("pi-rpc-text-v1", "1.5.0")
            } else {
                ("omp-rpc-text-v1", "18.14.0")
            };
            plan["adapter"] = json!(adapter);
            plan["required_version"] = json!(version);
            plan["scope"] = json!("explicit_text_only");
            plan["read_roots"] = json!([]);
            plan["write_roots"] = json!([]);
            plan["read_all"] = json!(false);
            plan["network"] = json!("none");
        }

        if matches!(request.engine_id.as_str(), "pi" | "oh-my-pi") && !text_only
            || matches!(
                request.engine_id.as_str(),
                "copilot" | "claude" | "opencode" | "grok"
            )
        {
            if grant["read_all"] == true || grant["network"] != "any" {
                return Err("当前整进程隔离能力要求明确目录及统一的模型／工具联网授权。".into());
            }
            troop_mcp::containment::available()?;
            let config = crate::sandbox::stdio_config(&grant)?;
            let runtime_root = grant["write_roots"]
                .as_array()
                .and_then(|roots| roots.first())
                .and_then(Value::as_str)
                .ok_or("原生 CLI 需要已授权的可写目录保存无凭据运行配置。")?;
            plan["engine_runtime_directory"] = json!(PathBuf::from(runtime_root).join(format!(
                ".troop-{}-{}",
                request.engine_id,
                Uuid::new_v4()
            )));
            let pi = request.engine_id == "pi";
            let copilot = request.engine_id == "copilot";
            let claude = request.engine_id == "claude";
            let opencode = request.engine_id == "opencode";
            let grok = request.engine_id == "grok";
            if grok && !text_only {
                let shell = crate::tools::host_shell()?;
                plan["native_shell"] = json!({"program":shell,"program_sha256":program_hash(&shell)?,"selection":"GROK_SHELL=powershell","read_source":"contained_windows_runtime"});
            }
            if (claude || opencode) && !text_only {
                let shell = crate::engines::launcher("pwsh")
                    .ok_or("当前原生 Shell 工具需要已安装的 pwsh。")?;
                let directory = shell.parent().ok_or("PowerShell 程序目录无效。")?;
                let readable = ["read_roots", "write_roots"]
                    .into_iter()
                    .flat_map(|key| grant[key].as_array().into_iter().flatten())
                    .filter_map(Value::as_str)
                    .any(|root| directory.starts_with(root));
                if !readable {
                    return Err(format!(
                        "原生 Shell 需要将程序目录 {} 加入读取授权。",
                        directory.display()
                    ));
                }
                plan["native_shell"] = json!({"program":shell,"program_sha256":program_hash(&shell)?,"read_root":directory});
            }
            plan["model_selection"] = if claude {
                crate::claude::selection(&grant)?
            } else if grok {
                crate::grok::selection()?
            } else if opencode {
                crate::opencode::selection(&grant)?
            } else if copilot {
                crate::copilot::model_selection()?
            } else if pi {
                pi_model_selection(&grant)?
            } else {
                Value::Null
            };
            plan["adapter"] = json!(if claude {
                "claude-stream-contained-v1"
            } else if grok {
                "grok-acp-contained-v1"
            } else if opencode {
                "opencode-acp-contained-v1"
            } else if copilot {
                "copilot-acp-contained-v1"
            } else if pi {
                "pi-rpc-contained-v1"
            } else {
                "omp-rpc-contained-v1"
            });
            plan["required_version"] = json!(if claude {
                "2.1.319"
            } else if grok {
                "1.0.70"
            } else if opencode {
                "1.19.5"
            } else if copilot {
                "1.0.107"
            } else if pi {
                "1.5.0"
            } else {
                "18.14.0"
            });
            plan["scope"] = json!(if text_only {
                "contained_text_process"
            } else {
                "contained_native_process"
            });
            plan["native_tools"] = if grok {
                if text_only {
                    json!([])
                } else {
                    json!(["read_file", "write_file", "edit_file", "shell"])
                }
            } else if claude {
                if text_only {
                    json!([])
                } else {
                    json!(["Read", "Write", "Edit", "PowerShell"])
                }
            } else if opencode {
                if text_only {
                    json!([])
                } else {
                    json!(["read", "write", "edit", "bash"])
                }
            } else if copilot {
                if text_only {
                    json!([])
                } else {
                    json!(["view", "create", "edit", "powershell"])
                }
            } else {
                json!([
                    "read",
                    if pi { "powershell" } else { "bash" },
                    "edit",
                    "write"
                ])
            };
            plan["credential_env_keys"] = grant
                .get("credential_env_keys")
                .cloned()
                .unwrap_or(json!([]));
            if grok && plan["credential_env_keys"].as_array().map(Vec::len) != Some(1) {
                return Err("Grok 需要且仅接受一个明确授权的模型环境凭据引用。".into());
            }
            if copilot
                && plan["credential_env_keys"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|key| {
                        !matches!(
                            key.as_str(),
                            Some("COPILOT_PROVIDER_API_KEY" | "COPILOT_PROVIDER_BEARER_TOKEN")
                        )
                    })
            {
                return Err("Copilot 当前仅接受显式授权的模型 API 环境凭据。".into());
            }
            plan["sandbox"] = config.evidence(&program, &workspace)?;
            plan["sandbox_config"] =
                serde_json::to_value(config).map_err(|error| error.to_string())?;
        }
        if matches!(request.engine_id.as_str(), "pi" | "oh-my-pi")
            && request.approval_mode == "manual"
        {
            plan["extensions"] = json!("bundled_interaction_only");
            plan["interaction_extension_sha256"] =
                json!(tools::hash(crate::pi::INTERACTION_EXTENSION.as_bytes()));
            plan["native_tools"]
                .as_array_mut()
                .unwrap()
                .push(json!("ask_user"));
        }
        if request.native_transport.as_deref() == Some("sdk_questions") {
            plan["native_tools"] = json!(["ask_user"]);
            plan["interaction_capabilities"]["permissions"] = json!("unavailable");
        } else if request.engine_id == "copilot" {
            plan["interaction_capabilities"]["questions"] = json!("unavailable");
        }
        if matches!(request.engine_id.as_str(), "pi" | "oh-my-pi" | "claude")
            && request.approval_mode != "manual"
            || text_only
        {
            plan["interaction_capabilities"]["questions"] = json!("unavailable");
            plan["interaction_capabilities"]["permissions"] = json!("unavailable");
        }
        if plan.to_string().len() > 12_000 {
            return Err("CLI 权限计划超过容量上限。".into());
        }
        Ok((run, plan))
    }

    pub(super) fn pump_external_task(
        &mut self,
        store: &mut Store,
        owner: &mut Value,
        task: &mut Value,
    ) -> Result<(), String> {
        if self.execution.blocked(store)? {
            return Ok(());
        }
        if let Err(reason) = Self::external_authorized(store, owner) {
            task["state"] = json!("failed");
            task["result"] = json!({"ok":false,"error":reason});
            owner["state"] = json!("failed");
            owner["error"] = task["result"]["error"].clone();
            owner["waiting"] = json!([]);
            return store.agent_commit(
                owner,
                &mut [],
                std::slice::from_mut(task),
                None,
                "cli_denied",
            );
        }
        let id = task["id"].as_i64().unwrap();
        let epoch = task["epoch"].as_i64().unwrap();
        let run = owner["id"].as_i64().unwrap();
        if owner["causal_scope"].is_object() && task["permission_plan"]["tool_mode"] != "disabled" {
            match store.causal_write_reserve(
                &owner["causal_scope"],
                "process.exec",
                &format!("cli-task:{id}:{epoch}"),
                run,
            ) {
                Ok(binding) => task["causal_write"] = binding,
                Err(error) => {
                    task["state"] = json!("failed");
                    task["stopped"] = json!(true);
                    task["result"] = json!({"ok":false,"error":error});
                    owner["causal_limit_state"] = json!("needs_attention");
                    owner["state"] = json!("failed");
                    owner["error"] = task["result"]["error"].clone();
                    owner["waiting"] = json!([]);
                    return store.agent_commit(
                        owner,
                        &mut [],
                        std::slice::from_mut(task),
                        None,
                        "causal_cli_blocked",
                    );
                }
            }
        }
        let context = context::ContextPipeline::new(vec![Arc::new(context::MemoryContext)])
            .build(store, owner)?;
        task["arguments"]["context"] = json!(context);
        task["context_delivery"] = json!({"state":"prepared","sources":owner["memory_snapshot"]["sources"],"sha256":tools::hash(task["arguments"]["context"].to_string().as_bytes()),"adoption":"unproven"});
        owner["attempt"] = json!(format!("cli-{id}-{epoch}"));
        task["execution_deadline"] = json!(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs()
                + task["arguments"]["timeout_seconds"]
                    .as_str()
                    .and_then(|s| s.parse::<u64>().ok())
                    .ok_or("执行时限无效。")?
        );
        task["state"] = json!("dispatched");
        task["stopped"] = json!(false);
        owner["state"] = json!("waiting");
        let execution = ExecutionOwner::new(run, epoch, ExecutionWork::Task(id));
        if self
            .execution
            .dispatch(store, |store| {
                store.agent_commit(
                    owner,
                    &mut [],
                    std::slice::from_mut(task),
                    None,
                    "cli_dispatched",
                )?;
                Ok(execution)
            })?
            .is_none()
        {
            return Ok(());
        }
        let mut arguments = task["arguments"].clone();
        arguments["workspace"] = owner["workspace"].clone();
        arguments["client_directory"] = json!(self.receipts.join(format!("cli-{id}-{epoch}")));
        let work = tools::Work {
            sandbox: Value::Null,
            id,
            epoch,
            workspace: owner["workspace"].as_str().unwrap().into(),
            name: "external_cli".into(),
            arguments,
            receipt: self.receipts.join(format!("task-{id}-{epoch}.json")),
            job_handle: 0,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        self.jobs.insert(
            id,
            TaskLive {
                cancel: cancel.clone(),
                external: true,
            },
        );
        let updates = self.sender.clone();
        std::thread::spawn(move || {
            let ready = updates.clone();
            let progress = updates.clone();
            let interaction = updates.clone();
            let result = tools::execute_with_interactions(
                work,
                cancel,
                move |gate| {
                    let _ = ready.blocking_send(Update::TaskReady(id, epoch, gate));
                },
                move |output| {
                    let _ = progress.blocking_send(Update::TaskOutput(id, epoch, output));
                },
                move |request, sender| {
                    let _ = interaction
                        .blocking_send(Update::TaskInteraction(id, epoch, request, sender));
                },
            );
            let _ = updates.blocking_send(Update::TaskDone(id, epoch, result));
        });
        Ok(())
    }

    pub(super) fn finish_external(
        store: &mut Store,
        owner: &mut Value,
        task: &mut Value,
        result: Value,
    ) -> Result<(), String> {
        Self::merge_interaction_deliveries(store, task, owner, &result)?;
        owner["_cli_close_task"] = task["id"].clone();
        task["result"] = result.clone();
        task["stopped"] = result["stopped"].clone();
        owner["waiting"] = json!([]);
        if result["stopped"] != true || result["indeterminate"] == true {
            task["state"] = json!("indeterminate");
            owner["state"] = json!("interrupted");
            let reason = owner["error"].as_str().unwrap_or("");
            owner["error"] = json!(format!("{reason} CLI 效果或停止结果需要核对。").trim());
        } else if !owner["intent"].is_null() || task["stop_requested"] == true {
            task["state"] = json!("cancelled");
        } else if result["ok"] == true && result["value"]["turn_status"] == "completed" {
            let text_only = task["permission_plan"]["tool_mode"] == "disabled";
            let captured = if text_only {
                Ok((BTreeMap::new(), true))
            } else {
                workspace_files(
                    std::path::Path::new(owner["workspace"].as_str().unwrap()),
                    &task["permission_plan"],
                )
            };
            let (files, complete, sealing_error) = match captured {
                Ok((files, complete)) => (files, complete, None),
                Err(reason) => (BTreeMap::new(), false, Some(reason)),
            };
            let mut bytes = 0;
            let mut artifacts = Vec::new();
            let mut deleted_files = Vec::new();
            let mut coverage = complete
                && task["baseline_complete"] == true
                && result["value"]["text_truncated"] != true
                && result["value"]["tool_metadata_complete"] != false
                && result["value"]["tool_calls_truncated"] != true;
            for (path, previous_sha256) in task["baseline"].as_object().ok_or("CLI 基线无效。")?
            {
                if files.contains_key(path) {
                    continue;
                }
                match fs::symlink_metadata(
                    PathBuf::from(owner["workspace"].as_str().unwrap()).join(path),
                ) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        let deleted = json!({"path":path,"previous_sha256":previous_sha256});
                        bytes += deleted.to_string().len();
                        if bytes > 16_000 {
                            coverage = false;
                            break;
                        }
                        deleted_files.push(deleted);
                    }
                    Err(_) => coverage = false,
                    Ok(metadata) if !metadata.is_file() => coverage = false,
                    Ok(_) => {}
                }
            }
            for (path, file) in files {
                if task["baseline"][&path] == file["sha256"] {
                    continue;
                }
                bytes += file.to_string().len();
                if bytes > 16_000 {
                    coverage = false;
                    break;
                }
                artifacts.push(file);
            }
            let evidence = json!({"task_id":task["id"],"epoch":task["epoch"],"result":result["value"],"permission_plan":task["permission_plan"],"context_delivery":task["context_delivery"],"artifacts":artifacts,"deleted_files":deleted_files,"coverage_complete":coverage,"sealing_error":sealing_error,"coverage":if text_only{"explicit_text_only"}else{"authorized_workspace_files_up_to_8KB_and_500_entries"},"sealed_at_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()});
            task["evidence"] = evidence;
            task["evidence"]["snapshot_source"] = json!(if task["receipt_reconciled"] == true {
                "current_workspace_after_receipt_reconciliation"
            } else {
                "workspace_after_managed_stop"
            });
            let digest = tools::hash(task["evidence"].to_string().as_bytes());
            task["evidence"]["sha256"] = json!(digest);
            task["state"] = json!("awaiting_review");
            owner["state"] = json!("waiting");
            owner["waiting"] = json!(["review"]);
            owner["output"] = result["value"]["text"].clone();
        } else {
            task["state"] = json!("failed");
            owner["state"] = json!("failed");
            owner["error"] = if result["error"].is_null() {
                json!({"message":"CLI 未正常完成。","turn_status":result["value"]["turn_status"],"error_info":result["value"]["error_info"]})
            } else {
                result["error"].clone()
            };
        }
        store.agent_commit(
            owner,
            &mut [],
            std::slice::from_mut(task),
            None,
            "cli_finished",
        )
    }

    pub(super) fn review_external(&self, store: &mut Store, input: Value) -> Result<Value, String> {
        let request = params::<ReviewExternal>(input)?;
        let mut task = store.owned_task(request.id)?;
        let mut run =
            store.agent_run(task["owner_run_id"].as_i64().ok_or("作业缺少执行归属。")?)?;
        if task["kind"] != "external_cli"
            || task["state"] != "awaiting_review"
            || task["stopped"] != true
            || task["epoch"] != request.epoch
            || store.execution_revision("task", request.id)? != request.expected_task_revision
            || task["evidence"]["sha256"] != request.evidence_sha256
            || request.note.trim().is_empty()
            || request.note.len() > 2000
            || !run["intent"].is_null()
        {
            return Err("结果证据、作业版本或审核状态已变化。".into());
        }
        task["reviewed"] = json!(true);
        task["review"] = json!({"accepted":request.accepted,"note":request.note,"evidence_sha256":request.evidence_sha256});
        task["state"] = json!(if request.accepted {
            "succeeded"
        } else {
            "failed"
        });
        task["consumed"] = json!(true);
        run["state"] = json!(if request.accepted {
            "completed"
        } else {
            "failed"
        });
        run["waiting"] = json!([]);
        let structured = serde_json::from_str::<Value>(
            task["evidence"]["result"]["text"].as_str().unwrap_or(""),
        )
        .ok();
        if request.accepted
            && structured.as_ref().is_some_and(|value| {
                value.get("troop_followup").is_some() || value.get("troop_handoff").is_some()
            })
        {
            run["followup_bridge"] = json!({"state":"pending","evidence_sha256":task["evidence"]["sha256"],"task_id":task["id"]});
        }
        store.agent_commit(
            &mut run,
            &mut [],
            std::slice::from_mut(&mut task),
            None,
            "cli_reviewed",
        )?;
        Ok(json!({"accepted":true,"task_id":task["id"],"run_id":run["id"]}))
    }
}
