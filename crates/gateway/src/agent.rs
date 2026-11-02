use super::{Failure, Protocol};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

pub struct ToolWire {
    pub history: Vec<Value>,
    pub definitions: Vec<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}
#[derive(Default)]
struct Pending {
    id: String,
    name: String,
    arguments: String,
}
#[derive(Default)]
pub(super) struct Collector {
    pending: BTreeMap<u64, Pending>,
    pub items: Vec<Value>,
    blocks: BTreeMap<u64, Value>,
}
fn invalid() -> Failure {
    Failure::new(
        "invalid_tool_call",
        "工具调用参数无效或超过限制；未执行工具。",
    )
}
impl Collector {
    fn full(&mut self, index: u64, item: &Value) -> Result<(), Failure> {
        let id = item["call_id"].as_str().ok_or_else(invalid)?;
        let name = item["name"].as_str().ok_or_else(invalid)?;
        let arguments = item["arguments"].as_str().ok_or_else(invalid)?;
        let p = self.pending.entry(index).or_default();
        if (!p.id.is_empty() && p.id != id)
            || (!p.name.is_empty() && p.name != name)
            || (!p.arguments.is_empty() && p.arguments != arguments)
        {
            return Err(invalid());
        }
        p.id = id.into();
        p.name = name.into();
        p.arguments = arguments.into();
        Ok(())
    }
    pub fn consume(&mut self, protocol: Protocol, data: &str) -> Result<(), Failure> {
        if data.trim() == "[DONE]" {
            return Ok(());
        }
        let v: Value = serde_json::from_str(data).map_err(|_| invalid())?;
        match protocol {
            Protocol::ChatCompletions => {
                if let Some(calls) = v["choices"][0]["delta"]["tool_calls"].as_array() {
                    for call in calls {
                        let p = self
                            .pending
                            .entry(call["index"].as_u64().ok_or_else(invalid)?)
                            .or_default();
                        if let Some(id) = call["id"].as_str() {
                            p.id.push_str(id);
                        }
                        if let Some(name) = call["function"]["name"].as_str() {
                            p.name.push_str(name);
                        }
                        if let Some(args) = call["function"]["arguments"].as_str() {
                            p.arguments.push_str(args);
                        }
                    }
                }
            }
            Protocol::Anthropic => {
                let index = v["index"].as_u64().unwrap_or(0);
                if v["type"] == "content_block_start" {
                    self.blocks.insert(index, v["content_block"].clone());
                }
                match v["type"].as_str() {
                    Some("content_block_start") if v["content_block"]["type"] == "tool_use" => {
                        let block = &v["content_block"];
                        let p = self.pending.entry(index).or_default();
                        p.id = block["id"].as_str().ok_or_else(invalid)?.into();
                        p.name = block["name"].as_str().ok_or_else(invalid)?.into();
                        if block["input"].as_object().is_some_and(|m| !m.is_empty()) {
                            p.arguments = block["input"].to_string();
                        }
                    }
                    Some("content_block_delta") if v["delta"]["type"] == "input_json_delta" => {
                        self.pending
                            .get_mut(&index)
                            .ok_or_else(invalid)?
                            .arguments
                            .push_str(v["delta"]["partial_json"].as_str().ok_or_else(invalid)?);
                    }
                    Some("content_block_delta") => {
                        let (field, delta) = match v["delta"]["type"].as_str() {
                            Some("text_delta") => ("text", v["delta"]["text"].as_str()),
                            Some("thinking_delta") => ("thinking", v["delta"]["thinking"].as_str()),
                            Some("signature_delta") => {
                                ("signature", v["delta"]["signature"].as_str())
                            }
                            _ => ("", None),
                        };
                        if let Some(delta) = delta {
                            let block = self
                                .blocks
                                .entry(index)
                                .or_insert_with(|| json!({"type":"text","text":""}));
                            let old = block[field].as_str().unwrap_or("");
                            block[field] = json!(format!("{old}{delta}"));
                        }
                    }
                    Some("message_stop") => self.items = self.blocks.values().cloned().collect(),
                    _ => {}
                }
            }
            Protocol::Responses => match v["type"].as_str() {
                Some("response.output_item.added") if v["item"]["type"] == "function_call" => {
                    let item = &v["item"];
                    let p = self
                        .pending
                        .entry(v["output_index"].as_u64().ok_or_else(invalid)?)
                        .or_default();
                    p.id = item["call_id"].as_str().ok_or_else(invalid)?.into();
                    p.name = item["name"].as_str().ok_or_else(invalid)?.into();
                    p.arguments = item["arguments"].as_str().unwrap_or("").into();
                }
                Some("response.function_call_arguments.delta") => {
                    self.pending
                        .get_mut(&v["output_index"].as_u64().ok_or_else(invalid)?)
                        .ok_or_else(invalid)?
                        .arguments
                        .push_str(v["delta"].as_str().ok_or_else(invalid)?);
                }
                Some("response.output_item.done") if v["item"]["type"] == "function_call" => {
                    self.full(v["output_index"].as_u64().ok_or_else(invalid)?, &v["item"])?
                }
                Some("response.completed") => {
                    if let Some(items) = v["response"]["output"].as_array() {
                        for (index, item) in items.iter().enumerate() {
                            match item["type"].as_str() {
                                Some("function_call") => self.full(index as u64, item)?,
                                Some("message" | "reasoning") => {}
                                _ => {
                                    return Err(Failure::new(
                                        "unsupported_capability",
                                        "响应包含未支持的服务器工具或内容。",
                                    ))
                                }
                            }
                        }
                        self.items = items.clone();
                    }
                }
                _ => {}
            },
        }
        if self.pending.len() > 8
            || self
                .pending
                .values()
                .any(|p| p.arguments.len() > 12_000 || p.id.len() > 200 || p.name.len() > 100)
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<(Vec<ToolCall>, Vec<Value>), Failure> {
        let mut ids = HashSet::new();
        let calls = self
            .pending
            .into_values()
            .map(|p| {
                if p.id.is_empty()
                    || p.name.is_empty()
                    || p.id.chars().any(char::is_control)
                    || p.name.chars().any(char::is_control)
                    || !ids.insert(p.id.clone())
                {
                    return Err(invalid());
                }
                let arguments: Value = serde_json::from_str(if p.arguments.is_empty() {
                    "{}"
                } else {
                    &p.arguments
                })
                .map_err(|_| invalid())?;
                if !arguments.is_object() {
                    return Err(invalid());
                }
                Ok(ToolCall {
                    id: p.id,
                    name: p.name,
                    arguments,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        for item in &mut self.items {
            if item["type"] == "tool_use" {
                let call = calls
                    .iter()
                    .find(|c| item["id"] == c.id)
                    .ok_or_else(invalid)?;
                item["input"] = call.arguments.clone();
            }
        }
        Ok((calls, self.items))
    }
}
pub(super) fn configure(body: &mut Value, protocol: Protocol, wire: ToolWire) {
    let mut history = wire.history;
    if protocol == Protocol::Anthropic {
        let system = history
            .iter()
            .filter(|m| m["role"] == "system")
            .filter_map(|m| m["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        history.retain(|m| m["role"] != "system");
        if !system.is_empty() {
            body["system"] = json!(system);
        }
    }
    body[if protocol == Protocol::Responses {
        "input"
    } else {
        "messages"
    }] = json!(history);
    body["tools"] = Value::Array(wire.definitions.into_iter().map(|tool| match protocol {
        Protocol::ChatCompletions => json!({"type":"function","function":tool}),
        Protocol::Responses => { let mut tool = tool; tool["type"] = json!("function"); tool },
        Protocol::Anthropic => json!({"name":tool["name"],"description":tool["description"],"input_schema":tool["parameters"]}),
    }).collect());
    if protocol == Protocol::Responses {
        body["include"] = json!(["reasoning.encrypted_content"]);
    }
}
pub fn assistant(
    protocol: Protocol,
    history: &mut Vec<Value>,
    text: &str,
    calls: &[ToolCall],
    items: &[Value],
) {
    match protocol {
        Protocol::ChatCompletions => {
            let mut message = json!({"role":"assistant","content":text});
            if !calls.is_empty() {
                message["tool_calls"] = json!(calls.iter().map(|c|json!({"id":c.id,"type":"function","function":{"name":c.name,"arguments":c.arguments.to_string()}})).collect::<Vec<_>>());
            }
            history.push(message);
        }
        Protocol::Responses if !items.is_empty() => history.extend_from_slice(items),
        Protocol::Responses => {
            if !text.is_empty() {
                history.push(json!({"role":"assistant","content":text}));
            }
            history.extend(calls.iter().map(|c|json!({"type":"function_call","call_id":c.id,"name":c.name,"arguments":c.arguments.to_string()})));
        }
        Protocol::Anthropic if !items.is_empty() => {
            history.push(json!({"role":"assistant","content":items}))
        }
        Protocol::Anthropic => {
            let mut blocks = Vec::new();
            if !text.is_empty() {
                blocks.push(json!({"type":"text","text":text}));
            }
            blocks.extend(
                calls.iter().map(
                    |c| json!({"type":"tool_use","id":c.id,"name":c.name,"input":c.arguments}),
                ),
            );
            history.push(json!({"role":"assistant","content":blocks}));
        }
    }
}
pub fn tool_result(
    protocol: Protocol,
    history: &mut Vec<Value>,
    id: &str,
    result: &Value,
    failed: bool,
) {
    let content = result.to_string();
    history.push(match protocol {
        Protocol::ChatCompletions => json!({"role":"tool","tool_call_id":id,"content":content}),
        Protocol::Responses => json!({"type":"function_call_output","call_id":id,"output":content}),
        Protocol::Anthropic => json!({"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":content,"is_error":failed}]}),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_response_can_supply_full_calls_and_keeps_reasoning_items() {
        let mut c = Collector::default();
        let event = json!({"type":"response.completed","response":{"output":[{"type":"reasoning","id":"r1","encrypted_content":"owned-test"},{"type":"function_call","id":"f1","call_id":"c1","name":"read_file","arguments":"{\"path\":\"a.txt\"}"}]}});
        c.consume(Protocol::Responses, &event.to_string()).unwrap();
        let (calls, items) = c.finish().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].arguments["path"], "a.txt");
        assert_eq!(items[0]["type"], "reasoning");
    }
    #[test]
    fn conflicting_completed_arguments_are_never_executable() {
        let mut c = Collector::default();
        c.consume(Protocol::Responses,&json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"read_file","arguments":""}}).to_string()).unwrap();
        c.consume(
            Protocol::Responses,
            &json!({"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"})
                .to_string(),
        )
        .unwrap();
        assert!(c.consume(Protocol::Responses,&json!({"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"read_file","arguments":"{\"path\":\"changed\"}"}}).to_string()).is_err());
    }
}
