use super::*;
use std::{future::Future, pin::Pin};

#[derive(Clone, serde::Serialize)]
pub struct ModelCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}
#[derive(serde::Serialize)]
pub struct ModelUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
pub struct ModelOutput {
    pub usage: ModelUsage,
    pub finish_reason: String,
    pub calls: Vec<ModelCall>,
    /// Immutable provider records retained for signed/opaque history round trips.
    pub output_items: Vec<Value>,
}
#[derive(Debug)]
pub struct ModelError {
    pub kind: &'static str,
    pub message: String,
}

pub enum ModelContext {
    Agent {
        history: Vec<Value>,
        definitions: Vec<Value>,
    },
    Text(String),
    Conversation(Vec<gateway::Message>),
}
pub struct ModelRequest {
    pub config: Config,
    pub secret: Option<Secret>,
    pub context: ModelContext,
}
pub type ModelFuture = Pin<Box<dyn Future<Output = Result<ModelOutput, ModelError>> + Send>>;
/// Dropping the returned future must release the active request. No detached
/// task may keep using credentials or emit results after cancellation.
pub trait ModelProvider: Send + Sync {
    fn stream(&self, request: ModelRequest, text: mpsc::Sender<String>) -> ModelFuture;
    fn append_result(&self, run: &mut Value, invocation: &Value) -> Result<(), String>;
    fn append_assistant(&self, run: &mut Value, output: &ModelOutput) -> Result<(), String>;
}
pub struct GatewayModel;
impl ModelProvider for GatewayModel {
    fn stream(&self, request: ModelRequest, text: mpsc::Sender<String>) -> ModelFuture {
        let (messages, tools) = match request.context {
            ModelContext::Agent {
                history,
                definitions,
            } => (
                vec![],
                Some(gateway::agent::ToolWire {
                    history,
                    definitions,
                }),
            ),
            ModelContext::Text(content) => (
                vec![gateway::Message {
                    role: "user".into(),
                    content,
                }],
                None,
            ),
            ModelContext::Conversation(messages) => (messages, None),
        };
        Box::pin(async move {
            gateway::stream(
                gateway::Request {
                    config: request.config,
                    secret: request.secret,
                    messages,
                    tools,
                },
                text,
            )
            .await
            .map(|summary| ModelOutput {
                usage: ModelUsage {
                    input_tokens: summary.usage.input_tokens,
                    output_tokens: summary.usage.output_tokens,
                },
                finish_reason: summary.finish_reason,
                calls: summary
                    .calls
                    .into_iter()
                    .map(|call| ModelCall {
                        id: call.id,
                        name: call.name,
                        arguments: call.arguments,
                    })
                    .collect(),
                output_items: summary.output_items,
            })
            .map_err(|error| ModelError {
                kind: error.kind,
                message: error.message,
            })
        })
    }
    fn append_result(&self, run: &mut Value, invocation: &Value) -> Result<(), String> {
        append_result(run, invocation)
    }
    fn append_assistant(&self, run: &mut Value, output: &ModelOutput) -> Result<(), String> {
        append_assistant(run, output)
    }
}

pub(super) fn append_result(doc: &mut Value, inv: &Value) -> Result<(), String> {
    let mut items = history(doc);
    gateway::agent::tool_result(
        protocol(doc)?,
        &mut items,
        inv["call_id"].as_str().ok_or("工具标识损坏。")?,
        &inv["result"],
        inv["state"] != "succeeded",
    );
    doc["history"] = json!(items);
    Ok(())
}
fn append_assistant(doc: &mut Value, summary: &ModelOutput) -> Result<(), String> {
    let mut items = history(doc);
    let calls = summary
        .calls
        .iter()
        .map(|call| gateway::agent::ToolCall {
            id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
        })
        .collect::<Vec<_>>();
    gateway::agent::assistant(
        protocol(doc)?,
        &mut items,
        doc["model_text"].as_str().unwrap_or(""),
        &calls,
        &summary.output_items,
    );
    doc["history"] = json!(items);
    Ok(())
}
fn protocol(doc: &Value) -> Result<gateway::Protocol, String> {
    serde_json::from_value(doc["config"]["protocol"].clone()).map_err(|_| "模型协议无效。".into())
}
