//! Claude Code 2.1.319 stream-json, with configuration credentials kept in memory.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::Command,
    sync::mpsc,
    time::{Duration, Instant},
};

use crate::cli_settings::Binding as SettingsBinding;

impl SettingsBinding {
    fn load(&self) -> Result<(Value, BTreeMap<String, String>), String> {
        let value = self.read()?;
        let mut env = BTreeMap::new();
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ] {
            if let Some(text) = value["env"][key].as_str().filter(|text| !text.is_empty()) {
                if text.len() > 8192 || text.contains('\0') {
                    return Err("Claude 模型配置值超过容量或编码无效。".into());
                }
                env.insert(key.to_owned(), text.to_owned());
            }
        }
        let base = env
            .get("ANTHROPIC_BASE_URL")
            .ok_or("当前 Claude 配置接入需要明确的 ANTHROPIC_BASE_URL。")?;
        let url = reqwest::Url::parse(base).map_err(|_| "Claude 模型目的地无效。")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !(url.scheme() == "https"
                || url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
        {
            return Err("Claude 模型目的地需要 HTTPS 或本机 HTTP，地址不能携带凭据。".into());
        }
        let model = value["model"]
            .as_str()
            .or_else(|| env.get("ANTHROPIC_MODEL").map(String::as_str))
            .ok_or("Claude 配置需要明确模型。")?;
        if model.is_empty()
            || model.len() > 200
            || model.chars().any(char::is_control)
            || !env.contains_key("ANTHROPIC_API_KEY") && !env.contains_key("ANTHROPIC_AUTH_TOKEN")
        {
            return Err("Claude 配置需要有效模型和已有 API 环境凭据。".into());
        }
        let selection = json!({"source_file":self.file,"source_sha256":self.sha256,"env_keys":env.keys().collect::<Vec<_>>(),"model":model,"base_url":base,"source":"explicit_settings_binding"});
        Ok((selection, env))
    }
}
pub(crate) fn selection(grant: &Value) -> Result<Value, String> {
    let binding: SettingsBinding = serde_json::from_value(grant["model_settings"].clone())
        .map_err(|_| "请在 Claude 启动授权中选择现有模型配置文件。")?;
    binding.load().map(|(selection, _)| selection)
}

struct Session {
    process: crate::cli_process::Process,
    input: Box<dyn Write + Send>,
    messages: mpsc::Receiver<Result<Value, String>>,
    native: bool,
    manual: bool,
    invoked: bool,
    initialized: bool,
    session_id: String,
    text: String,
    truncated: bool,
    progress: Instant,
    tools: crate::cli_process::ToolEvidence,
    result: Option<Value>,
    model: String,
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
            .map_err(|_| "Claude 原生输入已关闭。".into())
    }
    fn receive(&self, end: Instant) -> Result<Value, String> {
        self.messages
            .recv_timeout(
                end.checked_duration_since(Instant::now())
                    .ok_or("Claude 原生请求超时。")?,
            )
            .map_err(|_| "Claude 原生通道断开或请求超时。".to_string())?
    }
    fn event(&mut self, value: &Value) -> Result<(), String> {
        if let Some(id) = value["session_id"].as_str() {
            if !self.session_id.is_empty() && self.session_id != id {
                return Err("Claude 会话身份不匹配。".into());
            }
        }
        if !value["parent_tool_use_id"].is_null() {
            return Err("Claude 报告了计划外的子代理活动。".into());
        }
        match value["type"].as_str() {
            Some("system") if value["subtype"] == "init" => {
                let tools = value["tools"].as_array().ok_or("Claude 未读回工具清单。")?;
                let expected = if self.manual {
                    &["Read", "Write", "Edit", "PowerShell", "AskUserQuestion"][..]
                } else if self.native {
                    &["Read", "Write", "Edit", "PowerShell"][..]
                } else {
                    &[][..]
                };
                if tools.len() != expected.len()
                    || expected.iter().any(|name| !tools.contains(&json!(name)))
                    || value["mcp_servers"]
                        .as_array()
                        .is_none_or(|servers| !servers.is_empty())
                    || value["permissionMode"]
                        != if self.manual {
                            "default"
                        } else if self.native {
                            "bypassPermissions"
                        } else {
                            "dontAsk"
                        }
                {
                    return Err("Claude 工具、MCP 或权限模式未按计划生效。".into());
                }
                self.session_id = value["session_id"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 200)
                    .ok_or("Claude 会话标识无效。")?
                    .into();
                self.model = value["model"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(200)
                    .collect();
                self.initialized = true;
            }
            Some("control_request")
                if self.manual
                    && self.initialized
                    && self.invoked
                    && value["request"]["subtype"] == "can_use_tool" =>
            {
                let request = &value["request"];
                if !request["agent_id"].is_null() {
                    return Err("Claude 子代理审批缺少独立归属。".into());
                }
                let name = request["tool_name"]
                    .as_str()
                    .ok_or("Claude 审批工具名称缺失。")?;
                let input = &request["input"];
                let question = name == "AskUserQuestion";
                let body = if question {
                    let mut questions = input["questions"]
                        .as_array()
                        .ok_or("Claude 问题结构无效。")?
                        .clone();
                    for (index, item) in questions.iter_mut().enumerate() {
                        item["id"] = json!(index.to_string());
                    }
                    json!({"questions":questions})
                } else {
                    let kind = match name {
                        "Read" => "read",
                        "Write" | "Edit" => "edit",
                        "PowerShell" => "execute",
                        _ => return Err("Claude 请求了计划外的工具审批。".into()),
                    };
                    json!({"tool_name":name,"tool_call":{"kind":kind,"rawInput":input},"options":[{"optionId":"once","kind":"allow_once","name":"允许一次"},{"optionId":"reject","kind":"reject_once","name":"拒绝"}]})
                };
                let reply = crate::tools::interaction(
                    json!({"kind":if question {"question"} else {"permission"},"native_request_id":value["request_id"],"native_session_id":self.session_id,"body":body}),
                    crate::tools::interaction_deadline(),
                )?;
                if let Some(error) = reply["error"].as_str() {
                    return Err(error.to_owned());
                }
                if reply["native_request_id"] != value["request_id"] {
                    return Err("Claude 回应身份不匹配。".into());
                }
                let response = if question {
                    let mut updated = input.clone();
                    let mut answers = serde_json::Map::new();
                    for (index, item) in input["questions"].as_array().unwrap().iter().enumerate() {
                        let labels = reply["answer"]["answers"][index.to_string()]
                            .as_array()
                            .ok_or("Claude 问题答案缺失。")?;
                        answers.insert(
                            item["question"]
                                .as_str()
                                .ok_or("Claude 问题正文无效。")?
                                .to_owned(),
                            json!(labels
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")),
                        );
                    }
                    updated["answers"] = json!(answers);
                    json!({"behavior":"allow","updatedInput":updated})
                } else if reply["answer"]["option_id"] == "once" {
                    json!({"behavior":"allow","updatedInput":input})
                } else {
                    json!({"behavior":"deny","message":"TROOP denied this operation"})
                };
                self.send(json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":response}}))?;
                println!(
                    "{}",
                    json!({"progress":{"interaction_sent":reply["interaction_id"]}})
                );
                let _ = std::io::stdout().flush();
            }
            Some("control_request") => {
                self.send(json!({"type":"control_response","response":{"subtype":"error","request_id":value["request_id"],"error":"Additional client capability is not authorized"}}))?;
                return Err("Claude 请求了未授权的宿主交互能力。".into());
            }
            Some("system") if value["subtype"] == "task_started" => {
                return Err("Claude 报告了计划外的后台作业，执行效果需要核对。".into());
            }
            Some("assistant") => {
                if !self.initialized {
                    return Err("Claude 尚未确认初始能力。".into());
                }
                for part in value["message"]["content"].as_array().into_iter().flatten() {
                    if part["type"] == "tool_use" {
                        if !self.native
                            || !matches!(
                                part["name"].as_str(),
                                Some("Read" | "Write" | "Edit" | "PowerShell" | "AskUserQuestion")
                            )
                        {
                            return Err("Claude 报告了计划外的工具调用。".into());
                        }
                        self.tools.record(&json!({"type":"tool_execution_start","toolCallId":part["id"],"toolName":part["name"],"args":part["input"]}))?;
                    }
                }
            }
            Some("user") => {
                for part in value["message"]["content"].as_array().into_iter().flatten() {
                    if part["type"] == "tool_result" {
                        let name = self.tools.name(&part["tool_use_id"]);
                        self.tools.record(&json!({"type":"tool_execution_end","toolCallId":part["tool_use_id"],"toolName":name,"isError":part["is_error"]==true,"result":part["content"]}))?;
                    }
                }
            }
            Some("stream_event") if value["event"]["delta"]["type"] == "text_delta" => {
                for character in value["event"]["delta"]["text"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                {
                    if self.text.len() + character.len_utf8() > 12_000 {
                        self.truncated = true;
                        break;
                    }
                    if !self.truncated {
                        self.text.push(character);
                    }
                }
                if self.progress.elapsed() >= Duration::from_millis(150) {
                    println!(
                        "{}",
                        json!({"progress":{"text":self.text,"text_truncated":self.truncated}})
                    );
                    let _ = std::io::stdout().flush();
                    self.progress = Instant::now();
                }
            }
            Some("result") => self.result = Some(value.clone()),
            _ => {}
        }
        Ok(())
    }
}

pub(crate) fn perform(args: &Value) -> Result<Value, String> {
    let plan = &args["permission_plan"];
    let native = plan["tool_mode"] == "native";
    let policy: troop_mcp::containment::Config =
        serde_json::from_value(plan["sandbox_config"].clone())
            .map_err(|_| "Claude 隔离配置无效。")?;
    let program = Path::new(plan["program"].as_str().ok_or("Claude 程序缺失。")?);
    let _program = troop_mcp::program::admit(
        program,
        plan["program_sha256"]
            .as_str()
            .ok_or("Claude 程序指纹缺失。")?,
    )?;
    let binding = SettingsBinding {
        file: plan["model_selection"]["source_file"]
            .as_str()
            .ok_or("Claude 模型来源缺失。")?
            .into(),
        sha256: plan["model_selection"]["source_sha256"]
            .as_str()
            .ok_or("Claude 配置指纹缺失。")?
            .into(),
    };
    let (selection, env) = binding.load()?;
    let runtime = Path::new(
        plan["engine_runtime_directory"]
            .as_str()
            .ok_or("Claude 单次目录缺失。")?,
    );
    fs::create_dir(runtime).map_err(|_| "无法创建 Claude 单次运行目录。")?;
    let runtime =
        troop_mcp::program::execution_path(runtime.to_str().ok_or("Claude 运行目录编码无效。")?);
    let configure = |command: &mut Command| {
        command
            .current_dir(&runtime)
            .env("CLAUDE_CONFIG_DIR", &runtime)
            .env("HOME", &runtime)
            .env("USERPROFILE", &runtime)
            .env("APPDATA", &runtime)
            .env("LOCALAPPDATA", &runtime)
            .env("TEMP", &runtime)
            .env("TMP", &runtime)
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            .env("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1")
            .env("CLAUDE_CODE_DISABLE_CRON", "1");
    };
    let mut version = Command::new(program);
    configure(&mut version);
    version.arg("--version");
    crate::cli_process::confirm_version(version, &policy, "2.1.319 (Claude Code)")?;
    let mut command = Command::new(program);
    configure(&mut command);
    let _shell_guard = if native {
        let shell = Path::new(
            plan["native_shell"]["program"]
                .as_str()
                .ok_or("Claude PowerShell 程序身份缺失。")?,
        );
        let guard = troop_mcp::program::admit(
            shell,
            plan["native_shell"]["program_sha256"]
                .as_str()
                .ok_or("PowerShell 程序指纹缺失。")?,
        )?;
        let directory = troop_mcp::program::execution_path(
            shell
                .parent()
                .ok_or("PowerShell 程序目录无效。")?
                .to_str()
                .ok_or("PowerShell 程序目录编码无效。")?,
        );
        command.env("CLAUDE_CODE_USE_POWERSHELL_TOOL", "1").env(
            "PATH",
            format!("{directory};{}", std::env::var("PATH").unwrap_or_default()),
        );
        Some(guard)
    } else {
        None
    };
    let manual = plan["approval_mode"] == "manual";
    command
        .current_dir(args["workspace"].as_str().ok_or("Claude 工作区缺失。")?)
        .args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--safe-mode",
            "--setting-sources",
            "",
            "--no-session-persistence",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
            if manual {
                "--permission-prompt-tool"
            } else {
                "--permission-prompts"
            },
            if manual { "stdio" } else { "none" },
            "--permission-mode",
            if manual {
                "default"
            } else if native {
                "bypassPermissions"
            } else {
                "dontAsk"
            },
            "--tools",
            if manual {
                "Read,Write,Edit,PowerShell,AskUserQuestion"
            } else if native {
                "Read,Write,Edit,PowerShell"
            } else {
                ""
            },
            "--model",
        ])
        .arg(selection["model"].as_str().ok_or("Claude 模型缺失。")?)
        .envs(env);
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
                        .send(serde_json::from_str(&line).map_err(|_| "Claude 协议帧无效。".into()))
                        .is_err()
                    {
                        break;
                    }
                }
                _ => {
                    let _ = sender.send(Err("Claude 协议帧超出容量或读取失败。".into()));
                    break;
                }
            }
        }
    });
    let mut session = Session {
        process: channel.process,
        input: channel.input,
        messages,
        native,
        manual,
        invoked: false,
        initialized: false,
        session_id: String::new(),
        text: String::new(),
        truncated: false,
        progress: Instant::now(),
        tools: Default::default(),
        result: None,
        model: String::new(),
    };
    let seconds = args["timeout_seconds"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| (1..=3600).contains(seconds))
        .ok_or("Claude 执行时限无效。")?;
    let end = Instant::now() + Duration::from_secs(seconds);
    let startup = crate::cli_process::startup_deadline(args, end);
    let outcome = (|| {
        session.send(json!({"type":"control_request","request_id":"troop-initialize","request":{"subtype":"initialize","hooks":{},"sdkMcpServers":[]}}))?;
        loop {
            let value = session.receive(startup)?;
            if value["type"] == "control_response"
                && value["response"]["request_id"] == "troop-initialize"
            {
                if value["response"]["subtype"] != "success" {
                    return Err("Claude 未接受 stream-json 初始化。".into());
                }
                break;
            }
            session.event(&value)?;
        }
        session.invoked = true;
        session.send(json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":crate::cli_process::task_prompt(args)}]},"parent_tool_use_id":null,"session_id":""}))?;
        while session.result.is_none() {
            let value = session.receive(end)?;
            session.event(&value)?;
        }
        let result = session.result.as_ref().unwrap();
        if !session.initialized
            || result["subtype"] != "success"
            || result["is_error"] != false
            || !session.tools.complete()
            || result["permission_denials"]
                .as_array()
                .is_none_or(|denials| !denials.is_empty())
        {
            return Err(format!(
                "Claude 完成、工具或权限回执未确认。{}",
                json!({"initialized":session.initialized,"subtype":result["subtype"],"is_error":result["is_error"],"tools_complete":session.tools.complete(),"denials_count":result["permission_denials"].as_array().map(Vec::len)})
            ));
        }
        let text = result["result"]
            .as_str()
            .ok_or("Claude 完成结果缺少文本。")?;
        let mut bounded = String::new();
        for character in text.chars() {
            if bounded.len() + character.len_utf8() > 12_000 {
                break;
            }
            bounded.push(character);
        }
        Ok(
            json!({"exit_code":0,"turn_status":"completed","text":bounded,"text_truncated":bounded.len()<text.len(),"tools_disabled":!native,"tool_calls":session.tools.calls,"tool_call_count":session.tools.count,"tool_calls_truncated":session.tools.count>32,"session_settled":true,"version":"2.1.319","model":session.model,"provider":selection["base_url"],"tool_inventory_readback":true}),
        )
    })();
    if session.invoked && outcome.is_err() {
        return Ok(
            json!({"exit_code":1,"turn_status":"failed","effect_unknown":true,"tools_disabled":!native,"error_info":"claude_runtime_unconfirmed","runtime_error":outcome.as_ref().err(),"text":session.text,"text_truncated":session.truncated,"tool_calls":session.tools.calls}),
        );
    }
    outcome
}
