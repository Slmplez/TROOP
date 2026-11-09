const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setup, until } = require("../test/fixtures/hooks-fixture.cjs");

const engine = process.argv[2];
assert.ok(["claude", "codex", "pi", "opencode"].includes(engine));
const root = path.resolve(__dirname, "../../..");
const evidence = path.join(root, "verification/cli-followups-2026-11-09");
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
let h;

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
  h = await setup({ after: (fn) => cleanup.push(fn) });
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
    const runtime = path.join(root, ".tmp-troop-cli/pi-v1.5.0/native");
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
      reason: "Check the synthetic result again",
      expected_change: "A later observation",
    },
  };
  const follow = await policy(
    await item(`${engine} real appointment`),
    grant,
    `Synthetic text-only acceptance. Return exactly this JSON as your entire final answer without markdown or explanation: ${JSON.stringify(proposal)}. Do not use tools, read files, or change the supplied timestamp.`,
  );
  const first = await dispatch(follow);
  await ready(first.run_id);
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
  await review(next.run_id, false);
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
  report.passed = true;
}

main()
  .catch((error) => {
    report.error = error.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const fn of cleanup.reverse()) await fn();
    report.core_stopped = !h?.core.child;
    fs.writeFileSync(
      path.join(evidence, `real-${engine}-followups.json`),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  });
