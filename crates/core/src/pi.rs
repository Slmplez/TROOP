//! Pi 1.5.0 JSONL RPC, inside the already admitted Windows Worker.
//! Protocol source: earendil-works/pi v1.5.0, coding-agent/docs/rpc.md (MIT).
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::Command,
    sync::mpsc,
    time::{Duration, Instant},
};

// This engine-side hook only forwards native UI and blocks denied calls.
// Authorization, persistence and lifecycle decisions stay in Rust Core.
pub(crate) const INTERACTION_EXTENSION: &str = r#"
export default function(pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "ask_user") return;
    const confirmed = await ctx.ui.confirm("TROOP tool approval", JSON.stringify({tool_name:event.toolName,tool_call_id:event.toolCallId,input:event.input}));
    if (!confirmed) return {block:true,reason:"TROOP denied this operation"};
  });
  pi.registerTool({
    name:"ask_user", label:"Ask user", description:"Ask the user a question and wait for an explicit choice.",
    parameters:{type:"object",properties:{question:{type:"string"},choices:{type:"array",items:{type:"string"},minItems:1,maxItems:16}},required:["question","choices"]},
    async execute(id, params, signal, onUpdate, ctx) {
      const answer = await ctx.ui.select(params.question, params.choices);
      if (answer === undefined) throw new Error("User question cancelled");
      return {content:[{type:"text",text:answer}],details:{}};
    }
  });
}
"#;

struct Session {
    child: crate::cli_process::Process,
    input: Box<dyn Write + Send>,
    native: bool,
    manual: bool,
    session_id: String,
    messages: mpsc::Receiver<Result<Value, String>>,
    text: String,
    text_truncated: bool,
    last_progress: Instant,
    invoked: bool,
    started: bool,
    settled: bool,
    aborted: bool,
    completed: Option<Value>,
    unsafe_activity: bool,
    tools: crate::cli_process::ToolEvidence,
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
    fn append(&mut self, text: &str) {
        if self.text_truncated {
            return;
        }
        for character in text.chars() {
            if self.text.len() + character.len_utf8() > 12_000 {
                self.text_truncated = true;
                break;
            }
            self.text.push(character);
        }
    }
    fn event(&mut self, event: &Value) -> Result<(), String> {
        if event["type"] == "extension_ui_request"
            && matches!(
                event["method"].as_str(),
                Some("notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text")
            )
        {
            return Ok(());
        }
        match event["type"].as_str() {
            Some("tool_execution_start" | "bash_execution_update") if !self.native => {
                self.unsafe_activity = true;
                return Err("Pi 在文本模式报告了额外执行活动。".into());
            }
            Some("tool_execution_start")
                if self.native
                    && !matches!(
                        event["toolName"].as_str(),
                        Some("read" | "write" | "edit" | "powershell" | "ask_user")
                    ) =>
            {
                self.unsafe_activity = true;
                return Err("Pi 原生模式报告了计划外的工具。".into());
            }
            Some("extension_ui_request") if self.manual && self.invoked => {
                let response = crate::cli_process::rpc_interaction(event, &self.session_id)?;
                writeln!(self.input, "{}", response["native_response"])
                    .and_then(|_| self.input.flush())
                    .map_err(|_| "Pi 回应通道已关闭。")?;
                crate::cli_process::interaction_written(&response["interaction_id"]);
            }
            Some("extension_ui_request") => {
                self.unsafe_activity = true;
                return Err("Pi 报告了未授权的扩展交互。".into());
            }
            Some("tool_execution_start" | "tool_execution_end") if self.native => {
                self.tools.record(event)?
            }
            Some("agent_start") if self.invoked => {
                self.started = true;
                self.completed = None;
                self.settled = false;
                self.aborted = false;
                self.text.clear();
                self.text_truncated = false;
            }
            Some("message_update")
                if self.started && event["assistantMessageEvent"]["type"] == "text_delta" =>
            {
                if let Some(delta) = event["assistantMessageEvent"]["delta"].as_str() {
                    self.append(delta);
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
            Some("message_end") if self.started && event["message"]["role"] == "assistant" => {
                let message = &event["message"];
                let parts = message["content"]
                    .as_array()
                    .ok_or("Pi 完成消息缺少内容数组。")?;
                if parts.iter().any(|part| part["type"] == "toolCall") && !self.native {
                    self.unsafe_activity = true;
                    return Err("Pi 文本模式出现工具调用。".into());
                }
                self.text.clear();
                self.text_truncated = false;
                for part in parts {
                    if part["type"] == "text" {
                        self.append(part["text"].as_str().unwrap_or(""));
                    }
                }
                self.completed = Some(message.clone());
            }
            Some("agent_settled") if self.started && self.completed.is_some() => {
                self.settled = true;
                self.aborted = event["aborted"] != false;
            }
            _ => {}
        }
        Ok(())
    }
    fn receive(&self, deadline: Instant) -> Result<Value, String> {
        self.messages
            .recv_timeout(
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or("Pi 原生请求超时。")?,
            )
            .map_err(|_| "Pi 原生请求超时或连接已断开。".to_string())?
    }
    fn request(
        &mut self,
        id: &str,
        command: &str,
        mut fields: Value,
        deadline: Instant,
    ) -> Result<Value, String> {
        fields["id"] = json!(id);
        fields["type"] = json!(command);
        writeln!(self.input, "{fields}")
            .and_then(|_| self.input.flush())
            .map_err(|_| "Pi 原生通道已关闭。")?;
        loop {
            let value = self.receive(deadline)?;
            if value["type"] == "response" && value["id"] == id {
                if value["command"] != command || value["success"] != true {
                    return Err(format!("Pi 未接受 {command} 请求。"));
                }
                return Ok(value["data"].clone());
            }
            self.event(&value)?;
        }
    }
    fn confirm_idle(&mut self, id: &str, deadline: Instant) -> Result<Value, String> {
        let state = self.request(id, "get_state", json!({}), deadline)?;
        if state["isStreaming"] != false
            || state["isCompacting"] != false
            || state["pendingMessageCount"] != 0
            || !state["sessionFile"].is_null()
        {
            return Err("Pi 会话尚未空闲或未确认使用内存会话。".into());
        }
        Ok(state)
    }
}

pub(crate) fn perform(args: &Value) -> Result<Value, String> {
    let plan = &args["permission_plan"];
    let native = plan["tool_mode"] == "native";
    let manual = plan["approval_mode"] == "manual";
    if !native && plan["tool_mode"] != "disabled" {
        return Err("Pi 工具模式无效。".into());
    }
    let sandbox: Option<troop_mcp::containment::Config> = if native {
        Some(
            serde_json::from_value(plan["sandbox_config"].clone())
                .map_err(|_| "Pi 隔离计划缺失。")?,
        )
    } else {
        None
    };
    let program = Path::new(plan["program"].as_str().ok_or("Pi 程序身份缺失。")?);
    let _program = troop_mcp::program::admit(
        program,
        plan["program_sha256"].as_str().ok_or("Pi 程序指纹缺失。")?,
    )?;
    let mut version = Command::new(program);
    version.arg("--version");
    if let Some(policy) = &sandbox {
        version.current_dir(args["workspace"].as_str().ok_or("Pi 工作区缺失。")?);
        crate::cli_process::confirm_version(version, policy, "1.5.0")?;
    } else {
        let checked = crate::tools::command(version, 5, false, None)?;
        if checked["exit_code"] != 0 || checked["stdout"].as_str().map(str::trim) != Some("1.5.0") {
            return Err("当前 Pi 版本尚未匹配已验证的 RPC 契约。".into());
        }
    }
    let directory = Path::new(
        args["client_directory"]
            .as_str()
            .ok_or("Pi 隔离目录缺失。")?,
    );
    fs::create_dir(directory).map_err(|_| "无法创建 Pi 单次隔离目录。")?;
    let mut command = Command::new(program);
    command
        .current_dir(if native { Path::new(args["workspace"].as_str().ok_or("Pi 工作区缺失。")?) } else { directory })
        .args([
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-mcp",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-themes",
            "--no-approve",
            "--offline",
            "--system-prompt",
            if native { "You are a delegated assistant. Complete the supplied task within the host's enforced execution scope." } else { "You are a delegated text-only assistant. Use only the task text supplied by the host." },
        ])
        .env("PI_TELEMETRY", "0")
        .env("PI_SKIP_VERSION_CHECK", "1");
    if native {
        command.args([
            "--tools",
            if manual {
                "read,powershell,edit,write,ask_user"
            } else {
                "read,powershell,edit,write"
            },
        ]);
        let profile = Path::new(
            plan["engine_runtime_directory"]
                .as_str()
                .ok_or("Pi 运行配置目录缺失。")?,
        );
        fs::create_dir(profile).map_err(|_| "无法创建 Pi 单次无凭据配置目录。")?;
        if manual {
            if plan["interaction_extension_sha256"]
                != crate::tools::hash(INTERACTION_EXTENSION.as_bytes())
            {
                return Err("Pi 交互扩展身份与计划不符。".into());
            }
            let extension = profile.join("troop-interaction.mjs");
            fs::write(&extension, INTERACTION_EXTENSION).map_err(|_| "无法准备 Pi 交互扩展。")?;
            command
                .arg("--extension")
                .arg(troop_mcp::program::execution_path(
                    extension.to_str().ok_or("Pi 扩展路径编码无效。")?,
                ));
        }

        command.env(
            "PI_CODING_AGENT_DIR",
            troop_mcp::program::execution_path(profile.to_str().ok_or("Pi 运行目录编码无效。")?),
        );
        if plan["model_selection"].is_object() {
            command.arg("--provider").arg(
                plan["model_selection"]["provider"]
                    .as_str()
                    .ok_or("Pi 提供方无效。")?,
            );
            command.arg("--model").arg(
                plan["model_selection"]["model"]
                    .as_str()
                    .ok_or("Pi 模型无效。")?,
            );
        }
        let temporary = command.get_current_dir().unwrap().to_owned();
        command.env("TEMP", &temporary).env("TMP", &temporary);
        for key in plan["credential_env_keys"]
            .as_array()
            .ok_or("Pi 凭据引用计划缺失。")?
        {
            let key = key.as_str().ok_or("Pi 凭据引用无效。")?;
            let value = std::env::var(key)
                .ok()
                .filter(|value| !value.is_empty())
                .ok_or("Pi 已授权的凭据环境变量不可用。")?;
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
                    if sender
                        .send(serde_json::from_str(&line).map_err(|_| "Pi 返回无效协议帧。".into()))
                        .is_err()
                    {
                        break;
                    }
                }
                _ => {
                    let _ = sender.send(Err("Pi 协议帧超出容量或读取失败。".into()));
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
        messages,
        text: String::new(),
        text_truncated: false,
        last_progress: Instant::now(),
        invoked: false,
        started: false,
        settled: false,
        aborted: false,
        completed: None,
        unsafe_activity: false,
        tools: crate::cli_process::ToolEvidence::default(),
    };
    let timeout = args["timeout_seconds"]
        .as_str()
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|seconds| (1..=3600).contains(seconds))
        .ok_or("Pi 执行时限无效。")?;
    let end = Instant::now() + Duration::from_secs(timeout);
    let startup = crate::cli_process::startup_deadline(args, end);
    let outcome = (|| {
        session.request("retry", "set_auto_retry", json!({"enabled":false}), startup)?;
        session.request(
            "compact",
            "set_auto_compaction",
            json!({"enabled":false}),
            startup,
        )?;
        let initial = session.confirm_idle("initial", startup)?;
        if initial["messageCount"] != 0
            || !initial["sessionId"].is_string()
            || !initial["model"]["id"].is_string()
            || initial["model"]["id"] == "unknown"
            || initial["model"]["provider"] == "unknown"
            || initial["autoCompactionEnabled"] != false
        {
            return Err("Pi 初始会话、模型或压缩配置无效，未提交目标。".into());
        }
        let commands = session.request("resources", "get_commands", json!({}), startup)?;
        if !commands["commands"].as_array().is_some_and(Vec::is_empty) {
            return Err("Pi 未确认关闭额外命令资源，未提交目标。".into());
        }
        session.session_id = initial["sessionId"].as_str().unwrap().to_owned();
        let prompt = crate::cli_process::task_prompt(args);
        if native {
            session.invoked = true;
        }
        let accepted = session.request("troop-prompt", "prompt", json!({"message":prompt}), end)?;
        if accepted["disposition"] != "started" {
            return Err("Pi 目标未作为新模型请求启动。".into());
        }
        session.invoked = true;
        while !session.settled || session.completed.is_none() {
            let event = session.receive(end)?;
            session.event(&event)?;
        }
        let final_state = session.confirm_idle("final", end)?;
        if final_state["sessionId"] != initial["sessionId"] {
            return Err("Pi 会话身份在执行中变化。".into());
        }
        if final_state["model"] != initial["model"] || !session.tools.complete() {
            return Err("Pi 模型或原生工具完成证据未核实。".into());
        }
        let commands = session.request("final-resources", "get_commands", json!({}), end)?;
        if !commands["commands"].as_array().is_some_and(Vec::is_empty) {
            session.unsafe_activity = true;
            return Err("Pi 运行中出现额外命令资源。".into());
        }
        let reason = session.completed.as_ref().unwrap()["stopReason"]
            .as_str()
            .unwrap_or("");
        let completed = !session.aborted && reason == "stop";
        Ok(json!({
            "exit_code": 0,
            "turn_status": if completed { "completed" } else { "failed" },
            "error_info": if completed { Value::Null } else { json!("native_prompt_failed") },
            "text": session.text,
            "text_truncated": session.text_truncated,
            "effect_unknown": native && !completed,
            "tool_calls": session.tools.calls,
            "tool_call_count": session.tools.count,
            "tool_calls_truncated": session.tools.count > 32,
            "tools_disabled": !native,
            "tools_evidence": if native { "pinned 1.5.0 native tools within the recorded BaseContainer; RPC has no active-tools readback" } else { "pinned 1.5.0 --no-tools and disabled resources; RPC has no active-tools readback" },
            "session_settled": true,
            "session_id": initial["sessionId"],
            "version": "1.5.0",
            "model": initial["model"]["id"].as_str().unwrap_or("").chars().take(200).collect::<String>(),
            "provider": initial["model"]["provider"].as_str().unwrap_or("").chars().take(100).collect::<String>()
        }))
    })();
    if session.unsafe_activity || native && session.invoked && outcome.is_err() {
        return Ok(json!({
            "exit_code": 1,
            "turn_status": "failed",
            "effect_unknown": true,
            "tools_disabled": false,
            "error_info": if session.unsafe_activity { "unexpected_native_execution" } else { "native_runtime_unconfirmed" },
            "tool_calls": session.tools.calls,
            "text": session.text,
            "text_truncated": session.text_truncated
        }));
    }
    outcome
}
