use serde::Deserialize;
use serde_json::{json, Value};

pub const VERSION: u32 = 10;
pub const MAX_FRAME: usize = 65_536;
pub const METHODS: &[&str] = &[
    "system.hello",
    "mcp.list",
    "mcp.get",
    "mcp.save",
    "mcp.remove",
    "mcp.revisions",
    "mcp.preview",
    "mcp.import",
    "mcp.oauth.begin",
    "mcp.oauth.status",
    "mcp.oauth.cancel",
    "mcp.oauth.refresh",
    "mcp.oauth.disconnect",
    "skills.list",
    "skills.preview",
    "skills.import",
    "skills.get",
    "skills.versions",
    "skills.enable",
    "skills.remove",
    "skills.edit",
    "skills.refresh",
    "hooks.list",
    "hooks.definition",
    "hooks.save",
    "hooks.remove",
    "hooks.calls",
    "hooks.call",
    "hooks.reconcile",
    "system.ping",
    "system.shutdown",
    "workspace.list",
    "workspace.add",
    "workspace.rename",
    "workspace.remove",
    "provider.list",
    "provider.save",
    "provider.remove",
    "chat.list",
    "chat.create",
    "chat.remove",
    "chat.messages",
    "chat.send",
    "chat.cancel",
    "agent.list",
    "agent.mcp-catalogue",
    "agent.mcp-sessions",
    "agent.mcp-reconcile",
    "agent.mcp-artifact",
    "agent.get",
    "agent.content",
    "agent.events",
    "agent.event",
    "agent.invocation",
    "agent.start",
    "agent.cancel",
    "agent.approve",
    "agent.steer",
    "agent.reconcile",
    "agent.resume",
    "memory.agents",
    "memory.agent.save",
    "memory.projects",
    "memory.membership",
    "memory.list",
    "memory.write",
    "memory.edit",
    "memory.jobs",
    "memory.job",
    "memory.job.cancel",
    "memory.job.retry",
    "agent.compact",
    "agent.checkpoints",
    "agent.tasks",
    "agent.task",
    "agent.stop-task",
    "agent.reconcile-task",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub jsonrpc: String,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    pub generation: Option<String>,
}
impl Request {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.jsonrpc != "2.0" {
            return Err("JSON-RPC version must be 2.0");
        }
        if self.id.is_empty() || self.id.len() > 128 {
            return Err("Invalid request ID");
        }
        Ok(())
    }
}
pub fn result(id: &str, generation: &str, value: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":{"generation":generation,"value":value}})
}
pub fn error(id: Value, generation: &str, code: i32, kind: &str, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message,"data":{"kind":kind,"generation":generation}}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_envelope_fields_are_rejected() {
        assert!(serde_json::from_value::<Request>(
            json!({"jsonrpc":"2.0","id":"x","method":"system.ping","command":"unexpected"})
        )
        .is_err());
    }
    #[test]
    fn request_ids_are_bounded() {
        let request: Request = serde_json::from_value(
            json!({"jsonrpc":"2.0","id":"x".repeat(129),"method":"system.ping"}),
        )
        .unwrap();
        assert!(request.validate().is_err());
    }
}
