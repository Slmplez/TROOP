use super::*;
use std::time::{SystemTime, UNIX_EPOCH};
struct Fixture {
    store: Option<Store>,
    directory: std::path::PathBuf,
    workspace: i64,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "troop-causal-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let workspace = directory.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let mut store = Store::open(&directory).unwrap();
        let id = store.add(workspace.to_str().unwrap()).unwrap().items[0].id;
        store
            .event_source_save("source-A", 0, json!({"workspace_id":id}))
            .unwrap();
        store
            .event_source_save("source-B", 0, json!({"workspace_id":id}))
            .unwrap();
        Self {
            store: Some(store),
            directory,
            workspace: id,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.store.take());
        assert!(self.directory.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[test]
fn source_object_limits_share_counts_across_actions_and_runs_without_coupling_other_objects() {
    let fixture = Fixture::new();
    let store = fixture.store.as_ref().unwrap();
    let source = json!({"kind":"source","source_id":"source-A"});
    let object = json!({"kind":"object","source_id":"source-A","subject_id":"issue:1"});
    store.causal_policy_save(&json!({"scope":source,"expected_revision":0,"limits":{"max_depth":4,"max_writes_per_hour":3,"cooldown_seconds":60}})).unwrap();
    store.causal_policy_save(&json!({"scope":object,"expected_revision":0,"limits":{"max_depth":2,"max_writes_per_hour":2,"cooldown_seconds":0}})).unwrap();
    let context =
        json!({"workspace_id":fixture.workspace,"source_id":"source-A","subject_id":"issue:1"});
    assert_eq!(
        store.causal_policy_resolve(&context).unwrap()["limits"]["max_depth"],
        2
    );
    let first = store
        .causal_write_reserve(&context, "file.write", "effect-1", 1)
        .unwrap();
    assert_eq!(
        store
            .causal_write_reserve(&context, "file.write", "effect-1", 1)
            .unwrap(),
        first
    );
    store
        .causal_write_reserve(&context, "process.exec", "effect-2", 2)
        .unwrap();
    assert!(store
        .causal_write_reserve(&context, "file.write", "effect-3", 3)
        .is_err());
    let other =
        json!({"workspace_id":fixture.workspace,"source_id":"source-A","subject_id":"issue:2"});
    store
        .causal_write_reserve(&other, "file.write", "effect-4", 4)
        .unwrap();
    assert!(store
        .causal_write_reserve(&other, "file.write", "effect-5", 5)
        .is_err());
    store
        .causal_write_reserve(&other, "process.exec", "effect-6", 6)
        .unwrap();
    let source_b =
        json!({"workspace_id":fixture.workspace,"source_id":"source-B","subject_id":"issue:1"});
    store
        .causal_write_reserve(&source_b, "file.write", "effect-7", 7)
        .unwrap();
    assert!(store
        .causal_write_reserve(&source_b, "file.write", "effect-1", 1)
        .is_err());
    store.causal_policy_save(&json!({"scope":object,"expected_revision":1,"limits":{"max_depth":2,"max_writes_per_hour":1,"cooldown_seconds":0}})).unwrap();
    assert_eq!(
        store.causal_policy_history(&object).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        store
            .causal_write_check(&context, "process.exec", "effect-8")
            .unwrap()["count"],
        2
    );
}

#[test]
fn scoped_policy_defaults_revisions_and_window_survive_reopen() {
    let mut fixture = Fixture::new();
    let workspace = fixture.workspace;
    let store = fixture.store.as_mut().unwrap();
    let scope = json!({"kind":"workspace","workspace_id":workspace});
    let context = json!({"workspace_id":workspace,"source_id":"internal:1","subject_id":"run:1"});
    assert_eq!(
        store.causal_policy_resolve(&context).unwrap()["limits"]["max_writes_per_hour"],
        3
    );
    store.causal_policy_save(&json!({"scope":scope,"expected_revision":0,"limits":{"max_depth":5,"max_writes_per_hour":1,"cooldown_seconds":0}})).unwrap();
    store
        .causal_write_reserve(&context, "file.write", "effect-1", 1)
        .unwrap();
    assert!(store.causal_policy_save(&json!({"scope":scope,"expected_revision":0,"limits":{"max_depth":5,"max_writes_per_hour":100,"cooldown_seconds":0}})).is_err());
    assert!(store
        .causal_policy_get(&json!({"kind":"source","source_id":"missing"}))
        .is_err());
    drop(fixture.store.take());
    fixture.store = Some(Store::open(&fixture.directory).unwrap());
    let store = fixture.store.as_ref().unwrap();
    assert_eq!(
        store
            .causal_write_check(&context, "file.write", "effect-2")
            .unwrap()["allowed"],
        false
    );
    store
        .db
        .execute("UPDATE causal_writes SET created_at=unixepoch()-3601", [])
        .unwrap();
    assert_eq!(
        store
            .causal_write_check(&context, "file.write", "effect-2")
            .unwrap()["allowed"],
        true
    );
    assert_eq!(store.causal_policy_get(&scope).unwrap()["revision"], 1);
}
