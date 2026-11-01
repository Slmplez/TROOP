use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use troop_protocol::{error, result, Request, MAX_FRAME, METHODS, VERSION};
use troop_storage::Store;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    protocol: u32,
    client: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Add {
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rename {
    id: i64,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Remove {
    id: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    #[serde(default)]
    offset: i64,
}
fn params<T: DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|_| "Invalid method parameters".into())
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--data-dir" {
        return Err("Usage: troop-core --data-dir <absolute directory>".into());
    }
    let store = Store::open(&PathBuf::from(&args[2]))?;
    let generation = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let mut reader = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut handshaken = false;
    let mut seen = HashSet::new();
    loop {
        let mut bytes = Vec::new();
        let n = (&mut reader)
            .take((MAX_FRAME + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if n > MAX_FRAME {
            writeln!(
                output,
                "{}",
                error(
                    Value::Null,
                    &generation,
                    -32600,
                    "frame_too_large",
                    "Request frame too large"
                )
            )
            .map_err(|e| e.to_string())?;
            output.flush().map_err(|e| e.to_string())?;
            break;
        }
        let request = serde_json::from_slice::<Request>(&bytes);
        let (response, shutdown) = match request {
            Err(_) => (
                error(
                    Value::Null,
                    &generation,
                    -32700,
                    "invalid_request",
                    "Malformed request",
                ),
                false,
            ),
            Ok(r) => {
                let id = json!(r.id);
                if let Err(message) = r.validate() {
                    (
                        error(id, &generation, -32600, "invalid_request", message),
                        false,
                    )
                } else if !seen.insert(r.id.clone()) {
                    (
                        error(
                            id,
                            &generation,
                            -32600,
                            "duplicate_id",
                            "Request ID already used",
                        ),
                        false,
                    )
                } else if r.method == "system.hello" {
                    match params::<Hello>(r.params) {
                        Ok(h) if h.protocol == VERSION && h.client == "troop-desktop" => {
                            handshaken = true;
                            (
                                result(
                                    &r.id,
                                    &generation,
                                    json!({"protocol":VERSION,"core_version":env!("CARGO_PKG_VERSION"),"capabilities":METHODS}),
                                ),
                                false,
                            )
                        }
                        _ => (
                            error(
                                id,
                                &generation,
                                -32001,
                                "protocol_mismatch",
                                "Incompatible protocol or client",
                            ),
                            false,
                        ),
                    }
                } else if !handshaken {
                    (
                        error(
                            id,
                            &generation,
                            -32002,
                            "handshake_required",
                            "Handshake required",
                        ),
                        false,
                    )
                } else if r.generation.as_deref() != Some(&generation) {
                    (
                        error(
                            id,
                            &generation,
                            -32003,
                            "stale_generation",
                            "Core generation changed",
                        ),
                        false,
                    )
                } else {
                    let value: Result<Value, String> = match r.method.as_str() {
                        "system.ping" => Ok(json!({"ready":true})),
                        "system.shutdown" => Ok(json!({"stopped":true})),
                        "workspace.list" => params::<List>(r.params)
                            .and_then(|p| store.list(p.offset))
                            .and_then(|x| serde_json::to_value(x).map_err(|e| e.to_string())),
                        "workspace.add" => params::<Add>(r.params)
                            .and_then(|p| store.add(&p.path))
                            .and_then(|x| serde_json::to_value(x).map_err(|e| e.to_string())),
                        "workspace.rename" => params::<Rename>(r.params)
                            .and_then(|p| store.rename(p.id, &p.name))
                            .and_then(|x| serde_json::to_value(x).map_err(|e| e.to_string())),
                        "workspace.remove" => params::<Remove>(r.params)
                            .and_then(|p| store.remove(p.id))
                            .and_then(|x| serde_json::to_value(x).map_err(|e| e.to_string())),
                        _ => {
                            let e = error(
                                id.clone(),
                                &generation,
                                -32601,
                                "method_not_found",
                                "Unknown method",
                            );
                            writeln!(output, "{e}").map_err(|e| e.to_string())?;
                            output.flush().map_err(|e| e.to_string())?;
                            continue;
                        }
                    };
                    match value {
                        Ok(value) => (
                            result(&r.id, &generation, value),
                            r.method == "system.shutdown",
                        ),
                        Err(message) => (
                            error(id, &generation, -32602, "request_rejected", &message),
                            false,
                        ),
                    }
                }
            }
        };
        let response = if response.to_string().len() > MAX_FRAME {
            error(
                response["id"].clone(),
                &generation,
                -32004,
                "response_too_large",
                "Response exceeds frame limit",
            )
        } else {
            response
        };
        writeln!(output, "{response}").map_err(|e| e.to_string())?;
        output.flush().map_err(|e| e.to_string())?;
        if shutdown || seen.len() >= 16_384 {
            break;
        }
    }
    Ok(())
}
fn main() {
    if let Err(message) = run() {
        eprintln!("TROOP Core: {message}");
        std::process::exit(1);
    }
}
