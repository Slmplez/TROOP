//! Controlled stream-json peer, exercising the public managed CLI path.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
fn emit(value: Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}
fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.iter().any(|argument| argument == "--version") {
        println!("2.1.319 (Claude Code)");
        return;
    }
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if request["type"] == "control_request" {
            emit(
                json!({"type":"control_response","response":{"subtype":"success","request_id":request["request_id"],"response":{}}}),
            );
        }
        if request["type"] == "user" {
            if request.to_string().contains("G2_WAIT_BEFORE_REPLY") {
                std::fs::write("group-started.txt", "received").unwrap();
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
            let valid = std::env::var("ANTHROPIC_AUTH_TOKEN").ok().as_deref()
                == Some("TROOP_CLAUDE_TEST_CREDENTIAL")
                && std::env::var("TROOP_UNSELECTED_TOKEN").is_err();
            emit(
                json!({"type":"system","subtype":"init","session_id":"owned-claude-session","tools":if arguments.iter().any(|argument|argument=="Read,Write,Edit,PowerShell"){json!(["Read","Write","Edit","PowerShell"])}else{json!([])},"mcp_servers":[],"model":"owned-claude-model","permissionMode":if arguments.iter().any(|argument|argument=="bypassPermissions"){"bypassPermissions"}else{"dontAsk"}}),
            );
            if request.to_string().contains("33 complete tools") {
                for call in 0..33 {
                    emit(
                        json!({"type":"assistant","session_id":"owned-claude-session","message":{"content":[{"type":"tool_use","id":format!("owned-{call}"),"name":"Read","input":{"file_path":"input.txt"}}]}}),
                    );
                    emit(
                        json!({"type":"user","session_id":"owned-claude-session","message":{"content":[{"type":"tool_result","tool_use_id":format!("owned-{call}"),"content":"owned read"}]}}),
                    );
                }
            }
            if request.to_string().contains("unexpected background task") {
                emit(
                    json!({"type":"system","subtype":"task_started","session_id":"owned-claude-session","task_id":"unplanned-task"}),
                );
            }
            let text = if valid && request.to_string().contains("owned followup fixture") {
                std::fs::read_to_string("followup-result.json").unwrap()
            } else if valid && request.to_string().contains("troop_group_reply") {
                json!({"troop_group_reply":{"body":"Owned Claude group reply","mention_agent_ids":[],"broadcast":false}}).to_string()
            } else if valid {
                "Owned Claude text result".into()
            } else {
                "Missing configured credential".into()
            };
            emit(
                json!({"type":"result","subtype":"success","is_error":false,"session_id":"owned-claude-session","permission_denials":[],"result":text}),
            );
        }
    }
}
