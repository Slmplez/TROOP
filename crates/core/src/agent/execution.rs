//! Ownership of the existing, Core-wide execution slot. Idle MCP connections and model
//! requests do not hold it. Durable quarantine remains authoritative across restarts.
use std::collections::HashMap;
use troop_storage::Store;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum Work {
    Invocation(i64),
    Task(i64),
    Hook(i64),
    Discovery(i64),
    Closing(i64),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) struct Owner {
    pub run: i64,
    pub epoch: i64,
    pub work: Work,
}

impl Owner {
    pub fn new(run: i64, epoch: i64, work: Work) -> Self {
        Self { run, epoch, work }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Dispatched,
    Running,
}

#[derive(Default)]
pub(super) struct Gate {
    // Cleanup of idle sessions may overlap an already dispatched operation. Each has its
    // own identity: finishing one must never release another operation's reservation.
    active: HashMap<Owner, Phase>,
}

impl Gate {
    pub fn blocked(&self, store: &Store) -> Result<bool, String> {
        Ok(!self.active.is_empty()
            || store.agent_quarantined()?
            || store.tasks_quarantined()?
            || store.hooks_quarantined()?
            || store.mcp_quarantined()?)
    }

    /// Persist dispatch intent before allowing the caller to start its adapter. The
    /// closure returns the identity, including IDs allocated by the same commit.
    pub fn dispatch(
        &mut self,
        store: &mut Store,
        commit: impl FnOnce(&mut Store) -> Result<Owner, String>,
    ) -> Result<Option<Owner>, String> {
        if self.blocked(store)? {
            return Ok(None);
        }
        let owner = commit(store)?;
        self.active.insert(owner, Phase::Dispatched);
        Ok(Some(owner))
    }

    /// Current authorization belongs to the execution controller. Ownership, duplicate
    /// Ready rejection, and commit-before-go ordering belong to this gate.
    pub fn ready(
        &mut self,
        owner: Owner,
        authorized: bool,
        commit: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        if !authorized || self.active.get(&owner) != Some(&Phase::Dispatched) {
            return Ok(false);
        }
        commit()?;
        self.active.insert(owner, Phase::Running);
        Ok(true)
    }

    /// Persist the outcome (including unconfirmed stop) before releasing live ownership.
    /// The next dispatch rechecks durable quarantine; outcome unknown is not itself a
    /// reason to retain a live slot once the relevant resource is proven stopped.
    pub fn finish(
        &mut self,
        owner: Owner,
        commit: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        if !self.owns(owner) {
            return Ok(false);
        }
        commit()?;
        self.active.remove(&owner);
        Ok(true)
    }

    /// Closing an idle connection must proceed even while the slot is occupied. A
    /// discovery-to-cleanup handoff never creates a gap in resource ownership.
    pub fn close_session(
        &mut self,
        run: i64,
        epoch: i64,
        session: i64,
        commit: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        commit()?;
        self.active
            .remove(&Owner::new(run, epoch, Work::Discovery(session)));
        self.active.insert(
            Owner::new(run, epoch, Work::Closing(session)),
            Phase::Running,
        );
        Ok(())
    }

    pub fn owns(&self, owner: Owner) -> bool {
        self.active.contains_key(&owner)
    }

    pub fn closing(&self, run: Option<i64>) -> bool {
        self.active
            .keys()
            .any(|o| matches!(o.work, Work::Closing(_)) && run.is_none_or(|r| o.run == r))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::cell::Cell;

    fn with_store(test: impl FnOnce(&mut Store)) {
        let directory = std::env::temp_dir().join(format!("troop-gate-{}", uuid::Uuid::new_v4()));
        let mut store = Store::open(&directory).unwrap();
        test(&mut store);
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }

    // These tests cross the same ownership/commit interface as all four execution paths.
    fn reserved(owner: Owner) -> Gate {
        let mut gate = Gate::default();
        with_store(|store| {
            assert_eq!(gate.dispatch(store, |_| Ok(owner)).unwrap(), Some(owner));
        });
        gate
    }

    #[test]
    fn all_execution_kinds_share_the_slot_and_failed_dispatch_does_not_claim_it() {
        with_store(|store| {
            let kinds = [
                Work::Invocation(1),
                Work::Task(1),
                Work::Hook(1),
                Work::Discovery(1),
            ];
            let mut gate = Gate::default();
            assert!(gate
                .dispatch(store, |_| Err("commit failed".into()))
                .is_err());
            assert!(!gate.blocked(store).unwrap());
            for first in kinds {
                let owner = Owner::new(1, 1, first);
                assert_eq!(gate.dispatch(store, |_| Ok(owner)).unwrap(), Some(owner));
                for next in kinds {
                    let committed = Cell::new(false);
                    assert_eq!(
                        gate.dispatch(store, |_| {
                            committed.set(true);
                            Ok(Owner::new(2, 1, next))
                        })
                        .unwrap(),
                        None
                    );
                    assert!(!committed.get());
                }
                assert!(gate.finish(owner, || Ok(())).unwrap());
                assert!(!gate.blocked(store).unwrap());
            }
        });
    }

    #[test]
    fn durable_stop_evidence_controls_admission_after_live_completion() {
        for kind in 0..4 {
            with_store(|store| {
                let mut run = json!({"state":"queued","epoch":1,"revision":0});
                store
                    .agent_create("gate-test", &json!({}), &mut run)
                    .unwrap();
                let run_id = run["id"].as_i64().unwrap();
                let mut inv = json!({"state":"succeeded","stopped":true});
                store
                    .agent_save(&mut run, std::slice::from_mut(&mut inv), "fixture")
                    .unwrap();
                let mut record = json!({"state":"dispatched","stopped":false,"reviewed":false,
                    "run_id":run_id,"epoch":1,"kind":"background","owner_run_id":run_id,
                    "root_run_id":run_id,"event_key":"gate-test","rule":{"id":1},"transport":"stdio"});
                match kind {
                    0 | 1 => record["id"] = inv["id"].clone(),
                    2 => store.hook_call_create(&mut record).unwrap(),
                    _ => store.mcp_connection_create(&mut record).unwrap(),
                }
                let save = |store: &mut Store, run: &mut Value, record: &mut Value| match kind {
                    0 => store.agent_save(run, std::slice::from_mut(record), "fixture"),
                    1 => store.agent_commit(
                        run,
                        &mut [],
                        std::slice::from_mut(record),
                        None,
                        "fixture",
                    ),
                    2 => store.hook_call_save(record),
                    _ => store.mcp_connection_save(record),
                };
                let id = record["id"].as_i64().unwrap();
                let work = match kind {
                    0 => Work::Invocation(id),
                    1 => Work::Task(id),
                    2 => Work::Hook(id),
                    _ => Work::Discovery(id),
                };
                let owner = Owner::new(run_id, 1, work);
                let mut gate = Gate::default();
                assert_eq!(
                    gate.dispatch(store, |store| {
                        save(store, &mut run, &mut record)?;
                        Ok(owner)
                    })
                    .unwrap(),
                    Some(owner)
                );
                record["state"] = json!("indeterminate");
                assert!(gate
                    .finish(owner, || save(store, &mut run, &mut record))
                    .unwrap());
                assert!(!gate.owns(owner));
                // A fresh controller must still see the durable quarantine.
                let mut recovered = Gate::default();
                assert!(recovered.blocked(store).unwrap());
                assert!(recovered
                    .dispatch(store, |_| panic!("quarantined dispatch"))
                    .unwrap()
                    .is_none());
                // Known stop clears resource isolation even while business outcome is unknown.
                record["stopped"] = json!(true);
                save(store, &mut run, &mut record).unwrap();
                assert!(!recovered.blocked(store).unwrap());
            });
        }
    }

    #[test]
    fn ready_rejects_revoked_stale_and_duplicate_authority() {
        let owner = Owner::new(1, 2, Work::Invocation(3));
        let mut gate = reserved(owner);
        let committed = Cell::new(0);
        let commit = || {
            committed.set(committed.get() + 1);
            Ok(())
        };
        assert!(!gate.ready(owner, false, commit).unwrap());
        assert!(!gate
            .ready(Owner { epoch: 1, ..owner }, true, commit)
            .unwrap());
        assert!(!gate.ready(Owner { run: 2, ..owner }, true, commit).unwrap());
        assert!(!gate
            .ready(
                Owner {
                    work: Work::Task(3),
                    ..owner
                },
                true,
                commit
            )
            .unwrap());
        assert!(gate.ready(owner, true, commit).unwrap());
        assert!(!gate.ready(owner, true, commit).unwrap());
        assert_eq!(committed.get(), 1);
    }

    #[test]
    fn failed_ready_or_completion_commit_keeps_ownership() {
        for work in [
            Work::Invocation(1),
            Work::Task(1),
            Work::Hook(1),
            Work::Discovery(1),
        ] {
            let owner = Owner::new(1, 1, work);
            let mut gate = reserved(owner);
            assert!(gate
                .ready(owner, true, || Err("disk failure".into()))
                .is_err());
            assert!(gate.owns(owner));
            assert!(gate.ready(owner, true, || Ok(())).unwrap());
            assert!(gate.finish(owner, || Err("disk failure".into())).is_err());
            assert!(gate.owns(owner));
            assert!(gate.finish(owner, || Ok(())).unwrap());
            assert!(!gate.owns(owner));
        }
    }

    #[test]
    fn late_completion_cannot_release_another_owner() {
        let owner = Owner::new(1, 2, Work::Task(9));
        let mut gate = reserved(owner);
        assert!(!gate
            .finish(Owner { epoch: 1, ..owner }, || panic!("stale commit"))
            .unwrap());
        assert!(!gate
            .finish(
                Owner {
                    work: Work::Hook(9),
                    ..owner
                },
                || panic!("wrong work")
            )
            .unwrap());
        assert!(gate.owns(owner));
    }

    #[test]
    fn discovery_hands_off_to_cleanup_and_other_work_remains_owned() {
        let discovery = Owner::new(1, 2, Work::Discovery(8));
        let closing = Owner {
            work: Work::Closing(8),
            ..discovery
        };
        let mut gate = reserved(discovery);
        assert!(gate
            .close_session(1, 2, 8, || Err("disk failure".into()))
            .is_err());
        assert!(gate.owns(discovery));
        gate.close_session(1, 2, 8, || Ok(())).unwrap();
        assert!(!gate.owns(discovery));
        assert!(gate.closing(Some(1)));
        assert!(!gate.finish(discovery, || panic!("late discovery")).unwrap());
        gate.close_session(4, 1, 12, || Ok(())).unwrap();
        assert!(gate.finish(closing, || Ok(())).unwrap());
        assert!(!gate.closing(Some(1)));
        assert!(gate.closing(Some(4)));
    }

    #[test]
    fn finishing_a_call_does_not_release_its_connection_cleanup() {
        with_store(|store| {
            let owner = Owner::new(1, 2, Work::Invocation(3));
            let mut gate = Gate::default();
            gate.dispatch(store, |_| Ok(owner)).unwrap();
            gate.ready(owner, true, || Ok(())).unwrap();
            gate.close_session(1, 2, 8, || Ok(())).unwrap();
            assert!(gate.finish(owner, || Ok(())).unwrap());
            assert!(gate.blocked(store).unwrap());
            assert!(gate
                .finish(Owner::new(1, 2, Work::Closing(8)), || Ok(()))
                .unwrap());
            assert!(!gate.blocked(store).unwrap());
        });
    }
}
