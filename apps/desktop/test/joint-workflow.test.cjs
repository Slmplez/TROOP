const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  setup,
  until,
  sleep,
  results,
  user,
} = require("./fixtures/hooks-fixture.cjs");
const { writeTestClock } = require("./fixtures/test-clock.cjs");

async function operation(h, method, input, id = crypto.randomUUID()) {
  return h.core.request("operations.execute", {
    operation_id: id,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
}
async function command(h, method, input) {
  const receipt = await operation(h, method, input);
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return receipt.result;
}

test("J1 schedule, followup, reviewed work and dependency event form one restart-safe workflow", async (t) => {
  const parent = path.resolve(__dirname, "../../../.tmp-troop-followups");
  fs.mkdirSync(parent, { recursive: true });
  const clock = path.join(fs.mkdtempSync(path.join(parent, "joint-")), "clock");
  const now = Math.floor(Date.now() / 1000) * 1000;
  const followAt = now + 90000;
  fs.writeFileSync(clock, String(now));
  const h = await setup(t, {
    coreArgs: ["--test-clock-file", clock],
    plan: ({ body }) =>
      !results(body).length && user(body).startsWith("J1 scheduled source")
        ? [
            {
              name: "propose_followup",
              arguments: {
                at_ms: String(followAt),
                reason: "Observe the next synthetic revision",
                expected_change: "An updated check",
              },
            },
          ]
        : [],
    reply: () => "J1_FIXED_RESULT",
  });
  const create = (title, dependencies = []) =>
    command(h, "work_items.save", {
      expected_revision: 0,
      item: {
        title,
        goal: title,
        acceptance: "User confirms fixed result",
        owner_agent_id: 1,
        workspace_id: h.wid,
        dependency_ids: dependencies,
      },
    });
  const source = await create("J1 source work");
  const target = await create("J1 dependent work", [source.id]);
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "J1 bounded scope",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [],
      operations: ["read_file", "propose_followup"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const start = (goal) => ({
    client_run_id: crypto.randomUUID(),
    agent_id: 1,
    workspace_id: h.wid,
    provider_id: h.provider.id,
    authorization_id: grant.id,
    project_ids: [],
    goal,
  });
  const followDefinition = {
    name: "J1 followup",
    enabled: true,
    work_item_id: source.id,
    agent_id: 1,
    workspace_id: h.wid,
    project_id: null,
    start: start("J1 followup observation"),
    expected_plan_sha256: null,
    expires_at_ms: now + 600000,
    min_interval_ms: 60000,
    max_runs: 2,
    handoff_policy_ids: [],
  };
  followDefinition.expected_plan_sha256 = (
    await h.core.request("followups.preview", { policy: followDefinition })
  ).plan_sha256;
  const follow = await command(h, "followups.save", {
    expected_revision: 0,
    policy: followDefinition,
  });
  const propagation = await command(h, "rules.save", {
    expected_revision: 0,
    rule: {
      name: "J1 accepted dependency",
      enabled: true,
      event: "work.accepted",
      workspace_id: h.wid,
      source_run_id: null,
      source_work_item_id: source.id,
      work_item_id: target.id,
      expires_at: grant.expires_at,
      start: start("J1 dependent observation"),
    },
  });
  const due = new Date(now + 2000).toISOString();
  const scheduledDefinition = {
    kind: "scheduled",
    event: "time.due",
    name: "J1 source schedule",
    enabled: true,
    agent_id: 1,
    workspace_id: h.wid,
    project_id: null,
    work_item_id: source.id,
    schedule: {
      kind: "once",
      timezone: "UTC",
      date: due.slice(0, 10),
      time: due.slice(11, 19),
    },
    start: start("J1 scheduled source"),
  };
  const preview = await h.core.request("schedules.preview", {
    rule: scheduledDefinition,
  });
  const scheduled = await command(h, "rules.save", {
    expected_revision: 0,
    rule: { ...scheduledDefinition, expected_plan_sha256: preview.plan_sha256 },
  });
  await writeTestClock(clock, now + 2000);
  const first = await until(async () => {
    const item = await h.core.request("work_items.get", { id: source.id });
    return item.current_run_id && item;
  });
  assert.equal((await h.done(first.current_run_id)).run.state, "completed");
  const appointment = await until(
    async () =>
      (await h.core.request("followups.history", { id: follow.id })).items[0],
  );
  assert.equal(appointment.source_run_id, first.current_run_id);
  assert.equal(
    (await h.core.request("work_items.get", { id: target.id })).current_run_id,
    null,
  );
  await writeTestClock(clock, followAt);
  const next = await until(async () => {
    const row = (
      await h.core.request("followups.history", { id: follow.id })
    ).items.find((row) => row.id === appointment.id);
    return row.run_id && row;
  });
  assert.equal((await h.done(next.run_id)).run.state, "completed");
  assert.equal(
    (await h.core.request("work_items.get", { id: target.id })).current_run_id,
    null,
  );
  const current = await h.core.request("work_items.get", { id: source.id });
  const fixed = (
    await h.core.request("work_items.runs", { id: source.id })
  ).items.find((row) => row.run.id === next.run_id);
  const acceptance = {
    id: source.id,
    expected_revision: current.revision,
    run_id: fixed.run.id,
    expected_run_revision: fixed.run.revision,
    evidence_sha256: fixed.evidence_sha256,
    note: "Reviewed the current fixed synthetic result",
  };
  const key = crypto.randomUUID();
  const decided = await Promise.all([
    operation(h, "work_items.accept", acceptance, key),
    operation(h, "work_items.accept", acceptance),
  ]);
  assert.equal(decided.filter((row) => row.state === "committed").length, 1);
  assert.equal(decided.filter((row) => row.state === "rejected").length, 1);
  assert.deepEqual(
    await operation(h, "work_items.accept", acceptance, key),
    decided[0],
  );
  const dependent = await until(async () => {
    const item = await h.core.request("work_items.get", { id: target.id });
    return item.current_run_id && item;
  });
  assert.equal((await h.done(dependent.current_run_id)).run.state, "completed");
  assert.equal(
    (await h.core.request("rules.history", { id: propagation.id })).deliveries
      .length,
    1,
  );
  assert.equal(
    (await h.core.request("schedules.history", { id: scheduled.id })).items
      .length,
    1,
  );
  await h.core.stop();
  await h.core.start();
  await sleep(200);
  assert.equal((await h.core.request("agent.list", {})).items.length, 3);
  assert.equal(
    (await h.core.request("work_items.get", { id: source.id })).progress.state,
    "completed",
  );
});
