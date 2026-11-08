//! Copilot 1.0.107 ACP tools and native SDK questions inside the admitted container.
//! SDK wire source fixed at github/copilot-sdk d1e6021a43b26e87acfcd43b37988eff09dd8aaf (MIT).
//! Contract: docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::Command,
    sync::mpsc,
    time::{Duration, Instant},
};

pub(crate) fn model_selection() -> Result<Value, String> {
    let base = std::env::var("COPILOT_PROVIDER_BASE_URL")
        .map_err(|_| "Copilot 隔离接入需要现有 COPILOT_PROVIDER_BASE_URL 环境配置。")?;
    let url = reqwest::Url::parse(&base).map_err(|_| "Copilot 模型服务地址无效。")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err("Copilot 服务需要 HTTPS 或本机 HTTP，地址不能携带凭据。".into());
    }
    let model = std::env::var("COPILOT_MODEL").map_err(|_| "请配置 COPILOT_MODEL。")?;
    if model.is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
        return Err("Copilot 模型名称无效。".into());
    }
    let kind = std::env::var("COPILOT_PROVIDER_TYPE").unwrap_or_else(|_| "openai".into());
    let wire = std::env::var("COPILOT_PROVIDER_WIRE_API").unwrap_or_else(|_| "completions".into());
    if !matches!(kind.as_str(), "openai" | "anthropic")
        || !matches!(wire.as_str(), "completions" | "responses")
    {
        return Err("当前 Copilot 接入尚未验证此模型协议。".into());
    }
    Ok(
        json!({"base_url":base,"model":model,"type":kind,"wire_api":wire,"source":"existing_environment"}),
    )
}

struct Session {
    process: crate::cli_process::Process,
    input: Box<dyn Write + Send>,
    messages: mpsc::Receiver<Result<Value, String>>,
    session_id: String,
    native: bool,
    sdk_questions: bool,
    questions_answered: u64,
    expected_prompt: String,
    prompt_message_id: Option<String>,
    prompt_seen: bool,
    invoked: bool,
    started: bool,
    idle: bool,
    aborted: bool,
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
        let content = value.to_string();
        if self.sdk_questions {
            write!(
                self.input,
                "Content-Length: {}\r\n\r\n{}",
                content.len(),
                content
            )
        } else {
            writeln!(self.input, "{content}")
        }
        .and_then(|_| self.input.flush())
        .map_err(|_| "Copilot 协议输入已关闭。".into())
    }
    fn receive(&self, end: Instant) -> Result<Value, String> {
        self.messages
            .recv_timeout(
                end.checked_duration_since(Instant::now())
                    .ok_or("Copilot 请求超时。")?,
            )
            .map_err(|_| "Copilot 连接中断或请求超时。".to_string())?
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
            let value = self.receive(end)?;
            if value["id"] == id && value.get("method").is_none() {
                if value.get("error").is_some() {
                    return Err(format!("Copilot 未接受 {method} 请求。"));
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or("Copilot 响应缺少结果。".into());
            }
            self.event(&value)?;
        }
    }
    fn sdk_event(&mut self, value: &Value) -> Result<(), String> {
        let params = &value["params"];
        if params["sessionId"].is_string() && params["sessionId"] != self.session_id {
            return Err("Copilot SDK 会话身份不匹配。".into());
        }
        if value["id"].is_number() || value["id"].is_string() {
            if value["method"] == "userInput.request" && self.invoked && self.started {
                let choices = params["choices"]
                    .as_array()
                    .ok_or("Copilot SDK 问题缺少明确选项。")?;
                let reply = crate::tools::interaction(
                    json!({"kind":"question","native_request_id":value["id"],"native_session_id":self.session_id,"body":{"questions":[{"id":"choice","question":params["question"],"options":choices.iter().map(|label|json!({"label":label})).collect::<Vec<_>>()}]}}),
                    crate::tools::interaction_deadline(),
                )?;
                if let Some(error) = reply["error"].as_str() {
                    return Err(error.to_owned());
                }
                if reply["native_request_id"] != value["id"] {
                    return Err("Copilot SDK 问题回应身份不匹配。".into());
                }
                self.send(json!({"jsonrpc":"2.0","id":value["id"],"result":{"answer":reply["answer"]["answers"]["choice"][0],"wasFreeform":false}}))?;
                self.questions_answered += 1;
                crate::cli_process::interaction_written(&reply["interaction_id"]);
                return Ok(());
            }
            if value.get("method").is_some() {
                self.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"TROOP question-only transport"}}))?;
                return Err("Copilot SDK 请求了问题模式以外的客户端能力。".into());
            }
        }
        if value["method"] == "session.event" && self.invoked {
            let event = &params["event"];
            match event["type"].as_str() {
                Some("user.message") => {
                    if event["data"]["content"] != self.expected_prompt {
                        return Err("Copilot SDK 用户消息与当前目标不匹配。".into());
                    }
                    let id = event["data"]["messageId"]
                        .as_str()
                        .or_else(|| event["id"].as_str())
                        .ok_or("Copilot SDK 用户消息身份缺失。")?;
                    if self
                        .prompt_message_id
                        .as_deref()
                        .is_some_and(|expected| expected != id)
                    {
                        return Err("Copilot SDK 用户消息回执与当前目标不匹配。".into());
                    }
                    self.prompt_seen = true;
                    self.prompt_message_id = Some(id.to_owned());
                }
                Some("assistant.turn_start") if self.prompt_seen => {
                    if !event["data"]["parentToolCallId"].is_null() {
                        return Err("Copilot SDK 出现计划外子代理。".into());
                    }
                    self.started = true;
                    self.idle = false;
                }
                Some("session.idle") if self.started && self.tools.complete() => {
                    self.aborted = event["data"]["aborted"] == true;
                    self.idle = true;
                }
                Some("session.error") => return Err("Copilot SDK 报告执行错误。".into()),
                Some("assistant.message") => {
                    self.text.clear();
                    self.truncated = false;
                    for character in event["data"]["content"].as_str().unwrap_or("").chars() {
                        if self.text.len() + character.len_utf8() > 12000 {
                            self.truncated = true;
                            break;
                        }
                        self.text.push(character);
                    }
                }
                Some("tool.execution_start") => {
                    let data = &event["data"];
                    if !self.started
                        || data["toolName"] != "ask_user"
                        || !data["parentToolCallId"].is_null()
                    {
                        return Err("Copilot SDK 问题模式出现额外工具活动。".into());
                    }
                    self.tools.record(&json!({"type":"tool_execution_start","toolCallId":data["toolCallId"],"toolName":"ask_user","args":data["arguments"]}))?;
                }
                Some("tool.execution_complete") => {
                    let data = &event["data"];
                    self.tools.record(&json!({"type":"tool_execution_end","toolCallId":data["toolCallId"],"toolName":"ask_user","isError":!data["success"].as_bool().ok_or("Copilot SDK 工具完成状态无效。")?,"result":data}))?;
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn perform_sdk(&mut self, args: &Value, end: Instant) -> Result<Value, String> {
        let startup = crate::cli_process::startup_deadline(args, end);
        self.request("ping", "ping", json!({}), startup)?;
        let plan = &args["permission_plan"];
        let selection = &plan["model_selection"];
        let mut provider = json!({"type":selection["type"],"baseUrl":selection["base_url"],"wireApi":selection["wire_api"]});
        if let Some(key) = plan["credential_env_keys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .next()
        {
            provider["apiKey"] =
                json!(std::env::var(key).map_err(|_| "Copilot SDK 模型凭据不可用。")?);
        }
        self.session_id = plan["id"]
            .as_str()
            .ok_or("Copilot SDK 计划身份缺失。")?
            .to_owned();
        let created=self.request("create","session.create",json!({
            "sessionId":plan["id"],
            "model":selection["model"],
            "provider":provider,
            "availableTools":["ask_user"],
            "excludedTools":["task","powershell","view","create","edit"],
            "requestUserInput":true,
            "requestPermission":false,
            "workingDirectory":args["workspace"],
            "streaming":true,
            "enableSessionStore":false,
            "enableSessionTelemetry":false,
            "enableSkills":false,
            "enableFileHooks":false,
            "enableHostGitOperations":false,
            "mcpServers":{},
            "customAgents":[],
            "skillDirectories":[],
            "infiniteSessions":{"enabled":false},
            "systemMessage":{"mode":"replace","content":"Complete the supplied question-only task. Use ask_user to request an explicit choice. Do not use file, shell, network, MCP or subagent tools."}
        }),startup)?;
        self.session_id = created["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Copilot SDK 会话创建失败。")?
            .to_owned();
        if created["sessionId"] != plan["id"] {
            return Err("Copilot SDK 创建了计划外的会话。".into());
        }
        self.expected_prompt = crate::cli_process::task_prompt(args);
        self.invoked = true;
        let sent = self.request(
            "prompt",
            "session.send",
            json!({"sessionId":self.session_id,"prompt":self.expected_prompt}),
            end,
        )?;
        if self
            .prompt_message_id
            .as_deref()
            .is_some_and(|id| sent["messageId"] != id)
        {
            return Err("Copilot SDK 目标消息回执不匹配。".into());
        }
        if !sent["messageId"].is_string() {
            return Err("Copilot SDK 目标消息回执缺失。".into());
        }
        self.prompt_message_id = sent["messageId"].as_str().map(str::to_owned);
        while !self.idle {
            let event = self.receive(end)?;
            self.sdk_event(&event)?;
        }
        if self.aborted {
            return Err("Copilot SDK 作业已中断，需要核对。".into());
        }
        Ok(
            json!({"exit_code":0,"turn_status":"completed","text":self.text,"text_truncated":self.truncated,"questions_answered":self.questions_answered,"session_settled":true,"tools_disabled":false,"native_tools":["ask_user"],"tool_call_count":self.tools.count,"tool_calls":self.tools.calls,"version":"1.0.107","native_transport":"sdk_questions","model":selection["model"],"provider":selection["base_url"]}),
        )
    }
    fn event(&mut self, value: &Value) -> Result<(), String> {
        if self.sdk_questions {
            return self.sdk_event(value);
        }
        if value["jsonrpc"] != "2.0" {
            return Err("Copilot 协议版本无效。".into());
        }
        let params = &value["params"];
        if params.get("sessionId").is_some()
            && !self.session_id.is_empty()
            && params["sessionId"] != self.session_id
        {
            return Err("Copilot 会话身份不匹配。".into());
        }
        if let Some(id) = value.get("id").filter(|_| value.get("method").is_some()) {
            if value["method"] == "session/request_permission" {
                let call = &params["toolCall"];
                let name = call["name"].as_str().or_else(|| {
                    self.tools
                        .calls
                        .iter()
                        .find(|entry| entry["id"] == call["toolCallId"])
                        .and_then(|entry| entry["name"].as_str())
                });
                let allowed = self.invoked
                    && self.native
                    && matches!(
                        name,
                        Some(
                            "view"
                                | "create"
                                | "edit"
                                | "powershell"
                                | "ask_user"
                                | "copilot_filtered_tool"
                        )
                    );
                if !allowed {
                    self.send(json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}}))?;
                    return Err("Copilot 请求了计划外的工具权限。".into());
                }
                let response =
                    crate::cli_process::acp_permission(value, &self.session_id, name.unwrap())?;
                self.send(response["native_response"].clone())?;
                crate::cli_process::interaction_written(&response["interaction_id"]);
                return Ok(());
            }
            self.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client capability unavailable"}}))?;
            return Err("Copilot 请求了未授权的客户端能力。".into());
        }
        if value["method"] == "github.com/copilot/sessionEvent" && params["agentId"].is_null() {
            match params["type"].as_str() {
                Some("assistant.turn_start") if self.invoked => {
                    self.started = true;
                    self.idle = false;
                }
                Some("session.idle") if self.started => {
                    self.idle = true;
                    self.aborted |= params["data"]["aborted"] == true;
                }
                Some("assistant.idle") => self.aborted |= params["data"]["aborted"] == true,
                _ => {}
            }
        }
        if value["method"] != "session/update" {
            return Ok(());
        }
        let update = &params["update"];
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") if self.invoked => {
                if update["content"]["type"] != "text" {
                    return Err("Copilot 返回了未支持的结果类型。".into());
                }
                for character in update["content"]["text"].as_str().unwrap_or("").chars() {
                    if self.text.len() + character.len_utf8() > 12_000 {
                        self.truncated = true;
                        break;
                    }
                    if !self.truncated {
                        self.text.push(character);
                    }
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
            Some("tool_call") => {
                if !self.invoked
                    || !self.native
                    || update["name"].as_str().is_some_and(|name| {
                        !matches!(name, "view" | "create" | "edit" | "powershell")
                    })
                {
                    return Err("Copilot 报告了计划外的工具调用。".into());
                }
                // ACP v1 permits omitted names. The fixed server filter and OS
                // container enforce scope even without that metadata.
                let name = update["name"].as_str().unwrap_or("copilot_filtered_tool");
                self.tools.record(&json!({"type":"tool_execution_start","toolCallId":update["toolCallId"],"toolName":name,"args":update["rawInput"]}))?;
                self.tool_completion(update)?;
            }
            Some("tool_call_update") => self.tool_completion(update)?,
            _ => {}
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
}

pub(crate) fn perform(args: &Value) -> Result<Value, String> {
    let plan = &args["permission_plan"];
    let sdk_questions = plan["native_transport"] == "sdk_questions";
    let native = plan["tool_mode"] == "native";
    let policy: troop_mcp::containment::Config =
        serde_json::from_value(plan["sandbox_config"].clone())
            .map_err(|_| "Copilot 隔离配置缺失。")?;
    let program = Path::new(plan["program"].as_str().ok_or("Copilot 程序缺失。")?);
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let _guard = options
        .open(program)
        .map_err(|_| "Copilot 主程序无法锁定。")?;
    if program.canonicalize().ok().as_deref() != Some(program)
        || crate::agent::external::program_hash(program)? != plan["program_sha256"]
    {
        return Err("Copilot 程序身份已变化。".into());
    }
    let runtime = Path::new(
        plan["engine_runtime_directory"]
            .as_str()
            .ok_or("Copilot 运行目录缺失。")?,
    );
    fs::create_dir(runtime).map_err(|_| "无法创建 Copilot 单次运行目录。")?;
    let runtime = troop_mcp::program::execution_path(runtime.to_str().ok_or("运行目录编码无效。")?);
    let workspace =
        troop_mcp::program::execution_path(args["workspace"].as_str().ok_or("工作区缺失。")?);
    let configure = |command: &mut Command| {
        command
            .current_dir(&runtime)
            .env("COPILOT_HOME", &runtime)
            .env("HOME", &runtime)
            .env("USERPROFILE", &runtime)
            .env("APPDATA", &runtime)
            .env("LOCALAPPDATA", &runtime)
            .env("TEMP", &runtime)
            .env("TMP", &runtime)
            .env("DO_NOT_TRACK", "1");
    };
    let mut version = Command::new(program);
    configure(&mut version);
    version.arg("--version");
    crate::cli_process::confirm_version(
        version,
        &policy,
        "GitHub Copilot CLI 1.0.107.\nRun 'copilot update' to check for updates.",
    )?;
    fs::write(Path::new(&runtime).join("settings.json"), json!({"disableAllHooks":true,"extensions":{"mode":"disabled"},"enabledPlugins":{},"skillDirectories":[],"dynamicRetrieval":{"skills":false,"mcp":false}}).to_string()).map_err(|_| "无法准备 Copilot 无凭据配置。")?;
    let selection = &plan["model_selection"];
    let mut command = Command::new(program);
    configure(&mut command);
    command.args([
        if sdk_questions { "--headless" } else { "--acp" },
        "--stdio",
        "--disable-client-telemetry",
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        "--no-auto-update",
        "--no-experimental",
        "--no-bash-env",
        "--no-eager-powershell-resolution",
        "--sync-session=off",
        "--available-tools",
    ]);
    if native {
        command.arg(if sdk_questions {
            "ask_user"
        } else {
            "view,create,edit,powershell"
        });
    }
    command
        .env(
            "COPILOT_PROVIDER_BASE_URL",
            selection["base_url"].as_str().ok_or("模型服务缺失。")?,
        )
        .env(
            "COPILOT_MODEL",
            selection["model"].as_str().ok_or("模型缺失。")?,
        )
        .env(
            "COPILOT_PROVIDER_TYPE",
            selection["type"].as_str().ok_or("模型协议缺失。")?,
        )
        .env(
            "COPILOT_PROVIDER_WIRE_API",
            selection["wire_api"].as_str().ok_or("模型协议缺失。")?,
        );
    for key in plan["credential_env_keys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if key != "COPILOT_PROVIDER_API_KEY" && key != "COPILOT_PROVIDER_BEARER_TOKEN" {
            return Err("Copilot 当前仅接受显式提供的模型 API 环境凭据。".into());
        }
        command.env(
            key,
            std::env::var(key).map_err(|_| "已授权模型环境凭据不可用。")?,
        );
    }
    let channel = crate::cli_process::spawn(command, Some(&policy))?;
    let (sender, messages) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        let mut output = BufReader::new(channel.output);
        if sdk_questions {
            loop {
                let next = crate::cli_process::read_content_frame(&mut output);
                match next {
                    Ok(Some(value)) => {
                        if sender.send(Ok(value)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
            return;
        }
        loop {
            let mut line = String::new();
            match output.by_ref().take(1_048_577).read_line(&mut line) {
                Ok(0) => break,
                Ok(_) if line.len() <= 1_048_576 && line.ends_with('\n') => {
                    if sender
                        .send(
                            serde_json::from_str(&line).map_err(|_| "Copilot 协议帧无效。".into()),
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                _ => {
                    let _ = sender.send(Err("Copilot 协议帧超过容量或读取失败。".into()));
                    break;
                }
            }
        }
    });
    let mut session = Session {
        process: channel.process,
        input: channel.input,
        messages,
        session_id: String::new(),
        native,
        sdk_questions,
        questions_answered: 0,
        expected_prompt: String::new(),
        prompt_message_id: None,
        prompt_seen: false,
        invoked: false,
        started: false,
        idle: false,
        aborted: false,
        text: String::new(),
        truncated: false,
        progress: Instant::now(),
        tools: Default::default(),
    };
    let timeout = args["timeout_seconds"]
        .as_str()
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|seconds| (1..=3600).contains(seconds))
        .ok_or("Copilot 时限无效。")?;
    let end = Instant::now() + Duration::from_secs(timeout);
    let startup = crate::cli_process::startup_deadline(args, end);
    let outcome = (|| {
        if sdk_questions {
            return session.perform_sdk(args, end);
        }
        let initialized = session.request("initialize", "initialize", json!({"protocolVersion":1,"clientInfo":{"name":"TROOP","version":"0.10.2"},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"_meta":{"github.com/copilot":{"events":["assistant.turn_start","assistant.idle","session.idle"]}}}}), startup)?;
        if initialized["protocolVersion"] != 1 {
            return Err("Copilot ACP 协议版本不匹配。".into());
        }
        let created = session.request(
            "new",
            "session/new",
            json!({"cwd":workspace,"mcpServers":[]}),
            startup,
        )?;
        session.session_id = created["sessionId"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 200)
            .ok_or("Copilot 会话标识无效。")?
            .to_owned();
        session.invoked = true;
        let result = session.request("prompt", "session/prompt", json!({"sessionId":session.session_id,"prompt":[{"type":"text","text":crate::cli_process::task_prompt(args)}]}), end)?;
        while !session.idle {
            let value = session.receive(end)?;
            session.event(&value)?;
        }
        if result["stopReason"] != "end_turn" || session.aborted || !session.tools.complete() {
            return Err("Copilot 完成或所属工作证据未确认。".into());
        }
        Ok(
            json!({"exit_code":0,"turn_status":"completed","text":session.text,"text_truncated":session.truncated,"tools_disabled":!native,"tool_calls":session.tools.calls,"tool_call_count":session.tools.count,"tool_calls_truncated":session.tools.count>32,"tool_metadata_complete":session.tools.calls.iter().all(|call|call["name"]!="copilot_filtered_tool"),"session_settled":true,"version":"1.0.107","model":selection["model"],"provider":selection["base_url"],"tool_inventory_readback":false}),
        )
    })();
    if session.invoked && outcome.is_err() {
        return Ok(
            json!({"exit_code":1,"turn_status":"failed","effect_unknown":true,"tools_disabled":!native,"error_info":"copilot_runtime_unconfirmed","runtime_error":outcome.as_ref().err(),"text":session.text,"text_truncated":session.truncated,"tool_calls":session.tools.calls}),
        );
    }
    outcome
}
