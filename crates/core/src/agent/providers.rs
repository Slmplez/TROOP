use super::*;
use context::{ContextPipeline, HistoryContext, MemoryContext, SkillContext};
use model::{GatewayModel, ModelProvider};
use tool_provider::{NativeTools, ToolProvider};

/// Constructed once at the composition root. Each spawned operation clones the
/// selected adapter, so its implementation remains fixed for that operation.
pub struct Providers {
    pub model: Arc<dyn ModelProvider>,
    pub tools: Arc<dyn ToolProvider>,
    pub context: ContextPipeline,
}
impl Default for Providers {
    fn default() -> Self {
        Self {
            model: Arc::new(GatewayModel),
            tools: Arc::new(NativeTools),
            context: ContextPipeline::new(vec![
                Arc::new(MemoryContext),
                Arc::new(SkillContext),
                Arc::new(HistoryContext),
            ]),
        }
    }
}
