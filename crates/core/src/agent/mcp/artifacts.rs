use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
fn secret(text: &str, values: &[String]) -> bool {
    values.iter().any(|s| !s.is_empty() && text.contains(s))
}
fn scrub(value: &mut Value, values: &[String]) {
    match value {
        Value::String(s) if secret(s, values) => *s = "[redacted credential]".into(),
        Value::Array(a) => a.iter_mut().for_each(|v| scrub(v, values)),
        Value::Object(m) => {
            let mut fresh = serde_json::Map::new();
            for (k, mut v) in std::mem::take(m) {
                scrub(&mut v, values);
                let key = if secret(&k, values) {
                    format!("redacted_key_{}", fresh.len())
                } else {
                    k
                };
                fresh.insert(key, v);
            }
            *m = fresh;
        }
        _ => {}
    }
}
fn clip(s: &str, limit: usize) -> String {
    let mut n = s.len().min(limit);
    while !s.is_char_boundary(n) {
        n -= 1;
    }
    s[..n].into()
}
fn save(
    artifacts: &mut Vec<Value>,
    run: i64,
    inv: i64,
    bytes: Vec<u8>,
    mime: &str,
    label: &str,
) -> Result<Value, String> {
    if bytes.len() > 524288 || artifacts.len() >= 32 {
        return Err("MCP artifact budget exceeded".into());
    }
    let id = Uuid::new_v4().to_string();
    let safe_mime = if mime.len() <= 120 && !mime.chars().any(char::is_control) {
        mime
    } else {
        "application/octet-stream"
    };
    let mut d = json!({"id":id,"run_id":run,"invocation_id":inv,"mime_type":safe_mime,"label":label,"bytes":bytes.len(),"sha256":tools::hash(&bytes)});
    let public = d.clone();
    d["_bytes"] = json!(STANDARD.encode(bytes));
    artifacts.push(d);
    Ok(public)
}
pub(super) fn prepare(run: i64, inv: i64, mut value: Value, values: &[String]) -> Value {
    if !value.is_object()
        || value.get("isError").is_some_and(|v| !v.is_boolean())
        || !value["content"].is_array() && !value["structuredContent"].is_object()
    {
        return json!({"ok":false,"indeterminate":true,"error":"MCP tool returned a malformed result; inspect effects before continuing"});
    }
    let is_error = value["isError"] == true;
    let mut artifacts = vec![];
    // Binary data is removed before generic JSON archival; credential-bearing bytes are omitted.
    if let Some(content) = value["content"].as_array_mut() {
        for item in content.iter_mut() {
            let path = if matches!(item["type"].as_str(), Some("image" | "audio")) {
                Some(("data", false))
            } else if item["type"] == "resource" && item["resource"]["blob"].is_string() {
                Some(("blob", true))
            } else {
                None
            };
            if let Some((key, nested)) = path {
                let payload = if nested {
                    &mut item["resource"]
                } else {
                    &mut *item
                };
                let encoded = payload
                    .as_object_mut()
                    .and_then(|m| m.remove(key))
                    .and_then(|v| v.as_str().map(str::to_owned));
                let bytes = encoded
                    .as_deref()
                    .and_then(|s| STANDARD.decode(s).ok())
                    .filter(|b| b.len() <= 48_000);
                let mime = payload["mimeType"]
                    .as_str()
                    .unwrap_or("application/octet-stream")
                    .to_owned();
                let public = match bytes {
                    Some(bytes)
                        if !values.iter().any(|s| {
                            !s.is_empty() && bytes.windows(s.len()).any(|b| b == s.as_bytes())
                        }) =>
                    {
                        save(&mut artifacts, run, inv, bytes, &mime, "MCP attachment")
                            .unwrap_or(json!({"omitted":"artifact budget"}))
                    }
                    Some(_) => json!({"omitted":"credential-containing attachment"}),
                    None => json!({"omitted":"invalid or oversized attachment"}),
                };
                payload["artifact"] = public;
            }
        }
    }
    scrub(&mut value, values);
    let full = serde_json::to_vec(&value).unwrap_or_default();
    let full_result = if full.len() > 6000 {
        save(
            &mut artifacts,
            run,
            inv,
            full.clone(),
            "application/json",
            "MCP result",
        )
        .ok()
    } else {
        None
    };
    let mut output = value.clone();
    let mut truncated = false;
    if let Some(content) = output["content"].as_array_mut() {
        if content.len() > 24 {
            content.truncate(24);
            truncated = true;
        }
        let mut remaining = 5000;
        for item in content {
            for key in ["text", "uri", "name", "description"] {
                if let Some(s) = item[key].as_str() {
                    let kept = clip(s, remaining);
                    remaining = remaining.saturating_sub(kept.len());
                    truncated |= kept.len() < s.len();
                    item[key] = json!(kept);
                }
            }
            if item["type"] == "resource" {
                if let Some(s) = item["resource"]["text"].as_str() {
                    let kept = clip(s, remaining);
                    remaining = remaining.saturating_sub(kept.len());
                    truncated |= kept.len() < s.len();
                    item["resource"]["text"] = json!(kept);
                }
            }
        }
    }
    if output.to_string().len() > 9000 {
        output = json!({"isError":is_error,"text":clip(&String::from_utf8_lossy(&full),5000)});
        truncated = true;
    }
    output["truncated"] = json!(truncated || full_result.is_some());
    if let Some(full_result) = full_result {
        output["full_result"] = full_result;
    }
    let manifest = artifacts
        .iter()
        .map(|a| {
            let mut a = a.clone();
            a.as_object_mut().unwrap().remove("_bytes");
            a
        })
        .collect::<Vec<_>>();
    json!({"ok":!is_error,"value":output,"artifacts":manifest,"_artifacts":artifacts,"error":if is_error{Some("MCP tool reported isError")}else{None}})
}
pub(super) fn read(
    store: &Store,
    run: i64,
    id: &str,
    offset: usize,
    model: bool,
) -> Result<Value, String> {
    if Uuid::parse_str(id).is_err() {
        return Err("Invalid MCP artifact ID".into());
    }
    let meta = store.mcp_artifact(id, run)?;
    let bytes = store.mcp_artifact_bytes(id, run)?;
    if bytes.len() > 524288 || meta["sha256"] != tools::hash(&bytes) {
        return Err("MCP artifact integrity failed".into());
    }
    if offset > bytes.len() {
        return Err("MCP artifact offset exceeds size".into());
    }
    let mut result = json!({"artifact":meta});
    match std::str::from_utf8(&bytes) {
        Ok(text) => {
            if !text.is_char_boundary(offset) {
                return Err("MCP artifact offset must be a UTF-8 boundary".into());
            }
            let kept = clip(&text[offset..], 4000);
            let end = offset + kept.len();
            result["text"] = json!(kept);
            result["next_offset"] = if end < bytes.len() {
                json!(end)
            } else {
                Value::Null
            };
        }
        Err(_) => {
            result["binary"] = json!(true);
            if !model {
                let end = (offset + 4000).min(bytes.len());
                result["base64"] = json!(STANDARD.encode(&bytes[offset..end]));
                result["next_offset"] = if end < bytes.len() {
                    json!(end)
                } else {
                    Value::Null
                };
            }
        }
    }
    Ok(result)
}
