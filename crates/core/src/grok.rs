//! Grok 1.0.70 ACP, with a fresh profile and explicitly selected model environment.
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::Command,
    sync::mpsc,
    time::{Duration, Instant},
};

pub(crate) fn selection() -> Result<Value, String> {
    let base = std::env::var("GROK_MODELS_BASE_URL")
        .map_err(|_| "Grok 接入需要明确的 GROK_MODELS_BASE_URL。")?;
    let url = reqwest::Url::parse(&base).map_err(|_| "Grok 模型目的地无效。")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err("Grok 模型目的地需要 HTTPS 或本机 HTTP，不能携带凭据。".into());
    }
    let model =
        std::env::var("GROK_DEFAULT_MODEL").map_err(|_| "Grok 需要明确的 GROK_DEFAULT_MODEL。")?;
    if model.is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
        return Err("Grok 模型标识无效。".into());
    }
    Ok(json!({"model":model,"base_url":base,"source":"existing_environment"}))
}

struct Session {
    process: crate::cli_process::Process,
    input: Box<dyn Write + Send>,
    messages: mpsc::Receiver<Result<Value, String>>,
    id: String,
    invoked: bool,
    native: bool,
    credential_env_key: String,
    text: String,
    truncated: bool,
    progress: Instant,
    tools: crate::cli_process::ToolEvidence,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.process.kill();
        let end = Instant::now() + Duration::from_secs(2);
        while !self.process.stopped() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Session {
    fn send(&mut self, value: Value) -> Result<(), String> {
        writeln!(self.input, "{value}")
            .and_then(|_| self.input.flush())
            .map_err(|_| "Grok 输入通道已关闭。".into())
    }
    fn event(&mut self, value: &Value) -> Result<(), String> {
        if value["jsonrpc"] != "2.0" {
            return Err("Grok 协议版本无效。".into());
        }
        let params = &value["params"];
        if params.get("sessionId").is_some()
            && !self.id.is_empty()
            && params["sessionId"] != self.id
        {
            return Err("Grok 会话身份不匹配。".into());
        }
        if value["method"] == "session/request_permission" && self.native && self.invoked {
            let name = params["toolCall"]["name"]
                .as_str()
                .unwrap_or("grok_filtered_tool");
            let response = crate::cli_process::acp_permission(value, &self.id, name)?;
            self.send(response["native_response"].clone())?;
            crate::cli_process::interaction_written(&response["interaction_id"]);
            return Ok(());
        }
        if value.get("method").is_some() && value.get("id").is_some() {
            self.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"Client capability unavailable"}}))?;
            let method = value["method"]
                .as_str()
                .unwrap_or("")
                .chars()
                .filter(|character| !character.is_control())
                .take(120)
                .collect::<String>();
            return Err(format!("Grok 请求了未授权的宿主能力 {method}。"));
        }
        let update = &params["update"];
        if value["method"] == "session/update" {
            match update["sessionUpdate"].as_str() {
                Some("tool_call") => {
                    if !self.invoked
                        || !self.native
                        || update["name"].as_str().is_some_and(|name| {
                            !matches!(name, "read_file" | "write_file" | "edit_file" | "shell")
                        })
                    {
                        return Err("Grok 报告了计划外的工具活动，执行效果需要核对。".into());
                    }
                    self.tools.record(&json!({"type":"tool_execution_start","toolCallId":update["toolCallId"],"toolName":update["name"].as_str().unwrap_or("grok_filtered_tool"),"args":update["rawInput"]}))?;
                    self.tool_completion(update)?;
                }
                Some("tool_call_update") => self.tool_completion(update)?,
                Some("agent_message_chunk") if self.invoked => {
                    if update["content"]["type"] != "text" {
                        return Err("Grok 返回了未支持的内容类型。".into());
                    }
                    for character in update["content"]["text"].as_str().unwrap_or("").chars() {
                        if self.text.len() + character.len_utf8() > 12000 {
                            self.truncated = true;
                            break;
                        }
                        self.text.push(character);
                    }
                    if self.progress.elapsed() > Duration::from_millis(150) {
                        println!(
                            "{}",
                            json!({"progress":{"text":self.text,"text_truncated":self.truncated}})
                        );
                        let _ = std::io::stdout().flush();
                        self.progress = Instant::now();
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn tool_completion(&mut self, update: &Value) -> Result<(), String> {
        if matches!(update["status"].as_str(), Some("completed" | "failed")) {
            let name = self.tools.name(&update["toolCallId"]);
            self.tools.record(&json!({"type":"tool_execution_end","toolCallId":update["toolCallId"],"toolName":name,"isError":update["status"]=="failed","result":update}))?;
        }
        Ok(())
    }
    fn request(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
        end: Instant,
    ) -> Result<Value, String> {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        loop {
            let value = self
                .messages
                .recv_timeout(
                    end.checked_duration_since(Instant::now())
                        .ok_or("Grok 请求超时。")?,
                )
                .map_err(|_| "Grok 连接中断或请求超时。")??;
            if value["id"] == id && value.get("method").is_none() {
                if value.get("error").is_some() {
                    if let Some(message) = value["error"]["data"].as_str().filter(|message| {
                        message.starts_with("session initialization failed: invalid configuration:")
                    }) {
                        let mut detail = message.to_owned();
                        if let Ok(key) = std::env::var(&self.credential_env_key) {
                            if !key.is_empty() {
                                detail = detail.replace(&key, "[redacted]");
                            }
                        }
                        return Err(detail.chars().take(500).collect());
                    }
                    return Err(format!(
                        "Grok 未接受 {method} 请求，错误码 {}。",
                        value["error"]["code"].as_i64().unwrap_or(-32603)
                    ));
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or("Grok 响应缺少结果。".into());
            }
            self.event(&value)?;
        }
    }
}

pub(crate) fn perform(args: &Value) -> Result<Value, String> {
    let plan = &args["permission_plan"];
    let native = plan["tool_mode"] == "native";
    let policy: troop_mcp::containment::Config =
        serde_json::from_value(plan["sandbox_config"].clone())
            .map_err(|_| "Grok 隔离配置无效。")?;
    let program = Path::new(plan["program"].as_str().ok_or("Grok 程序缺失。")?);
    let _program = troop_mcp::program::admit(
        program,
        plan["program_sha256"]
            .as_str()
            .ok_or("Grok 程序指纹缺失。")?,
    )?;
    let runtime = Path::new(
        plan["engine_runtime_directory"]
            .as_str()
            .ok_or("Grok 单次目录缺失。")?,
    );
    fs::create_dir(runtime).map_err(|_| "无法创建 Grok 单次目录。")?;
    let runtime =
        troop_mcp::program::execution_path(runtime.to_str().ok_or("Grok 目录编码无效。")?);
    let selected = &plan["model_selection"];
    let references = plan["credential_env_keys"]
        .as_array()
        .filter(|keys| keys.len() == 1)
        .ok_or("Grok 需要一个明确授权的模型环境凭据引用。")?;
    let credential_env_key = references[0].as_str().ok_or("Grok 模型凭据引用无效。")?;
    let configuration = format!("[models]\ndefault = \"troop\"\nsession_summary = \"troop\"\n[features]\ntitle_refresh = false\nturn_summary = false\n[model.troop]\nmodel = {}\nbase_url = {}\nenv_key = {}\napi_backend = \"chat_completions\"\ncontext_window = 32768\nmax_completion_tokens = 4096\n[subagents]\nenabled = false\n", selected["model"], selected["base_url"], references[0]);
    fs::write(Path::new(&runtime).join("config.toml"), configuration)
        .map_err(|_| "无法准备 Grok 无凭据模型选择。")?;
    let configure = |command: &mut Command| {
        command.current_dir(&runtime);
        for key in [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
            "GROK_HOME",
        ] {
            command.env(key, &runtime);
        }
        for key in [
            "GROK_SUBAGENTS",
            "GROK_AGENT_DASHBOARD",
            "GROK_TELEMETRY",
            "GROK_MEMORY",
            "GROK_TITLE_REFRESH",
            "GROK_TURN_SUMMARY",
            "GROK_CLAUDE_HOOKS_ENABLED",
            "GROK_CURSOR_HOOKS_ENABLED",
        ] {
            command.env(key, "0");
        }
        command.env("DISABLE_TELEMETRY", "1");
        command.env("GROK_SHELL", "powershell");
        command
            .env("GROK_DISABLE_AUTOUPDATER", "1")
            .env("GROK_DISABLE_EXPERIMENTS", "1");
    };
    let mut version = Command::new(program);
    configure(&mut version);
    version.arg("--version");
    crate::cli_process::confirm_version(version, &policy, "grok 1.0.70 (f50904eaee6c)")?;
    let mut command = Command::new(program);
    configure(&mut command);
    let _shell_guard = if native {
        Some(troop_mcp::program::admit(
            Path::new(
                plan["native_shell"]["program"]
                    .as_str()
                    .ok_or("Grok 原生 Shell 身份缺失。")?,
            ),
            plan["native_shell"]["program_sha256"]
                .as_str()
                .ok_or("Grok Shell 指纹缺失。")?,
        )?)
    } else {
        None
    };
    command
        .args([
            "agent",
            "--no-leader",
            "--model",
            "troop",
            "--xai-api-base-url",
            selected["base_url"].as_str().ok_or("Grok 模型地址缺失。")?,
            "--cli-chat-proxy-base-url",
            selected["base_url"].as_str().ok_or("Grok 模型地址缺失。")?,
            "stdio",
        ])
        .env_remove("XAI_API_KEY")
        .env(
            credential_env_key,
            std::env::var(credential_env_key).map_err(|_| "已授权的 Grok 模型环境凭据不可用。")?,
        );
    let channel = crate::cli_process::spawn(command, Some(&policy))?;
    let (sender, messages) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        let mut output = BufReader::new(channel.output);
        loop {
            let mut line = String::new();
            match output.by_ref().take(1_048_577).read_line(&mut line) {
                Ok(0) => break,
                Ok(_) if line.len() <= 1_048_576 && line.ends_with('\n') => {
                    if sender
                        .send(serde_json::from_str(&line).map_err(|_| "Grok 协议帧无效。".into()))
                        .is_err()
                    {
                        break;
                    }
                }
                _ => {
                    let _ = sender.send(Err("Grok 协议帧超过容量或读取失败。".into()));
                    break;
                }
            }
        }
    });
    let mut session = Session {
        process: channel.process,
        input: channel.input,
        messages,
        id: String::new(),
        invoked: false,
        native,
        credential_env_key: credential_env_key.to_owned(),
        text: String::new(),
        truncated: false,
        progress: Instant::now(),
        tools: Default::default(),
    };
    let timeout = args["timeout_seconds"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1..=3600).contains(value))
        .ok_or("Grok 时限无效。")?;
    let end = Instant::now() + Duration::from_secs(timeout);
    let startup = crate::cli_process::startup_deadline(args, end);
    let outcome = (|| {
        let initialized=session.request("initialize","initialize",json!({"protocolVersion":1,"clientInfo":{"name":"TROOP","version":"0.10.2"},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}),startup)?;
        if initialized["protocolVersion"] != 1 {
            return Err("Grok ACP 协议版本不匹配。".into());
        }
        let profile = json!({"name":"troop-text","description":"Owned text-only task","promptMode":"full","promptBody":"Complete the supplied TROOP text task without using tools.","toolConfig":{"tools":[{"id":"GrokBuild:read_file"}]},"disallowedTools":["GrokBuild:read_file","read_file"],"injectDefaultTools":false,"discoverSkills":false,"inheritSkills":false,"agentsMd":false,"mcpInheritance":"none","mcpServers":[],"permissionMode":"dontAsk"});
        let mut profile = profile;
        if native {
            profile["name"] = json!("troop-native");
            profile["description"] = json!("Owned contained file and shell task");
            profile["promptBody"] = json!("Complete the supplied TROOP task using only the admitted tools and execution scope.");
            profile["permissionMode"] = json!(if plan["approval_mode"] == "manual" {
                "default"
            } else {
                "bypassPermissions"
            });
            profile["disallowedTools"] = json!([]);
            profile["toolConfig"]["tools"] = json!([
                {"id":"GrokBuild:read_file","name_override":"read_file"},
                {"id":"OpenCode:write","name_override":"write_file"},
                {"id":"GrokBuild:search_replace","name_override":"edit_file"},
                {"id":"GrokBuild:run_terminal_cmd","name_override":"shell","params":{"enabled_background":false,"auto_background_on_timeout":false,"allow_background_operator":false,"foreground_block_budget_ms":0,"default_block_until_ms":90000,"max_timeout_secs":90.0}}
            ]);
        }
        let created = session.request(
            "new",
            "session/new",
            json!({"cwd":args["workspace"],"mcpServers":[],"_meta":{"agentProfile":profile,"yoloMode":native}}),
            startup,
        )?;
        session.id = created["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 200)
            .ok_or("Grok 会话标识无效。")?
            .into();
        session.invoked = true;
        let result=session.request("prompt","session/prompt",json!({"sessionId":session.id,"prompt":[{"type":"text","text":crate::cli_process::task_prompt(args)}]}),end)?;
        if result["stopReason"] != "end_turn" || !session.tools.complete() {
            return Err("Grok 本轮未确认完成。".into());
        }
        Ok(
            json!({"exit_code":0,"turn_status":"completed","text":session.text,"text_truncated":session.truncated,"tools_disabled":!native,"tool_calls":session.tools.calls,"tool_call_count":session.tools.count,"tool_calls_truncated":session.tools.count>32,"tool_metadata_complete":session.tools.calls.iter().all(|call|call["name"]!="grok_filtered_tool"),"tool_inventory_readback":false,"version":"1.0.70","model":selected["model"],"model_evidence":"configured","provider":selected["base_url"]}),
        )
    })();
    if session.invoked && outcome.is_err() {
        return Ok(
            json!({"exit_code":1,"turn_status":"failed","effect_unknown":true,"tools_disabled":!native,"runtime_error":outcome.as_ref().err(),"text":session.text,"tool_calls":session.tools.calls}),
        );
    }
    outcome
}
