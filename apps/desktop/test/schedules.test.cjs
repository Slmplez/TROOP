const { test } = require("node:test");
const { cliTest } = require("./fixtures/sandbox-support.cjs");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  fs = require("node:fs"),
  path = require("node:path");
const { setup, until, sleep } = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");
const { writeTestClock } = require("./fixtures/test-clock.cjs");
const read = async (h, method, input = {}) => {
  const result = await h.core.request(method, input);
  return contract.methods[method]
    ? contract.validate(method, result, true)
    : result;
};
const operation = (h, method, input, operation_id = crypto.randomUUID()) =>
  h.core.request("operations.execute", {
    operation_id,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
async function command(h, method, input, key) {
  const receipt = await operation(h, method, input, key);
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return contract.methods[method]
    ? contract.validate(method, receipt.result, true)
    : receipt.result;
}
async function controlled(t, options = {}) {
  const root = path.resolve(__dirname, "../../../.tmp-troop-schedules");
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "clock-")),
    file = path.join(directory, "clock");
  let current = Date.parse("2026-11-08T00:00:00Z");
  fs.writeFileSync(file, String(current));
  const h = await setup(t, {
    ...options,
    coreArgs: ["--test-clock-file", file],
  });
  return {
    ...h,
    time: () => current,
    clock: file,
    advance: async (time) => {
      current = time;
      await writeTestClock(file, time);
      await sleep(170);
    },
  };
}
const grant = (h, extra = {}) =>
  command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "定时工具范围",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["read_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
      ...extra,
    },
  });
const definition = (h, permission, extra = {}) => ({
  kind: "scheduled",
  event: "time.due",
  name: "定时核对",
  enabled: true,
  agent_id: 1,
  workspace_id: h.wid,
  project_id: null,
  work_item_id: null,
  schedule: {
    kind: "once",
    timezone: "UTC",
    date: "2026-11-08",
    time: "00:00:02",
  },
  start: {
    client_run_id: crypto.randomUUID(),
    agent_id: 1,
    workspace_id: h.wid,
    provider_id: h.provider.id,
    authorization_id: permission.id,
    project_ids: [],
    goal: "核对定时交办的固定资料",
  },
  ...extra,
});
async function save(h, rule, old, key) {
  const plan = await read(h, "schedules.preview", {
    ...(old ? { id: old.id } : {}),
    rule,
  });
  return command(
    h,
    "rules.save",
    {
      ...(old ? { id: old.id } : {}),
      expected_revision: old?.revision ?? 0,
      rule: { ...rule, expected_plan_sha256: plan.plan_sha256 },
    },
    key,
  );
}

test("one scheduled slot commits one preauthorized native Run and frozen trigger evidence", async (t) => {
  const h = await controlled(t),
    permission = await grant(h),
    rule = await save(h, definition(h, permission));
  assert.equal(h.server.requests.length, 0);
  assert.equal(rule.next_slot.due_at_ms, h.time() + 2000);
  await h.advance(h.time() + 2000);
  const occurrence = await until(
    async () => (await read(h, "schedules.history", { id: rule.id })).items[0],
  );
  assert.equal(occurrence.state, "dispatched");
  const result = await h.done(occurrence.run.id);
  assert.equal(result.run.state, "completed");
  assert.equal(result.run.trigger.rule_id, rule.id);
  assert.equal(result.run.trigger.rule_revision, rule.revision);
  assert.equal(
    result.run.trigger.permission.grant_revision,
    permission.revision,
  );
  await h.advance(h.time() + 1000);
  assert.equal((await read(h, "agent.list")).items.length, 1);
  assert.equal(
    (await read(h, "schedules.history", { id: rule.id })).items.length,
    1,
  );
  assert.equal((await read(h, "notifications.list")).items.length, 0);
});

test("revocation before the slot is recorded as blocked without creating a Run or calling the model", async (t) => {
  const h = await controlled(t),
    permission = await grant(h),
    rule = await save(h, definition(h, permission));
  await command(h, "authorizations.revoke", {
    id: permission.id,
    expected_revision: permission.revision,
  });
  await h.advance(h.time() + 2000);
  const item = (await read(h, "schedules.history", { id: rule.id })).items[0];
  assert.equal(item.state, "blocked");
  assert.equal(item.run, null);
  assert.equal((await read(h, "agent.list")).items.length, 0);
  assert.equal(h.server.requests.length, 0);
  const paused = await command(h, "schedules.set_enabled", {
    id: rule.id,
    expected_revision: rule.revision,
    enabled: false,
  });
  assert.equal(paused.phase, "paused");
});

test("manual keys deduplicate across operations, overlap is blocked and pausing leaves the Run independently stoppable", async (t) => {
  const h = await controlled(t, { beforeResponse: async () => sleep(1000) }),
    permission = await grant(h),
    rule = await save(
      h,
      definition(h, permission, {
        schedule: { kind: "daily", timezone: "UTC", time: "12:00" },
      }),
    );
  const request = {
    id: rule.id,
    expected_revision: rule.revision,
    client_trigger_id: crypto.randomUUID(),
  };
  const [one, two] = await Promise.all([
    command(h, "schedules.run", request),
    command(h, "schedules.run", request),
  ]);
  assert.equal(one.run.id, two.run.id);
  assert.equal((await read(h, "agent.list")).items.length, 1);
  const busy = await command(h, "schedules.run", {
    ...request,
    client_trigger_id: crypto.randomUUID(),
  });
  assert.equal(busy.state, "blocked");
  assert.equal(busy.run, null);
  const paused = await command(h, "schedules.set_enabled", {
    id: rule.id,
    expected_revision: rule.revision,
    enabled: false,
  });
  assert.equal(paused.phase, "paused");
  assert.equal(paused.current_run.id, one.run.id);
  assert.notEqual((await h.get(one.run.id)).run.intent, "cancel");
  await command(h, "agent.cancel", { id: one.run.id });
  assert.equal((await h.done(one.run.id)).run.state, "cancelled");
  assert.equal(
    (
      await operation(h, "schedules.cancel", {
        id: rule.id,
        expected_revision: rule.revision,
      })
    ).state,
    "rejected",
  );
  await command(h, "schedules.cancel", {
    id: rule.id,
    expected_revision: paused.revision,
  });
  assert.equal(
    (
      await operation(h, "schedules.run", {
        ...request,
        expected_revision: paused.revision + 1,
        client_trigger_id: crypto.randomUUID(),
      })
    ).state,
    "rejected",
  );
});

test("missed slots drain across batches without model work and an explicit rerun preserves its original slot", async (t) => {
  const h = await controlled(t),
    permission = await grant(h),
    rule = await save(
      h,
      definition(h, permission, {
        schedule: { kind: "daily", timezone: "UTC", time: "12:00" },
      }),
    );
  await h.advance(Date.parse("2026-11-12T12:00:01Z"));
  const page = await until(async () => {
    const p = await read(h, "schedules.history", { id: rule.id });
    return p.items.length === 5 && p;
  });
  assert.ok(page.items.every((i) => i.state === "skipped"));
  assert.equal(h.server.requests.length, 0);
  const source = page.items[0],
    rerun = await command(h, "schedules.run", {
      id: rule.id,
      expected_revision: rule.revision,
      client_trigger_id: crypto.randomUUID(),
      source_slot_id: source.id,
    });
  assert.equal(rerun.source_slot_id, source.id);
  assert.equal(rerun.manual, true);
  assert.equal((await h.done(rerun.run.id)).run.state, "completed");
});

test("a work-linked slot uses the shared work execution history and fixed result acceptance", async (t) => {
  const h = await controlled(t),
    permission = await grant(h),
    work = await command(h, "work_items.save", {
      expected_revision: 0,
      item: {
        title: "定时工作",
        goal: "核对已发布资料",
        acceptance: "提供可核对结论",
        owner_agent_id: 1,
        workspace_id: h.wid,
      },
    }),
    rule = await save(h, definition(h, permission, { work_item_id: work.id }));
  await h.advance(h.time() + 2000);
  const event = (await read(h, "schedules.history", { id: rule.id })).items[0];
  await h.done(event.run.id);
  const current = await read(h, "work_items.get", { id: work.id }),
    result = (await read(h, "work_items.runs", { id: work.id })).items[0];
  assert.equal(current.progress.state, "awaiting_acceptance");
  assert.equal(result.run.id, event.run.id);
  const accepted = await command(h, "work_items.accept", {
    id: work.id,
    expected_revision: current.revision,
    run_id: result.run.id,
    expected_run_revision: result.run.revision,
    evidence_sha256: result.evidence_sha256,
    note: "固定结论符合验收要求",
  });
  assert.equal(accepted.progress.state, "completed");
  assert.equal(
    (await read(h, "schedules.history", { id: rule.id })).items[0].work_item
      .progress.state,
    "completed",
  );
});

test("Run insertion failure rolls back execution and records one blocked slot without activation", async (t) => {
  const h = await controlled(t),
    permission = await grant(h),
    rule = await save(h, definition(h, permission));
  const { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER owned_schedule_fail BEFORE INSERT ON agent_runs BEGIN SELECT RAISE(ABORT,'owned schedule failure'); END;",
  );
  db.close();
  await h.advance(h.time() + 2000);
  const page = await read(h, "schedules.history", { id: rule.id });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].state, "blocked");
  assert.match(page.items[0].reason, /owned schedule failure/);
  assert.equal((await read(h, "agent.list")).items.length, 0);
  assert.equal(h.server.requests.length, 0);
  await h.advance(h.time() + 1000);
  assert.equal(
    (await read(h, "schedules.history", { id: rule.id })).items.length,
    1,
  );
});

for (const engine of ["codex", "claude", "pi", "opencode"])
  cliTest(engine, `${engine} scheduled slot uses the real Worker and requires fixed CLI result review`, async (t) => {
    const h = await controlled(t);
    const program = {
      codex: "cli_protocol_probe",
      claude: "claude_protocol_probe",
      pi: "pi_protocol_probe",
      opencode: "opencode_protocol_probe",
    }[engine];
    let model_settings;
    if (engine === "claude" || engine === "opencode") {
      const file = path.join(h.directory, engine + "-settings.json");
      fs.writeFileSync(
        file,
        JSON.stringify(
          engine === "claude"
            ? {
                env: {
                  ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
                  ANTHROPIC_MODEL: "owned-claude-model",
                  ANTHROPIC_AUTH_TOKEN: "TROOP_CLAUDE_TEST_CREDENTIAL",
                },
              }
            : {
                model: "owned/fixture",
                provider: {
                  owned: {
                    npm: "@ai-sdk/openai-compatible",
                    options: {
                      baseURL: "http://127.0.0.1:9/v1",
                      apiKey: "TROOP_OPENCODE_TEST_CREDENTIAL",
                    },
                    models: {
                      fixture: { limit: { context: 32768, output: 4096 } },
                    },
                  },
                },
              },
        ),
      );
      model_settings = { file };
    }
    const permission = await grant(h, {
      purpose: "cli_start",
      engine_id: engine,
      operations: ["start"],
      network: "any",
      program: path.resolve(
        __dirname,
        `../../../target/debug/examples/${program}.exe`,
      ),
      ...(model_settings ? { model_settings } : {}),
    });
    const base = definition(h, permission),
      rule = await save(h, {
        ...base,
        start: {
          client_run_id: crypto.randomUUID(),
          agent_id: 1,
          workspace_id: h.wid,
          project_ids: [],
          engine_id: engine,
          authorization_id: permission.id,
          tool_mode: engine === "codex" ? "native" : "disabled",
          approval_mode: "preauthorized",
          goal: "Owned scheduled fixture task",
        },
      });
    await h.advance(h.time() + 2000);
    const occurrence = (await read(h, "schedules.history", { id: rule.id }))
      .items[0];
    assert.equal(occurrence.state, "dispatched", JSON.stringify(occurrence));
    assert.ok(occurrence.frozen_definition.start.timeout_seconds > 0);
    assert.equal(
      occurrence.frozen_definition.start.expected_plan_sha256,
      rule.expected_plan_sha256,
    );
    await until(async () =>
      (await h.get(occurrence.run.id)).run.waiting.includes("review"),
    );
    const snapshot = await h.get(occurrence.run.id),
      task = await read(h, "agent.task", { id: snapshot.tasks[0].id });
    assert.ok(task.evidence.sha256);
    assert.equal(task.stopped, true);
    assert.equal(
      (await read(h, "schedules.get", { id: rule.id })).allowed_actions.run
        .allowed,
      false,
    );
    await command(h, "cli.review", {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: task.evidence.sha256,
      accepted: true,
      note: "核对定时执行固定证据",
    });
    assert.equal((await h.done(occurrence.run.id)).run.state, "completed");
    assert.equal((await read(h, "agent.list")).items.length, 1);
    assert.equal(h.server.requests.length, 0);
  });

test("pausing and enabling a future rule expose matching backend actions and preserve its current revision", async (t) => {
  const h = await controlled(t),
    permission = await grant(h);
  let rule = await save(
    h,
    definition(h, permission, {
      schedule: { kind: "daily", timezone: "UTC", time: "12:00" },
    }),
  );
  rule = await command(h, "schedules.set_enabled", {
    id: rule.id,
    expected_revision: rule.revision,
    enabled: false,
  });
  assert.equal(rule.allowed_actions.set_enabled.allowed, true);
  rule = await command(h, "schedules.set_enabled", {
    id: rule.id,
    expected_revision: rule.revision,
    enabled: true,
  });
  assert.equal(rule.phase, "active");
  assert.equal(rule.revision, 3);
  assert.equal(
    (await read(h, "schedules.get", { id: rule.id })).current_blocker,
    null,
  );
});

test("restart retains an unresolved Run and blocks a fresh manual trigger until reconciliation", async (t) => {
  const h = await controlled(t, { beforeResponse: async () => sleep(1000) }),
    permission = await grant(h),
    rule = await save(h, definition(h, permission));
  await h.advance(h.time() + 2000);
  const first = (await read(h, "schedules.history", { id: rule.id })).items[0];
  await until(() => h.server.requests.length > 0);
  h.core.child.kill();
  await until(() => h.core.state === "faulted");
  await h.core.start();
  assert.equal(
    (await read(h, "schedules.get", { id: rule.id })).current_run.id,
    first.run.id,
  );
  const retried = await command(h, "schedules.run", {
    id: rule.id,
    expected_revision: rule.revision,
    client_trigger_id: crypto.randomUUID(),
  });
  assert.equal(retried.state, "blocked");
  assert.equal((await read(h, "agent.list")).items.length, 1);
});

test("a changed work definition blocks the frozen scheduled target until the rule is saved again", async (t) => {
  const h = await controlled(t),
    permission = await grant(h),
    item = {
      title: "工作目标",
      goal: "第一版目标",
      acceptance: "第一版验收",
      owner_agent_id: 1,
      workspace_id: h.wid,
    },
    work = await command(h, "work_items.save", { expected_revision: 0, item }),
    rule = await save(h, definition(h, permission, { work_item_id: work.id }));
  await command(h, "work_items.save", {
    id: work.id,
    expected_revision: work.revision,
    item: { ...item, goal: "第二版目标" },
  });
  await h.advance(h.time() + 2000);
  const record = (await read(h, "schedules.history", { id: rule.id })).items[0];
  assert.equal(record.state, "blocked");
  assert.match(record.reason, /工作目标已变化/);
  assert.equal(h.server.requests.length, 0);
});

test("model configuration changes after confirmation block the slot and invalidate its stored permission plan", async (t) => {
  const h = await controlled(t),
    permission = await grant(h),
    rule = await save(h, definition(h, permission));
  await h.core.request("provider.save", {
    id: h.provider.id,
    expected_revision: h.provider.revision,
    config: { ...h.provider.config, model: "changed-model" },
  });
  await h.advance(h.time() + 2000);
  const result = (await read(h, "schedules.history", { id: rule.id })).items[0];
  assert.equal(result.state, "blocked");
  assert.match(result.reason, /权限计划/);
  assert.equal(h.server.requests.length, 0);
});

test("an authorization expiring after save is checked again before the scheduled Run is created", async (t) => {
  const h = await controlled(t),
    permission = await grant(h, {
      expires_at: Math.floor(Date.now() / 1000) + 2,
    }),
    rule = await save(h, definition(h, permission));
  await sleep(2100);
  await h.advance(h.time() + 2000);
  const result = (await read(h, "schedules.history", { id: rule.id })).items[0];
  assert.equal(result.state, "blocked");
  assert.equal((await read(h, "agent.list")).items.length, 0);
  assert.equal(h.server.requests.length, 0);
});
