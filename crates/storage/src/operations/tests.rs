use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    store: Option<Store>,
    dir: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "troop-operations-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Self {
            store: Some(Store::open(&dir).unwrap()),
            dir,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.store.take());
        assert!(self.dir.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(&self.dir).unwrap();
    }
}
fn create(store: &mut Store) -> Result<(Value, i64), OperationFailure> {
    let mut run = json!({"state":"queued","epoch":1,"revision":0});
    store.agent_create("business-id", &json!({}), &mut run)?;
    Ok((json!({"run":run}), run["id"].as_i64().unwrap()))
}
#[test]
fn receipt_and_business_commit_together_and_duplicate_survives_reopen() {
    let mut f = Fixture::new();
    let s = f.store.as_mut().unwrap();
    let instance = s.instance_id().unwrap();
    let (receipt, effect) = s
        .execute_operation(
            "desktop",
            "op",
            "agent.start",
            &json!({"b":2,"a":1}),
            None,
            create,
        )
        .unwrap();
    assert!(effect.is_some());
    assert_eq!(receipt["state"], "committed");
    drop(f.store.take());
    f.store = Some(Store::open(&f.dir).unwrap());
    let s = f.store.as_mut().unwrap();
    assert_eq!(s.instance_id().unwrap(), instance);
    let (duplicate, effect) = s
        .execute_operation::<()>(
            "desktop",
            "op",
            "agent.start",
            &json!({"a":1,"b":2}),
            None,
            |_| panic!("must not execute again"),
        )
        .unwrap();
    assert_eq!(receipt, duplicate);
    assert!(effect.is_none());
    assert_eq!(s.agent_runs().unwrap().len(), 1);
    assert_eq!(
        s.operation_get("other-principal", "op").unwrap()["state"],
        "not_found"
    );
}
#[test]
fn fingerprint_covers_method_target_and_revision_and_keeps_original_result() {
    let mut f = Fixture::new();
    let s = f.store.as_mut().unwrap();
    let (receipt, _) = s
        .execute_operation(
            "desktop",
            "op",
            "agent.start",
            &json!({"id":1}),
            Some(3),
            create,
        )
        .unwrap();
    for (method, input, revision) in [
        ("agent.cancel", json!({"id":1}), Some(3)),
        ("agent.start", json!({"id":2}), Some(3)),
        ("agent.start", json!({"id":1}), Some(4)),
    ] {
        let (result, _) = s
            .execute_operation::<()>("desktop", "op", method, &input, revision, |_| {
                panic!("conflicting request ran")
            })
            .unwrap();
        assert_eq!(result["error"]["kind"], "operation_conflict");
    }
    assert_eq!(s.operation_get("desktop", "op").unwrap(), receipt);
}
#[test]
fn receipt_write_failure_rolls_back_business_and_never_releases_runtime_action() {
    let mut f = Fixture::new();
    let s = f.store.as_mut().unwrap();
    s.db.execute_batch("CREATE TRIGGER fail_receipt BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'receipt fault'); END;").unwrap();
    assert!(s
        .execute_operation("desktop", "op", "agent.start", &json!({}), None, create)
        .is_err());
    assert!(s.agent_runs().unwrap().is_empty());
    assert_eq!(
        s.operation_get("desktop", "op").unwrap()["state"],
        "not_found"
    );
    assert!(s.db.is_autocommit());
    s.db.execute_batch("DROP TRIGGER fail_receipt").unwrap();
    assert_eq!(
        s.execute_operation("desktop", "op", "agent.start", &json!({}), None, create)
            .unwrap()
            .0["state"],
        "committed"
    );
}
#[test]
fn rejected_partial_mutation_rolls_back_and_rejection_is_stable() {
    let mut f = Fixture::new();
    let s = f.store.as_mut().unwrap();
    let (receipt, _) = s
        .execute_operation::<()>("desktop", "op", "agent.start", &json!({}), None, |s| {
            create(s)?;
            Err(OperationFailure {
                current_revision: None,
                kind: "revision_conflict",
                message: "changed".into(),
            })
        })
        .unwrap();
    assert!(s.agent_runs().unwrap().is_empty());
    assert_eq!(receipt["state"], "rejected");
    assert_eq!(
        s.execute_operation::<()>(
            "desktop",
            "op",
            "agent.start",
            &json!({}),
            None,
            |_| panic!("rejected command replayed")
        )
        .unwrap()
        .0,
        receipt
    );
}
