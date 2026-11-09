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

test("J1 group CLI review, durable external event, crash recovery and memory maintenance share one work dependency", async (t) => {
  const http = require("node:http");
  const api = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: 42,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      }),
    );
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    api.closeAllConnections();
    return new Promise((resolve) => api.close(resolve));
  });
  const h = await setup(t, {
    reply: ({ body }) =>
      user(body).startsWith("<<TROOP_MEMORY_VALIDATE>>")
        ? '{"approved":true}'
        : user(body).startsWith("<<TROOP_MEMORY_")
          ? '{"additions":[],"removals":[]}'
          : "J1_REVIEWED_RESULT",
  });
  await h.core.request("memory.agent.save", {
    id: 1,
    name: "J1 combined",
    automatic: true,
    dreaming: false,
    expected_revision: 2,
  });
  await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    provider_id: h.provider.id,
    model: "owned-j1-memory",
    target_scope: "agent",
    target_project: "",
  });
  const create = (title, dependencies = []) =>
    command(h, "work_items.save", {
      expected_revision: 0,
      item: {
        title,
        goal: title,
        acceptance: "Reviewed evidence",
        owner_agent_id: 1,
        workspace_id: h.wid,
        dependency_ids: dependencies,
      },
    });
  const sourceWork = await create("J1 group source");
  const target = await create("J1 external dependent", [sourceWork.id]);
  let group = await command(h, "groups.save", {
    expected_revision: 0,
    group: {
      name: "J1 combined group",
      rules: "Keep fixed result evidence",
      project_id: null,
      paused: false,
    },
  });
  group = await command(h, "groups.member", {
    id: group.id,
    expected_revision: group.revision,
    agent_id: 1,
  });
  const cliGrant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "J1 controlled CLI",
      purpose: "cli_start",
      agent_id: 1,
      engine_id: "codex",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 600,
      program: path.resolve(
        __dirname,
        `../../../target/debug/examples/cli_protocol_probe${process.platform === "win32" ? ".exe" : ""}`,
      ),
    },
  });
  const executor = {
    group_id: group.id,
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    workspace_id: h.wid,
    execution: {
      kind: "cli",
      engine_id: "codex",
      authorization_id: cliGrant.id,
      tool_mode: "native",
      approval_mode: "preauthorized",
    },
  };
  executor.execution.expected_plan_sha256 = (
    await h.core.request("groups.executor.preview", executor)
  ).plan_sha256;
  await command(h, "groups.executor.save", executor);
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "J1 dependent native",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [],
      operations: ["read_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const source = crypto.randomUUID(),
    secret = crypto.randomBytes(32).toString("hex");
  await command(h, "events.source.save", {
    id: source,
    expected_revision: 0,
    definition: {
      name: "J1 simulated GitHub",
      kind: "github",
      project: "owner/repo",
      workspace_id: h.wid,
      enabled: true,
      mode: "local",
      api_base_url: `http://127.0.0.1:${api.address().port}`,
      consumer_id: h.core.snapshot().storage_instance,
    },
    secrets: {
      webhook_secret: secret,
      consumer_token: crypto.randomBytes(32).toString("hex"),
    },
  });
  const rule = await command(h, "rules.save", {
    expected_revision: 0,
    rule: {
      name: "J1 external completion",
      enabled: true,
      event: "github.workflow.completed",
      event_state: "failure",
      source_id: source,
      source_work_item_id: null,
      workspace_id: h.wid,
      work_item_id: target.id,
      expires_at: grant.expires_at,
      start: {
        client_run_id: crypto.randomUUID(),
        agent_id: 1,
        workspace_id: h.wid,
        provider_id: h.provider.id,
        authorization_id: grant.id,
        project_ids: [],
        goal: "Check the accepted group result",
      },
    },
  });
  const sent = await command(h, "groups.send", {
    group_id: group.id,
    expected_revision: group.revision,
    client_message_id: crypto.randomUUID(),
    body: "Produce the fixed group result",
    mention_agent_ids: [1],
    broadcast: false,
    work_item_id: sourceWork.id,
    execute_work_item: true,
  });
  const delivery = await until(async () =>
    (
      await h.core.request("groups.deliveries", {
        group_id: group.id,
        message_id: sent.id,
      })
    ).items.find((item) => item.adopted && item.run_id),
  );
  const snapshot = await until(async () => {
    const value = await h.get(delivery.run_id);
    return value.run.waiting.includes("review") && value;
  });
  const task = await h.core.request("agent.task", { id: snapshot.tasks[0].id });
  const body = JSON.stringify({
    action: "completed",
    repository: { full_name: "owner/repo" },
    workflow_run: {
      id: 42,
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
    },
  });
  const headers = {
    "x-github-event": "workflow_run",
    "x-github-delivery": "j1-combined-event",
    "x-hub-signature-256":
      "sha256=" +
      crypto.createHmac("sha256", secret).update(body).digest("hex"),
  };
  const post = async () =>
    fetch(
      (await h.core.request("events.health", {})).address +
        "/webhooks/" +
        source,
      { method: "POST", headers, body },
    );
  assert.equal((await post()).status, 202);
  await until(async () =>
    (await h.core.request("rules.history", { id: rule.id })).deliveries.some(
      (item) => item.state === "waiting",
    ),
  );
  assert.equal(
    (await h.core.request("work_items.get", { id: target.id })).current_run_id,
    null,
  );
  const reviewInput = {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted: true,
    note: "Read complete group CLI evidence",
  };
  const reviewKey = crypto.randomUUID();
  const reviewed = await operation(h, "cli.review", reviewInput, reviewKey);
  assert.equal(reviewed.state, "committed");
  await until(async () =>
    (
      await h.core.request("groups.messages", { group_id: group.id })
    ).items.some((message) => message.sender_agent_id === 1),
  );
  h.core.child.kill();
  await until(() => h.core.state === "faulted");
  await h.core.start();
  assert.deepEqual(
    await operation(h, "cli.review", reviewInput, reviewKey),
    reviewed,
  );
  assert.equal((await post()).status, 202);
  const work = await h.core.request("work_items.get", { id: sourceWork.id });
  const fixed = (await h.core.request("work_items.runs", { id: sourceWork.id }))
    .items[0];
  const acceptance = {
    id: sourceWork.id,
    expected_revision: work.revision,
    run_id: fixed.run.id,
    expected_run_revision: fixed.run.revision,
    evidence_sha256: fixed.evidence_sha256,
    note: "Accept reviewed group work",
  };
  const decisions = await Promise.all([
    operation(h, "work_items.accept", acceptance),
    operation(h, "work_items.accept", acceptance),
  ]);
  assert.equal(
    decisions.filter((item) => item.state === "committed").length,
    1,
  );
  assert.equal(decisions.filter((item) => item.state === "rejected").length, 1);
  const dependent = await until(async () => {
    const item = await h.core.request("work_items.get", { id: target.id });
    return item.current_run_id && item;
  });
  assert.equal((await h.done(dependent.current_run_id)).run.state, "completed");
  const job = await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find((job) =>
      ["completed", "failed", "waiting_review"].includes(job.state),
    ),
  );
  assert.equal(job.state, "completed", job.error);
  assert.ok(
    h.server.requests.some(({ body }) => body.model === "owned-j1-memory"),
  );
  assert.equal(
    (await h.core.request("rules.history", { id: rule.id })).deliveries.length,
    1,
  );
  assert.equal(
    (
      await h.core.request("groups.messages", { group_id: group.id })
    ).items.filter((message) => message.sender_agent_id === 1).length,
    1,
  );
  await command(h, "authorizations.revoke", {
    id: grant.id,
    expected_revision: grant.revision,
  });
  await h.core.stop();
  await h.core.start();
  assert.equal((await post()).status, 202);
  await sleep(200);
  assert.equal((await h.core.request("agent.list", {})).items.length, 2);
});
