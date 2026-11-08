//! Controlled ACP peer for the public managed OpenCode execution contract.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
fn emit(value: Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}
fn main() {
    if std::env::args().any(|arg| arg == "--version") {
        println!("1.19.5");
        return;
    }
    let mut pending_prompt = Value::Null;
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if request["id"] == "approval" && request.get("method").is_none() {
            let allowed = request["result"]["outcome"]["optionId"] == "once";
            if allowed {
                emit(
                    json!({"jsonrpc":"2.0","id":"editor-mirror","method":"fs/write_text_file","params":{"sessionId":"owned-opencode-session","path":"approved.txt","content":"owned approved effect"}}),
                );
                continue;
            }
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-opencode-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"owned-call","status":if allowed {"completed"} else {"failed"}}}}),
            );
            emit(json!({"jsonrpc":"2.0","id":pending_prompt,"result":{"stopReason":"end_turn"}}));
            continue;
        }
        if request["id"] == "editor-mirror" && request.get("method").is_none() {
            assert_eq!(request["error"]["code"], -32601);
            assert!(!std::path::Path::new("approved.txt").exists());
            std::fs::write("approved.txt", "owned approved effect").unwrap();
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-opencode-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"owned-call","status":"completed"}}}),
            );
            emit(json!({"jsonrpc":"2.0","id":pending_prompt,"result":{"stopReason":"end_turn"}}));
            continue;
        }
        let result = match request["method"].as_str() {
            Some("initialize") => json!({"protocolVersion":1,"agentCapabilities":{}}),
            Some("session/new") => {
                std::env::set_current_dir(request["params"]["cwd"].as_str().unwrap()).unwrap();
                json!({"sessionId":"owned-opencode-session","configOptions":[{"id":"model","currentValue":"owned/fixture"}]})
            }
            Some("session/prompt") => {
                if let Ok(mode) = std::fs::read_to_string("approval-case") {
                    pending_prompt = request["id"].clone();
                    if matches!(
                        mode.as_str(),
                        "terminal-reopen"
                            | "terminal-evicted"
                            | "unfinished-tail"
                            | "finished-tail"
                    ) {
                        let update = |call: usize, initial: bool, completed: bool| {
                            emit(
                                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-opencode-session","update":{"sessionUpdate":if initial {"tool_call"} else {"tool_call_update"},"toolCallId":format!("historical-{call}"),"name":"write","kind":"edit","status":if completed {"completed"} else {"pending"},"rawInput":if initial {json!({"path":"approved.txt","content":"x".repeat(11_000)})} else {json!({})}}}}),
                            );
                        };
                        let total = if mode.ends_with("tail") {
                            33
                        } else if mode == "terminal-evicted" {
                            4
                        } else {
                            1
                        };
                        for call in 0..total {
                            update(call, true, false);
                            if mode != "unfinished-tail" || call < 32 {
                                update(call, false, true);
                            }
                        }
                        if mode.ends_with("tail") {
                            emit(
                                json!({"jsonrpc":"2.0","id":pending_prompt,"result":{"stopReason":"end_turn"}}),
                            );
                            continue;
                        }
                        if mode == "terminal-reopen" {
                            update(0, false, false);
                        }
                        emit(
                            json!({"jsonrpc":"2.0","id":"approval","method":"session/request_permission","params":{"sessionId":"owned-opencode-session","toolCall":{"toolCallId":"historical-0","kind":"edit","rawInput":if mode == "terminal-reopen" {json!({})} else {json!({"path":"approved.txt","content":"new"})}},"options":[{"optionId":"once","kind":"allow_once","name":"Allow once"}]}}),
                        );
                        continue;
                    }
                    let target = if mode == "outside" {
                        "../outside.txt"
                    } else {
                        "approved.txt"
                    };
                    emit(
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-opencode-session","update":{"sessionUpdate":"tool_call","toolCallId":"owned-call","name":"write","kind":"edit","status":"pending","rawInput":{}}}}),
                    );
                    if mode != "missing" {
                        emit(
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-opencode-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"owned-call","rawInput":{"path":target,"content":if mode == "oversized" {"x".repeat(17_000)} else {"owned approved effect".to_owned()}}}}}),
                        );
                    }
                    let mut call = json!({"toolCallId":if mode=="unrelated" {"other-call"}else{"owned-call"},"kind":"edit","status":"pending","rawInput":{},"locations":[]});
                    if mode == "partial" {
                        call["rawInput"] = json!({"path":"approved.txt"});
                    }
                    if mode == "conflict" {
                        call["rawInput"] = json!({"path":"different.txt"});
                    }
                    emit(
                        json!({"jsonrpc":"2.0","id":"approval","method":"session/request_permission","params":{"sessionId":"owned-opencode-session","toolCall":call,"options":[{"optionId":"once","name":"Allow once","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}),
                    );
                    continue;
                }
                let config: Value =
                    serde_json::from_str(&std::env::var("OPENCODE_CONFIG_CONTENT").unwrap())
                        .unwrap();
                let valid = config["provider"]["owned"]["options"]["apiKey"]
                    == "TROOP_OPENCODE_TEST_CREDENTIAL"
                    && config["permission"]["*"] == "deny"
                    && std::env::var("OPENCODE_DISABLE_PROJECT_CONFIG").as_deref() == Ok("1");
                if request.to_string().contains("G2_WAIT_BEFORE_REPLY") {
                    std::fs::write("group-started.txt", "received").unwrap();
                    std::thread::sleep(std::time::Duration::from_secs(5));
                }
                let text = if valid && request.to_string().contains("troop_group_reply") {
                    json!({"troop_group_reply":{"body":"Owned OpenCode group reply","mention_agent_ids":[],"broadcast":false}}).to_string()
                } else if valid {
                    "Owned OpenCode text result".into()
                } else {
                    "Invalid owned model configuration".into()
                };
                emit(
                    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-opencode-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}}),
                );
                json!({"stopReason":"end_turn"})
            }
            _ => json!({}),
        };
        if request.get("id").is_some() {
            emit(json!({"jsonrpc":"2.0","id":request["id"],"result":result}));
        }
    }
}
