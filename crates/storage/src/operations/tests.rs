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
fn archived_receipts_keep_identity_conflicts_and_original_result_after_restart() {
    let mut fixture = Fixture::new();
    let store = fixture.store.as_mut().unwrap();
    let input = json!({"value": "original"});
    let (original, _) = store
        .execute_operation("desktop", "archive-once", "example", &input, None, |_| {
            Ok((json!({"saved":true}), ()))
        })
        .unwrap();
    store
        .operation_archive_configure(
            &json!({"expected_revision":1,"enabled":true,"retention_seconds":60}),
        )
        .unwrap();
    store
        .db
        .execute("UPDATE operation_receipt_times SET updated_at=0", [])
        .unwrap();
    assert_eq!(store.archive_operations().unwrap()["archived"], 1);
    let stub = store.operation_get("desktop", "archive-once").unwrap();
    assert_eq!(stub["state"], "archived");
    assert_eq!(stub["terminal_state"], "committed");
    let archive_id = stub["archive_ref"]["archive_id"].as_str().unwrap();
    assert_eq!(
        store
            .operation_archive_get("desktop", "archive-once", archive_id)
            .unwrap(),
        original
    );
    assert!(store
        .operation_archive_get("other", "archive-once", archive_id)
        .is_err());
    assert!(store
        .operation_archive_get("desktop", "other", archive_id)
        .is_err());
    drop(fixture.store.take());
    fixture.store = Some(Store::open(&fixture.dir).unwrap());
    let store = fixture.store.as_mut().unwrap();
    let (replayed, effect) = store
        .execute_operation(
            "desktop",
            "archive-once",
            "example",
            &input,
            None,
            |_| -> Result<(Value, ()), OperationFailure> {
                panic!("archived command executed again")
            },
        )
        .unwrap();
    assert_eq!(replayed, stub);
    assert!(effect.is_none());
    let (conflict, _) = store
        .execute_operation(
            "desktop",
            "archive-once",
            "example",
            &json!({"value":"changed"}),
            None,
            |_| Ok((Value::Null, ())),
        )
        .unwrap();
    assert_eq!(conflict["error"]["kind"], "operation_conflict");
    assert_eq!(store.archive_operations().unwrap()["archived"], 0);
}

#[test]
fn archive_batch_rolls_back_and_preserves_unresolved_external_intents() {
    let mut fixture = Fixture::new();
    let store = fixture.store.as_mut().unwrap();
    store
        .operation_archive_configure(
            &json!({"expected_revision":1,"enabled":true,"retention_seconds":60}),
        )
        .unwrap();
    store
        .reserve_external_operation("desktop", "pending", "external", &json!({}), None)
        .unwrap();
    let (original, _) = store
        .execute_operation("desktop", "finished", "example", &json!({}), None, |_| {
            Ok((json!("done"), ()))
        })
        .unwrap();
    store
        .db
        .execute("UPDATE operation_receipt_times SET updated_at=0", [])
        .unwrap();
    store.db.execute_batch("CREATE TRIGGER fail_archive BEFORE UPDATE ON operations WHEN json_extract(NEW.receipt,'$.state')='archived' BEGIN SELECT RAISE(ABORT,'archive fault'); END;").unwrap();
    assert!(store.archive_operations().is_err());
    assert_eq!(
        store.operation_get("desktop", "finished").unwrap(),
        original
    );
    assert_eq!(
        store
            .db
            .query_row("SELECT COUNT(*) FROM operation_archives", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    store.db.execute_batch("DROP TRIGGER fail_archive").unwrap();
    assert_eq!(store.archive_operations().unwrap()["archived"], 1);
    assert_eq!(
        store.operation_get("desktop", "pending").unwrap()["state"],
        "needs_reconciliation"
    );
    assert_eq!(
        store
            .finish_external_operation("desktop", "pending", Ok(json!("reconciled")))
            .unwrap()["state"],
        "committed"
    );
    assert_eq!(store.archive_operations().unwrap()["archived"], 0);
}

#[test]
fn archive_configuration_is_versioned_and_disabled_by_default() {
    let mut fixture = Fixture::new();
    let store = fixture.store.as_mut().unwrap();
    assert_eq!(
        store.operation_archive_settings().unwrap()["enabled"],
        false
    );
    assert_eq!(store.archive_operations().unwrap()["archived"], 0);
    let settings = store
        .operation_archive_configure(
            &json!({"expected_revision":1,"enabled":true,"retention_seconds":3600}),
        )
        .unwrap();
    assert_eq!(settings["revision"], 2);
    assert!(store
        .operation_archive_configure(
            &json!({"expected_revision":1,"enabled":false,"retention_seconds":3600})
        )
        .is_err());
    assert!(store
        .operation_archive_configure(
            &json!({"expected_revision":2,"enabled":true,"retention_seconds":0})
        )
        .is_err());
    assert_eq!(store.operation_archive_settings().unwrap(), settings);
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
