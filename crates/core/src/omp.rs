//! OMP RPC inside an admitted Worker, with explicit text or contained native tools.
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::Command,
    sync::mpsc,
    time::{Duration, Instant},
};

struct Session {
    child: crate::cli_process::Process,
    input: Box<dyn Write + Send>,
    native: bool,
    manual: bool,
    session_id: String,
    invoked: bool,
    tools: crate::cli_process::ToolEvidence,
    messages: mpsc::Receiver<Result<Value, String>>,
    text: String,
    text_truncated: bool,
    unsafe_activity: bool,
    last_progress: Instant,
    prompt_result: Option<Value>,
    settled: bool,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.child.kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.child.stopped() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Session {
    fn send(&mut self, value: Value) -> Result<(), String> {
        writeln!(self.input, "{value}")
            .and_then(|_| self.input.flush())
            .map_err(|_| "OMP 原生通道已关闭。".into())
    }
    fn receive(&self, deadline: Instant) -> Result<Value, String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("OMP 原生请求超时。")?;
        self.messages
            .recv_timeout(remaining)
            .map_err(|_| "OMP 原生请求超时或连接已断开。".to_string())?
    }
    fn event(&mut self, value: &Value) -> Result<(), String> {
        if value["type"] == "extension_ui_request"
            && matches!(
                value["method"].as_str(),
                Some("notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text")
            )
        {
            return Ok(());
        }
        if value["type"] == "extension_ui_request" && self.manual && self.invoked {
            let response = crate::cli_process::rpc_interaction(value, &self.session_id)?;
            self.send(response["native_response"].clone())?;
            crate::cli_process::interaction_written(&response["interaction_id"]);
            return Ok(());
        }
        match value["type"].as_str() {
            Some("tool_execution_start")
                if self.native
                    && matches!(
                        value["toolName"].as_str(),
                        Some("read" | "write" | "edit" | "bash" | "ask_user")
                    ) =>
            {
                self.tools.record(value)?
            }
            Some("tool_execution_end") if self.native => self.tools.record(value)?,
            Some(
                "tool_execution_start"
                | "host_tool_call"
                | "host_uri_request"
                | "extension_ui_request"
                | "subagent_lifecycle",
            ) => {
                self.unsafe_activity = true;
                return Err("OMP 在工具关闭模式报告了额外执行活动。".into());
            }
            Some("rpc_frame_error" | "extension_error") => {
                return Err("OMP 原生协议或扩展状态异常。".into())
            }
            Some("message_update") if value["assistantMessageEvent"]["type"] == "text_delta" => {
                if let Some(delta) = value["assistantMessageEvent"]["delta"]
                    .as_str()
                    .filter(|_| !self.text_truncated)
                {
                    for character in delta.chars() {
                        if self.text.len() + character.len_utf8() > 12_000 {
                            self.text_truncated = true;
                            break;
                        }
                        self.text.push(character);
                    }
                    if self.last_progress.elapsed() >= Duration::from_millis(150) {
                        println!(
                            "{}",
                            json!({"progress":{"text":self.text,"text_truncated":self.text_truncated}})
                        );
                        let _ = std::io::stdout().flush();
                        self.last_progress = Instant::now();
                    }
                }
            }
            Some("prompt_result") if value["id"] == "troop-prompt" => {
                self.settled = value["sessionSettled"] == true;
                self.prompt_result = Some(value.clone());
            }
            Some("session_settled") if self.prompt_result.is_some() => self.settled = true,
            _ => {}
        }
        Ok(())
    }
    fn request(
        &mut self,
        id: &str,
        command: &str,
        fields: Value,
        deadline: Instant,
    ) -> Result<Value, String> {
        let mut input = fields;
        input["id"] = json!(id);
        input["type"] = json!(command);
        self.send(input)?;
        loop {
            let value = self.receive(deadline)?;
            if value["type"] == "response" && value["id"] == id {
                if value["command"] != command || value["success"] != true {
                    return Err(format!("OMP 未接受 {command} 请求。"));
                }
                return Ok(value["data"].clone());
            }
            self.event(&value)?;
        }
    }
}
fn confirm_tools(state: &Value, native: bool, manual: bool) -> Result<(), String> {
    let expected = if manual {
        &["read", "write", "edit", "bash", "ask_user"][..]
    } else if native {
        &["read", "write", "edit", "bash"][..]
    } else {
        &[][..]
    };
    if !state["dumpTools"].as_array().is_some_and(|tools| {
        tools.len() == expected.len()
            && expected
                .iter()
                .all(|name| tools.iter().any(|tool| tool["name"] == *name))
    }) {
        return Err("OMP 未确认工具集合为空，未接受当前能力状态。".into());
    }
    if state["isSettled"] != true
        || state["hasPendingAsyncWork"] != false
        || state["isStreaming"] != false
    {
        return Err("OMP 尚有活动或后台工作。".into());
    }
    Ok(())
}
pub(crate) fn perform(args: &Value) -> Result<Value, String> {
    let plan = &args["permission_plan"];
    let native = plan["tool_mode"] == "native";
    let manual = plan["approval_mode"] == "manual";
    if !native && plan["tool_mode"] != "disabled" {
        return Err("OMP 工具模式无效。".into());
    }
    let sandbox: Option<troop_mcp::containment::Config> = if native {
        Some(
            serde_json::from_value(plan["sandbox_config"].clone())
                .map_err(|_| "OMP 隔离计划缺失。")?,
        )
    } else {
        None
    };
    let runtime = if native {
        let path = Path::new(
            plan["engine_runtime_directory"]
                .as_str()
                .ok_or("OMP 运行目录缺失。")?,
        );
        fs::create_dir(path).map_err(|_| "无法创建 OMP 单次运行目录。")?;
        Some(troop_mcp::program::execution_path(
            path.to_str().ok_or("OMP 运行目录编码无效。")?,
        ))
    } else {
        None
    };
    let program = Path::new(plan["program"].as_str().ok_or("OMP 程序身份缺失。")?);
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let _program_guard = options
        .open(program)
        .map_err(|_| "OMP 程序正在变化或无法锁定。")?;
    if program.canonicalize().ok().as_deref() != Some(program)
        || crate::agent::external::program_hash(program)? != plan["program_sha256"]
    {
        return Err("OMP 程序身份已变化，未启动。".into());
    }
    let mut version = Command::new(program);
    version.arg("--version");
    if let Some(policy) = &sandbox {
        let runtime = runtime.as_ref().unwrap();
        version
            .current_dir(args["workspace"].as_str().ok_or("OMP 工作区缺失。")?)
            .env("PI_NATIVES_DIR", Path::new(runtime).join("natives"))
            .env("HOME", runtime)
            .env("USERPROFILE", runtime);
        crate::cli_process::confirm_version(version, policy, "omp/18.14.0")?;
    } else {
        let checked = crate::tools::command(version, 5, false, None)?;
        if checked["exit_code"] != 0
            || checked["stdout"].as_str().map(str::trim) != Some("omp/18.14.0")
        {
            return Err("当前 OMP 版本尚未匹配已验证的 RPC 契约。".into());
        }
    }
    let directory = Path::new(
        args["client_directory"]
            .as_str()
            .ok_or("OMP 隔离目录缺失。")?,
    );
    fs::create_dir(directory).map_err(|_| "无法创建 OMP 单次隔离目录。")?;
    let configuration = runtime
        .as_ref()
        .map(Path::new)
        .unwrap_or(directory)
        .join("session-config.json");
    fs::write(&configuration,json!({"memory":{"backend":"off"},"advisor":{"enabled":false},"prewalk":{"enabled":false,"auto":false},"git":{"enabled":false},"collab":{"autoStart":false},"mcp":{"enableProjectConfig":false},"bash":{"autoBackground":{"enabled":false}}}).to_string()).map_err(|_|"无法准备 OMP 单次配置。")?;
    let mut command = Command::new(program);
    command
        .current_dir(if native {Path::new(args["workspace"].as_str().ok_or("OMP 工作区缺失。")?)}else{directory})
        .args([
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-rules",
            "--no-lsp",
            "--no-pty",
            "--no-context-files",
            "--no-title",
            "--no-prewalk",
            "--system-prompt",
            if native {"You are a delegated assistant. Complete the task within the host's enforced execution scope."}else{"You are a delegated text-only assistant. Use only the task text supplied by the host."},
            "--config",
        ])
        .arg(configuration);
    if !manual {
        command.arg("--no-ui");
    }
    if let Some(runtime) = &runtime {
        if manual {
            let extension = Path::new(runtime).join("troop-interaction.mjs");
            if plan["interaction_extension_sha256"]
                != crate::tools::hash(crate::pi::INTERACTION_EXTENSION.as_bytes())
            {
                return Err("OMP 交互扩展身份已变化。".into());
            }
            fs::write(&extension, crate::pi::INTERACTION_EXTENSION)
                .map_err(|_| "无法准备 OMP 交互扩展。")?;
            command.arg("--extension").arg(&extension);
        }
        command
            .args([
                "--tools",
                if manual {
                    "read,write,edit,bash,ask_user"
                } else {
                    "read,write,edit,bash"
                },
                "--approval-mode",
                "yolo",
            ])
            .env("PI_CODING_AGENT_DIR", Path::new(runtime).join("agent"))
            .env("PI_NATIVES_DIR", Path::new(runtime).join("natives"))
            .env("HOME", runtime)
            .env("USERPROFILE", runtime)
            .env("TEMP", runtime)
            .env("TMP", runtime);
        for key in plan["credential_env_keys"]
            .as_array()
            .ok_or("OMP 凭据引用计划缺失。")?
        {
            let key = key.as_str().ok_or("OMP 凭据引用无效。")?;
            let value = std::env::var(key)
                .ok()
                .filter(|value| !value.is_empty())
                .ok_or("OMP 已授权的凭据环境变量不可用。")?;
            command.env(key, value);
        }
    } else {
        command.arg("--no-tools");
    }
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("CODEX_") && !matches!(name.as_ref(), "CODEX_HOME" | "CODEX_API_KEY") {
            command.env_remove(key);
        }
    }
    let channel = crate::cli_process::spawn(command, sandbox.as_ref())?;
    let input = channel.input;
    let output = channel.output;
    let (sender, messages) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        let mut output = BufReader::new(output);
        loop {
            let mut line = String::new();
            match output.by_ref().take(1_048_577).read_line(&mut line) {
                Ok(0) => break,
                Ok(_) if line.len() <= 1_048_576 && line.ends_with('\n') => {
                    let value =
                        serde_json::from_str(&line).map_err(|_| "OMP 返回无效协议帧。".to_string());
                    if sender.send(value).is_err() {
                        break;
                    }
                }
                _ => {
                    let _ = sender.send(Err("OMP 协议帧超出容量或读取失败。".into()));
                    break;
                }
            }
        }
    });
    let mut session = Session {
        child: channel.process,
        input,
        native,
        manual,
        session_id: String::new(),
        invoked: false,
        tools: crate::cli_process::ToolEvidence::default(),
        messages,
        text: String::new(),
        text_truncated: false,
        unsafe_activity: false,
        last_progress: Instant::now(),
        prompt_result: None,
        settled: false,
    };
    let timeout = args["timeout_seconds"]
        .as_str()
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|seconds| (1..=3600).contains(seconds))
        .ok_or("OMP 执行时限无效。")?;
    let end = Instant::now() + Duration::from_secs(timeout);
    let startup = crate::cli_process::startup_deadline(args, end);
    let outcome = (|| {
        let ready = session.receive(startup)?;
        if ready["type"] != "ready" || ready["protocolVersion"] != 1 {
            return Err("OMP 未确认受支持的协议版本。".into());
        }
        session.request(
            "filter",
            "set_event_filter",
            json!({"events":null,"messageUpdates":"delta"}),
            startup,
        )?;
        session.request(
            "warming",
            "set_cache_warming",
            json!({"mode":"off"}),
            startup,
        )?;
        session.request("retry", "set_auto_retry", json!({"enabled":false}), startup)?;
        session.request(
            "compact",
            "set_auto_compaction",
            json!({"enabled":false}),
            startup,
        )?;
        let state = session.request("initial", "get_state", json!({}), startup)?;
        confirm_tools(&state, native, manual)?;
        if state["messageCount"]
            .as_u64()
            .is_some_and(|count| count != 0)
        {
            return Err("OMP 会话包含已有历史，未提交目标。".into());
        }
        // A fixed prefix prevents goals beginning with native slash/bang commands
        // from being dispatched as host commands by the CLI prompt parser.
        let prompt = crate::cli_process::task_prompt(args);
        session.session_id = state["sessionId"]
            .as_str()
            .unwrap_or(plan["id"].as_str().unwrap())
            .to_owned();
        session.invoked = true;
        let accepted = session.request("troop-prompt", "prompt", json!({"message":prompt}), end)?;
        if accepted["agentInvoked"] == false {
            return Err("OMP 提示由本地命令处理，未产生模型执行。".into());
        }
        while session.prompt_result.is_none() || !session.settled {
            let event = session.receive(end)?;
            session.event(&event)?;
        }
        let final_state = session.request("final", "get_state", json!({}), end)?;
        if let Err(reason) = confirm_tools(&final_state, native, manual) {
            session.unsafe_activity = true;
            return Err(reason);
        }
        if native && (!session.tools.complete() || final_state["model"] != state["model"]) {
            return Err("OMP 原生模型或工具完成证据未核实。".into());
        }
        let result = session.prompt_result.as_ref().unwrap();
        Ok(
            json!({"exit_code":0,"turn_status":if result["status"]=="completed"&&result["agentInvoked"]==true{"completed"}else{"failed"},"effect_unknown":native && result["status"]!="completed","error_info":if result["status"]=="completed"{Value::Null}else{json!("native_prompt_failed")},"text":session.text,"text_truncated":session.text_truncated,"tools_disabled":!native,"tool_calls":session.tools.calls,"tool_call_count":session.tools.count,"tool_calls_truncated":session.tools.count>32,"session_settled":true,"version":"18.14.0","model":state["model"]["id"].as_str().unwrap_or("").chars().take(200).collect::<String>(),"provider":state["model"]["provider"].as_str().unwrap_or("").chars().take(100).collect::<String>()}),
        )
    })();
    if session.unsafe_activity || native && session.invoked && outcome.is_err() {
        return Ok(
            json!({"exit_code":1,"turn_status":"failed","effect_unknown":true,"tools_disabled":false,"error_info":if session.unsafe_activity{"unexpected_native_execution"}else{"native_runtime_unconfirmed"},"runtime_error":outcome.as_ref().err(),"tool_calls":session.tools.calls,"text":session.text,"text_truncated":session.text_truncated}),
        );
    }
    outcome
}
