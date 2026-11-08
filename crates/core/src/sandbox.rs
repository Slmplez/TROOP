//! Fixed MXC process containment. Core owns grants and the outer Windows Job.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Command};
use troop_mcp::program::{check_write_aliases, execution_path};

const EXECUTOR_SHA256: &str = "090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a";

pub(crate) fn stdio_config(grant: &Value) -> Result<troop_mcp::containment::Config, String> {
    let config = troop_mcp::containment::Config {
        adapter: troop_mcp::containment::ADAPTER.into(),
        read_roots: serde_json::from_value(grant["read_roots"].clone())
            .map_err(|_| "MCP 读取目录无效。")?,
        write_roots: serde_json::from_value(grant["write_roots"].clone())
            .map_err(|_| "MCP 写入目录无效。")?,
        network: grant["network"]
            .as_str()
            .ok_or("MCP 网络范围无效。")?
            .into(),
    };
    config.validate()?;
    Ok(config)
}

fn paths(value: &Value) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or("隔离目录计划无效。")?
        .iter()
        .map(|value| {
            let raw = value.as_str().ok_or("隔离目录计划无效。")?;
            let path = PathBuf::from(raw);
            if path.canonicalize().ok() != Some(path) {
                return Err("Shell 授权目录目标已变化。".into());
            }
            Ok(execution_path(raw))
        })
        .collect()
}

#[derive(Default, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct ShellBinding {
    program: String,
    program_sha256: String,
    shell: String,
    shell_sha256: String,
    runtime_read_roots: Vec<String>,
}

fn binding() -> Result<ShellBinding, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("当前 MXC 权限计划仅支持 Windows x64。".into());
    }
    let program = std::env::current_exe()
        .map_err(|_| "无法定位 Core。")?
        .parent()
        .ok_or("Core 目录无效。")?
        .join("mxc/wxc-exec.exe")
        .canonicalize()
        .map_err(|_| "请先运行桌面 scripts/prepare-sandbox.mjs 准备固定 MXC 运行时。")?;
    let hash = troop_mcp::program::fingerprint(&program)?;
    if hash != EXECUTOR_SHA256 {
        return Err("MXC 原生程序与已验证发行版不匹配。".into());
    }
    let shell = crate::tools::host_shell()?;
    let system = shell.ancestors().nth(4).ok_or("系统运行库目录无效。")?;
    Ok(ShellBinding {
        program: program.to_str().ok_or("MXC 路径编码无效。")?.into(),
        program_sha256: hash,
        shell: shell.to_str().ok_or("Shell 路径编码无效。")?.into(),
        shell_sha256: troop_mcp::program::fingerprint(&shell)?,
        runtime_read_roots: vec![system.to_str().ok_or("系统目录编码无效。")?.into()],
    })
}

pub(crate) fn bind(request: &mut ShellBinding) -> Result<(), String> {
    let current = binding()?;
    if *request != ShellBinding::default() && *request != current {
        return Err("Shell 或隔离程序身份已变化，请清空旧绑定后重新确认。".into());
    }
    // Request-specific creation remains fail-closed even after this capability probe.
    let _program =
        troop_mcp::program::admit(&PathBuf::from(&current.program), &current.program_sha256)?;
    let mut probe = Command::new(&current.program);
    probe.arg("--probe");
    let result = crate::tools::command(probe, 5, false, None)?;
    let support: Value = serde_json::from_str(result["stdout"].as_str().unwrap_or(""))
        .map_err(|_| "无法确认 MXC 原生隔离能力。")?;
    if result["exit_code"] != 0 || support["tier"] != "base-container" {
        return Err("此主机缺少已验证的 BaseContainer 能力。".into());
    }
    *request = current;
    Ok(())
}

pub(crate) fn plan(grant: &Value) -> Result<Value, String> {
    let saved: ShellBinding = serde_json::from_value(grant["shell"].clone())
        .map_err(|_| "受限 Shell 需要显式绑定已验证的隔离运行时。")?;
    let current = binding()?;
    if saved != current {
        return Err("Shell 或隔离程序身份已变化，请重新授权。".into());
    }
    paths(&grant["read_roots"])?;
    paths(&grant["write_roots"])?;
    Ok(json!({
        "adapter": "mxc-process-v1", "version": "1.0.1", "contract_version": "1.0.0",
        "binding": saved, "read_roots": grant["read_roots"],
        "write_roots": grant["write_roots"], "network": grant["network"],
        "host_acl_fallback": false, "telemetry": false,
        "write_alias_policy": "reject_existing_hardlinks", "write_tree_scan_limit": 20_000
    }))
}

pub(crate) fn perform(
    workspace: &str,
    name: &str,
    args: &Value,
    plan: &Value,
) -> Result<Value, String> {
    if plan["adapter"] != "mxc-process-v1"
        || !matches!(plan["network"].as_str(), Some("none" | "any"))
    {
        return Err("受限 Shell 执行计划无效。".into());
    }
    let saved: ShellBinding =
        serde_json::from_value(plan["binding"].clone()).map_err(|_| "受限 Shell 程序绑定缺失。")?;
    if saved != binding()? {
        return Err("受限 Shell 程序身份在放行前发生变化。".into());
    }
    let _executor =
        troop_mcp::program::admit(&PathBuf::from(&saved.program), &saved.program_sha256)?;
    let _shell = troop_mcp::program::admit(&PathBuf::from(&saved.shell), &saved.shell_sha256)?;
    let script = format!(
        "$ProgressPreference='SilentlyContinue'\n[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n{}",
        args["command"].as_str().ok_or("命令缺失。")?
    );
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let timeout = args["timeout_seconds"]
        .as_str()
        .and_then(|text| text.parse::<u64>().ok())
        .unwrap_or(60);
    let mut readonly = saved
        .runtime_read_roots
        .iter()
        .map(|path| execution_path(path))
        .collect::<Vec<_>>();
    readonly.extend(paths(&plan["read_roots"])?);
    let write = paths(&plan["write_roots"])?;
    check_write_aliases(&write)?;
    // MXC treats equal readonly/readwrite entries as readonly. Grant read roots
    // are read allowances, so remove entries already covered by a write root.
    readonly.retain(|read| {
        !write
            .iter()
            .any(|write| PathBuf::from(read).starts_with(write))
    });
    let network = if plan["network"] == "any" {
        "allow"
    } else {
        "deny"
    };
    let request = json!({
        "version": "1.0.0", "containment": "processcontainer",
        "fallback": {"allowDaclMutation": false},
        "process": {
            // Windows PowerShell's .NET configuration initialization fails when
            // argv[0] has the extended-length prefix. Identity keeps the canonical path.
            "commandLine": format!("\"{}\" -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand {encoded}", execution_path(&saved.shell)),
            "cwd": execution_path(workspace), "timeout": timeout * 1000
        },
        "filesystem": {"readonlyPaths": readonly, "readwritePaths": write},
        "network": {"egress": {"default": network}, "ingress": {"default": "deny", "hostLoopback": network}},
        "ui": {"disable": false, "clipboard": "none", "injection": false},
        "processContainer": {"ui": {"isolation": "container", "desktopSystemControl": false, "systemSettings": "none", "ime": false}},
        "telemetry": {"enabled": false},
        "lifecycle": {"destroyOnExit": true, "preservePolicy": false}
    });
    let mut command = Command::new(&saved.program);
    command
        .current_dir(workspace)
        .args(["--config-base64", &STANDARD.encode(request.to_string())]);
    let input = if name == "__hook_command" {
        Some(format!(
            "{}\n",
            args["input"].as_str().ok_or("Hook 输入缺失。")?
        ))
    } else {
        None
    };
    let mut result =
        crate::tools::command(command, timeout + 5, name == "start_background", input)?;
    result["sandbox"] = plan.clone();
    Ok(result)
}
