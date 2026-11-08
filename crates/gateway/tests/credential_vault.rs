#![cfg(windows)]

use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use troop_gateway::credentials::mcp as vault;

const ITERATIONS: u32 = 16;

fn reference(owner: u32, child: u32, iteration: u32) -> String {
    format!("TROOP/mcp/{owner:08x}-b2d5-4a16-85db-76ad34e478ee/{child:08x}-0000-4000-8000-{iteration:012x}")
}

#[test]
fn credential_child() {
    let Ok(owner) = std::env::var("TROOP_VAULT_TEST_OWNER") else {
        return;
    };
    let owner = owner.parse::<u32>().unwrap();
    let mut failures = Vec::new();
    for iteration in 0..ITERATIONS {
        let target = reference(owner, std::process::id(), iteration);
        let result = vault::write(&target, "owned-regression-token").and_then(|_| {
            for _ in 0..2 {
                if vault::read(&target)? != "owned-regression-token" {
                    return Err("Credential content changed".into());
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(())
        });
        if let Err(error) = result {
            failures.push(format!("iteration {iteration}: {error}"));
        }
        if let Err(error) = vault::delete(&target) {
            failures.push(format!("cleanup {iteration}: {error}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn credentials_survive_parallel_processes() {
    let owner = std::process::id();
    let mut children = Vec::new();
    for _ in 0..8 {
        children.push(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "credential_child", "--nocapture"])
                .env("TROOP_VAULT_TEST_OWNER", owner.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
    }
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut failures = Vec::new();
    let ids = children.iter().map(|child| child.id()).collect::<Vec<_>>();
    for mut child in children {
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().unwrap().is_none() {
            let _ = child.kill();
            failures.push("Credential child exceeded deadline".into());
        }
        let output = child.wait_with_output().unwrap();
        if !output.status.success() {
            failures.push(String::from_utf8_lossy(&output.stderr).into_owned());
        }
    }
    // All child processes have exited. Remove only this test's exact owned references.
    for child in ids {
        for iteration in 0..ITERATIONS {
            let target = reference(owner, child, iteration);
            if vault::read(&target).is_ok() {
                failures.push("Deleted credential survived child exit".into());
            }
            vault::delete(&target).unwrap();
            assert!(vault::read(&target).unwrap_err().contains("1168"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
