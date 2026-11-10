const { test } = require("node:test");
const { cliTest } = require("./fixtures/sandbox-support.cjs");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  setup,
  until,
  sleep,
  results,
} = require("./fixtures/hooks-fixture.cjs");
const { writeTestClock } = require("./fixtures/test-clock.cjs");
const { user } = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");
async function read(h, method, input = {}) {
  return contract.validate(method, await h.core.request(method, input), true);
}
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
  return contract.validate(method, receipt.result, true);
}
async function controlled(t, options = {}) {
  const folder = path.resolve(__dirname, "../../../.tmp-troop-followups");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(fs.mkdtempSync(path.join(folder, "clock-")), "clock");
  let current = Date.now();
  fs.writeFileSync(file, String(current));
  const h = await setup(t, {
    ...options,
    coreArgs: ["--test-clock-file", file],
  });
  const item = await command(h, "work_items.save", {
    expected_revision: 0,
    item: {
      title: "持续核对",
      goal: "观察固定资料变化",
      acceptance: "用户确认目标达成",
      owner_agent_id: 1,
      workspace_id: h.wid,
      dependency_ids: [],
    },
  });
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "跟进范围",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["read_file", "propose_followup", "request_handoff"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  return {
    ...h,
    item,
    grant,
    time: () => current,
    advance: async (value) => {
      current = value;
      await writeTestClock(file, value);
      await sleep(180);
    },
  };
}
const definition = (h, extra = {}) => ({
  name: "有限期检查",
  enabled: true,
  work_item_id: h.item.id,
  agent_id: 1,
  workspace_id: h.wid,
  project_id: null,
  start: {
    client_run_id: crypto.randomUUID(),
    agent_id: 1,
    workspace_id: h.wid,
    provider_id: h.provider.id,
    authorization_id: h.grant.id,
    project_ids: [],
    goal: "检查实际变化，保持来源；需要后续检查时提出预约。",
  },
  expected_plan_sha256: null,
  expires_at_ms: h.time() + 600_000,
  min_interval_ms: 60_000,
  max_runs: 2,
  ...extra,
});
async function save(h, value = definition(h), old) {
  const plan = await read(h, "followups.preview", {
    ...(old ? { id: old.id } : {}),
    policy: value,
  });
  return command(h, "followups.save", {
    ...(old ? { id: old.id } : {}),
    expected_revision: old?.revision ?? 0,
    policy: { ...value, expected_plan_sha256: plan.plan_sha256 },
  });
}
const request = (h, policy, extra = {}) => ({
  id: policy.id,
  expected_revision: policy.revision,
  client_request_id: crypto.randomUUID(),
  at_ms: h.time() + 62_000,
  reason: "等待下一份测试结果",
  expected_change: "测试结论或版本发生变化",
  ...extra,
});
async function history(h, policy) {
  return (await read(h, "followups.history", { id: policy.id })).items;
}
async function cliPolicy(h, engine, extra = {}, goal) {
  const program = {
    codex: "cli_protocol_probe",
    claude: "claude_protocol_probe",
    pi: "pi_protocol_probe",
    opencode: "opencode_protocol_probe",
  }[engine];
  let model_settings;
  if (["claude", "opencode"].includes(engine)) {
    const file = path.join(h.directory, `${engine}-followup-settings.json`);
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
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: `${engine} followup`,
      purpose: "cli_start",
      agent_id: 1,
      engine_id: engine,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      program: path.resolve(
        __dirname,
        `../../../target/debug/examples/${program}${process.platform === "win32" ? ".exe" : ""}`,
      ),
      ...(model_settings ? { model_settings } : {}),
    },
  });
  const value = definition(h, {
    ...extra,
    start: {
      client_run_id: crypto.randomUUID(),
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      authorization_id: grant.id,
      engine_id: engine,
      tool_mode: engine === "codex" ? "native" : "disabled",
      approval_mode: "preauthorized",
      goal:
        goal ??
        `owned followup fixture\nowned followup fixture result ${fs.readFileSync(path.join(h.workspace, "followup-result.json"), "utf8")}`,
    },
  });
  return { policy: await save(h, value), grant };
}
test("followup deadline fences native CLI answers in both orderings", async (t) => {
  for (const expireFirst of [true, false]) {
    const h = await controlled(t);
    const { policy } = await cliPolicy(
      h,
      "codex",
      { expires_at_ms: h.time() + 90_000 },
      "followup owned question",
    );
    const source = await dispatch(h, policy);
    const snapshot = await until(async () => {
      const value = await h.get(source.run_id);
      return value.tasks[0] && value;
    });
    const question = await until(
      async () =>
        (
          await h.core.request("cli.interactions", {
            task_id: snapshot.tasks[0].id,
          })
        ).items[0],
    );
    const answer = {
      interaction_id: question.interaction_id,
      expected_revision: question.revision,
      task_epoch: question.task_epoch,
      request_sha256: question.request_sha256,
      answer: { kind: "question", answers: { target: ["alpha"] } },
    };
    if (!expireFirst) {
      await command(h, "cli.respond", answer);
      await cliSnapshot(h, source.run_id);
    }
    await h.advance(policy.expires_at_ms);
    await until(
      async () => (await read(h, "followups.chain", { id: policy.id })).stopped,
    );
    if (expireFirst) {
      assert.equal(
        (await operation(h, "cli.respond", answer)).state,
        "rejected",
      );
      assert.equal(fs.existsSync(path.join(h.workspace, "answer.txt")), false);
    }
    const stopped = await h.done(source.run_id);
    assert.ok(
      ["cancelled", "interrupted"].includes(stopped.run.state),
      JSON.stringify(stopped.run),
    );
    assert.equal(stopped.run.intent, "cancel");
    await h.core.stop();
    await h.core.start();
    assert.equal((await read(h, "agent.list")).items.length, 1);
  }
});
async function cliSnapshot(h, id) {
  return until(async () => {
    const value = await h.get(id);
    if (value.run.waiting.includes("review")) return value;
    if (["failed", "cancelled", "interrupted"].includes(value.run.state))
      throw Error(JSON.stringify(value));
    return false;
  });
}
async function cliReview(h, runId, accepted = true, key) {
  const snapshot = await cliSnapshot(h, runId);
  const task = await h.core.request("agent.task", { id: snapshot.tasks[0].id });
  const input = {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted,
    note: "检查固定提议证据",
  };
  return { input, result: await command(h, "cli.review", input, key) };
}
for (const engine of ["claude", "codex", "pi", "opencode"]) {
  cliTest(engine, `${engine} fixed review registers one durable check and reuses the original chain`, async (t) => {
    const h = await controlled(t),
      at = h.time() + 90_000;
    fs.writeFileSync(
      path.join(h.workspace, "followup-result.json"),
      JSON.stringify({
        troop_followup: {
          at_ms: at,
          reason: "固定证据后复查",
          expected_change: "资料变化",
        },
      }),
    );
    const { policy } = await cliPolicy(h, engine),
      first = await dispatch(h, policy);
    await cliSnapshot(h, first.run_id);
    assert.equal((await history(h, policy)).length, 1);
    const key = crypto.randomUUID();
    const reviewed = await cliReview(h, first.run_id, true, key);
    const pending = await until(async () =>
      (await history(h, policy)).find((row) => row.state === "pending"),
    );
    assert.equal(pending.source_run_id, first.run_id);
    assert.equal(pending.chain_id, first.chain_id);
    assert.equal(
      (await h.get(first.run_id)).run.followup_bridge.state,
      "applied",
    );
    assert.deepEqual(
      await command(h, "cli.review", reviewed.input, key),
      reviewed.result,
    );
    await h.core.stop();
    await h.core.start();
    assert.equal((await history(h, policy)).length, 2);
    await h.advance(at);
    const second = await until(async () =>
      (await history(h, policy)).find(
        (row) => row.id === pending.id && row.state === "dispatched",
      ),
    );
    assert.equal((await h.get(second.run_id)).run.engine_id, engine);
    await cliReview(h, second.run_id, false);
    assert.equal(
      (await read(h, "followups.get", { id: policy.id })).chain.wake_count,
      2,
    );
    assert.equal(
      (await read(h, "engines.list")).find((row) => row.id === engine).followups
        .contract_version,
      1,
    );
  });
}
for (const engine of ["claude", "codex", "pi", "opencode"]) {
  cliTest(engine, `${engine} reviewed handoff retains the source chain and receiver permission`, async (t) => {
    const h = await controlled(t);
    const item = await command(h, "work_items.save", {
      expected_revision: 0,
      item: {
        title: "CLI 接收工作",
        goal: "复核资料",
        acceptance: "人工确认",
        owner_agent_id: 1,
        workspace_id: h.wid,
        dependency_ids: [],
      },
    });
    fs.writeFileSync(path.join(h.workspace, "followup-result.json"), "{}");
    const receiving = await cliPolicy(h, engine, {
      work_item_id: item.id,
      max_runs: 4,
    });
    fs.writeFileSync(
      path.join(h.workspace, "followup-result.json"),
      JSON.stringify({
        troop_handoff: {
          route_id: receiving.policy.id,
          reason: "复核交接",
          expected_change: "接收结论",
        },
      }),
    );
    const { policy } = await cliPolicy(h, engine, {
      max_runs: 4,
      handoff_policy_ids: [receiving.policy.id],
    });
    const source = await dispatch(h, policy);
    await cliSnapshot(h, source.run_id);
    assert.equal((await history(h, receiving.policy)).length, 0);
    await cliReview(h, source.run_id);
    const transfer = await handoff(h, receiving.policy, "dispatched");
    assert.equal(transfer.source_run_id, source.run_id);
    assert.equal(transfer.chain_id, source.chain_id);
    await cliSnapshot(h, transfer.run_id);
    await command(h, "followups.stop_chain", {
      id: policy.id,
      expected_revision: (await read(h, "followups.chain", { id: policy.id }))
        .revision,
    });
    assert.equal((await h.done(transfer.run_id)).run.state, "cancelled");
  });
}
test("an immediate reviewed handoff survives validation delay within the original chain deadline", async (t) => {
  const h = await controlled(t);
  const item = await command(h, "work_items.save", {
    expected_revision: 0,
    item: {
      title: "Delayed handoff receiver",
      goal: "Check the result",
      acceptance: "User confirms",
      owner_agent_id: 1,
      workspace_id: h.wid,
    },
  });
  fs.writeFileSync(path.join(h.workspace, "followup-result.json"), "{}");
  const receiving = await cliPolicy(h, "codex", {
    work_item_id: item.id,
    max_runs: 4,
  });
  fs.writeFileSync(
    path.join(h.workspace, "followup-result.json"),
    JSON.stringify({
      troop_handoff: {
        route_id: receiving.policy.id,
        reason: "Slow permission validation",
        expected_change: "Receiver checks",
      },
    }),
  );
  const { policy } = await cliPolicy(h, "codex", {
    max_runs: 4,
    handoff_policy_ids: [receiving.policy.id],
  });
  const source = await dispatch(h, policy);
  await cliSnapshot(h, source.run_id);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(`CREATE TRIGGER delay_handoff AFTER UPDATE ON followup_appointments
    WHEN json_extract(NEW.document,'$.kind')='handoff' AND json_extract(OLD.document,'$.kind') IS NULL
    BEGIN UPDATE followup_appointments SET document=json_set(document,'$.at_ms',json_extract(document,'$.at_ms')-10000) WHERE id=NEW.id; END`);
  t.after(() => db.close());
  await cliReview(h, source.run_id);
  const transfer = await handoff(h, receiving.policy, "dispatched");
  assert.equal(transfer.chain_id, source.chain_id);
  assert.ok(transfer.at_ms + 5000 < h.time());
  await cliSnapshot(h, transfer.run_id);
  await command(h, "followups.stop_chain", {
    id: policy.id,
    expected_revision: (await read(h, "followups.chain", { id: policy.id }))
      .revision,
  });
  assert.equal((await h.done(transfer.run_id)).run.state, "cancelled");
});

test("review intent survives a bridge receipt crash and restart registers exactly one appointment", async (t) => {
  const h = await controlled(t),
    at = h.time() + 90_000;
  fs.writeFileSync(
    path.join(h.workspace, "followup-result.json"),
    JSON.stringify({
      troop_followup: {
        at_ms: at,
        reason: "恢复后检查",
        expected_change: "新资料",
      },
    }),
  );
  const { policy } = await cliPolicy(h, "pi"),
    first = await dispatch(h, policy);
  await cliSnapshot(h, first.run_id);
  const { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TRIGGER bridge_fault BEFORE UPDATE ON operations WHEN NEW.method='followups.reviewed_result' BEGIN SELECT RAISE(ABORT,'bridge receipt fixture'); END",
  );
  await cliReview(h, first.run_id);
  await until(() => h.core.state !== "ready");
  assert.equal(
    db.prepare("SELECT count(*) n FROM followup_appointments").get().n,
    1,
  );
  const pending = JSON.parse(
    db.prepare("SELECT document FROM agent_runs WHERE id=?").get(first.run_id)
      .document,
  );
  assert.equal(pending.followup_bridge.state, "pending");
  db.exec("DROP TRIGGER bridge_fault");
  db.close();
  await h.core.start();
  await until(
    async () =>
      (await h.get(first.run_id)).run.followup_bridge?.state === "applied",
  );
  assert.equal((await history(h, policy)).length, 2);
  await h.core.stop();
  await h.core.start();
  assert.equal((await history(h, policy)).length, 2);
  assert.equal((await read(h, "agent.list")).items.length, 1);
});
test("reviewed CLI rejection and stale authority cannot create a followup", async (t) => {
  for (const mode of ["reject", "revoke", "pause", "extra"]) {
    const h = await controlled(t),
      proposal = {
        troop_followup: {
          at_ms: h.time() + 90_000,
          reason: "复查",
          expected_change: "变化",
        },
      };
    if (mode === "extra") proposal.extra = "untrusted";
    fs.writeFileSync(
      path.join(h.workspace, "followup-result.json"),
      JSON.stringify(proposal),
    );
    const { policy, grant } = await cliPolicy(h, "pi"),
      first = await dispatch(h, policy);
    await cliSnapshot(h, first.run_id);
    if (mode === "revoke")
      await command(h, "authorizations.revoke", {
        id: grant.id,
        expected_revision: grant.revision,
      });
    if (mode === "pause")
      await command(h, "followups.set_enabled", {
        id: policy.id,
        expected_revision: policy.revision,
        enabled: false,
      });
    await cliReview(h, first.run_id, mode !== "reject");
    if (mode !== "reject")
      await until(
        async () =>
          (await h.get(first.run_id)).run.followup_bridge?.state === "blocked",
      );
    assert.equal((await history(h, policy)).length, 1);
  }
});

test("follow-up policy and appointment persist once and dispatch one work-linked Run", async (t) => {
  const h = await controlled(t),
    policy = await save(h),
    input = request(h, policy),
    key = crypto.randomUUID();
  const first = await command(h, "followups.request", input, key);
  assert.equal(
    (await command(h, "followups.request", input, key)).id,
    first.id,
  );
  assert.equal((await command(h, "followups.request", input)).id, first.id);
  assert.equal((await read(h, "agent.list", {})).items.length, 0);
  await h.advance(input.at_ms);
  const dispatched = await until(async () =>
    (await history(h, policy)).find((row) => row.state === "dispatched"),
  );
  const run = await h.done(dispatched.run_id);
  assert.equal(run.run.state, "completed", JSON.stringify(run));
  assert.equal(
    (await read(h, "work_items.get", { id: h.item.id })).current_run_id,
    dispatched.run_id,
  );
  assert.equal(
    (await read(h, "followups.get", { id: policy.id })).state.wake_count,
    1,
  );
  assert.equal((await read(h, "rules.list", {})).items[0].kind, "followup");
  await h.core.stop();
  await h.core.start();
  assert.equal((await history(h, policy))[0].run_id, dispatched.run_id);
  assert.equal((await read(h, "agent.list", {})).items.length, 1);
});

test("pause invalidates old appointments and resume never replays them", async (t) => {
  const h = await controlled(t);
  let policy = await save(h);
  const input = request(h, policy);
  await command(h, "followups.request", input);
  policy = await command(h, "followups.set_enabled", {
    id: policy.id,
    expected_revision: policy.revision,
    enabled: false,
  });
  await h.advance(input.at_ms);
  assert.equal((await history(h, policy))[0].state, "cancelled");
  policy = await command(h, "followups.set_enabled", {
    id: policy.id,
    expected_revision: policy.revision,
    enabled: true,
  });
  await sleep(200);
  assert.equal((await read(h, "agent.list", {})).items.length, 0);
  const fresh = request(h, policy);
  await command(h, "followups.request", fresh);
  await h.advance(fresh.at_ms);
  await until(async () =>
    (await history(h, policy)).some((value) => value.state === "dispatched"),
  );
});

test("changed authorization blocks appointments without execution", async (t) => {
  const h = await controlled(t),
    policy = await save(h),
    input = request(h, policy);
  await command(h, "followups.request", input);
  await command(h, "authorizations.revoke", {
    id: h.grant.id,
    expected_revision: h.grant.revision,
  });
  await h.advance(input.at_ms);
  assert.equal((await history(h, policy))[0].state, "blocked");
  assert.equal((await read(h, "agent.list", {})).items.length, 0);
});

test("native Run proposes a durable bounded check and the chain keeps its cumulative limit", async (t) => {
  let at;
  const h = await controlled(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "propose_followup",
              arguments: {
                at_ms: String(at),
                reason: "观察下一版本",
                expected_change: "资料变化",
              },
            },
          ],
  });
  const policy = await save(h);
  at = h.time() + 62_000;
  await command(h, "followups.run", request(h, policy, { at_ms: h.time() }));
  const first = await until(async () =>
    (await history(h, policy)).find((value) => value.state === "dispatched"),
  );
  const done = await h.done(first.run_id);
  assert.equal(done.run.state, "completed", JSON.stringify(done));
  const pending = (await history(h, policy)).find(
    (value) => value.state === "pending",
  );
  assert.ok(pending, JSON.stringify(await history(h, policy)));
  await h.advance(at);
  await until(
    async () =>
      (await history(h, policy)).filter((value) => value.state === "dispatched")
        .length === 2,
  );
  const current = await read(h, "followups.get", { id: policy.id });
  assert.equal(current.state.wake_count, 2);
  assert.equal(current.chain.wake_count, 2);
  assert.equal(current.allowed_actions.request.allowed, false);
});

test("missed appointments are recorded, while explicit manual checks retain their own identity", async (t) => {
  const h = await controlled(t),
    policy = await save(h),
    input = request(h, policy);
  await command(h, "followups.request", input);
  await h.advance(input.at_ms + 6000);
  assert.equal((await history(h, policy))[0].state, "blocked");
  assert.match((await history(h, policy))[0].status_reason, /错过/);
  const manual = request(h, policy, { at_ms: h.time() });
  const first = await command(h, "followups.run", manual);
  assert.equal((await command(h, "followups.run", manual)).id, first.id);
  await until(async () =>
    (await history(h, policy)).some(
      (row) => row.id === first.id && row.state === "dispatched",
    ),
  );
  assert.equal((await read(h, "agent.list", {})).items.length, 1);
});

test("cancelled work stops its chain and cannot be revived by an old appointment", async (t) => {
  const h = await controlled(t),
    policy = await save(h),
    input = request(h, policy);
  await command(h, "followups.request", input);
  await command(h, "work_items.cancel", {
    id: h.item.id,
    expected_revision: h.item.revision,
  });
  await h.advance(input.at_ms);
  assert.equal((await history(h, policy))[0].state, "cancelled");
  assert.equal((await read(h, "agent.list", {})).items.length, 0);
  assert.equal(
    (await read(h, "followups.get", { id: policy.id })).allowed_actions.request
      .allowed,
    false,
  );
});

test("receipt failure rolls back the policy, chain and appointment before activation", async (t) => {
  const h = await controlled(t),
    { DatabaseSync } = require("node:sqlite");
  const value = definition(h),
    plan = await read(h, "followups.preview", { policy: value });
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TRIGGER followup_receipt_fault BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'followup fixture'); END",
  );
  await assert.rejects(
    operation(h, "followups.save", {
      expected_revision: 0,
      policy: { ...value, expected_plan_sha256: plan.plan_sha256 },
    }),
  );
  db.exec("DROP TRIGGER followup_receipt_fault");
  db.close();
  assert.equal((await read(h, "followups.list", {})).items.length, 0);
  assert.equal((await read(h, "agent.list", {})).items.length, 0);
});

test("schema 29 work and rule data migrate with empty follow-up state", async (t) => {
  const h = await controlled(t),
    { DatabaseSync } = require("node:sqlite");
  await h.core.stop();
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  require("./fixtures/remove-policy-schema.cjs")(db);
  db.exec(
    "DROP TABLE followup_appointments; DROP TABLE followup_chains; DROP TABLE followup_states; PRAGMA user_version=29",
  );
  db.close();
  await h.core.start();
  assert.equal(
    (await read(h, "work_items.get", { id: h.item.id })).goal,
    h.item.goal,
  );
  assert.equal((await read(h, "followups.list", {})).items.length, 0);
  await save(h);
});

async function receiver(h, extra = {}) {
  const agent = await h.core.request("memory.agent.save", {
    name: "接收 Agent",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  const item = await command(h, "work_items.save", {
    expected_revision: 0,
    item: {
      title: "交接核对",
      goal: "核对交接资料",
      acceptance: "用户确认交接结论",
      owner_agent_id: agent.id,
      workspace_id: h.wid,
      dependency_ids: extra.dependencies ?? [],
    },
  });
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "接收方范围",
      purpose: "tool_call",
      agent_id: agent.id,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: extra.operations ?? [
        "read_file",
        "propose_followup",
        "request_handoff",
      ],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  const value = definition(h, {
    work_item_id: item.id,
    agent_id: agent.id,
    max_runs: 4,
  });
  value.start = {
    ...value.start,
    agent_id: agent.id,
    authorization_id: grant.id,
    goal: "接收方检查资料",
  };
  return { agent, item, grant, policy: await save(h, value) };
}
async function dispatch(h, policy) {
  await command(h, "followups.run", request(h, policy, { at_ms: h.time() }));
  return until(async () =>
    (await history(h, policy)).find((row) => row.state === "dispatched"),
  );
}
async function handoff(h, policy, state) {
  return until(async () => {
    const rows = await history(h, policy);
    const matched = rows.find(
      (row) => row.kind === "handoff" && row.state === state,
    );
    if (matched) return matched;
    // Tools use the real authority clock. Advance the controlled scheduler to
    // a proposal's actual timestamp if fixture setup crossed a second boundary.
    const future = rows.find(
      (row) =>
        row.kind === "handoff" &&
        row.state === "pending" &&
        row.at_ms > h.time(),
    );
    if (future) await h.advance(future.at_ms);
    return false;
  });
}
test("native handoff keeps two Agents in the same chain and a receiver check shares the root limit", async (t) => {
  let target, at;
  const h = await controlled(t, {
    plan: ({ body }) => {
      if (results(body).length) return [];
      return user(body).startsWith("接收方")
        ? [
            {
              name: "propose_followup",
              arguments: {
                at_ms: String(at),
                reason: "等待下一版",
                expected_change: "接收资料更新",
              },
            },
          ]
        : [
            {
              name: "request_handoff",
              arguments: {
                route_id: target,
                reason: "需要接收方核对",
                expected_change: "新增核对结论",
              },
            },
          ];
    },
  });
  const receiving = await receiver(h);
  target = receiving.policy.id;
  at = h.time() + 62_000;
  const origin = await save(
    h,
    definition(h, { max_runs: 3, handoff_policy_ids: [target] }),
  );
  const first = await dispatch(h, origin);
  assert.equal(
    first.frozen_definition.context.handoff_routes[0].route_id,
    target,
  );
  assert.equal(
    first.frozen_definition.context.followup_limits
      .remaining_starts_after_this_run,
    2,
  );
  const source = await h.done(first.run_id);
  assert.equal(
    source.invocations[0].state,
    "succeeded",
    JSON.stringify(source),
  );
  const transferred = await handoff(h, receiving.policy, "dispatched");
  const received = await h.done(transferred.run_id);
  assert.equal(received.run.agent_id, receiving.agent.id);
  assert.equal(transferred.chain_id, first.chain_id);
  assert.equal(transferred.source_run_id, first.run_id);
  assert.equal(
    received.invocations[0].state,
    "succeeded",
    JSON.stringify(received),
  );
  await h.advance(at);
  const last = await until(async () =>
    (await history(h, receiving.policy)).find(
      (row) => row.kind !== "handoff" && row.state === "dispatched",
    ),
  );
  await h.done(last.run_id);
  const chain = await read(h, "followups.chain", { id: first.chain_id });
  assert.equal(chain.wake_count, 3);
  const current = await read(h, "followups.get", { id: target });
  assert.equal(current.chain.id, first.chain_id);
  assert.equal(current.allowed_actions.request.allowed, false);
  const rejected = await operation(
    h,
    "followups.run",
    request(h, current, { at_ms: h.time() }),
  );
  assert.equal(rejected.state, "rejected");
  assert.equal((await read(h, "agent.list")).items.length, 3);
  assert.equal(
    (await read(h, "work_items.get", { id: receiving.item.id })).progress.state,
    "awaiting_acceptance",
  );
});

test("an unconfigured route and a broader receiving scope cannot create a handoff", async (t) => {
  const h = await controlled(t, { beforeResponse: () => sleep(800) });
  const receiving = await receiver(h),
    origin = await save(h, definition(h, { max_runs: 4 }));
  const source = await dispatch(h, origin);
  const input = {
    source_run_id: source.run_id,
    route_id: receiving.policy.id,
    client_request_id: crypto.randomUUID(),
    reason: "交接核对",
    expected_change: "结论更新",
  };
  const denied = await operation(h, "followups.handoff", input);
  assert.equal(denied.state, "rejected");
  assert.match(denied.error.message, /路由/);
  assert.equal((await history(h, receiving.policy)).length, 0);
  await h.done(source.run_id);
  const broad = await receiver(h, {
    operations: [
      "read_file",
      "propose_followup",
      "request_handoff",
      "write_file",
    ],
  });
  const updated = await save(
    h,
    definition(h, { max_runs: 4, handoff_policy_ids: [broad.policy.id] }),
    origin,
  );
  await h.advance(h.time() + 61_000);
  const second = await dispatch(h, updated);
  const declined = await operation(h, "followups.handoff", {
    ...input,
    source_run_id: second.run_id,
    route_id: broad.policy.id,
    client_request_id: crypto.randomUUID(),
  });
  assert.equal(declined.state, "rejected");
  assert.match(declined.error.message, /能力上限/);
  assert.equal((await history(h, broad.policy)).length, 0);
});

test("pausing preserves an in-flight Run and resume does not restore its old appointment", async (t) => {
  const h = await controlled(t, { beforeResponse: () => sleep(500) });
  let policy = await save(h);
  const started = await dispatch(h, policy);
  await command(h, "followups.request", request(h, policy));
  policy = await command(h, "followups.set_enabled", {
    id: policy.id,
    expected_revision: policy.revision,
    enabled: false,
  });
  assert.equal((await h.done(started.run_id)).run.state, "completed");
  assert.ok(
    (await history(h, policy)).some((row) => row.state === "cancelled"),
  );
  policy = await command(h, "followups.set_enabled", {
    id: policy.id,
    expected_revision: policy.revision,
    enabled: true,
  });
  await h.advance(h.time() + 62_000);
  assert.equal((await read(h, "agent.list")).items.length, 1);
});

test("chain stop fences current execution and pending checks and survives restart", async (t) => {
  const h = await controlled(t, { beforeResponse: () => sleep(700) }),
    policy = await save(h, definition(h, { max_runs: 4 }));
  const started = await dispatch(h, policy);
  await command(h, "followups.request", request(h, policy));
  const chain = await read(h, "followups.chain", { id: started.chain_id });
  const key = crypto.randomUUID(),
    input = { id: chain.id, expected_revision: chain.revision };
  const stopped = await command(h, "followups.stop_chain", input, key);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.generation, chain.generation + 1);
  assert.deepEqual(
    await command(h, "followups.stop_chain", input, key),
    stopped,
  );
  assert.equal((await h.done(started.run_id)).run.state, "cancelled");
  assert.ok(
    (await history(h, policy)).some((row) => row.state === "cancelled"),
  );
  await h.core.stop();
  await h.core.start();
  await h.advance(h.time() + 62_000);
  assert.equal(
    (await read(h, "followups.chain", { id: chain.id })).stopped,
    true,
  );
  assert.equal((await read(h, "agent.list")).items.length, 1);
  assert.equal(
    (await read(h, "followups.get", { id: policy.id })).allowed_actions.request
      .allowed,
    false,
  );
});

test("deadline and root work cancellation stop the whole causal chain", async (t) => {
  for (const cancelWork of [false, true]) {
    const h = await controlled(t, { beforeResponse: () => sleep(700) }),
      policy = await save(
        h,
        definition(h, { expires_at_ms: h.time() + 90_000 }),
      );
    const started = await dispatch(h, policy);
    if (cancelWork) {
      const item = await read(h, "work_items.get", { id: h.item.id });
      await command(h, "work_items.cancel", {
        id: item.id,
        expected_revision: item.revision,
      });
    } else {
      await h.advance(policy.expires_at_ms);
    }
    const chain = await until(async () => {
      const value = await read(h, "followups.chain", { id: started.chain_id });
      return value.stopped && value;
    });
    assert.equal(chain.stopped, true);
    assert.equal((await h.done(started.run_id)).run.state, "cancelled");
  }
});

test("policy definition edits invalidate old appointments while preserving consumed limits", async (t) => {
  const h = await controlled(t),
    policy = await save(h, definition(h, { max_runs: 4 }));
  const first = await dispatch(h, policy);
  await h.done(first.run_id);
  await command(h, "followups.request", request(h, policy));
  const revised = await save(
    h,
    definition(h, { max_runs: 4, name: "重新确认的策略" }),
    policy,
  );
  assert.equal(revised.state.wake_count, 1);
  assert.equal(revised.chain.wake_count, 1);
  assert.ok(
    (await history(h, revised)).some((row) => row.state === "cancelled"),
  );
  await h.advance(h.time() + 62_000);
  assert.equal((await read(h, "agent.list")).items.length, 1);
});

test("two Agents handing work back and forth stop at the original chain limit", async (t) => {
  let firstTarget, secondTarget;
  const h = await controlled(t, {
    beforeResponse: async ({ body }) => {
      if (!user(body).startsWith("接收方") && results(body).length)
        await sleep(500);
    },
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "request_handoff",
              arguments: {
                route_id: user(body).startsWith("接收方")
                  ? secondTarget
                  : firstTarget,
                reason: "请对方复核",
                expected_change: "补充核对结果",
              },
            },
          ],
  });
  const receiving = await receiver(h);
  firstTarget = receiving.policy.id;
  const origin = await save(
    h,
    definition(h, { max_runs: 3, handoff_policy_ids: [firstTarget] }),
  );
  secondTarget = origin.id;
  const targetDefinition = definition(h, {
    work_item_id: receiving.item.id,
    agent_id: receiving.agent.id,
    max_runs: 4,
    handoff_policy_ids: [origin.id],
  });
  targetDefinition.start = {
    ...targetDefinition.start,
    agent_id: receiving.agent.id,
    authorization_id: receiving.grant.id,
    goal: "接收方检查资料",
  };
  await save(h, targetDefinition, receiving.policy);
  const first = await dispatch(h, origin);
  await h.done(first.run_id);
  const back = await until(async () => {
    await handoff(h, receiving.policy, "dispatched");
    const rows = await history(h, origin);
    const queued = rows.find((row) => row.kind === "handoff");
    if (queued?.state === "pending" && queued.at_ms > h.time())
      await h.advance(queued.at_ms);
    return queued?.state === "waiting" && queued;
  });
  assert.equal(back.chain_id, origin.id);
  await h.advance(h.time() + 61_000);
  const last = await until(async () =>
    (await history(h, origin)).find(
      (row) => row.id === back.id && row.state === "dispatched",
    ),
  );
  const done = await h.done(last.run_id);
  assert.equal(done.invocations[0].state, "failed", JSON.stringify(done));
  assert.equal((await read(h, "agent.list")).items.length, 3);
  assert.equal(
    (await read(h, "followups.chain", { id: origin.id })).wake_count,
    3,
  );
  assert.equal(
    (await read(h, "followups.get", { id: receiving.policy.id })).chain.id,
    origin.id,
  );
});

test("handoff rechecks dependencies and cannot release an unaccepted predecessor", async (t) => {
  const h = await controlled(t, { beforeResponse: () => sleep(700) });
  const receiving = await receiver(h, { dependencies: [h.item.id] });
  const origin = await save(
    h,
    definition(h, { max_runs: 4, handoff_policy_ids: [receiving.policy.id] }),
  );
  const source = await dispatch(h, origin);
  const receipt = await operation(h, "followups.handoff", {
    source_run_id: source.run_id,
    route_id: receiving.policy.id,
    client_request_id: crypto.randomUUID(),
    reason: "推进后续工作",
    expected_change: "后续结果",
  });
  assert.equal(receipt.state, "rejected");
  assert.match(receipt.error.message, /前置/);
  assert.equal((await history(h, receiving.policy)).length, 0);
  await h.done(source.run_id);
  assert.equal(
    (await read(h, "work_items.get", { id: h.item.id })).progress.state,
    "awaiting_acceptance",
  );
});

test("stopping the source prevents its queued follow-up from starting", async (t) => {
  let hold = false,
    at;
  const h = await controlled(t, {
    beforeResponse: async ({ body }) => {
      if (hold && results(body).length) await sleep(1500);
    },
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "propose_followup",
              arguments: {
                at_ms: String(at),
                reason: "等待资料",
                expected_change: "版本变化",
              },
            },
          ],
  });
  at = h.time() + 62_000;
  hold = true;
  const policy = await save(h),
    source = await dispatch(h, policy);
  await until(async () =>
    (await history(h, policy)).some((row) => row.state === "pending"),
  );
  await command(h, "agent.cancel", { id: source.run_id });
  await h.done(source.run_id);
  await h.advance(at);
  const rows = await history(h, policy);
  assert.ok(
    rows.some(
      (row) => row.state === "blocked" && /来源执行/.test(row.status_reason),
    ),
  );
  assert.equal((await read(h, "agent.list")).items.length, 1);
});

test("a failed chain-stop receipt rolls back fences and appointments before any runtime stop", async (t) => {
  const h = await controlled(t, { beforeResponse: () => sleep(1800) }),
    policy = await save(h);
  const source = await dispatch(h, policy);
  await command(h, "followups.request", request(h, policy));
  const chain = await read(h, "followups.chain", { id: policy.id }),
    { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TRIGGER stop_receipt_fault BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'stop fixture'); END",
  );
  await assert.rejects(
    operation(h, "followups.stop_chain", {
      id: chain.id,
      expected_revision: chain.revision,
    }),
  );
  db.exec("DROP TRIGGER stop_receipt_fault");
  db.close();
  assert.deepEqual(await read(h, "followups.chain", { id: chain.id }), chain);
  assert.ok((await history(h, policy)).some((row) => row.state === "pending"));
  assert.equal((await h.done(source.run_id)).run.state, "completed");
});

test("a group-origin check inherits its upstream wake budget and whole-chain stop", async (t) => {
  for (const exhaust of [false, true]) {
    let at,
      hold = false;
    const h = await controlled(t, {
      beforeResponse: async () => {
        if (hold) await sleep(1200);
      },
      plan: ({ body }) =>
        results(body).length
          ? []
          : [
              {
                name: "propose_followup",
                arguments: {
                  at_ms: String(at),
                  reason: "群交办后复查",
                  expected_change: "新资料",
                },
              },
            ],
    });
    at = h.time() + 62_000;
    const policy = await save(h, definition(h, { max_runs: 4 }));
    let group = await command(h, "groups.save", {
      expected_revision: 0,
      group: {
        name: "跟进协作群",
        rules: "受控复查",
        project_id: null,
        paused: false,
      },
    });
    group = await command(h, "groups.member", {
      id: group.id,
      expected_revision: group.revision,
      agent_id: 1,
    });
    await command(h, "groups.executor.save", {
      group_id: group.id,
      agent_id: 1,
      expected_revision: 0,
      enabled: true,
      workspace_id: h.wid,
      execution: {
        kind: "agent",
        provider_id: h.provider.id,
        authorization_id: h.grant.id,
      },
    });
    const message = await command(h, "groups.send", {
      group_id: group.id,
      expected_revision: group.revision,
      client_message_id: crypto.randomUUID(),
      body: "检查当前工作",
      mention_agent_ids: [1],
      broadcast: false,
      work_item_id: h.item.id,
      execute_work_item: true,
    });
    const delivery = await until(async () =>
      (
        await read(h, "groups.deliveries", {
          group_id: group.id,
          message_id: message.id,
        })
      ).items.find((row) => row.run_state === "completed"),
    );
    const pending = await until(async () =>
      (await history(h, policy)).find((row) => row.state === "pending"),
    );
    const upstream = await read(h, "groups.chain", { id: delivery.chain_id });
    assert.equal(pending.chain_id, policy.id);
    if (exhaust) {
      const { DatabaseSync } = require("node:sqlite"),
        db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
      db.prepare(
        "UPDATE group_chains SET document=json_set(document,'$.wake_limit',1) WHERE id=?",
      ).run(upstream.id);
      db.close();
    }
    hold = true;
    await h.advance(at);
    if (exhaust) {
      assert.equal(
        (await history(h, policy)).find((row) => row.id === pending.id).state,
        "blocked",
      );
      assert.equal((await read(h, "agent.list")).items.length, 1);
    } else {
      const check = await until(async () =>
        (await history(h, policy)).find(
          (row) => row.id === pending.id && row.state === "dispatched",
        ),
      );
      const current = await read(h, "groups.chain", { id: upstream.id });
      assert.equal(current.wake_count, 2);
      await command(h, "groups.stop_chain", {
        id: current.id,
        expected_revision: current.revision,
      });
      assert.equal(
        (await read(h, "followups.chain", { id: policy.id })).stopped,
        true,
      );
      assert.equal((await h.done(check.run_id)).run.state, "cancelled");
    }
  }
});
