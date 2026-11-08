const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");
const command = (h, method, input, operation = crypto.randomUUID()) =>
  h.core.request("operations.execute", {
    operation_id: operation,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
async function committed(h, method, input, operation) {
  const receipt = await command(h, method, input, operation);
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return receipt.result;
}
const create = (h, extra = {}) =>
  committed(h, "work_items.save", {
    expected_revision: 0,
    item: {
      title: "核对发布",
      goal: "核对发布步骤",
      acceptance: "提交固定检查结果",
      owner_agent_id: 1,
      workspace_id: h.wid,
      ...extra,
    },
  });
const start = (h, item, extra = {}, operation) =>
  committed(
    h,
    "work_items.start",
    {
      id: item.id,
      expected_revision: item.revision,
      execution: { kind: "agent", provider_id: h.provider.id, ...extra },
    },
    operation,
  );
test("work item starts one owned Run, keeps its result unaccepted and accepts the exact version", async (t) => {
  const h = await setup(t);
  const item = await create(h),
    operation = crypto.randomUUID();
  const [first, duplicate] = await Promise.all([
    start(h, item, {}, operation),
    start(h, item, {}, operation),
  ]);
  assert.deepEqual(first, duplicate);
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  const settled = await h.done(first.current_run_id);
  assert.equal(settled.run.state, "completed", JSON.stringify(settled));
  let current = await h.core.request("work_items.get", { id: item.id });
  assert.equal(current.progress.state, "awaiting_acceptance");
  const page = await h.core.request("work_items.runs", { id: item.id });
  assert.equal(page.items.length, 1);
  const result = page.items[0];
  assert.equal(result.run.id, first.current_run_id);
  assert.equal(result.allowed_actions.accept.allowed, true);
  current = await committed(h, "work_items.accept", {
    id: item.id,
    expected_revision: current.revision,
    run_id: result.run.id,
    expected_run_revision: result.run.revision,
    evidence_sha256: result.evidence_sha256,
    note: "固定结果满足验收条件",
  });
  assert.equal(current.progress.state, "completed");
  await h.core.stop();
  await h.core.start();
  assert.equal(
    (await h.core.request("work_items.get", { id: item.id })).progress.state,
    "completed",
  );
});
async function accept(h, item) {
  const current = await h.core.request("work_items.get", { id: item.id });
  const result = (await h.core.request("work_items.runs", { id: item.id }))
    .items[0];
  return command(h, "work_items.accept", {
    id: item.id,
    expected_revision: current.revision,
    run_id: result.run.id,
    expected_run_revision: result.run.revision,
    evidence_sha256: result.evidence_sha256,
    note: "确认固定结果符合目标",
  });
}
test("dependencies release only after acceptance, reject cycles and recheck before accepting a dependent result", async (t) => {
  const h = await setup(t),
    prerequisite = await create(h),
    dependent = await create(h, { dependency_ids: [prerequisite.id] });
  assert.equal(dependent.allowed_actions.start.allowed, false);
  const cycle = await command(h, "work_items.save", {
    id: prerequisite.id,
    expected_revision: prerequisite.revision,
    item: {
      title: "前置",
      goal: "前置目标",
      acceptance: "前置验收",
      owner_agent_id: 1,
      workspace_id: h.wid,
      dependency_ids: [dependent.id],
    },
  });
  assert.equal(cycle.state, "rejected");
  const first = await start(h, prerequisite);
  await h.done(first.current_run_id);
  assert.equal(
    (await h.core.request("work_items.get", { id: dependent.id }))
      .allowed_actions.start.allowed,
    false,
  );
  assert.equal((await accept(h, prerequisite)).state, "committed");
  const second = await start(h, dependent);
  await h.done(second.current_run_id);
  const prior = await h.core.request("work_items.get", { id: prerequisite.id });
  await committed(h, "work_items.save", {
    id: prior.id,
    expected_revision: prior.revision,
    item: {
      title: prior.title,
      goal: "已经修改的前置目标",
      acceptance: prior.acceptance,
      workspace_id: prior.workspace_id,
      owner_agent_id: prior.owner_agent_id,
    },
  });
  const rejected = await accept(h, dependent);
  assert.equal(rejected.state, "rejected");
  assert.notEqual(
    (await h.core.request("work_items.get", { id: dependent.id })).progress
      .state,
    "completed",
  );
});
test("competing starts, edits, stale evidence and cancellation cannot revive the work", async (t) => {
  const h = await setup(t, { delay: 50 }),
    item = await create(h);
  const first = await start(h, item);
  const stale = await command(h, "work_items.start", {
    id: item.id,
    expected_revision: item.revision,
    execution: { kind: "agent", provider_id: h.provider.id },
  });
  assert.equal(stale.state, "rejected");
  assert.equal(stale.error.kind, "revision_conflict");
  const competing = await command(h, "work_items.start", {
    id: item.id,
    expected_revision: first.revision,
    execution: { kind: "agent", provider_id: h.provider.id },
  });
  assert.equal(competing.state, "rejected");
  const cancelled = await committed(h, "work_items.cancel", {
    id: item.id,
    expected_revision: first.revision,
  });
  assert.equal(cancelled.cancelled, true);
  await h.done(first.current_run_id);
  assert.equal((await accept(h, item)).state, "rejected");
  await h.core.stop();
  await h.core.start();
  const restored = await h.core.request("work_items.get", { id: item.id });
  assert.equal(restored.progress.state, "cancelled");
  assert.equal(restored.allowed_actions.start.allowed, false);
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
});
test("external work requires its confirmed permission plan and fixed CLI review before work acceptance", async (t) => {
  const fs = require("node:fs"),
    path = require("node:path");
  const h = await setup(t),
    item = await create(h);
  const file = path.join(h.directory, "owned-model.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      model: "owned/fixture",
      provider: {
        owned: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://127.0.0.1:9/v1",
            apiKey: "TROOP_OPENCODE_TEST_CREDENTIAL",
          },
          models: { fixture: { limit: { context: 32768, output: 4096 } } },
        },
      },
    }),
  );
  const grant = await committed(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned W2 CLI",
      purpose: "cli_start",
      engine_id: "opencode",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/opencode_protocol_probe.exe",
      ),
      model_settings: { file },
    },
  });
  const input = {
    id: item.id,
    expected_revision: item.revision,
    execution: {
      kind: "cli",
      engine_id: "opencode",
      authorization_id: grant.id,
      tool_mode: "disabled",
    },
  };
  assert.equal((await command(h, "work_items.start", input)).state, "rejected");
  const preview = await h.core.request("work_items.preview", input);
  input.execution.expected_plan_sha256 = preview.plan_sha256;
  const started = await committed(h, "work_items.start", input);
  const running = await h.core.request("work_items.runs", { id: item.id });
  require("../contracts/execution.cjs").validate(
    "work_items.runs",
    running,
    true,
  );
  assert.equal(running.items[0].allowed_actions.accept.allowed, false);
  await until(async () =>
    (await h.get(started.current_run_id)).run.waiting.includes("review"),
  );
  const result = (await h.core.request("work_items.runs", { id: item.id }))
    .items[0];
  assert.equal(result.allowed_actions.accept.allowed, false);
  assert.equal((await accept(h, item)).state, "rejected");
  const task = await h.core.request("agent.task", { id: result.task_id });
  await committed(h, "cli.review", {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted: true,
    note: "核对固定文本产物",
  });
  assert.equal(
    (await h.core.request("work_items.get", { id: item.id })).progress.state,
    "awaiting_acceptance",
  );
  const stale = await command(h, "work_items.accept", {
    id: item.id,
    expected_revision: started.revision,
    run_id: result.run.id,
    expected_run_revision: result.run.revision,
    evidence_sha256: result.evidence_sha256,
    note: "旧版本",
  });
  assert.equal(stale.state, "rejected");
  assert.equal((await accept(h, item)).state, "committed");
});
test("work dispatch and receipt roll back together before activation, and a schema 24 work definition survives migration", async (t) => {
  const h = await setup(t),
    item = await create(h);
  let db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER work_receipt_fault BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await assert.rejects(start(h, item));
  db.exec("DROP TRIGGER work_receipt_fault");
  db.close();
  assert.equal((await h.core.request("agent.list", {})).items.length, 0);
  assert.equal(
    (await h.core.request("work_items.runs", { id: item.id })).items.length,
    0,
  );
  assert.equal(
    (await h.core.request("work_items.get", { id: item.id })).revision,
    1,
  );
  await h.core.stop();
  db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "DROP TABLE followup_appointments; DROP TABLE followup_chains; DROP TABLE followup_states; DROP TABLE reminder_notifications; DROP TABLE reminder_slots; DROP TABLE reminder_states; DROP TABLE reminder_preferences; DROP TABLE group_executors; DROP TABLE group_chains; DROP TRIGGER group_project_revoked; DROP TABLE group_deliveries; DROP TABLE group_messages; DROP TABLE group_chats; DROP TABLE work_item_runs; PRAGMA user_version=24;",
  );
  db.close();
  await h.core.start();
  const restored = await h.core.request("work_items.get", { id: item.id });
  assert.equal(restored.goal, "核对发布步骤");
  const started = await start(h, restored);
  await h.done(started.current_run_id);
  assert.equal((await accept(h, item)).state, "committed");
});
test("escaped notes and multibyte results keep execution history bounded with usable cursors", async (t) => {
  const h = await setup(t, { reply: "😀".repeat(1000) });
  let item = await create(h);
  for (let round = 0; round < 10; round++) {
    const started = await start(h, item);
    await h.done(started.current_run_id);
    const result = (await h.core.request("work_items.runs", { id: item.id }))
      .items[0];
    item = await committed(h, "work_items.accept", {
      id: item.id,
      expected_revision: started.revision,
      run_id: result.run.id,
      expected_run_revision: result.run.revision,
      evidence_sha256: result.evidence_sha256,
      note: "\\".repeat(1900),
    });
    if (round < 9)
      item = await committed(h, "work_items.save", {
        id: item.id,
        expected_revision: item.revision,
        item: {
          title: item.title,
          goal: `下一轮 ${round}`,
          acceptance: item.acceptance,
          owner_agent_id: item.owner_agent_id,
          workspace_id: item.workspace_id,
        },
      });
  }
  const ids = [];
  let before;
  do {
    const page = await h.core.request("work_items.runs", {
      id: item.id,
      ...(before ? { before } : {}),
    });
    require("../contracts/execution.cjs").validate(
      "work_items.runs",
      page,
      true,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32000);
    ids.push(...page.items.map((result) => result.run.id));
    before = page.next_before;
  } while (before);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
});
test("work operation identity cannot adopt a Run created through another entry point", async (t) => {
  const h = await setup(t),
    item = await create(h),
    operation = crypto.randomUUID();
  const existing = await h.core.request("agent.start", {
    client_run_id: operation,
    workspace_id: h.wid,
    agent_id: 1,
    project_ids: [],
    provider_id: h.provider.id,
    goal: `${item.goal}\n\n验收条件\n${item.acceptance}`,
  });
  await h.done(existing.run.id);
  const started = await start(h, item, {}, operation);
  assert.notEqual(started.current_run_id, existing.run.id);
  assert.equal((await h.get(existing.run.id)).run.work_item_id, null);
  await h.done(started.current_run_id);
  assert.equal(
    (await h.core.request("work_items.runs", { id: item.id })).items.length,
    1,
  );
});
