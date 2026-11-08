//! Native Codex app-server transport inside the already admitted Windows Worker.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

struct Native {
    child: Child,
    input: ChildStdin,
    messages: mpsc::Receiver<Result<Value, String>>,
    text: String,
    thread: Option<String>,
    turn: Option<String>,
    completed: Option<Value>,
    blocked: Vec<String>,
    commands: Vec<Value>,
    commands_bytes: usize,
    commands_truncated: bool,
    last_progress: Instant,
}
impl Drop for Native {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Native {
    fn send(&mut self, value: Value) -> Result<(), String> {
        writeln!(self.input, "{value}")
            .and_then(|_| self.input.flush())
            .map_err(|_| "Codex 原生通道已关闭。".into())
    }
    fn receive(&mut self, deadline: Instant) -> Result<Value, String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("Codex 原生请求超时。")?;
        self.messages
            .recv_timeout(remaining)
            .map_err(|_| "Codex 原生请求超时或连接已断开。".to_string())?
    }
    fn event(&mut self, value: &Value) -> Result<(), String> {
        if value["id"].is_number() || value["id"].is_string() {
            if let Some(method) = value["method"].as_str() {
                if method == "item/tool/requestUserInput"
                    && self.thread.as_deref() == value["params"]["threadId"].as_str()
                    && self.turn.as_deref() == value["params"]["turnId"].as_str()
                {
                    let reply = crate::tools::interaction(
                        json!({"kind":"question","native_request_id":value["id"],"native_session_id":self.thread,"native_turn_id":self.turn,"body":{"questions":value["params"]["questions"]}}),
                        crate::tools::interaction_deadline(),
                    )?;
                    if let Some(reason) = reply["error"].as_str() {
                        return Err(reason.to_owned());
                    }
                    if reply["native_request_id"] != value["id"] {
                        return Err("问题回应身份不匹配。".into());
                    }
                    let mut answers = serde_json::Map::new();
                    for (key, selected) in reply["answer"]["answers"]
                        .as_object()
                        .ok_or("问题答案无效。")?
                    {
                        answers.insert(key.clone(), json!({"answers":selected}));
                    }
                    self.send(json!({"id":value["id"],"result":{"answers":answers}}))?;
                    crate::cli_process::interaction_written(&reply["interaction_id"]);
                    return Ok(());
                }
                if matches!(
                    method,
                    "item/commandExecution/requestApproval"
                        | "item/fileChange/requestApproval"
                        | "item/permissions/requestApproval"
                ) && self.thread.as_deref() == value["params"]["threadId"].as_str()
                    && self.turn.as_deref() == value["params"]["turnId"].as_str()
                {
                    let reply = crate::tools::interaction(
                        json!({"kind":"permission","native_request_id":value["id"],"native_session_id":self.thread,"native_turn_id":self.turn,"body":{"tool_name":method,"tool_call":{"rawInput":value["params"]},"options":[{"optionId":"accept","kind":"allow_once","name":"允许一次"},{"optionId":"decline","kind":"reject_once","name":"拒绝"}],"scope_reason":"原生批准可能触发脱离沙箱的重试，需要先停止、核对并重新授权。"}}),
                        crate::tools::interaction_deadline(),
                    )?;
                    if let Some(error) = reply["error"].as_str() {
                        return Err(error.to_owned());
                    }
                    if reply["native_request_id"] != value["id"]
                        || reply["answer"]["option_id"] != "decline"
                    {
                        return Err("Codex 原生扩权需要新的明确授权与执行。".into());
                    }
                    let response = if method == "item/permissions/requestApproval" {
                        json!({"permissions":{},"scope":"turn"})
                    } else {
                        json!({"decision":"decline"})
                    };
                    self.send(json!({"id":value["id"],"result":response}))?;
                    crate::cli_process::interaction_written(&reply["interaction_id"]);
                    return Ok(());
                }
                if self.blocked.len() >= 16 {
                    return Err("Codex 原生交互超过当前接入能力。".into());
                }
                self.blocked.push(method.chars().take(120).collect());
                self.send(json!({"id":value["id"],"error":{"code":-32001,"message":"TROOP requires a supported, explicitly authorized interaction"}}))?;
            }
        }
        let params = &value["params"];
        if params["threadId"].as_str() != self.thread.as_deref() {
            return Ok(());
        }
        if value["method"] == "item/completed"
            && params["item"]["type"] == "commandExecution"
            && self
                .turn
                .as_deref()
                .is_none_or(|turn| params["turnId"] == turn)
        {
            let item = &params["item"];
            let command = item["command"].as_str().unwrap_or("");
            let entry = json!({"id":item["id"].as_str().unwrap_or("").chars().take(80).collect::<String>(),
                "command":command.chars().take(500).collect::<String>(),"command_sha256":crate::tools::hash(command.as_bytes()),
                "command_truncated":command.chars().count()>500,"exit_code":item["exitCode"].as_i64(),
                "status":item["status"].as_str().unwrap_or("").chars().take(40).collect::<String>()});
            self.commands_bytes += entry.to_string().len();
            if self.commands_bytes <= 6000 {
                self.commands.push(entry);
            } else {
                self.commands_truncated = true;
            }
        }
        if value["method"] == "item/agentMessage/delta" {
            if let Some(turn) = self.turn.as_deref() {
                if params["turnId"] != turn {
                    return Ok(());
                }
            }
            if let Some(delta) = params["delta"].as_str() {
                for character in delta.chars() {
                    if self.text.len() + character.len_utf8() > 12_000 {
                        break;
                    }
                    self.text.push(character);
                }
                if self.last_progress.elapsed() >= Duration::from_millis(150) {
                    println!("{}", json!({"progress":{"text":self.text}}));
                    let _ = std::io::stdout().flush();
                    self.last_progress = Instant::now();
                }
            }
        }
        if value["method"] == "turn/completed"
            && self
                .turn
                .as_deref()
                .is_none_or(|turn| params["turn"]["id"] == turn)
        {
            self.completed = Some(params["turn"].clone());
        }
        Ok(())
    }
    fn request(
        &mut self,
        id: i64,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<Value, String> {
        self.send(json!({"id":id,"method":method,"params":params}))?;
        loop {
            let value = self.receive(deadline)?;
            if value["id"] == id && value["method"].is_null() {
                if !value["error"].is_null() {
                    return Err(format!(
                        "Codex 拒绝 {method}，请检查原生权限配置或模型服务（错误码 {}）。",
                        value["error"]["code"]
                    ));
                }
                return Ok(value["result"].clone());
            }
            self.event(&value)?;
        }
    }
}

pub(crate) fn perform(workspace: &str, args: &Value) -> Result<Value, String> {
    let plan = &args["permission_plan"];
    let program = Path::new(plan["program"].as_str().ok_or("CLI 程序身份缺失。")?);
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let _program_guard = options
        .open(program)
        .map_err(|_| "CLI 程序正在变化或无法锁定。")?;
    if program.canonicalize().ok().as_deref() != Some(program)
        || crate::agent::external::program_hash(program)? != plan["program_sha256"]
    {
        return Err("CLI 程序身份已变化，未启动。".into());
    }
    let mut version_command = Command::new(program);
    version_command.arg("--version");
    let version = crate::tools::command(version_command, 5, false, None)?;
    if version["exit_code"] != 0
        || version["stdout"].as_str().map(str::trim) != Some("codex-cli 0.166.0")
    {
        return Err("当前 Codex 版本尚未匹配已验证的权限与协议契约。".into());
    }
    let mut command = Command::new(program);
    command
        .current_dir(workspace)
        .arg("app-server")
        .args(["--listen", "stdio://"]);
    let disabled = [
        "hooks",
        "apps",
        "plugins",
        "remote_plugin",
        "plugin_discovery_prefetch",
        "multi_agent",
        "multi_agent_v2",
        "js_repl",
        "shell_snapshot",
        "browser_use",
        "computer_use",
    ];
    for feature in disabled {
        command.args(["-c", &format!("features.{feature}=false")]);
    }
    command.args([
        "-c",
        "notify=[]",
        "-c",
        "web_search=\"disabled\"",
        "-c",
        "allow_login_shell=false",
    ]);
    // A delegated CLI owns its own session and must not inherit the host's IPC
    // endpoints or task identities. Preserve its explicit home and model key.
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("CODEX_") && !matches!(name.as_ref(), "CODEX_HOME" | "CODEX_API_KEY") {
            command.env_remove(key);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Codex 原生进程启动失败。")?;
    let input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (sender, messages) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut output = BufReader::new(output);
        loop {
            let mut line = String::new();
            match output.by_ref().take(65_537).read_line(&mut line) {
                Ok(0) => break,
                Ok(_) if line.len() <= 65_536 && line.ends_with('\n') => {
                    let value = serde_json::from_str(&line)
                        .map_err(|_| "Codex 返回无效的协议帧。".to_owned());
                    if sender.send(value).is_err() {
                        break;
                    }
                }
                _ => {
                    let _ = sender.send(Err("Codex 协议帧超过容量或读取失败。".into()));
                    break;
                }
            }
        }
    });
    let mut native = Native {
        child,
        input,
        messages,
        text: String::new(),
        thread: None,
        turn: None,
        completed: None,
        blocked: Vec::new(),
        commands: Vec::new(),
        commands_bytes: 0,
        commands_truncated: false,
        last_progress: Instant::now(),
    };
    let timeout = args["timeout_seconds"]
        .as_str()
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|seconds| (1..=3600).contains(seconds))
        .ok_or("CLI 执行时限无效。")?;
    let end = Instant::now() + Duration::from_secs(timeout);
    let startup = end.min(
        Instant::now()
            + Duration::from_secs(plan["startup_timeout_seconds"].as_u64().unwrap_or(60)),
    );
    native.request(1,"initialize",json!({"clientInfo":{"name":"troop","title":"TROOP","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),startup)?;
    native.send(json!({"method":"initialized"}))?;
    let configuration = native.request(
        2,
        "config/read",
        json!({"cwd":workspace,"includeLayers":false}),
        startup,
    )?;
    let profile = format!(
        "troop_{}",
        plan["id"]
            .as_str()
            .ok_or("权限计划身份无效。")?
            .replace('-', "")
    );
    let mut filesystem = BTreeMap::new();
    filesystem.insert(
        if plan["read_all"] == true {
            ":root"
        } else {
            ":minimal"
        }
        .to_string(),
        json!("read"),
    );
    for (key, access) in [("read_roots", "read"), ("write_roots", "write")] {
        for root in plan[key].as_array().ok_or("权限计划目录无效。")? {
            let path = root.as_str().ok_or("权限计划目录无效。")?;
            if Path::new(path).canonicalize().ok().as_deref() != Some(Path::new(path)) {
                return Err("权限目录目标已变化。".into());
            }
            filesystem.insert(path.to_owned(), json!(access));
        }
    }
    let mut overrides = json!({"notify":[],"web_search":"disabled","allow_login_shell":false,"project_doc_max_bytes":0});
    for feature in disabled {
        overrides[format!("features.{feature}")] = json!(false);
    }
    overrides[format!("permissions.{profile}.filesystem")] = json!(filesystem);
    overrides[format!("permissions.{profile}.network.enabled")] = json!(plan["network"] == "any");
    overrides["default_permissions"] = json!(profile);
    if let Some(servers) = configuration["config"]["mcp_servers"].as_object() {
        for name in servers.keys() {
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            {
                return Err("MCP 配置名称无法安全覆盖，未提交目标。".into());
            }
            overrides[format!("mcp_servers.{name}.enabled")] = json!(false);
        }
    }
    let thread=native.request(3,"thread/start",json!({"cwd":workspace,"runtimeWorkspaceRoots":[workspace],"permissions":profile,"approvalPolicy":"never","ephemeral":true,"config":overrides}),startup)?;
    if thread["activePermissionProfile"]["id"] != profile || thread["approvalPolicy"] != "never" {
        return Err("Codex 未确认所请求的权限计划，未提交目标。".into());
    }
    native.thread = Some(
        thread["thread"]["id"]
            .as_str()
            .ok_or("Codex 缺少会话身份。")?
            .to_owned(),
    );
    let execution = (|| -> Result<Value, String> {
        let mut turn_params = json!({"threadId":native.thread,"input":[{"type":"text","text":crate::cli_process::task_prompt(args)}],"permissions":profile,"approvalPolicy":"never"});
        if let Some(mode) = plan["collaboration_mode"].as_str() {
            turn_params["collaborationMode"] = json!({"mode":mode,"settings":{"model":thread["model"],"developer_instructions":null}});
        }
        let turn = native.request(4, "turn/start", turn_params, end)?;
        native.turn = Some(
            turn["turn"]["id"]
                .as_str()
                .ok_or("Codex 缺少执行身份。")?
                .to_owned(),
        );
        while native.completed.is_none() {
            let event = native.receive(end)?;
            native.event(&event)?;
        }
        let completed = native.completed.as_ref().unwrap();
        if completed["id"].as_str() != native.turn.as_deref() {
            return Err("Codex 完成回执与当前执行不匹配。".into());
        }
        if completed["error"]["message"]
            .as_str()
            .is_some_and(|message| message.starts_with("failed to load workspace requirements:"))
        {
            return Err("Codex 原生工作区策略加载失败，请检查当前账户与原生服务配置。".into());
        }
        if plan["collaboration_mode"] == "plan"
            && completed["status"] == "completed"
            && !native.text.trim().is_empty()
        {
            let digest = crate::tools::hash(native.text.as_bytes());
            let reply = crate::tools::interaction(
                json!({"source":"host_plan_confirmation","kind":"plan","native_request_id":format!("plan-confirmation-{}",native.turn.as_deref().unwrap_or("")),"native_session_id":native.thread,"native_turn_id":native.turn,"body":{"text":native.text,"sha256":digest,"version":1}}),
                crate::tools::interaction_deadline(),
            )?;
            if let Some(error) = reply["error"].as_str() {
                return Err(error.to_owned());
            }
            if reply["answer"]["kind"] != "plan" || reply["answer"]["plan_sha256"] != digest {
                return Err("Codex 计划确认身份不匹配。".into());
            }
            crate::tools::record_interaction_delivery(&reply["interaction_id"], true);
            println!(
                "{}",
                json!({"progress":{"interaction_host_ack":reply["interaction_id"]}})
            );
            let _ = std::io::stdout().flush();
            if reply["answer"]["accepted"] != true {
                return Err("用户拒绝了本次计划，请核对已有执行效果。".into());
            }
        }
        Ok(
            json!({"exit_code":0,"turn_status":completed["status"],"error_info":completed["error"]["codexErrorInfo"],"text":native.text,"thread_id":native.thread,"turn_id":native.turn,"permission_profile":profile,"version":"0.166.0","model":thread["model"],"blocked_interactions":native.blocked,"commands":native.commands,"commands_truncated":native.commands_truncated}),
        )
    })();
    execution.or_else(|error|Ok(json!({"exit_code":1,"turn_status":"failed","effect_unknown":true,"runtime_error":error,"text":native.text,"thread_id":native.thread,"turn_id":native.turn})))
}
