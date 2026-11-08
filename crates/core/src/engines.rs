use serde_json::{json, Value};
use std::{env, fs::File, io::Read, path::PathBuf};

const CLI_ENGINES: &[(&str, &str, &str, Option<&str>)] = &[
    (
        "claude",
        "Claude Code",
        "claude",
        Some("@anthropic-ai/claude-code"),
    ),
    ("codex", "Codex", "codex", Some("@openai/codex")),
    ("pi", "Pi", "pi", Some("@earendil-works/pi-coding-agent")),
    ("opencode", "OpenCode", "opencode", Some("opencode-ai")),
];

pub(crate) fn require_enabled(engine: &str) -> Result<(), String> {
    if CLI_ENGINES.iter().any(|(id, ..)| *id == engine) {
        Ok(())
    } else {
        Err("当前仅接入 Claude Code、Codex、Pi 和 OpenCode，请选择当前支持的引擎。".into())
    }
}

pub(crate) fn launcher(command: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .take(256)
        .flat_map(|directory| {
            [".exe", ".cmd", ".ps1"]
                .map(|extension| directory.join(format!("{command}{extension}")))
        })
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
}

fn package_version(launcher: &std::path::Path, package: Option<&str>) -> Option<String> {
    let package_file = launcher
        .parent()?
        .join("node_modules")
        .join(package?)
        .join("package.json");
    let mut content = String::new();
    File::open(package_file)
        .ok()?
        .take(32_001)
        .read_to_string(&mut content)
        .ok()?;
    if content.len() > 32_000 {
        return None;
    }
    let metadata: Value = serde_json::from_str(&content).ok()?;
    let version = metadata["version"].as_str()?;
    (version.len() <= 80
        && !version.is_empty()
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte)))
    .then(|| version.to_owned())
}

pub(crate) fn interactions(engine: &str) -> Value {
    let (version, questions, approvals, reason) = match engine {
        "codex" => (
            "0.166.0",
            "native_fixed_choices",
            "reject_or_scope_change",
            "原生批准可能触发脱离原沙箱的重试。当前支持拒绝或停止后重新授权。",
        ),
        "copilot" => (
            "1.0.107",
            "sdk_questions",
            "acp_allow_once",
            "原生 RPC 问答通道仅开放 ask_user，ACP 通道承接工具执行与审批。",
        ),
        "claude" => (
            "2.1.319",
            "manual_control_request",
            "manual_allow_once",
            "人工模式使用 stream-json 控制请求，工具集合固定。",
        ),
        "pi" => (
            "1.5.0",
            "bundled_rpc_extension",
            "manual_allow_once",
            "人工模式加载内置执行前回调，扩展摘要固定在权限计划中。",
        ),
        "oh-my-pi" => (
            "18.14.0",
            "bundled_rpc_extension",
            "manual_allow_once",
            "人工模式加载内置执行前回调，扩展摘要固定在权限计划中。",
        ),
        "opencode" => (
            "1.19.5",
            "unavailable",
            "allow_once_with_correlated_parameters",
            "审批按同会话工具调用关联结构化参数，参数缺失、冲突或越界时阻断批准。",
        ),
        "grok" => (
            "1.0.70",
            "unavailable",
            "manual_unavailable",
            "实测 ACP 未发出人工审批，人工模式启动已阻断。",
        ),
        _ => return Value::Null,
    };
    json!({"contract_version":1,"required_version":version,"questions":questions,"permissions":approvals,"reason":reason,"plans":if engine=="codex" {"versioned_confirmation"} else {"unavailable"},"scope_change":"stop_reconcile_reauthorize_linked_run","persistent_allow":"unavailable","secret_input":"unavailable","free_text":"unavailable","restart":"reconcile_without_reply_replay"})
}

pub fn list(input: Value) -> Result<Value, String> {
    if input != json!({}) {
        return Err("引擎查询参数无效。".into());
    }
    Ok(json!(CLI_ENGINES.iter().map(|(id,name,command,package)| {
        let path = launcher(command);
        let version = path.as_ref().and_then(|path| package_version(path,*package));
        json!({"id":id,"name":name,"installed":path.is_some(),"launcher":path.as_ref().map(|path|path.to_string_lossy()),
            "version":version,"version_evidence":if version.is_some(){"package_metadata"}else{"unverified"},
            "execution_available":path.is_some(),"permissions":"unverified","model_access":"unverified",
            "interactions":interactions(id),
            "group_delivery":{"contract_version":1,"required_version":interactions(id)["required_version"],"initial_context":"new_run_bounded_group_envelope","busy":"ordered_queue","adoption":if *id=="codex"{"completed_turn_with_thread_and_turn_ids"}else{"completed_settled_session"},"reply":"reviewed_complete_evidence_structured_result","stop":"owned_process_stop_and_reconcile","restart":"reconcile_without_automatic_replay","internal_usage":"unobservable_chain_start_and_deadline_caps"},
            "required_action":if path.is_some(){"validate_managed_execution_and_permissions"}else{"install_engine"}})
    }).collect::<Vec<_>>()))
}
