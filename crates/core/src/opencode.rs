//! OpenCode 1.19.5 ACP v1. Only selected model data crosses the settings boundary.
use crate::cli_settings::Binding;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::Command,
    sync::mpsc,
    time::{Duration, Instant},
};

fn model(grant: &Value) -> Result<(Value, Value), String> {
    let binding: Binding = serde_json::from_value(grant["model_settings"].clone())
        .map_err(|_| "OpenCode 需要明确绑定现有模型 JSON 配置。")?;
    let source = binding.read()?;
    let selected = source["model"]
        .as_str()
        .ok_or("OpenCode 配置缺少明确模型。")?;
    let (provider, model) = selected
        .split_once('/')
        .ok_or("OpenCode 模型需包含提供方和模型 ID。")?;
    if provider.is_empty()
        || provider.len() > 100
        || !provider
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        || model.is_empty()
        || model.len() > 200
        || model.chars().any(char::is_control)
    {
        return Err("OpenCode 模型标识无效。".into());
    }
    let configuration = &source["provider"][provider];
    if configuration["npm"] != "@ai-sdk/openai-compatible" {
        return Err("当前 OpenCode 绑定已验证的 openai-compatible 模型提供方。".into());
    }
    let base = configuration["options"]["baseURL"]
        .as_str()
        .ok_or("OpenCode 需要明确模型目的地。")?;
    let url = reqwest::Url::parse(base).map_err(|_| "OpenCode 模型目的地无效。")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err("OpenCode 模型目的地需要 HTTPS 或本机 HTTP，不能携带凭据。".into());
    }
    let raw_key = configuration["options"]["apiKey"]
        .as_str()
        .filter(|key| !key.is_empty() && key.len() <= 8192 && !key.contains('\0'))
        .ok_or("OpenCode 配置需要已有 API 凭据。")?;
    let environment = raw_key
        .strip_prefix("{env:")
        .and_then(|value| value.strip_suffix('}'));
    let key = if let Some(name) = environment {
        if !grant["credential_env_keys"]
            .as_array()
            .is_some_and(|keys| keys.contains(&json!(name)))
        {
            return Err("OpenCode 模型环境引用需要在启动授权中明确选择。".into());
        }
        std::env::var(name).map_err(|_| "已授权的 OpenCode 模型环境凭据不可用。")?
    } else {
        if raw_key.contains("{env:") || raw_key.contains("{file:") {
            return Err("OpenCode 当前支持完整的环境引用，文件展开仍待接入。".into());
        }
        raw_key.to_owned()
    };
    if key.is_empty() || key.len() > 8192 || key.contains('\0') {
        return Err("OpenCode 模型凭据值无效。".into());
    }
    let limit = &configuration["models"][model]["limit"];
    let context = limit["context"]
        .as_u64()
        .filter(|value| (1024..=2_000_000).contains(value))
        .ok_or("OpenCode 模型缺少有效上下文容量。")?;
    let output = limit["output"]
        .as_u64()
        .filter(|value| *value > 0 && *value <= context)
        .ok_or("OpenCode 模型缺少有效输出容量。")?;
    let selection = json!({"source_file":binding.file,"source_sha256":binding.sha256,"source":"explicit_settings_binding","model":selected,"base_url":base,"provider":provider,"model_id":model,"context":context,"output":output,"credential_env_key":environment});
    let provider_config = json!({"npm":"@ai-sdk/openai-compatible","name":"TROOP selected model","options":{"baseURL":base,"apiKey":key},"models":{model:{"name":model,"limit":{"context":context,"output":output}}}});
    Ok((selection, provider_config))
}
pub(crate) fn selection(grant: &Value) -> Result<Value, String> {
    model(grant).map(|(selection, _)| selection)
}
pub(crate) fn check_ancestors(workspace: &Path, grant: &Value) -> Result<(), String> {
    for directory in workspace.ancestors().skip(1) {
        for name in [
            "opencode.json",
            "opencode.jsonc",
            ".opencode/opencode.json",
            ".opencode/opencode.jsonc",
        ] {
            let file = directory.join(name);
            if !file.is_file() {
                continue;
            }
            let target = file
                .canonicalize()
                .map_err(|_| "OpenCode 上级目录配置身份已变化。")?;
            let readable = ["read_roots", "write_roots"]
                .into_iter()
                .flat_map(|key| grant[key].as_array().into_iter().flatten())
                .filter_map(Value::as_str)
                .any(|root| target.starts_with(root));
            if !readable {
                return Err(format!("OpenCode 1.19.5 仍会检查上级目录配置 {}，当前读取授权未覆盖该文件，已阻止执行。", file.display()));
            }
        }
    }
    Ok(())
}

fn empty_call_field(value: &Value) -> bool {
    value.is_null()
        || value.as_object().is_some_and(|fields| fields.is_empty())
        || value.as_array().is_some_and(|fields| fields.is_empty())
        || value.as_str() == Some("")
}

// Only structured, same-session tool facts can supplement an approval.
// Nonempty conflicting fields are rejected instead of choosing an authority.
fn merge_call(target: &mut Value, source: &Value) -> Result<Vec<&'static str>, String> {
    let mut filled = Vec::new();
    for field in ["name", "kind", "rawInput", "locations"] {
        if empty_call_field(&source[field]) {
            continue;
        }
        if empty_call_field(&target[field]) {
            target[field] = source[field].clone();
            filled.push(field);
        } else if field == "rawInput" && target[field].is_object() && source[field].is_object() {
            let input = target[field].as_object_mut().unwrap();
            let mut changed = false;
            for (key, value) in source[field].as_object().unwrap() {
                if let Some(existing) = input.get(key) {
                    if existing != value {
                        return Err("OpenCode 同一工具调用的 rawInput 参数冲突，需要核对。".into());
                    }
                } else {
                    input.insert(key.clone(), value.clone());
                    changed = true;
                }
            }
            if changed {
                filled.push(field);
            }
        } else if target[field] != source[field] {
            return Err(format!(
                "OpenCode 同一工具调用的 {field} 参数冲突，需要核对。"
            ));
        }
    }
    Ok(filled)
}

struct Session {
    process: crate::cli_process::Process,
    input: Box<dyn Write + Send>,
    messages: mpsc::Receiver<Result<Value, String>>,
    id: String,
    invoked: bool,
    native: bool,
    text: String,
    truncated: bool,
    progress: Instant,
    tools: crate::cli_process::ToolEvidence,
    approval_calls: Vec<Value>,
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
            .map_err(|_| "OpenCode 输入通道已关闭。".into())
    }
    fn receive(&self, end: Instant) -> Result<Value, String> {
        self.messages
            .recv_timeout(
                end.checked_duration_since(Instant::now())
                    .ok_or("OpenCode 请求超时。")?,
            )
            .map_err(|_| "OpenCode 连接中断或请求超时。".to_string())?
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
                    let code = value["error"]["code"].as_i64().unwrap_or(-32603);
                    let class = value["error"]["data"]["errorName"]
                        .as_str()
                        .filter(|name| {
                            name.len() <= 80
                                && name
                                    .bytes()
                                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                        })
                        .unwrap_or("unclassified");
                    return Err(format!(
                        "OpenCode 未接受 {method} 请求，错误码 {code}，类别 {class}。"
                    ));
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or("OpenCode 响应缺少结果。".into());
            }
            self.event(&value)?;
        }
    }
    fn remember_call(&mut self, update: &Value, initial: bool) -> Result<(), String> {
        let id = update["toolCallId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)
            .ok_or("OpenCode 工具调用身份无效。")?;
        if self.tools.finished(id) {
            if update["status"]
                .as_str()
                .is_some_and(|status| !matches!(status, "completed" | "failed"))
            {
                return Err("OpenCode 已结束的工具调用不能退回执行状态。".into());
            }
            return Ok(());
        }
        let previous = self
            .approval_calls
            .iter()
            .position(|call| call["toolCallId"] == id);
        let mut call = if let Some(index) = previous {
            if initial {
                return Err("OpenCode 重用了原生工具调用身份。".into());
            }
            self.approval_calls.remove(index)
        } else if initial {
            json!({"toolCallId":id})
        } else {
            return Ok(());
        };
        merge_call(&mut call, update)?;
        if !empty_call_field(&call["rawInput"]) {
            if let Some(evidence) = self.tools.calls.iter_mut().find(|entry| entry["id"] == id) {
                evidence["arguments_sha256"] =
                    json!(crate::tools::hash(call["rawInput"].to_string().as_bytes()));
            }
        }
        if let Some(status) = update.get("status") {
            call["status"] = status.clone();
        }
        if call.to_string().len() <= 16_000 {
            self.approval_calls.push(call);
        }
        while self.approval_calls.len() > 64
            || self
                .approval_calls
                .iter()
                .map(|call| call.to_string().len())
                .sum::<usize>()
                > 32_000
        {
            self.approval_calls.remove(0);
        }
        Ok(())
    }
    fn permission_request(&self, value: &Value) -> Result<Value, String> {
        let mut request = value.clone();
        let call = &mut request["params"]["toolCall"];
        if !call.is_object() {
            return Err("OpenCode 审批工具记录无效。".into());
        }
        let id = call["toolCallId"]
            .as_str()
            .ok_or("OpenCode 审批工具身份无效。")?;
        if self.tools.finished(id) {
            return Err("OpenCode 已结束的工具调用不能再次请求审批。".into());
        }
        call.as_object_mut()
            .unwrap()
            .remove("parameter_correlation");
        if value["params"]["sessionId"] == self.id {
            if let Some(source) = self
                .approval_calls
                .iter()
                .find(|source| source["toolCallId"] == call["toolCallId"])
            {
                if matches!(source["status"].as_str(), Some("completed" | "failed")) {
                    return Err("OpenCode 已结束的工具调用不能再次请求审批。".into());
                }
                let fields = merge_call(call, source)?;
                if !fields.is_empty() {
                    call["parameter_correlation"] = json!({"source":"same_session_tool_update","tool_call_id":source["toolCallId"],"fields":fields,"source_sha256":crate::tools::hash(source.to_string().as_bytes())});
                }
            }
        }
        Ok(request)
    }
    fn event(&mut self, value: &Value) -> Result<(), String> {
        if value["jsonrpc"] != "2.0" {
            return Err("OpenCode 协议版本无效。".into());
        }
        let params = &value["params"];
        if params.get("sessionId").is_some()
            && !self.id.is_empty()
            && params["sessionId"] != self.id
        {
            return Err("OpenCode 会话身份不匹配。".into());
        }
        if let Some(id) = value.get("id").filter(|_| value.get("method").is_some()) {
            if value["method"] == "session/request_permission" && self.native && self.invoked {
                let request = self.permission_request(value)?;
                let name = request["params"]["toolCall"]["name"]
                    .as_str()
                    .unwrap_or("opencode_filtered_tool");
                let response = crate::cli_process::acp_permission(&request, &self.id, name)?;
                self.send(response["native_response"].clone())?;
                crate::cli_process::interaction_written(&response["interaction_id"]);
                return Ok(());
            }
            self.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client capability unavailable"}}))?;
            // OpenCode 1.19.5 optionally mirrors an approved edit into the IDE,
            // then performs the native write itself. Our fs capability is false.
            // The -32601 response above declines the mirror without ending its turn.
            if value["method"] == "fs/write_text_file" && self.native && self.invoked {
                return Ok(());
            }
            let method = value["method"]
                .as_str()
                .filter(|method| {
                    method.len() <= 100
                        && method
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"/_".contains(&byte))
                })
                .unwrap_or("unclassified");
            return Err(format!(
                "OpenCode 请求了计划外的客户端能力或权限 {method}。"
            ));
        }
        if value["method"] != "session/update" {
            return Ok(());
        }
        let update = &params["update"];
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") if self.invoked => {
                if update["content"]["type"] != "text" {
                    return Err("OpenCode 返回了未支持的结果类型。".into());
                }
                for character in update["content"]["text"].as_str().unwrap_or("").chars() {
                    if self.text.len() + character.len_utf8() > 12_000 {
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
            Some("tool_call") => {
                if !self.invoked
                    || !self.native
                    || update["name"]
                        .as_str()
                        .is_some_and(|name| !matches!(name, "read" | "write" | "edit" | "bash"))
                {
                    return Err("OpenCode 报告了计划外的工具调用。".into());
                }
                if params["sessionId"] == self.id {
                    self.remember_call(update, true)?;
                }
                self.tools.record(&json!({"type":"tool_execution_start","toolCallId":update["toolCallId"],"toolName":update["name"].as_str().unwrap_or("opencode_filtered_tool"),"args":update["rawInput"]}))?;
                self.tool_completion(update)?;
            }
            Some("tool_call_update") => {
                if self.invoked && self.native && params["sessionId"] == self.id {
                    self.remember_call(update, false)?;
                }
                self.tool_completion(update)?;
            }
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
    let native = plan["tool_mode"] == "native";
    let policy: troop_mcp::containment::Config =
        serde_json::from_value(plan["sandbox_config"].clone())
            .map_err(|_| "OpenCode 隔离配置无效。")?;
    let program = Path::new(plan["program"].as_str().ok_or("OpenCode 程序缺失。")?);
    let _program = troop_mcp::program::admit(
        program,
        plan["program_sha256"]
            .as_str()
            .ok_or("OpenCode 程序指纹缺失。")?,
    )?;
    let binding = json!({"model_settings":{"file":plan["model_selection"]["source_file"],"sha256":plan["model_selection"]["source_sha256"]},"credential_env_keys":plan["credential_env_keys"]});
    let (selection, provider) = model(&binding)?;
    let runtime = Path::new(
        plan["engine_runtime_directory"]
            .as_str()
            .ok_or("OpenCode 单次目录缺失。")?,
    );
    fs::create_dir(runtime).map_err(|_| "无法创建 OpenCode 单次目录。")?;
    let runtime =
        troop_mcp::program::execution_path(runtime.to_str().ok_or("OpenCode 目录编码无效。")?);
    for directory in [
        "data/opencode/log",
        "cache/opencode/bin",
        "cache/opencode/repos",
        "config/opencode",
        "state/opencode",
        "tmp/opencode",
    ] {
        fs::create_dir_all(Path::new(&runtime).join(directory))
            .map_err(|_| "无法准备 OpenCode 单次状态目录。")?;
    }
    let configure = |command: &mut Command| {
        command.current_dir(&runtime);
        for key in [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_TEST_HOME",
        ] {
            command.env(key, &runtime);
        }
        for (key, directory) in [
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_STATE_HOME", "state"),
            ("TEMP", "tmp"),
            ("TMP", "tmp"),
            ("OPENCODE_CONFIG_DIR", "config/opencode"),
        ] {
            command.env(key, Path::new(&runtime).join(directory));
        }
        for key in [
            "OPENCODE_DISABLE_AUTOUPDATE",
            "OPENCODE_DISABLE_PROJECT_CONFIG",
            "OPENCODE_DISABLE_MODELS_FETCH",
            "OPENCODE_PURE",
            "DO_NOT_TRACK",
        ] {
            command.env(key, "1");
        }
    };
    let mut version = Command::new(program);
    configure(&mut version);
    version.arg("--version");
    crate::cli_process::confirm_version(version, &policy, "1.19.5")?;
    let mut permission = json!({"*":"deny"});
    let mut config = json!({"model":selection["model"],"small_model":selection["model"],"enabled_providers":[selection["provider"]],"provider":{selection["provider"].as_str().unwrap():provider},"autoupdate":false,"share":"disabled","snapshot":false,"mcp":{},"plugin":[],"instructions":[],"lsp":false,"formatter":false,"subagent_depth":0,"compaction":{"auto":false,"prune":false}});
    let _shell_guard = if native {
        for tool in ["read", "write", "edit", "bash", "external_directory"] {
            permission[tool] = json!(if plan["approval_mode"] == "manual" {
                "ask"
            } else {
                "allow"
            });
        }
        let shell = Path::new(
            plan["native_shell"]["program"]
                .as_str()
                .ok_or("OpenCode 原生 Shell 缺失。")?,
        );
        let guard = troop_mcp::program::admit(
            shell,
            plan["native_shell"]["program_sha256"]
                .as_str()
                .ok_or("Shell 指纹缺失。")?,
        )?;
        config["shell"] = json!(troop_mcp::program::execution_path(
            shell.to_str().ok_or("Shell 路径编码无效。")?
        ));
        Some(guard)
    } else {
        None
    };
    config["permission"] = permission;
    let mut command = Command::new(program);
    configure(&mut command);
    command
        .args(["acp", "--pure"])
        .env("OPENCODE_CONFIG_CONTENT", config.to_string());
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
                        .send(
                            serde_json::from_str(&line).map_err(|_| "OpenCode 协议帧无效。".into()),
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                _ => {
                    let _ = sender.send(Err("OpenCode 协议帧超过容量或读取失败。".into()));
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
        text: String::new(),
        truncated: false,
        progress: Instant::now(),
        tools: Default::default(),
        approval_calls: Vec::new(),
    };
    let timeout = args["timeout_seconds"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1..=3600).contains(value))
        .ok_or("OpenCode 时限无效。")?;
    let end = Instant::now() + Duration::from_secs(timeout);
    let startup = crate::cli_process::startup_deadline(args, end);
    let outcome = (|| {
        let initialized=session.request("initialize","initialize",json!({"protocolVersion":1,"clientInfo":{"name":"TROOP","version":"0.10.2"},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}),startup)?;
        if initialized["protocolVersion"] != 1 {
            return Err("OpenCode ACP 协议版本不匹配。".into());
        }
        let created = session.request(
            "new",
            "session/new",
            json!({"cwd":args["workspace"],"mcpServers":[]}),
            startup,
        )?;
        session.id = created["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 200)
            .ok_or("OpenCode 会话标识无效。")?
            .into();
        let model = created["configOptions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|option| option["id"] == "model")
            .map(|option| &option["currentValue"]);
        if model != Some(&selection["model"]) {
            return Err("OpenCode 读回模型与明确选择不匹配。".into());
        }
        session.invoked = true;
        let result=session.request("prompt","session/prompt",json!({"sessionId":session.id,"prompt":[{"type":"text","text":crate::cli_process::task_prompt(args)}]}),end)?;
        if result["stopReason"] != "end_turn" || !session.tools.complete() {
            return Err("OpenCode 完成或工具回执未确认。".into());
        }
        Ok(
            json!({"exit_code":0,"turn_status":"completed","text":session.text,"text_truncated":session.truncated,"tools_disabled":!native,"tool_calls":session.tools.calls,"tool_call_count":session.tools.count,"tool_calls_truncated":session.tools.count>32,"tool_metadata_complete":session.tools.calls.iter().all(|call|call["name"]!="opencode_filtered_tool"),"tool_inventory_readback":false,"session_settled":true,"version":"1.19.5","model":selection["model"],"provider":selection["base_url"]}),
        )
    })();
    if session.invoked && outcome.is_err() {
        return Ok(
            json!({"exit_code":1,"turn_status":"failed","effect_unknown":true,"tools_disabled":!native,"runtime_error":outcome.as_ref().err(),"text":session.text,"tool_calls":session.tools.calls}),
        );
    }
    outcome
}
