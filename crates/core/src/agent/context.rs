use super::*;

/// Contributors query scoped sources. The pipeline records the selected source
/// revisions on the Run before the caller commits and starts the model request.
pub trait ContextContributor: Send + Sync {
    fn contribute(&self, sources: &mut ContextSources<'_>) -> Result<ContextFragment, String>;
}
pub struct ContextFragment {
    pub source: String,
    pub revision: Value,
    pub items: Vec<Value>,
}
pub struct ContextSources<'a> {
    store: &'a Store,
    run: &'a mut Value,
}
impl ContextSources<'_> {
    pub fn memory(&mut self) -> Result<ContextFragment, String> {
        let items = system(Manager::memory_snapshot(self.store, self.run)?);
        Ok(ContextFragment {
            source: "memory".into(),
            revision: json!({"entries":self.run["memory_snapshot"]["sources"],"force_revision":self.run["memory_snapshot"]["force_revision"],"compaction_epoch":self.run["memory_snapshot"]["epoch"],"sha256":tools::hash(serde_json::to_vec(&items).map_err(|e|e.to_string())?.as_slice())}),
            items,
        })
    }
    pub fn skills(&self) -> Result<ContextFragment, String> {
        let (render, versions) = Manager::skill_catalog(self.store, self.run)?;
        let items = system(render);
        Ok(ContextFragment {
            source: "skills".into(),
            revision: json!({"versions":versions,"sha256":tools::hash(serde_json::to_vec(&items).unwrap().as_slice())}),
            items,
        })
    }
    pub fn history(&self) -> ContextFragment {
        let mut items = system(crate::office::reference_context(
            &self.run["office_references"],
        ));
        items.extend(Manager::context_view(self.run));
        ContextFragment {
            source: "history".into(),
            revision: json!({"context_start":self.run["context_start"],"sha256":tools::hash(serde_json::to_vec(&items).unwrap().as_slice())}),
            items,
        }
    }
}

pub struct ContextPipeline {
    contributors: Vec<Arc<dyn ContextContributor>>,
}
impl ContextPipeline {
    pub fn new(contributors: Vec<Arc<dyn ContextContributor>>) -> Self {
        Self { contributors }
    }
    pub fn build(&self, store: &Store, run: &mut Value) -> Result<Vec<Value>, String> {
        let mut items = Vec::new();
        let scope = json!({"agent_id":run["agent_id"],"workspace_id":run["workspace_id"],"project_ids":run["project_ids"]});
        let mut sources = ContextSources { store, run };
        let mut selected = Vec::new();
        for contributor in &self.contributors {
            let fragment = contributor.contribute(&mut sources)?;
            selected
                .push(json!({"source":fragment.source,"revision":fragment.revision,"scope":scope}));
            items.extend(fragment.items);
            if serde_json::to_vec(&items).map_err(|e| e.to_string())?.len() > 192_000 {
                return Err("Model context exceeds the bounded memory and history budget".into());
            }
        }
        sources.run["context_sources"] = json!(selected);
        Ok(items)
    }
}
pub struct MemoryContext;
pub struct SkillContext;
pub struct HistoryContext;
fn system(text: String) -> Vec<Value> {
    if text.is_empty() {
        vec![]
    } else {
        vec![json!({"role":"system","content":text})]
    }
}
impl ContextContributor for MemoryContext {
    fn contribute(&self, sources: &mut ContextSources<'_>) -> Result<ContextFragment, String> {
        sources.memory()
    }
}
impl ContextContributor for SkillContext {
    fn contribute(&self, sources: &mut ContextSources<'_>) -> Result<ContextFragment, String> {
        sources.skills()
    }
}
impl ContextContributor for HistoryContext {
    fn contribute(&self, sources: &mut ContextSources<'_>) -> Result<ContextFragment, String> {
        Ok(sources.history())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fragment(&'static str);
    impl ContextContributor for Fragment {
        fn contribute(&self, _: &mut ContextSources<'_>) -> Result<ContextFragment, String> {
            Ok(ContextFragment {
                source: "fixture".into(),
                revision: json!(1),
                items: vec![json!({"role":"system","content":self.0})],
            })
        }
    }
    #[test]
    fn composed_context_keeps_contributor_order_and_committed_history() {
        let directory = std::env::temp_dir().join(format!("troop-context-{}", Uuid::new_v4()));
        let store = Store::open(&directory).unwrap();
        let pipeline = ContextPipeline::new(vec![
            Arc::new(Fragment("project data")),
            Arc::new(HistoryContext),
        ]);
        let mut run = json!({"goal":"inspect", "context_start":1, "context_summary":"tool 7 already wrote file", "history":[{"role":"user","content":"older"},{"role":"user","content":"latest"}]});
        let context = pipeline.build(&store, &mut run).unwrap();
        assert_eq!(context[0]["content"], "project data");
        assert!(context[1]["content"]
            .as_str()
            .unwrap()
            .contains("tool 7 already wrote file"));
        assert_eq!(context[2]["content"], "latest");
        assert_eq!(context.len(), 3);
        assert_eq!(run["context_sources"][0]["revision"], 1);
        assert_eq!(run["context_sources"][1]["source"], "history");
        // A second composition can use a different contributor without editing the loop.
        let providers = providers::Providers {
            context: pipeline,
            ..Default::default()
        };
        let manager = Manager::with_providers(directory.clone(), providers).unwrap();
        drop(manager);
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn skill_revocation_changes_delivered_revision_and_excludes_undelivered_versions() {
        let directory = std::env::temp_dir().join(format!("troop-context-{}", Uuid::new_v4()));
        std::fs::create_dir_all(directory.join("recipe")).unwrap();
        std::fs::write(
            directory.join("recipe/SKILL.md"),
            "---\nname: Recipe\ndescription: Inspect source\n---\nRead the file.",
        )
        .unwrap();
        let mut store = Store::open(&directory.join("data")).unwrap();
        let mut manager =
            Manager::with_providers(directory.clone(), providers::Providers::default()).unwrap();
        let source = json!({"path":directory.join("recipe").to_str().unwrap(),"id":"recipe","mode":"copy","source_kind":"local"});
        let preview = manager
            .skills_rpc(&mut store, "skills.preview", source.clone())
            .unwrap();
        manager.skills_rpc(&mut store,"skills.import",json!({"source":source,"preview_hash":preview["preview_hash"],"expected_revision":0})).unwrap();
        let mut run = json!({"agent_id":1});
        manager.prepare_skills(&mut store, &mut run).unwrap();
        let pipeline = ContextPipeline::new(vec![Arc::new(SkillContext)]);
        assert!(!pipeline.build(&store, &mut run).unwrap().is_empty());
        let before = run["context_sources"][0]["revision"].clone();
        assert_eq!(before["versions"].as_array().unwrap().len(), 1);
        store.skill_enable(1, "recipe", false).unwrap();
        assert!(pipeline.build(&store, &mut run).unwrap().is_empty());
        let after = &run["context_sources"][0]["revision"];
        assert_eq!(after["versions"], json!([]));
        assert_ne!(before["sha256"], after["sha256"]);
        drop(manager);
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn context_limit_counts_utf8_bytes_across_contributors() {
        struct Large;
        impl ContextContributor for Large {
            fn contribute(&self, _: &mut ContextSources<'_>) -> Result<ContextFragment, String> {
                Ok(ContextFragment {
                    source: "large".into(),
                    revision: json!(1),
                    items: vec![json!({"role":"system","content":"中".repeat(32_000)})],
                })
            }
        }
        let directory = std::env::temp_dir().join(format!("troop-context-{}", Uuid::new_v4()));
        let store = Store::open(&directory).unwrap();
        let pipeline = ContextPipeline::new(vec![Arc::new(Large), Arc::new(Large)]);
        assert!(pipeline
            .build(&store, &mut json!({}))
            .unwrap_err()
            .contains("budget"));
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
