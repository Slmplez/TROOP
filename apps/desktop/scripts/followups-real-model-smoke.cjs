const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { CoreSupervisor } = require("../src/core-client.cjs"),
  { coreBinary } = require("../src/core-path.cjs");
const { until, sleep } = require("../test/fixtures/hooks-fixture.cjs");
const root = path.resolve(__dirname, "../../.."),
  evidence = path.join(root, "verification/cli-followups-2026-11-09");
fs.mkdirSync(path.join(root, ".tmp-troop-followups"), { recursive: true });
const folder = fs.mkdtempSync(path.join(root, ".tmp-troop-followups/real-")),
  workspace = path.join(folder, "workspace");
fs.mkdirSync(workspace);
fs.mkdirSync(evidence, { recursive: true });
const core = new CoreSupervisor({
  executable: path.join(root, "apps/desktop/bin", coreBinary),
  args: ["--data-dir", path.join(folder, "data")],
  timeout: 10000,
});
const report = {
  passed: false,
  real_model: true,
  model: "deepseek-flash",
  max_starts: 2,
  min_interval_ms: 60_000,
  runs: [],
};
let provider;
async function command(method, input) {
  const receipt = await core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: core.snapshot().storage_instance,
    method,
    input,
  });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return receipt.result;
}
async function main() {
  assert.ok(
    process.env.DEEPSEEK_API_KEY,
    "Existing DeepSeek credential required",
  );
  await core.start();
  await core.request("memory.agent.save", {
    id: 1,
    name: "Bounded real followup",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  provider = await command("provider.save", {
    config: {
      name: "Bounded followup real model",
      protocol: "chat_completions",
      base_url: "https://api.deepseek.com/v1",
      model: report.model,
      max_output_tokens: 1024,
      idle_timeout_secs: 45,
    },
    api_key: process.env.DEEPSEEK_API_KEY,
  });
  const grant = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Read synthetic followup file",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: wid,
      project_ids: [],
      read_roots: [workspace],
      write_roots: [],
      operations: ["read_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const item = await command("work_items.save", {
    expected_revision: 0,
    item: {
      title: "Real model bounded recheck",
      goal: "Observe synthetic file versions",
      acceptance: "User confirms evidence",
      owner_agent_id: 1,
      workspace_id: wid,
    },
  });
  const definition = {
    name: "Two real model checks",
    enabled: true,
    work_item_id: item.id,
    agent_id: 1,
    workspace_id: wid,
    project_id: null,
    start: {
      client_run_id: crypto.randomUUID(),
      agent_id: 1,
      workspace_id: wid,
      provider_id: provider.id,
      authorization_id: grant.id,
      project_ids: [],
      goal: "Call read_file exactly once for input.txt, then return its marker verbatim. Do not call other tools or propose further work.",
    },
    expected_plan_sha256: null,
    expires_at_ms: Date.now() + 300_000,
    min_interval_ms: 60000,
    max_runs: 2,
    handoff_policy_ids: [],
  };
  const preview = await core.request("followups.preview", {
    policy: definition,
  });
  definition.expected_plan_sha256 = preview.plan_sha256;
  const policy = await command("followups.save", {
    expected_revision: 0,
    policy: definition,
  });
  let previous;
  for (const version of [1, 2]) {
    const marker = `TROOP_REAL_FOLLOWUP_V${version}`;
    fs.writeFileSync(path.join(workspace, "input.txt"), marker);
    const at = version === 1 ? Date.now() : Date.now() + 61_000;
    const appointment = await command(
      version === 1 ? "followups.run" : "followups.request",
      {
        id: policy.id,
        expected_revision: policy.revision,
        client_request_id: crypto.randomUUID(),
        at_ms: at,
        reason: `Observe version ${version}`,
        expected_change: `File marker becomes version ${version}`,
      },
    );
    if (version === 2) {
      await sleep(300);
      assert.equal((await core.request("agent.list", {})).items.length, 1);
    }
    const dispatched = await until(
      async () =>
        (await core.request("followups.history", { id: policy.id })).items.find(
          (row) => row.id === appointment.id && row.state === "dispatched",
        ),
      100000,
    );
    const snapshot = await until(async () => {
      const value = await core.request("agent.get", { id: dispatched.run_id });
      return (
        ["completed", "failed", "interrupted", "cancelled"].includes(
          value.run.state,
        ) && value
      );
    }, 120000);
    assert.equal(
      snapshot.run.state,
      "completed",
      snapshot.run.error ?? "Real model did not complete",
    );
    assert.ok(
      snapshot.invocations.some(
        (inv) => inv.name === "read_file" && inv.state === "succeeded",
      ),
    );
    assert.ok(snapshot.run.output.includes(marker));
    if (previous) assert.ok(dispatched.dispatched_at_ms - previous >= 60000);
    previous = dispatched.dispatched_at_ms;
    report.runs.push({
      id: snapshot.run.id,
      state: snapshot.run.state,
      step: snapshot.run.step,
      tools: snapshot.invocations.map((inv) => ({
        name: inv.name,
        state: inv.state,
      })),
      marker,
      started_at_ms: previous,
    });
  }
  const current = await core.request("followups.get", { id: policy.id });
  assert.equal(current.chain.wake_count, 2);
  assert.equal(current.allowed_actions.request.allowed, false);
  assert.equal(
    (await core.request("work_items.get", { id: item.id })).progress.state,
    "awaiting_acceptance",
  );
  report.passed = true;
}
main()
  .catch((error) => {
    report.error = error.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    if (provider) {
      try {
        if (core.state !== "ready") await core.start();
        await command("provider.remove", { id: provider.id });
        report.credential_reference_removed = true;
      } catch {
        report.passed = false;
        report.credential_reference_removed = false;
        process.exitCode = 1;
      }
    }
    await core.stop();
    report.core_stopped = !core.child;
    fs.writeFileSync(
      path.join(evidence, "real-model.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  });
