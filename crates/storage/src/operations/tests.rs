use super::*;
use rusqlite::Connection;
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

#[test]
fn archived_receipt_keeps_a_reference_and_does_not_replay() {
    let mut f = Fixture::new();
    let s = f.store.as_mut().unwrap();
    let (receipt, _) = s
        .execute_operation(
            "desktop",
            "op",
            "agent.start",
            &json!({"n": 1}),
            None,
            create,
        )
        .unwrap();
    assert_eq!(s.archive_operation_receipts(30, 30).unwrap(), 0);
    assert_eq!(
        s.operation_get("desktop", "op").unwrap()["state"],
        "committed"
    );
    s.db.execute(
        "UPDATE operations SET recorded_at=unixepoch()-100 WHERE operation_id='op'",
        [],
    )
    .unwrap();
    assert_eq!(s.archive_operation_receipts(30, 60).unwrap(), 1);
    let archived = s.operation_get("desktop", "op").unwrap();
    assert_eq!(archived["state"], "archived");
    assert!(archived.get("result").is_none());
    let reference = archived["archive_ref"].as_str().unwrap();
    assert!(reference.starts_with("archive:"));
    let body = s.operation_archive_get(reference).unwrap();
    assert_eq!(body["state"], "committed");
    assert_eq!(body["result"]["run"]["id"], receipt["result"]["run"]["id"]);
    let reference = reference.to_owned();
    let (again, effect) = s
        .execute_operation::<()>(
            "desktop",
            "op",
            "agent.start",
            &json!({"n": 1}),
            None,
            |_| panic!("archived command replayed"),
        )
        .unwrap();
    assert!(effect.is_none());
    assert_eq!(again["state"], "archived");
    assert_eq!(again["archive_ref"], reference);
    let (conflict, effect) = s
        .execute_operation::<()>(
            "desktop",
            "op",
            "agent.start",
            &json!({"n": 2}),
            None,
            |_| panic!("conflicting archived command ran"),
        )
        .unwrap();
    assert!(effect.is_none());
    assert_eq!(conflict["error"]["kind"], "operation_conflict");
    s.db.execute(
        "UPDATE operation_receipt_archive SET payload_expires_at=unixepoch()-1",
        [],
    )
    .unwrap();
    assert_eq!(s.archive_operation_receipts(30, 60).unwrap(), 0);
    assert!(s
        .operation_archive_get(&reference)
        .unwrap_err()
        .contains("保留期"));
    let still = s.operation_get("desktop", "op").unwrap();
    assert_eq!(still["state"], "archived");
    assert_eq!(still["archive_ref"], reference);
    assert_eq!(
        s.operation_get("desktop", "missing").unwrap()["state"],
        "not_found"
    );
}

#[test]
fn schema_34_gains_receipt_archive_without_losing_the_receipt() {
    let mut f = Fixture::new();
    let (receipt, _) = f
        .store
        .as_mut()
        .unwrap()
        .execute_operation("desktop", "keep", "agent.start", &json!({}), None, create)
        .unwrap();
    f.store
        .as_ref()
        .unwrap()
        .db
        .execute_batch("ALTER TABLE operations DROP COLUMN recorded_at; DROP TABLE operation_receipt_archive; PRAGMA user_version=34;")
        .unwrap();
    let dir = f.dir.clone();
    drop(f.store.take());
    f.store = Some(Store::open(&dir).unwrap());
    let s = f.store.as_ref().unwrap();
    let version: i64 =
        s.db.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
    assert_eq!(version, 35);
    assert_eq!(s.operation_get("desktop", "keep").unwrap(), receipt);
    let recorded: bool =
        s.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('operations') WHERE name='recorded_at')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(recorded);
}

#[test]
fn incomplete_receipt_archive_is_rejected_without_migration() {
    let mut f = Fixture::new();
    f.store
        .as_ref()
        .unwrap()
        .db
        .execute_batch("DROP TABLE operation_receipt_archive; PRAGMA user_version=35;")
        .unwrap();
    let dir = f.dir.clone();
    drop(f.store.take());
    match Store::open(&dir) {
        Err(error) => assert!(error.contains("Operation receipt archive is incomplete")),
        Ok(_) => panic!("incomplete receipt archive was opened"),
    }
    let db = Connection::open(dir.join("troop.sqlite3")).unwrap();
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 35);
    drop(db);
}
