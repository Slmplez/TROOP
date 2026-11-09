use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() {
    if std::env::args().any(|arg| arg == "--version") {
        println!("codex-cli 0.166.0");
        return;
    }
    let thread_id = if std::path::Path::new("long-native-identities").exists() {
        "x".repeat(7000)
    } else {
        "owned-thread".into()
    };
    let question_id = if std::path::Path::new("constructor-question").exists() {
        "constructor"
    } else {
        "target"
    };
    let mut stdout = io::stdout();
    let mut remaining_questions = 0;
    let mut question_number = 0;
    let mut repeated = false;
    for line in io::stdin().lock().lines() {
        let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if value["id"] == "owned-permission" && value.get("method").is_none() {
            assert_eq!(value["result"]["decision"], "decline");
            writeln!(stdout,"{}",json!({"method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":"owned-turn","status":"completed"}}})).unwrap();
            stdout.flush().unwrap();
            continue;
        }
        if value["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("owned-question"))
            && value.get("method").is_none()
        {
            let answer = value["result"]["answers"][question_id]["answers"][0]
                .as_str()
                .unwrap();
            std::fs::write("answer.txt", answer).unwrap();
            if !repeated
                && (std::path::Path::new("duplicate-question").exists()
                    || std::path::Path::new("conflicting-question").exists())
            {
                repeated = true;
                let question = if std::path::Path::new("conflicting-question").exists() {
                    "Changed owned target"
                } else {
                    "Choose an owned target"
                };
                writeln!(stdout,"{}",json!({"id":"owned-question","method":"item/tool/requestUserInput","params":{"threadId":thread_id,"turnId":"owned-turn","itemId":"owned-item","questions":[{"id":question_id,"question":question,"options":[{"label":"alpha","description":"Owned alpha"},{"label":"beta","description":"Owned beta"}]}]}})).unwrap();
                stdout.flush().unwrap();
                continue;
            }
            if remaining_questions > 0 {
                remaining_questions -= 1;
                question_number += 1;
                writeln!(stdout,"{}",json!({"id":format!("owned-question-{question_number}"),"method":"item/tool/requestUserInput","params":{"threadId":thread_id,"turnId":"owned-turn","questions":[{"id":question_id,"question":"Choose an owned target","options":[{"label":"alpha"},{"label":"beta"}]}]}})).unwrap();
                stdout.flush().unwrap();
                continue;
            }

            writeln!(stdout,"{}",json!({"method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":"owned-turn","status":"completed"}}})).unwrap();
            stdout.flush().unwrap();
            continue;
        }
        let method = value["method"].as_str().unwrap_or("");
        let result = match method {
            "initialize" => json!({"userAgent":"owned-cli-probe"}),
            "config/read" => json!({"config":{"mcp_servers":{}}}),
            "thread/start" => {
                if std::path::Path::new("profile-mismatch").exists() {
                    writeln!(stdout, "{}", json!({"id":value["id"],"result":{"thread":{"id":thread_id},"activePermissionProfile":{"id":"unexpected-profile"},"approvalPolicy":"never"}})).unwrap();
                    stdout.flush().unwrap();
                    continue;
                }
                json!({"thread":{"id":thread_id},"activePermissionProfile":{"id":value["params"]["permissions"]},"approvalPolicy":"never"})
            }
            "turn/start" => {
                let prompt = value["params"]["input"][0]["text"].as_str().unwrap();
                let goal = prompt
                    .rsplit_once("Task input as JSON:\n")
                    .map(|(_, encoded)| serde_json::from_str::<String>(encoded).unwrap());
                let prompt = goal.as_deref().unwrap_or(prompt);
                if prompt.contains("G2_WAIT_BEFORE_REPLY") {
                    std::fs::write("group-started.txt", "received").unwrap();
                    std::thread::sleep(std::time::Duration::from_secs(5));
                }
                if prompt == "ask owned question"
                    && std::path::Path::new("unsupported-question").exists()
                {
                    std::fs::write("previous-step.txt", "owned effect").unwrap();
                    writeln!(stdout,"{}",json!({"id":value["id"],"result":{"turn":{"id":"owned-turn","status":"inProgress"}}})).unwrap();
                    writeln!(stdout,"{}",json!({"id":"unsupported-question","method":"item/tool/requestUserInput","params":{"threadId":thread_id,"turnId":"owned-turn","questions":[{"id":question_id,"question":"Owned unsupported question","options":[]}]}})).unwrap();
                    stdout.flush().unwrap();
                    continue;
                }
                if prompt == "request owned permission" {
                    writeln!(stdout,"{}",json!({"id":value["id"],"result":{"turn":{"id":"owned-turn","status":"inProgress"}}})).unwrap();
                    writeln!(stdout,"{}",json!({"id":"owned-permission","method":"item/commandExecution/requestApproval","params":{"threadId":thread_id,"turnId":"owned-turn","itemId":"owned-command","command":"Write-Output TROOP_PERMISSION_TEST","cwd":std::env::current_dir().unwrap()}})).unwrap();
                    stdout.flush().unwrap();
                    continue;
                }
                if matches!(prompt, "ask owned question" | "many owned questions")
                    || prompt.contains("followup owned question")
                {
                    if prompt == "many owned questions" {
                        remaining_questions = 35;
                    }

                    writeln!(stdout,"{}",json!({"id":value["id"],"result":{"turn":{"id":"owned-turn","status":"inProgress"}}})).unwrap();
                    writeln!(stdout,"{}",json!({"id":"owned-question","method":"item/tool/requestUserInput","params":{"threadId":thread_id,"turnId":"owned-turn","itemId":"owned-item","questions":[{"id":question_id,"question":"Choose an owned target","options":[{"label":"alpha","description":"Owned alpha"},{"label":"beta","description":"Owned beta"}]}]}})).unwrap();
                    stdout.flush().unwrap();
                    continue;
                }
                if prompt == "hold" {
                    for n in 0..600 {
                        std::fs::write("heartbeat.txt", n.to_string()).unwrap();
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
                if matches!(prompt, "delete input" | "replace input with directory") {
                    std::fs::remove_file("input.txt").unwrap();
                    if prompt == "replace input with directory" {
                        std::fs::create_dir("input.txt").unwrap();
                    }
                }
                if prompt == "scoped output" {
                    // Deliberately untrusted boundary data tests capture filtering,
                    // not a native OS sandbox.
                    std::fs::write("outside.txt", "outside the capture scope").unwrap();
                    std::fs::write("allowed/result.txt", "owned scoped output").unwrap();
                } else if !prompt.contains("troop_group_reply") {
                    std::fs::write("result.txt", "owned CLI output").unwrap();
                }
                let text = if prompt.contains("owned followup fixture") {
                    std::fs::read_to_string("followup-result.json").unwrap()
                } else if prompt.contains("troop_group_reply") {
                    json!({"troop_group_reply":{"body":"Owned Codex group reply","mention_agent_ids":[],"broadcast":false}}).to_string()
                } else {
                    "Owned CLI task finished".into()
                };
                writeln!(stdout,"{}",json!({"method":"item/agentMessage/delta","params":{"threadId":thread_id,"turnId":"owned-turn","delta":text}})).unwrap();
                writeln!(stdout,"{}",json!({"id":value["id"],"result":{"turn":{"id":"owned-turn","status":"inProgress"}}})).unwrap();
                writeln!(stdout,"{}",json!({"method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":"owned-turn","status":"completed"}}})).unwrap();
                stdout.flush().unwrap();
                continue;
            }
            _ => continue,
        };
        writeln!(stdout, "{}", json!({"id":value["id"],"result":result})).unwrap();
        stdout.flush().unwrap();
    }
}
