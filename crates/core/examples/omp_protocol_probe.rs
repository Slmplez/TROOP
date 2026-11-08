//! Controlled native-protocol boundary used by the public Core RPC tests.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() {
    let native = std::env::args().any(|arg| arg == "--tools");
    if std::env::args().any(|arg| arg == "--version") {
        println!("omp/18.14.0");
        return;
    }
    let mut output = io::stdout();
    let unsafe_tools = std::env::current_exe()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .contains("unsafe-tools");
    writeln!(
        output,
        "{}",
        json!({"type":"ready","protocolVersion":1,"maxFrameBytes":1048576})
    )
    .unwrap();
    output.flush().unwrap();
    let mut late_tools = false;
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let command = request["type"].as_str().unwrap();
        let data = if command == "get_state" {
            json!({"model":{"id":"owned-model","provider":"owned-provider"},"dumpTools":if unsafe_tools || late_tools {json!([{"name":"bash"}])}else if native {json!([{"name":"read"},{"name":"write"},{"name":"edit"},{"name":"bash"}])}else{json!([])},"isSettled":true,"hasPendingAsyncWork":false,"isStreaming":false})
        } else {
            json!({})
        };
        writeln!(output,"{}",json!({"id":request["id"],"type":"response","command":command,"success":true,"data":data})).unwrap();
        if command == "prompt" {
            let message = request["message"].as_str().unwrap();
            if message.contains("contained boundary probe") {
                let goal: String =
                    serde_json::from_str(message.split("Task input as JSON:\n").last().unwrap())
                        .unwrap();
                let input: Value = serde_json::from_str(&goal).unwrap();
                writeln!(output,"{}",json!({"type":"tool_execution_start","toolName":"write","toolCallId":"owned-write","args":{"path":"result.txt"}})).unwrap();
                output.flush().unwrap();
                let audit = json!({"workspace":std::fs::write("result.txt","contained native artifact").is_ok(),"selected_credential":std::env::var("TROOP_PI_TEST_API_KEY").is_ok(),"unselected_credential":std::env::var("TROOP_PI_OTHER_API_KEY").is_ok(),"outside":std::fs::write(input["outside"].as_str().unwrap(),"bad").is_ok(),"readonly":std::fs::write(input["readonly"].as_str().unwrap(),"bad").is_ok()});
                std::fs::write("boundary.json", audit.to_string()).unwrap();
                if input["wait"] == true {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    std::fs::write("late.txt", "bad").unwrap();
                }
                writeln!(output,"{}",json!({"type":"tool_execution_end","toolName":"write","toolCallId":"owned-write","isError":false,"result":{"content":[]}})).unwrap();
            }
            late_tools = message.contains("late tool inventory");
            if message.contains("unexpected tool event") {
                writeln!(
                    output,
                    "{}",
                    json!({"type":"tool_execution_start","toolName":"bash"})
                )
                .unwrap();
                output.flush().unwrap();
                continue;
            }
            let delayed = message.contains("wait for settled");
            if delayed {
                writeln!(output,"{}",json!({"type":"prompt_result","id":"other-prompt","status":"completed","sessionSettled":true})).unwrap();
                writeln!(output, "{}", json!({"type":"session_settled"})).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            let text = if message.contains("long text result") {
                "记忆😀".repeat(2000)
            } else {
                "Owned OMP text result".to_string()
            };
            writeln!(output,"{}",json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":text}})).unwrap();
            writeln!(output,"{}",json!({"type":"prompt_result","id":request["id"],"agentInvoked":true,"status":if message.contains("model failure"){"error"}else{"completed"},"sessionSettled":!delayed})).unwrap();
            output.flush().unwrap();
            if delayed {
                std::thread::sleep(std::time::Duration::from_millis(1200));
            }
            writeln!(output, "{}", json!({"type":"session_settled"})).unwrap();
        }
        output.flush().unwrap();
    }
}
