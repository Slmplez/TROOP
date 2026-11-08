use super::*;
use std::time::{SystemTime, UNIX_EPOCH};
static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct Fixture {
    store: Option<Store>,
    dir: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "troop-follow-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
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
fn run(store: &mut Store, name: &str) -> Value {
    let mut doc = json!({"state":"completed","epoch":1,"revision":0,"pending":[],"waiting":[]});
    store.agent_create(name, &json!({}), &mut doc).unwrap();
    doc
}
fn follow(store: &Store, id: i64, cursor: Option<&str>) -> Value {
    store
        .execution_follow("run", id, cursor, |s| s.agent_run(id))
        .unwrap()
}
#[test]
fn snapshot_replay_is_contiguous_scoped_and_survives_reopen() {
    let mut f = Fixture::new();
    let s = f.store.as_mut().unwrap();
    let mut a = run(s, "a");
    let mut b = run(s, "b");
    let id = a["id"].as_i64().unwrap();
    let first = follow(s, id, None);
    let mut cursor = first["cursor"].as_str().unwrap().to_owned();
    for _ in 0..40 {
        s.agent_save(&mut a, &mut [], "a").unwrap();
        s.agent_save(&mut b, &mut [], "b").unwrap();
    }
    let mut events = 0;
    let mut pages = 0;
    loop {
        let frame = follow(s, id, Some(&cursor));
        assert_eq!(frame["from_cursor"], cursor);
        for change in frame["changes"].as_array().unwrap() {
            assert_eq!(change["run_id"], id);
            if change["resource"] == "run" {
                assert_eq!(change["revision"], change["run_revision"]);
            }
            if change["resource"] == "event" {
                events += 1;
            }
        }
        cursor = frame["cursor"].as_str().unwrap().into();
        pages += 1;
        if frame["has_more"] == false {
            assert_eq!(frame["snapshot"]["revision"], 40);
            break;
        }
        assert!(frame["snapshot"].is_null());
    }
    assert!(pages > 1);
    assert_eq!(events, 40);
    drop(f.store.take());
    f.store = Some(Store::open(&f.dir).unwrap());
    let frame = follow(f.store.as_ref().unwrap(), id, Some(&cursor));
    assert_eq!(frame["state"], "delta");
    assert_eq!(frame["cursor"], cursor);
}
#[test]
fn rollback_removes_feed_entries_and_bad_or_expired_cursors_reset() {
    let mut f = Fixture::new();
    let s = f.store.as_mut().unwrap();
    let mut doc = run(s, "a");
    let id = doc["id"].as_i64().unwrap();
    let base = follow(s, id, None);
    let cursor = base["cursor"].as_str().unwrap();
    s.db.execute_batch("CREATE TRIGGER fail_receipt BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    let result = s.execute_operation("desktop", "op", "test", &json!({}), None, |s| {
        s.agent_save(&mut doc, &mut [], "rollback")?;
        Ok((json!({}), ()))
    });
    assert!(result.is_err());
    let replay = follow(s, id, Some(cursor));
    assert_eq!(replay["cursor"], cursor);
    assert!(replay["changes"].as_array().unwrap().is_empty());
    for bad in [
        "foreign",
        &format!("{cursor}999999"),
        &cursor.replace(":run:", ":task:"),
    ] {
        assert_eq!(follow(s, id, Some(bad))["state"], "reset_required");
    }
    s.db.execute_batch("WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<4100) INSERT INTO execution_changes(resource,resource_id,run_id,revision) SELECT 'run',1,1,0 FROM seq;").unwrap();
    assert_eq!(follow(s, id, Some(cursor))["state"], "reset_required");
    let fresh = follow(s, id, None);
    assert_eq!(fresh["state"], "snapshot");
    let count: i64 =
        s.db.query_row("SELECT count(*) FROM execution_changes", [], |r| r.get(0))
            .unwrap();
    assert_eq!(count, 4096);
}
#[test]
fn snapshot_boundary_cannot_observe_a_concurrent_writer_commit() {
    let mut f = Fixture::new();
    let s = f.store.as_mut().unwrap();
    let doc = run(s, "a");
    let id = doc["id"].as_i64().unwrap();
    let writer = Connection::open(f.dir.join("troop.sqlite3")).unwrap();
    let baseline = s
        .execution_follow("run", id, None, |s| {
            writer
                .execute(
                    "UPDATE agent_runs SET document=json_set(document,'$.revision',5) WHERE id=?1",
                    [id],
                )
                .unwrap();
            s.agent_run(id)
        })
        .unwrap();
    assert_eq!(baseline["snapshot"]["revision"], 0);
    let next = follow(s, id, baseline["cursor"].as_str());
    assert_eq!(next["snapshot"]["revision"], 5);
    assert_eq!(next["changes"].as_array().unwrap().len(), 1);
}
#[test]
fn a_deleted_middle_change_requires_reset_instead_of_silent_skip() {
    let mut f = Fixture::new();
    let s = f.store.as_mut().unwrap();
    let mut doc = run(s, "a");
    let id = doc["id"].as_i64().unwrap();
    let base = follow(s, id, None);
    for _ in 0..3 {
        s.agent_save(&mut doc, &mut [], "change").unwrap();
    }
    s.db.execute("DELETE FROM execution_changes WHERE sequence=(SELECT max(sequence)-1 FROM execution_changes)",[]).unwrap();
    assert_eq!(
        follow(s, id, base["cursor"].as_str())["state"],
        "reset_required"
    );
}
