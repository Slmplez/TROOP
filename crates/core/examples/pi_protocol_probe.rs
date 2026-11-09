//! Controlled Pi RPC peer for public Core lifecycle tests.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn emit(value: Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}
fn main() {
    let old_version = std::env::current_exe()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .contains("old-version");
    let extra_resources = std::env::current_exe()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .contains("extra-resources");
    if std::env::args().any(|arg| arg == "--version") {
        println!("{}", if old_version { "1.4.0" } else { "1.5.0" });
        return;
    }
    let mut prompted = false;
    let mut message = String::new();
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let command = input["type"].as_str().unwrap();
        let data = match command {
            "get_state" => {
                json!({"sessionId":if prompted && message.contains("changed session"){"other-session"}else{"owned-pi-session"},"model":{"id":"owned-pi-model","provider":"owned-provider"},"isStreaming":false,"isCompacting":false,"pendingMessageCount":0,"messageCount":if prompted{2}else{0},"sessionFile":null,"autoCompactionEnabled":false})
            }
            "get_commands" => {
                json!({"commands":if extra_resources || prompted && message.contains("late resources"){json!([{"name":"unexpected"}])}else{json!([])}})
            }
            "prompt" => {
                // An unrelated idle notification cannot complete the submitted prompt.
                emit(json!({"type":"agent_settled","aborted":false}));
                prompted = true;
                message = input["message"].as_str().unwrap().to_owned();
                json!({"disposition":"started"})
            }
            _ => json!({}),
        };
        emit(
            json!({"type":"response","id":input["id"],"command":command,"success":true,"data":data}),
        );
        if command == "prompt" {
            if message.contains("G2_WAIT_BEFORE_REPLY") {
                std::fs::write("group-started.txt", "received").unwrap();
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
            let delayed = input["message"]
                .as_str()
                .unwrap()
                .contains("wait for settled");
            emit(json!({"type":"agent_start"}));
            if message.contains("contained boundary probe") {
                let encoded = message.split("Task input as JSON:\n").last().unwrap();
                let goal: String = serde_json::from_str(encoded).unwrap();
                let input: Value = serde_json::from_str(&goal).unwrap();
                emit(
                    json!({"type":"tool_execution_start","toolName":"write","toolCallId":"owned-write","args":{"path":"result.txt"}}),
                );
                let audit = json!({
                    "workspace": std::fs::write("result.txt", "contained native artifact").is_ok(),
                    "selected_credential": std::env::var("TROOP_PI_TEST_API_KEY").is_ok(),
                    "unselected_credential": std::env::var("TROOP_PI_OTHER_API_KEY").is_ok(),
                    "outside": std::fs::write(input["outside"].as_str().unwrap(), "bad").is_ok(),
                    "readonly": std::fs::write(input["readonly"].as_str().unwrap(), "bad").is_ok()
                });
                std::fs::write("boundary.json", audit.to_string()).unwrap();
                if input["wait"] == true {
                    emit(
                        json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Working on contained task"}}),
                    );
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    std::fs::write("late.txt", "bad").unwrap();
                }
                emit(
                    json!({"type":"tool_execution_end","toolName":"write","toolCallId":"owned-write","isError":false,"result":{"content":[]}}),
                );
            }
            if message.contains("unexpected tool event") {
                emit(json!({"type":"tool_execution_start","toolName":"bash"}));
                continue;
            }
            if delayed {
                emit(json!({"type":"agent_settled","aborted":false}));
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            let text = if message.contains("owned followup fixture") {
                let encoded = message.split("Task input as JSON:\n").last().unwrap();
                let goal: String = serde_json::from_str(encoded).unwrap();
                goal.lines()
                    .find_map(|line| line.strip_prefix("owned followup fixture result "))
                    .unwrap()
                    .to_owned()
            } else if message.contains("troop_group_reply") {
                json!({"troop_group_reply":{"body":"Owned Pi group reply","mention_agent_ids":[],"broadcast":false}}).to_string()
            } else if message.contains("check delegated memory") {
                if message.contains("TROOP_PRIVATE_CLI_CONTEXT")
                    && message.contains("TROOP_SELECTED_CLI_CONTEXT")
                    && !message.contains("TROOP_UNSELECTED_CLI_CONTEXT")
                {
                    "Owned scoped CLI memory received".into()
                } else {
                    "Missing scoped CLI memory".into()
                }
            } else if message.contains("long text result") {
                "记忆😀".repeat(2000)
            } else {
                "Owned Pi text result".into()
            };
            emit(
                json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":text}}),
            );
            emit(
                json!({"type":"message_end","message":{"role":"assistant","stopReason":if message.contains("model failure"){"error"}else{"stop"},"content":[{"type":"text","text":text}]}}),
            );
            emit(json!({"type":"agent_end","willRetry":false}));
            if delayed {
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    emit(json!({"type":"agent_settled","aborted":false}));
                });
            } else {
                emit(json!({"type":"agent_settled","aborted":false}));
            }
        }
    }
}
