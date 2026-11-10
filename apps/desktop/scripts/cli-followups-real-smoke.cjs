const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { coreBinary } = require("../src/core-path.cjs");
const { setup, until } = require("../test/fixtures/hooks-fixture.cjs");

const engine = process.argv[2];
assert.ok(["claude", "codex", "pi", "opencode"].includes(engine));
const root = path.resolve(__dirname, "../../..");
const officeMode = process.env.TROOP_C7_OFFICE === "1";
const evidence = path.join(
  root,
  officeMode
    ? "verification/c7-joint-2026-11-10"
    : "verification/cli-followups-2026-11-09",
);
fs.mkdirSync(evidence, { recursive: true });
const cleanup = [];
const report = {
  engine,
  real_engine: true,
  real_model: true,
  passed: false,
  checks: [],
  runs: [],
};
let h, officeReference;
const runtimeRoot = process.env.TROOP_C7_RUNTIME_ROOT ?? root;
const marker = `TROOP_C7_FIXED_${engine.toUpperCase()}`;

const reportPath = path.join(
  evidence,
  officeMode
    ? `real-${engine}-office-followups.json`
    : `real-${engine}-followups.json`,
);
report.run_identity = crypto.randomUUID();
report.started_at = new Date().toISOString();
report.status = "running";
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
const fingerprint = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function verifyCandidate() {
  const git = (args) =>
    spawnSync("git", ["-C", runtimeRoot, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  const head = git(["rev-parse", "HEAD"]);
  assert.equal(head.status, 0, head.stderr);
  report.feature_head = head.stdout.trim();
  if (process.env.TROOP_C7_CANDIDATE_SHA)
    assert.equal(
      report.feature_head,
      process.env.TROOP_C7_CANDIDATE_SHA,
      "Candidate source changed",
    );
  const clean = git([
    "diff",
    "--quiet",
    "HEAD",
    "--",
    "crates",
    "Cargo.toml",
    "Cargo.lock",
    "apps/desktop/src",
    "apps/desktop/contracts",
    "apps/desktop/package.json",
    "apps/desktop/package-lock.json",
  ]);
  assert.equal(
    clean.status,
    0,
    "Candidate runtime source has uncommitted changes",
  );
  const build = spawnSync(
    "cargo",
    ["build", "--offline", "--locked", "-p", "troop-core"],
    { cwd: runtimeRoot, encoding: "utf8", windowsHide: true },
  );
  assert.equal(build.status, 0, build.stderr.slice(-2000));
  const compiled = path.join(
    runtimeRoot,
    "target/debug",
    process.platform === "win32" ? "troop-core.exe" : "troop-core",
  );
  const selected =
    process.env.TROOP_C7_CORE ??
    path.join(root, "apps/desktop/bin", coreBinary);
  assert.equal(
    fingerprint(selected),
    fingerprint(compiled),
    "Selected Core differs from the candidate build",
  );
}

async function command(method, input, operationId = crypto.randomUUID()) {
  report.phase = method;
  console.log(`${engine} ${method}`);
  const receipt = await h.core.request("operations.execute", {
    operation_id: operationId,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return receipt.result;
}

async function item(title) {
  return command("work_items.save", {
    expected_revision: 0,
    item: {
      title,
      goal: title,
      acceptance: "User checks the fixed evidence",
      owner_agent_id: 1,
      workspace_id: h.wid,
    },
  });
}

async function policy(work, grant, goal, routes = []) {
  const definition = {
    name: `${engine} real followup`,
    enabled: true,
    work_item_id: work.id,
    agent_id: 1,
    workspace_id: h.wid,
    project_id: null,
    start: {
      client_run_id: crypto.randomUUID(),
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      engine_id: engine,
      authorization_id: grant.id,
      tool_mode: engine === "codex" ? "native" : "disabled",
      approval_mode: "preauthorized",
      timeout_seconds: 150,
      goal,
      ...(officeReference
        ? { office_reference_ids: [officeReference.id] }
        : {}),
    },
    expected_plan_sha256: null,
    expires_at_ms: Date.now() + 1200000,
    min_interval_ms: 60000,
    max_runs: 3,
    handoff_policy_ids: routes,
  };
  const preview = await h.core.request("followups.preview", {
    policy: definition,
  });
  definition.expected_plan_sha256 = preview.plan_sha256;
  return command("followups.save", {
    expected_revision: 0,
    policy: definition,
  });
}

async function history(definition) {
  return (await h.core.request("followups.history", { id: definition.id }))
    .items;
}

async function dispatch(definition) {
  const appointment = await command("followups.run", {
    id: definition.id,
    expected_revision: definition.revision,
    client_request_id: crypto.randomUUID(),
    at_ms: Date.now(),
    reason: "Owned real engine acceptance",
    expected_change: "Fixed synthetic result",
  });
  return until(
    async () =>
      (await history(definition)).find(
        (row) => row.id === appointment.id && row.run_id,
      ),
    20000,
  );
}

async function ready(id) {
  return until(async () => {
    const snapshot = await h.get(id);
    if (["failed", "interrupted", "cancelled"].includes(snapshot.run.state))
      throw Error(
        `${engine} Run ${id} ended ${snapshot.run.state}: ${snapshot.run.error}`,
      );
    return snapshot.run.waiting.includes("review") && snapshot;
  }, 180000);
}

async function review(id, accepted) {
  const snapshot = await ready(id);
  const task = await h.core.request("agent.task", { id: snapshot.tasks[0].id });
  assert.equal(task.evidence.coverage_complete, true);
  report.runs.push({
    id,
    task_id: task.id,
    model: task.evidence.result.model,
    evidence_sha256: task.evidence.sha256,
  });
  const input = {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted,
    note: "Inspected the exact synthetic proposal in complete fixed evidence",
  };
  const key = crypto.randomUUID();
  const result = await command("cli.review", input, key);
  assert.deepEqual(await command("cli.review", input, key), result);
  return task;
}

async function main() {
  if (officeMode) verifyCandidate();
  h = await setup(
    { after: (fn) => cleanup.push(fn) },
    { executable: process.env.TROOP_C7_CORE },
  );
  report.core_version = h.core.snapshot().version;
  report.core_sha256 = fingerprint(h.core.executable);
  if (officeMode) {
    fs.writeFileSync(path.join(h.workspace, "fixed-office.md"), marker + "\n");
    const document = (
      await command("office.open", {
        workspace_id: h.wid,
        path: "fixed-office.md",
      })
    ).document;
    officeReference = await command("office.reference.create", {
      id: document.id,
      revision: 1,
      kind: "paragraphs",
      start: 0,
      end: 1,
    });
    fs.writeFileSync(
      path.join(h.workspace, "fixed-office.md"),
      "CURRENT_CHANGED_DO_NOT_QUOTE\n",
    );
    report.office_reference = {
      id: officeReference.id,
      revision: officeReference.revision,
      sha256: officeReference.sha256,
    };
  }
  h.core.timeout = 60000;
  const grantDefinition = {
    name: `${engine} bounded real followup`,
    purpose: "cli_start",
    engine_id: engine,
    agent_id: 1,
    workspace_id: h.wid,
    project_ids: [],
    read_roots: [h.workspace],
    write_roots: [h.workspace],
    operations: ["start"],
    network: "any",
    expires_at: Math.floor(Date.now() / 1000) + 1800,
  };
  if (engine === "codex") grantDefinition.read_all = true;
  if (engine === "claude")
    grantDefinition.model_settings = {
      file: path.join(process.env.USERPROFILE, ".claude/settings.json"),
    };
  if (engine === "pi") {
    const runtime = path.join(runtimeRoot, ".tmp-troop-cli/pi-v1.5.0/native");
    grantDefinition.program = path.join(runtime, "pi.exe");
    grantDefinition.read_roots.push(
      runtime,
      process.env.PI_CODING_AGENT_DIR ??
        path.join(process.env.USERPROFILE, ".pi/agent"),
    );
    grantDefinition.credential_env_keys = ["DEEPSEEK_API_KEY"];
  }
  if (engine === "opencode") {
    const settings = path.join(h.directory, "opencode-model.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({
        model: "owned/deepseek-flash",
        provider: {
          owned: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: "https://api.deepseek.com",
              apiKey: "{env:DEEPSEEK_API_KEY}",
            },
            models: {
              "deepseek-flash": { limit: { context: 32768, output: 4096 } },
            },
          },
        },
      }),
    );
    grantDefinition.model_settings = { file: settings };
    grantDefinition.credential_env_keys = ["DEEPSEEK_API_KEY"];
  }
  const grant = await command("authorizations.save", {
    expected_revision: 0,
    grant: grantDefinition,
  });
  const at = Date.now() + 180000;
  const proposal = {
    troop_followup: {
      at_ms: at,
      reason: officeMode
        ? "COPY_FIXED_REFERENCE_MARKER"
        : "Check the synthetic result again",
      expected_change: "A later observation",
    },
  };
  const follow = await policy(
    await item(`${engine} real appointment`),
    grant,
    `Synthetic text-only acceptance. Return exactly this JSON as your entire final answer without markdown or explanation: ${JSON.stringify(proposal)}. ${officeMode ? "Replace only troop_followup.reason with the marker line from the explicitly supplied fixed Office reference. The current disk file has changed and is not that fixed version." : ""} Do not use tools, read files, or change the supplied timestamp.`,
  );
  const first = await dispatch(follow);
  const firstSnapshot = await ready(first.run_id);
  if (officeMode) {
    const firstTask = await h.core.request("agent.task", {
      id: firstSnapshot.tasks[0].id,
    });
    assert.equal(
      JSON.parse(
        firstTask.evidence.result.text.trim(),
      ).troop_followup.reason.trim(),
      marker,
    );
    assert.equal(
      (await h.core.request("office.reference.get", { id: officeReference.id }))
        .stale,
      true,
    );
    report.checks.push(
      "Actual model reads the explicitly delivered fixed Office version after its source file changes",
    );
  }
  assert.equal((await history(follow)).length, 1);
  await review(first.run_id, true);
  const bridged = await until(async () => {
    const run = (await h.get(first.run_id)).run;
    if (run.followup_bridge?.state === "blocked")
      throw Error(JSON.stringify(run.followup_bridge.error));
    return run.followup_bridge?.state === "applied" && run;
  });
  const queued = (await history(follow)).find(
    (row) => row.source_run_id === first.run_id,
  );
  assert.equal(queued.id, bridged.followup_bridge.appointment_id);
  assert.equal(queued.chain_id, first.chain_id);
  await h.core.stop();
  await h.core.start();
  assert.equal((await history(follow)).length, 2);
  report.checks.push(
    "Real model fixed evidence creates one appointment only after explicit review and survives restart without duplication",
  );
  const next = await until(
    async () =>
      (await history(follow)).find((row) => row.id === queued.id && row.run_id),
    230000,
  );
  assert.ok(next.dispatched_at_ms >= at);
  const historyBeforeRejection = (await history(follow)).length;
  await review(next.run_id, false);
  await until(async () => (await h.get(next.run_id)).run.state === "failed");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal((await history(follow)).length, historyBeforeRejection);
  assert.equal((await h.get(next.run_id)).run.followup_bridge ?? null, null);
  assert.ok(
    !(await history(follow)).some((row) => row.source_run_id === next.run_id),
  );
  report.checks.push(
    "Actual wall-clock appointment dispatches a second real-model Run at the requested time; rejecting its result adds no proposal",
  );

  const receiver = await policy(
    await item(`${engine} receiver`),
    grant,
    "Return TROOP_REAL_HANDOFF_RECEIVED as your complete final answer. Do not use tools.",
  );
  const transfer = {
    troop_handoff: {
      route_id: receiver.id,
      reason: "Request an independent synthetic check",
      expected_change: "Receiver observation",
    },
  };
  const source = await policy(
    await item(`${engine} transfer`),
    grant,
    `Return exactly this JSON as your entire final answer, without markdown or explanation: ${JSON.stringify(transfer)}. Do not use tools.`,
    [receiver.id],
  );
  const origin = await dispatch(source);
  await ready(origin.run_id);
  assert.equal((await history(receiver)).length, 0);
  await review(origin.run_id, true);
  const received = await until(async () => {
    const row = (await history(receiver)).find(
      (row) => row.source_run_id === origin.run_id,
    );
    if (row?.state === "blocked") throw Error(row.status_reason);
    return row?.run_id && row;
  }, 120000);
  assert.equal(received.chain_id, origin.chain_id);
  await review(received.run_id, true);
  let futureStopped, futureRevoked, revokedPolicy;
  if (officeMode) {
    revokedPolicy = await policy(
      await item(`${engine} revocation fence`),
      grant,
      "Return no output because this grant will be revoked before dispatch.",
    );
    futureStopped = await command("followups.request", {
      id: source.id,
      expected_revision: source.revision,
      client_request_id: crypto.randomUUID(),
      at_ms: Date.now() + 90000,
      reason: "C7 queued stop fence",
      expected_change: "No dispatch after stop",
    });
    assert.equal(futureStopped.chain_id, origin.chain_id);
    futureRevoked = await command("followups.request", {
      id: revokedPolicy.id,
      expected_revision: revokedPolicy.revision,
      client_request_id: crypto.randomUUID(),
      at_ms: Date.now() + 90000,
      reason: "C7 queued revocation fence",
      expected_change: "No dispatch after revocation",
    });
    assert.equal(futureStopped.state, "pending");
    assert.equal(futureRevoked.state, "pending");
  }
  const chain = await h.core.request("followups.chain", { id: source.id });
  await command("followups.stop_chain", {
    id: source.id,
    expected_revision: chain.revision,
  });
  await command("authorizations.revoke", {
    id: grant.id,
    expected_revision: grant.revision,
  });
  await h.core.stop();
  await h.core.start();
  assert.equal(
    (await h.core.request("followups.chain", { id: source.id })).stopped,
    true,
  );
  assert.equal((await h.core.request("agent.list", {})).items.length, 4);
  report.checks.push(
    "Reviewed real-model handoff retains the original chain; explicit whole-chain stop and revocation remain fenced after restart",
  );
  if (officeMode) {
    const stopped = (await history(source)).find(
      (row) => row.id === futureStopped.id,
    );
    assert.equal(stopped.state, "cancelled");
    assert.equal(stopped.run_id, null);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(
          0,
          Math.max(futureStopped.at_ms, futureRevoked.at_ms) -
            Date.now() +
            1000,
        ),
      ),
    );
    const revoked = await until(async () => {
      const row = (await history(revokedPolicy)).find(
        (value) => value.id === futureRevoked.id,
      );
      return row && row.state !== "pending" && row;
    });
    assert.equal(revoked.run_id, null);
    assert.ok(["blocked", "cancelled"].includes(revoked.state));
    assert.match(revoked.status_reason ?? revoked.reason ?? "", /授权|撤销/);
    assert.equal((await h.core.request("agent.list", {})).items.length, 4);
    assert.equal(
      (await h.core.request("authorizations.get", { id: grant.id })).revoked,
      true,
    );
    report.checks.push(
      "Separate real-runtime future appointments remain undispatched after whole-chain stop and grant revocation across their wall-clock due time and Core restart",
    );
  }
  report.passed = true;
}

main()
  .catch((error) => {
    report.error = error.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    const cleanupErrors = [];
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }
    report.core_stopped = !h?.core.child;
    if (cleanupErrors.length || !report.core_stopped) {
      report.passed = false;
      report.cleanup_errors = cleanupErrors;
      process.exitCode = 1;
    }
    report.status = report.passed ? "passed" : "failed";
    report.completed_at = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  });
