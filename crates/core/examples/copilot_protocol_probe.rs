//! Controlled ACP peer. It exercises Core lifecycle independently of model quality.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
fn emit(value: Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}
fn emit_sdk(value: Value) {
    let text = value.to_string();
    print!("Content-Length: {}\r\n\r\n{}", text.len(), text);
    io::stdout().flush().unwrap();
}
fn sdk_peer() {
    use std::io::Read;
    let mut reader = io::stdin().lock();
    let mut session = String::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap() == 0 {
            break;
        }
        let size = header
            .strip_prefix("Content-Length: ")
            .unwrap()
            .trim()
            .parse::<usize>()
            .unwrap();
        assert!(size < 65536);
        let mut separator = [0; 2];
        reader.read_exact(&mut separator).unwrap();
        assert_eq!(separator, *b"\r\n");
        let mut bytes = vec![0; size];
        reader.read_exact(&mut bytes).unwrap();
        let request: Value = serde_json::from_slice(&bytes).unwrap();
        let event = |kind: &str, data: Value| json!({"jsonrpc":"2.0","method":"session.event","params":{"sessionId":session,"event":{"type":kind,"data":data}}});
        if request["id"] == "owned-sdk-question" && request.get("method").is_none() {
            assert_eq!(request["result"]["answer"], "Alpha");
            emit_sdk(event(
                "tool.execution_complete",
                json!({"toolCallId":"owned-sdk-tool","success":true,"result":{"content":"Alpha"}}),
            ));
            emit_sdk(event(
                "assistant.message",
                json!({"content":"Owned SDK question complete","messageId":"owned-sdk-answer"}),
            ));
            emit_sdk(event("session.idle", json!({"aborted":false})));
            continue;
        }
        let result = match request["method"].as_str().unwrap_or("") {
            "ping" => json!({"protocolVersion":2}),
            "session.create" => {
                session = request["params"]["sessionId"].as_str().unwrap().to_owned();
                assert_eq!(request["params"]["availableTools"], json!(["ask_user"]));
                json!({"sessionId":session})
            }
            "session.send" => {
                let prompt = request["params"]["prompt"].as_str().unwrap();
                let late = prompt.contains("late sdk message")
                    || prompt.contains("mismatched sdk message");
                let input_id = if prompt.contains("mismatched sdk message") {
                    "wrong-sdk-input"
                } else {
                    "owned-sdk-input"
                };
                if late {
                    emit_sdk(
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"messageId":"owned-sdk-input"}}),
                    );
                }
                // A delayed startup idle must not complete the just-submitted task.
                emit_sdk(event("session.idle", json!({"aborted":false})));
                emit_sdk(event(
                    "user.message",
                    json!({"content":request["params"]["prompt"],"messageId":input_id}),
                ));
                emit_sdk(event(
                    "assistant.turn_start",
                    json!({"turnId":"owned-sdk-turn"}),
                ));
                let unexpected = request["params"]["prompt"]
                    .as_str()
                    .unwrap()
                    .contains("unexpected sdk tool");
                emit_sdk(event(
                    "tool.execution_start",
                    json!({"toolCallId":"owned-sdk-tool","toolName":if unexpected {"powershell"} else {"ask_user"},"arguments":{"question":"Choose a synthetic target","choices":["Alpha","Beta"]}}),
                ));
                if !late {
                    emit_sdk(
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"messageId":"owned-sdk-input"}}),
                    );
                }
                emit_sdk(
                    json!({"jsonrpc":"2.0","id":"owned-sdk-question","method":"userInput.request","params":{"sessionId":session,"question":"Choose a synthetic target","choices":["Alpha","Beta"],"allowFreeform":false}}),
                );
                continue;
            }
            _ => continue,
        };
        emit_sdk(json!({"jsonrpc":"2.0","id":request["id"],"result":result}));
    }
}
fn main() {
    if std::env::args().any(|argument| argument == "--version") {
        println!("GitHub Copilot CLI 1.0.107.\nRun 'copilot update' to check for updates.");
        return;
    }
    if std::env::args().any(|argument| argument == "--headless") {
        sdk_peer();
        return;
    }
    let mut pending_prompt = Value::Null;
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if request["id"] == "owned-permission" && request.get("method").is_none() {
            let allowed = request["result"]["outcome"]["optionId"] == "once";
            assert!(allowed || request["result"]["outcome"]["optionId"] == "reject");
            if allowed {
                std::fs::write("approved.txt", "owned approved effect").unwrap();
            }
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"owned-create","status":"completed","content":[{"type":"text","text":"owned"}]}}}),
            );
            emit(
                json!({"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"owned-session","type":"session.idle","data":{}}}),
            );
            emit(json!({"jsonrpc":"2.0","id":pending_prompt,"result":{"stopReason":"end_turn"}}));
            continue;
        }
        let result = match request["method"].as_str().unwrap_or("") {
            "initialize" => json!({"protocolVersion":1}),
            "session/new" => json!({"sessionId":"owned-session"}),
            "session/prompt" => {
                let input = request["params"]["prompt"][0]["text"].as_str().unwrap();
                emit(
                    json!({"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"owned-session","type":"assistant.turn_start","data":{}}}),
                );
                if input.contains("owned approval") {
                    pending_prompt = request["id"].clone();
                    let mut call = json!({"toolCallId":"owned-create","kind":"edit","name":"create","rawInput":{"path":"approved.txt","content":"owned approved effect"},"status":"in_progress"});
                    if input.contains("filtered") {
                        call.as_object_mut().unwrap().remove("name");
                    }
                    emit(
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-session","update":{"sessionUpdate":"tool_call","toolCallId":"owned-create","name":call["name"],"rawInput":call["rawInput"],"status":"in_progress"}}}),
                    );
                    emit(
                        json!({"jsonrpc":"2.0","id":"owned-permission","method":"session/request_permission","params":{"sessionId":"owned-session","toolCall":call,"options":[{"optionId":"always","name":"Always allow","kind":"allow_always"},{"optionId":"once","name":"Allow once","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}),
                    );
                    continue;
                }
                if input.contains("unexpected client operation") {
                    emit(
                        json!({"jsonrpc":"2.0","id":"fs-request","method":"fs/write_text_file","params":{"sessionId":"owned-session","path":"bad.txt","content":"bad"}}),
                    );
                    continue;
                }
                if input.contains("unexpected tool event") {
                    emit(
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-session","update":{"sessionUpdate":"tool_call","toolCallId":"bad","name":"powershell"}}}),
                    );
                    continue;
                }
                emit(
                    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Owned Copilot text result"}}}}),
                );
                emit(
                    json!({"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"owned-session","type":"assistant.idle","data":{}}}),
                );
                if input.contains("wait for session idle") {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                }
                if input.contains("hold for revoke") {
                    std::fs::write("started.txt", "owned").unwrap();
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    std::fs::write("late.txt", "bad").unwrap();
                }
                emit(
                    json!({"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"owned-session","type":"session.idle","data":{}}}),
                );
                json!({"stopReason":"end_turn"})
            }
            _ => json!({}),
        };
        if request.get("id").is_some() && request.get("method").is_some() {
            emit(json!({"jsonrpc":"2.0","id":request["id"],"result":result}));
        }
    }
}
