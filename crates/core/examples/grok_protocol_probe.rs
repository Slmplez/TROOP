//! Controlled Grok ACP peer for the public CLI execution boundary.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
fn emit(value: Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}
fn main() {
    if std::env::args().any(|arg| arg == "--version") {
        println!("grok 1.0.70 (f50904eaee6c)");
        return;
    }
    let mut native = false;
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let result = match request["method"].as_str() {
            Some("initialize") => json!({"protocolVersion":1}),
            Some("session/new") => {
                native = request["params"]["_meta"]["agentProfile"]["toolConfig"]["tools"]
                    .as_array()
                    .unwrap()
                    .len()
                    > 1;
                if !native {
                    assert_eq!(
                        request["params"]["_meta"]["agentProfile"]["toolConfig"]["tools"],
                        json!([{"id":"GrokBuild:read_file"}])
                    );
                }
                json!({"sessionId":"owned-grok-session"})
            }
            Some("session/prompt") => {
                assert_eq!(
                    std::env::var(if std::env::var("TROOP_GROK_TEST_API_KEY").is_ok() {
                        assert!(std::env::var("XAI_API_KEY").is_err());
                        "TROOP_GROK_TEST_API_KEY"
                    } else {
                        "XAI_API_KEY"
                    })
                    .as_deref(),
                    Ok("TROOP_GROK_TEST_CREDENTIAL")
                );
                assert!(std::env::var("TROOP_UNSELECTED_API_KEY").is_err());
                if native {
                    emit(
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-grok-session","update":{"sessionUpdate":"tool_call","toolCallId":"owned-read","name":"read_file","rawInput":{"target_file":"input.txt"},"status":"in_progress"}}}),
                    );
                    emit(
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-grok-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"owned-read","status":"completed","content":[{"type":"text","text":"owned"}]}}}),
                    );
                }
                emit(
                    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-grok-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Owned Grok text result"}}}}),
                );
                json!({"stopReason":"end_turn"})
            }
            _ => json!({}),
        };
        emit(json!({"jsonrpc":"2.0","id":request["id"],"result":result}));
    }
}
