use super::*;

fn interrupted() -> Value {
    json!({"id":1,"state":"interrupted","epoch":4,"intent":null,"pending":[7],"waiting":[],"history":[]})
}
fn pending() -> Value {
    json!({"id":7,"run_id":1,"epoch":4,"state":"prepared","reviewed":false,"stopped":false})
}

#[test]
fn fences_and_recovery_never_erase_terminal_intent() {
    for intent in [json!("cancel"), json!("failure")] {
        let mut run = interrupted();
        run["intent"] = intent.clone();
        assert!(fence_run(&mut run, None));
        assert!(recover_run(&mut run, &mut [pending()]));
        assert_eq!(run["intent"], intent);
        let before = run.clone();
        assert!(resume(&mut run, &mut [pending()], &Relations::default()).is_err());
        assert_eq!(run, before);
    }
    for state in ["completed", "failed", "cancelled"] {
        let mut run = json!({"state":state,"intent":"failure","epoch":3});
        let before = run.clone();
        assert!(!fence_run(&mut run, Some("cancel")));
        assert!(!recover_run(&mut run, &mut []));
        assert_eq!(run, before);
    }
}

#[test]
fn stop_waits_for_owned_work_and_preserves_failure_diagnostics() {
    let mut run = json!({"state":"cancelling","intent":"failure","error":"model failed"});
    let mut invs = [pending()];
    let tasks = [json!({"state":"running"})];
    assert!(!finish_stop(
        &mut run,
        &mut invs,
        &Relations {
            tasks: &tasks,
            ..Default::default()
        },
        false
    ));
    assert_eq!(invs[0]["state"], "prepared");
    assert!(!finish_stop(
        &mut run,
        &mut invs,
        &Relations::default(),
        true
    ));
    assert!(finish_stop(
        &mut run,
        &mut invs,
        &Relations::default(),
        false
    ));
    assert_eq!(run["state"], "failed");
    assert_eq!(run["error"], "model failed");
    assert_eq!(invs[0]["state"], "cancelled");
}

#[test]
fn process_stop_and_outcome_review_are_distinct() {
    let mut invs =
        [json!({"id":7,"epoch":4,"state":"indeterminate","stopped":true,"reviewed":false})];
    let mut run = interrupted();
    run["state"] = json!("cancelling");
    assert!(finish_stop(
        &mut run,
        &mut invs,
        &Relations::default(),
        false
    ));
    assert!(!invocation_holds_resource(&invs[0]));
    assert!(resume(&mut run, &mut invs, &Relations::default()).is_err());
    reconcile_invocation(
        &run,
        &mut invs[0],
        4,
        Evidence::Reviewed("effects inspected".into()),
    )
    .unwrap();
    assert_eq!(invs[0]["state"], "indeterminate");
    assert_eq!(run["state"], "interrupted");
    let results = resume(&mut run, &mut invs, &Relations::default()).unwrap();
    assert_eq!(run["epoch"], 5);
    assert_eq!(results[0]["result"]["indeterminate"], true);
    assert!(run["pending"].as_array().unwrap().is_empty());
}

#[test]
fn every_unresolved_dependency_blocks_resume_without_mutation() {
    let unknown = [json!({"state":"indeterminate","reviewed":false,"stopped":true})];
    let owner = json!({"state":"queued","intent":null});
    let consumed = json!({"consumed":true});
    for relations in [
        Relations {
            tasks: &unknown,
            ..Default::default()
        },
        Relations {
            hooks: &unknown,
            ..Default::default()
        },
        Relations {
            connections: &unknown,
            ..Default::default()
        },
        Relations {
            parent: Some((&consumed, &owner)),
            ..Default::default()
        },
    ] {
        let mut run = interrupted();
        let mut invs = [pending()];
        let before = (run.clone(), invs.clone());
        assert!(resume(&mut run, &mut invs, &relations).is_err());
        assert_eq!((run, invs), before);
    }
}

#[test]
fn manual_resume_invalidates_old_prepared_plan_instead_of_replaying_it() {
    let mut run = interrupted();
    let mut invs = [pending()];
    let results = resume(&mut run, &mut invs, &Relations::default()).unwrap();
    assert_eq!(run["state"], "queued");
    assert_eq!(run["epoch"], 5);
    assert_eq!(invs[0]["epoch"], 4);
    assert_eq!(invs[0]["state"], "cancelled");
    assert_eq!(results, invs);
    assert_eq!(run["pending"], json!([]));
}

#[test]
fn receipt_requires_exact_identity_known_result_and_confirmed_stop() {
    let owner = interrupted();
    let original =
        json!({"id":7,"epoch":4,"state":"indeterminate","stopped":false,"reviewed":false});
    let receipt = json!({"id":7,"epoch":4,"status":"finished","result":{"ok":true,"stopped":true,"value":{"exit_code":0}}});
    for (path, value) in [
        ("/id", json!(8)),
        ("/epoch", json!(3)),
        ("/status", json!("started")),
        ("/result/ok", Value::Null),
        ("/result/stopped", json!(false)),
    ] {
        let mut bad = receipt.clone();
        *bad.pointer_mut(path).unwrap() = value;
        let mut inv = original.clone();
        assert!(reconcile_invocation(&owner, &mut inv, 4, Evidence::Receipt(bad)).is_err());
        assert_eq!(inv, original);
    }
    let mut unknown = receipt.clone();
    unknown["result"]["indeterminate"] = json!(true);
    assert!(
        reconcile_invocation(&owner, &mut original.clone(), 4, Evidence::Receipt(unknown)).is_err()
    );
    let mut inv = original;
    reconcile_invocation(&owner, &mut inv, 4, Evidence::Receipt(receipt)).unwrap();
    assert_eq!(inv["state"], "succeeded");
    assert_eq!(inv["reviewed"], true);
    assert_eq!(owner["state"], "interrupted");
}

#[test]
fn task_recovery_distinguishes_undispatched_work_and_unknown_processes() {
    for (state, expected, stopped) in [
        ("queued", "interrupted", true),
        ("running", "indeterminate", false),
        ("cancelling", "indeterminate", false),
    ] {
        let mut task = json!({"kind":"background","state":state,"stop_requested":true});
        assert!(recover_task(&mut task));
        assert_eq!(task["state"], expected);
        assert_eq!(task["stopped"], stopped);
        assert_eq!(task["stop_requested"], true);
        let recovered = task.clone();
        assert!(!recover_task(&mut task));
        assert_eq!(task, recovered);
    }
    let mut task = json!({"kind":"background","state":"running"});
    complete_background(
        &mut task,
        json!({"ok":true,"stopped":false,"value":{"exit_code":0}}),
    );
    assert_eq!(task["state"], "indeterminate");
}

#[test]
fn parent_review_requires_descendants_and_never_resumes_the_owner() {
    let owner = interrupted();
    let mut task = json!({"id":3,"kind":"agent","epoch":4,"state":"interrupted","reviewed":false});
    assert!(reconcile_task(
        &owner,
        &mut task,
        4,
        false,
        Evidence::Reviewed("checked".into())
    )
    .is_err());
    assert_eq!(task["reviewed"], false);
    reconcile_task(
        &owner,
        &mut task,
        4,
        true,
        Evidence::Reviewed("checked".into()),
    )
    .unwrap();
    assert_eq!(task["reviewed"], true);
    assert_eq!(owner["state"], "interrupted");
}

#[test]
fn subtree_stops_do_not_include_siblings_or_loop_on_a_repeated_edge() {
    let tasks = [
        json!({"owner_run_id":1,"child_run_id":2}),
        json!({"owner_run_id":1,"child_run_id":3}),
        json!({"owner_run_id":2,"child_run_id":4}),
        json!({"owner_run_id":4,"child_run_id":2}),
    ];
    assert_eq!(subtree(2, &tasks), vec![2, 4]);
}
