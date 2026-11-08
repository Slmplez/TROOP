use super::*;
use rusqlite::Connection;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    directory: PathBuf,
    store: Option<Store>,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "troop-lifecycle-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SERIAL.fetch_add(1, Ordering::SeqCst)
        ));
        let workspace = directory.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let store = Store::open(&directory).unwrap();
        store.add(workspace.to_str().unwrap()).unwrap();
        Self {
            directory,
            store: Some(store),
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
fn run(store: &mut Store, state: &str) -> Value {
    let mut doc = json!({"state":state,"epoch":1,"revision":0,"intent":null,"pending":[],"waiting":[],"workspace_id":1,"history":[]});
    store
        .agent_create(
            &format!("test-{}", SERIAL.fetch_add(1, Ordering::SeqCst)),
            &json!({}),
            &mut doc,
        )
        .unwrap();
    store.agent_save(&mut doc, &mut [], "fixture").unwrap();
    doc
}
fn invocation(store: &mut Store, owner: &mut Value, state: &str) -> Value {
    let mut inv =
        json!({"run_id":owner["id"],"epoch":1,"state":state,"stopped":false,"reviewed":false});
    store
        .agent_save(owner, std::slice::from_mut(&mut inv), "fixture")
        .unwrap();
    inv
}
fn task(store: &mut Store, owner: &mut Value, child: Option<&mut Value>) -> Value {
    let inv = invocation(store, owner, "succeeded");
    let mut task = json!({"id":inv["id"],"owner_run_id":owner["id"],"root_run_id":Store::task_root(owner),"kind":if child.is_some(){"agent"}else{"background"},"state":"running","epoch":1,"stopped":false,"reviewed":false,"stop_requested":false,"consumed":false});
    if let Some(child) = child {
        child["owner_task_id"] = inv["id"].clone();
        child["root_run_id"] = json!(Store::task_root(owner));
        store.agent_save(child, &mut [], "fixture").unwrap();
        task["child_run_id"] = child["id"].clone();
    }
    store
        .agent_commit(
            owner,
            &mut [],
            std::slice::from_mut(&mut task),
            None,
            "fixture",
        )
        .unwrap();
    task
}
fn id(doc: &Value) -> i64 {
    doc["id"].as_i64().unwrap()
}
fn event_count(store: &Store) -> i64 {
    store
        .db
        .query_row("SELECT count(*) FROM agent_events", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn tree_stop_rolls_back_all_runs_tasks_and_events_before_returning_a_plan() {
    let mut f = Fixture::new();
    let store = f.store.as_mut().unwrap();
    let mut root = run(store, "running");
    let mut child = run(store, "running");
    let owned = task(store, &mut root, Some(&mut child));
    let background = task(store, &mut child, None);
    let unrelated = run(store, "running");
    let before = (
        store.agent_run(id(&root)).unwrap(),
        store.agent_run(id(&child)).unwrap(),
        event_count(store),
    );
    store.db.execute_batch(&format!("CREATE TRIGGER fail_task BEFORE UPDATE ON owned_tasks WHEN NEW.id={} BEGIN SELECT RAISE(ABORT,'stop fault'); END;",id(&background))).unwrap();
    assert!(store
        .stop_tree(id(&root), Some("cancel"), &[id(&background)])
        .is_err());
    assert_eq!(store.agent_run(id(&root)).unwrap(), before.0);
    assert_eq!(store.agent_run(id(&child)).unwrap(), before.1);
    assert_eq!(store.owned_task(id(&owned)).unwrap(), owned);
    assert_eq!(store.owned_task(id(&background)).unwrap(), background);
    assert_eq!(event_count(store), before.2);
    store.db.execute_batch("DROP TRIGGER fail_task").unwrap();
    let plan = store
        .stop_tree(id(&root), Some("cancel"), &[id(&background)])
        .unwrap();
    assert_eq!(plan.runs, vec![id(&root), id(&child)]);
    assert!(plan.tasks.contains(&id(&background)));
    assert_eq!(store.agent_run(id(&root)).unwrap()["intent"], "cancel");
    assert_eq!(store.agent_run(id(&child)).unwrap()["intent"], "cancel");
    assert_eq!(
        store.owned_task(id(&background)).unwrap()["state"],
        "cancelling"
    );
    assert_eq!(store.agent_run(id(&unrelated)).unwrap(), unrelated);
}

#[test]
fn direct_child_task_stop_commits_with_its_descendant_fence() {
    let mut f = Fixture::new();
    let store = f.store.as_mut().unwrap();
    let mut root = run(store, "running");
    let mut child = run(store, "running");
    let owned = task(store, &mut root, Some(&mut child));
    let background = task(store, &mut child, None);
    let before_root = store.agent_run(id(&root)).unwrap();
    store.db.execute_batch("CREATE TRIGGER fail_fence BEFORE INSERT ON agent_events WHEN NEW.kind='tree_stop_requested' BEGIN SELECT RAISE(ABORT,'fence fault'); END;").unwrap();
    assert!(store
        .stop_owned_task(id(&owned), &[id(&background)])
        .is_err());
    assert_eq!(store.owned_task(id(&owned)).unwrap(), owned);
    assert_eq!(store.agent_run(id(&child)).unwrap(), child);
    assert_eq!(store.agent_run(id(&root)).unwrap(), before_root);
    store.db.execute_batch("DROP TRIGGER fail_fence").unwrap();
    let (stopped, plan) = store
        .stop_owned_task(id(&owned), &[id(&background)])
        .unwrap();
    assert_eq!(stopped["state"], "cancelling");
    assert_eq!(plan.runs, vec![id(&child)]);
    assert_eq!(store.agent_run(id(&root)).unwrap()["state"], "running");
    assert_eq!(store.agent_run(id(&root)).unwrap()["intent"], Value::Null);
    assert_eq!(store.agent_run(id(&child)).unwrap()["intent"], "cancel");
}

#[test]
fn startup_recovery_is_atomic_and_retry_does_not_replay_or_clear_cancellation() {
    let mut f = Fixture::new();
    let store = f.store.as_mut().unwrap();
    let mut root = run(store, "cancelling");
    root["intent"] = json!("cancel");
    let inv = invocation(store, &mut root, "running");
    let background = task(store, &mut root, None);
    let before = store.agent_run(id(&root)).unwrap();
    store.db.execute_batch("CREATE TRIGGER fail_recover BEFORE UPDATE ON owned_tasks BEGIN SELECT RAISE(ABORT,'recovery fault'); END;").unwrap();
    drop(f.store.take());
    assert!(Store::open(&f.directory).is_err());
    let connection = Connection::open(f.directory.join("troop.sqlite3")).unwrap();
    let raw: String = connection
        .query_row(
            "SELECT document FROM agent_runs WHERE id=?1",
            [id(&root)],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), before);
    let raw: String = connection
        .query_row(
            "SELECT document FROM agent_invocations WHERE id=?1",
            [id(&inv)],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), inv);
    connection
        .execute_batch("DROP TRIGGER fail_recover")
        .unwrap();
    drop(connection);
    let mut recovered = Store::open(&f.directory).unwrap();
    assert_eq!(
        recovered.agent_run(id(&root)).unwrap()["state"],
        "interrupted"
    );
    assert_eq!(recovered.agent_run(id(&root)).unwrap()["intent"], "cancel");
    assert_eq!(
        recovered.agent_invocation(id(&inv)).unwrap()["state"],
        "indeterminate"
    );
    assert_eq!(
        recovered.owned_task(id(&background)).unwrap()["state"],
        "indeterminate"
    );
    let count = event_count(&recovered);
    recovered.recover_executions().unwrap();
    assert_eq!(event_count(&recovered), count);
    f.store = Some(recovered);
}

#[test]
fn resume_rolls_back_history_epoch_and_old_plan_on_adapter_or_commit_failure() {
    let mut f = Fixture::new();
    let store = f.store.as_mut().unwrap();
    let mut doc = run(store, "interrupted");
    let inv = invocation(store, &mut doc, "prepared");
    doc["pending"] = json!([inv["id"]]);
    store.agent_save(&mut doc, &mut [], "fixture").unwrap();
    assert!(store
        .resume_run(id(&doc), |_, _| Err("history failed".into()))
        .is_err());
    assert_eq!(store.agent_run(id(&doc)).unwrap(), doc);
    store.db.execute_batch("CREATE TRIGGER fail_resume BEFORE INSERT ON agent_events WHEN NEW.kind='manual_resume' BEGIN SELECT RAISE(ABORT,'resume fault'); END;").unwrap();
    let history = |run: &mut Value, results: &[Value]| {
        run["history"] = json!(results);
        Ok(())
    };
    assert!(store.resume_run(id(&doc), history).is_err());
    assert_eq!(store.agent_run(id(&doc)).unwrap(), doc);
    assert_eq!(store.agent_invocation(id(&inv)).unwrap(), inv);
    store.db.execute_batch("DROP TRIGGER fail_resume").unwrap();
    let resumed = store.resume_run(id(&doc), history).unwrap();
    assert_eq!(resumed["epoch"], 2);
    assert_eq!(resumed["pending"], json!([]));
    assert_eq!(resumed["history"][0]["state"], "cancelled");
    assert_eq!(store.agent_invocation(id(&inv)).unwrap()["epoch"], 1);
    assert!(store.resume_run(id(&doc), history).is_err());
}

#[test]
fn reconciliation_commits_evidence_without_implicitly_resuming() {
    let mut f = Fixture::new();
    let store = f.store.as_mut().unwrap();
    let mut doc = run(store, "interrupted");
    let inv = invocation(store, &mut doc, "indeterminate");
    store.db.execute_batch("CREATE TRIGGER fail_review BEFORE INSERT ON agent_events WHEN NEW.kind='reconciled' BEGIN SELECT RAISE(ABORT,'review fault'); END;").unwrap();
    assert!(store
        .reconcile_invocation(id(&inv), 1, Evidence::Reviewed("verified stop".into()))
        .is_err());
    assert_eq!(store.agent_invocation(id(&inv)).unwrap(), inv);
    assert!(store.agent_quarantined().unwrap());
    store.db.execute_batch("DROP TRIGGER fail_review").unwrap();
    store
        .reconcile_invocation(id(&inv), 1, Evidence::Reviewed("verified stop".into()))
        .unwrap();
    assert!(!store.agent_quarantined().unwrap());
    assert_eq!(store.agent_run(id(&doc)).unwrap()["state"], "interrupted");
    assert_eq!(store.agent_run(id(&doc)).unwrap()["epoch"], 1);
}
