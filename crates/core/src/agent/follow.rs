use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Follow {
    pub resource: String,
    pub id: i64,
    pub cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FollowContent {
    pub id: i64,
    pub field: String,
    pub revision: i64,
    pub offset: usize,
}
impl Manager {
    pub fn follow(&self, store: &Store, p: Value, generation: &str) -> Result<Value, String> {
        let a = params::<Follow>(p)?;
        let mut frame = store.execution_follow(&a.resource,a.id,a.cursor.as_deref(),|store| {
            if a.resource == "run" {
                Ok(json!({"value":self.run_snapshot(store,a.id)?,"events":store.agent_events(a.id,None)?}))
            } else if a.resource == "invocation" {
                Ok(json!({"value":self.invocation_snapshot(store,a.id)?}))
            } else {
                Ok(json!({"value":self.task_snapshot(store,a.id)?}))
            }
        })?;
        frame["generation"] = json!(generation);
        Ok(frame)
    }
    pub fn follow_content(&self, store: &Store, p: Value) -> Result<Value, String> {
        let a = params::<FollowContent>(p)?;
        if a.id <= 0 || a.revision < 0 || !matches!(a.field.as_str(), "goal" | "output") {
            return Err("Invalid follow content reference".into());
        }
        let run = store.agent_run(a.id)?;
        if run["revision"] != a.revision {
            return Ok(
                json!({"state":"reset_required","revision":run["revision"],"text":"","next_offset":null}),
            );
        }
        let text = run[&a.field].as_str().unwrap_or("");
        let chunk = text.chars().skip(a.offset).take(4096).collect::<String>();
        let next = a.offset.saturating_add(chunk.chars().count());
        Ok(
            json!({"state":"content","revision":a.revision,"text":chunk,"next_offset":if next<text.chars().count(){Some(next)}else{None}}),
        )
    }
}
