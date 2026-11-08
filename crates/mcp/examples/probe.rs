//! Deterministic transport harness, not an IPC endpoint or permission bypass.
use serde::Deserialize;
use serde_json::json;
use std::{collections::BTreeMap, io::Read, time::Duration};
#[derive(Deserialize)]
struct Input {
    endpoint: Option<String>,
    #[serde(default)]
    legacy: bool,
    stdio: Option<troop_mcp::StdioConfig>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default = "deadline")]
    timeout_ms: u64,
    #[serde(default)]
    call: bool,
    #[serde(default)]
    second: bool,
    abort_after_ms: Option<u64>,
}
fn deadline() -> u64 {
    1500
}
#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--mcp-stdio-worker") {
        let code = if troop_mcp::worker::run().is_ok() {
            0
        } else {
            1
        };
        std::process::exit(code);
    }
    let mut text = String::new();
    std::io::stdin()
        .take(65_537)
        .read_to_string(&mut text)
        .unwrap();
    let i: Input = serde_json::from_str(&text).unwrap();
    let d = Duration::from_millis(i.timeout_ms);
    let opened = if let Some(config) = i.stdio {
        troop_mcp::Client::stdio(&std::env::current_exe().unwrap(), config, d).await
    } else {
        troop_mcp::Client::http(i.endpoint.as_deref().unwrap(), i.headers, i.legacy, d).await
    };
    let mut c = match opened {
        Ok(c) => c,
        Err(e) => {
            println!("{}", json!({"open_error":e}));
            return;
        }
    };
    let tools = c.tools(d).await;
    let mut out = json!({"tools":tools.as_ref().ok(),"list_error":tools.as_ref().err()});
    if i.call {
        let r = if let Some(ms) = i.abort_after_ms {
            match tokio::time::timeout(
                Duration::from_millis(ms),
                c.call("echo", json!({"text":"中文"}), d),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => Err(troop_mcp::Failure {
                    kind: "Caller cancelled future".into(),
                    indeterminate: true,
                }),
            }
        } else {
            c.call("echo", json!({"text":"中文"}), d).await
        };
        out["call"] = json!(r.as_ref().ok());
        out["error"] = json!(r.as_ref().err());
    }
    if i.second {
        let r = c.call("echo", json!({}), d).await;
        out["second_error"] = json!(r.as_ref().err());
    }
    out["changed"] = json!(c.tools_changed);
    out["close_error"] = json!(c.close().await.err());
    println!("{out}");
}
