use super::*;

pub type Ready = Box<dyn FnOnce(blocking::Sender<bool>) + Send>;
pub type Progress = Box<dyn Fn(Value) + Send>;
/// Stateful memory, Skill, MCP and Task actions retain their Run-owned handlers.
/// The Worker method starts only after the runtime commits dispatch and supplies
/// a Ready gate. Adapters must wait for that gate before producing host effects.
pub trait ToolProvider: Send + Sync {
    fn catalogue(&self, store: &Store, run: &Value) -> Vec<Value>;
    fn validate(&self, store: &Store, run: &Value, name: &str, args: &Value) -> Result<(), String>;
    fn read_only(&self, name: &str) -> bool;
    fn needs_approval(&self, name: &str) -> bool;
    fn execute(
        &self,
        work: tools::Work,
        cancel: Arc<AtomicBool>,
        ready: Ready,
        progress: Progress,
    ) -> Value;
}
pub struct NativeTools;
impl ToolProvider for NativeTools {
    fn catalogue(&self, store: &Store, run: &Value) -> Vec<Value> {
        let sandbox = run["authorization_id"]
            .as_str()
            .and_then(|id| store.authorization_get(id).ok())
            .is_some_and(|grant| grant["shell"].is_object());
        tools::definitions()
            .into_iter()
            .map(|mut definition| {
                if sandbox && matches!(definition["name"].as_str(), Some("run_command" | "start_background")) {
                    definition["description"] = json!("Execute PowerShell within this Run's granted filesystem roots and network policy using MXC containment. Windows runtime libraries are additionally readonly. Write trees are checked before execution and must contain at most 20,000 entries with no hardlinked files. Background commands retain their owned Task lifecycle.");
                }
                definition
            })
            .filter(|d| {
                if d["name"]=="group_reply" {return run["group_delivery_id"].is_i64() && run["authorization_id"].as_str().and_then(|id|store.authorization_get(id).ok()).is_some_and(|grant|grant["operations"].as_array().is_some_and(|operations|operations.contains(&json!("group_reply"))));}
                d["name"] != "manage_rule" || run["rule_management_authorization_id"].is_string()
            })
            .filter(|d| run["read_only"] != true || self.read_only(d["name"].as_str().unwrap()))
            .chain(mcp::definitions(run, store))
            .collect()
    }
    fn validate(&self, store: &Store, run: &Value, name: &str, args: &Value) -> Result<(), String> {
        mcp::validate_tool(store, run, name, args)
    }
    fn read_only(&self, name: &str) -> bool {
        tools::read_only(name)
    }
    fn needs_approval(&self, name: &str) -> bool {
        tools::needs_approval(name)
    }
    fn execute(
        &self,
        work: tools::Work,
        cancel: Arc<AtomicBool>,
        ready: Ready,
        progress: Progress,
    ) -> Value {
        tools::execute_with_progress(work, cancel, ready, progress)
    }
}
