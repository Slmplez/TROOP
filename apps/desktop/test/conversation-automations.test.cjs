const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");
const proposal = (extra = {}) => ({
  troop_automation: {
    kind: "reminder",
    name: "对话提醒",
    body: "核对交付",
    schedule: {
      kind: "once",
      timezone: "Asia/Shanghai",
      date: "2030-11-09",
      time: "09:00",
      weekdays: [],
    },
    ...extra,
  },
});
async function fixture(t, value = proposal(), project = null) {
  const h = await setup(t, {
    executable: path.resolve(
      __dirname,
      "../../../target/debug",
      process.platform === "win32" ? "troop-core.exe" : "troop-core",
    ),
    reply: JSON.stringify(value),
  });
  if (project)
    await command(h, "memory.membership", {
      agent_id: 1,
      project,
      action: "create",
    });
  const chat = await h.core.request("chat.create", {
    title: "对话自动化",
    workspace_id: h.wid,
    agent_id: 1,
    project_id: project,
  });
  const client = crypto.randomUUID();
  const turn = await h.core.request("chat.send", {
    conversation_id: chat.id,
    provider_id: h.provider.id,
    client_turn_id: client,
    text: "2030年11月9日上午九点提醒核对交付",
    automation: true,
  });
  await until(async () =>
    (
      await h.core.request("chat.messages", { conversation_id: chat.id })
    ).items.some(
      (m) =>
        m.turn_id === turn.turn_id &&
        m.role === "assistant" &&
        m.status === "completed",
    ),
  );
  return { ...h, turn: turn.turn_id, chat: chat.id, client };
}
async function command(h, method, input, operation = crypto.randomUUID()) {
  return h.core.request("operations.execute", {
    operation_id: operation,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
}
const confirm = (h, draft, extra = {}) =>
  command(h, "automations.confirm", {
    turn_id: h.turn,
    source_sha256: draft.source_sha256,
    ...extra,
  });
test("conversation reminder inherits scope and requires confirmation; concurrent identities and restart retain one rule", async (t) => {
  const h = await fixture(t);
  assert.equal((await h.core.request("rules.list", {})).items.length, 0);
  const draft = await h.core.request("automations.preview", {
    turn_id: h.turn,
  });
  contract.validate("automations.preview", draft, true);
  assert.equal(draft.rule.agent_id, 1);
  assert.equal(draft.rule.project_id, null);
  assert.equal(draft.preview.slots[0].timezone, "Asia/Shanghai");
  assert.ok(JSON.stringify(h.server.requests[0].body).includes("只提出草稿"));
  const receipts = await Promise.all([confirm(h, draft), confirm(h, draft)]);
  assert.ok(
    receipts.every((receipt) => receipt.state === "committed"),
    JSON.stringify(receipts),
  );
  assert.equal(receipts[0].result.id, receipts[1].result.id);
  assert.equal(receipts[0].result.revision, 1);
  await h.core.stop();
  await h.core.start();
  assert.equal((await confirm(h, draft)).result.revision, 1);
  assert.equal((await h.core.request("rules.list", {})).items.length, 1);
  assert.equal((await h.core.request("agent.list", {})).items.length, 0);
  assert.equal(h.server.requests.length, 1);
});
test("confirmation rejects changed evidence and proposal-controlled scope", async (t) => {
  const h = await fixture(t);
  const draft = await h.core.request("automations.preview", {
    turn_id: h.turn,
  });
  assert.equal(
    (await confirm(h, { ...draft, source_sha256: "wrong" })).state,
    "rejected",
  );
  assert.equal((await h.core.request("rules.list", {})).items.length, 0);
  const bad = await fixture(t, proposal({ agent_id: 999 }));
  await assert.rejects(
    bad.core.request("automations.preview", { turn_id: bad.turn }),
    /草稿|补充/,
  );
});
test("same message identity cannot change automation mode", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    h.core.request("chat.send", {
      conversation_id: h.chat,
      provider_id: h.provider.id,
      client_turn_id: h.client,
      text: "2030年11月9日上午九点提醒核对交付",
      automation: false,
    }),
    /自动化模式/,
  );
});
test("scheduled proposal needs explicit current grant; changed plan blocks confirmation", async (t) => {
  const value = proposal({
    kind: "scheduled",
    body: undefined,
    goal: "读取当前工作区资料",
  });
  const h = await fixture(t, value);
  await assert.rejects(
    h.core.request("automations.preview", { turn_id: h.turn }),
    /授权/,
  );
  const receipt = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "对话定时范围",
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
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  const grant = receipt.result;
  const draft = await h.core.request("automations.preview", {
    turn_id: h.turn,
    authorization_id: grant.id,
  });
  assert.equal(
    (
      await confirm(h, draft, {
        authorization_id: grant.id,
        expected_plan_sha256: "stale",
      })
    ).state,
    "rejected",
  );
  const saved = await confirm(h, draft, {
    authorization_id: grant.id,
    expected_plan_sha256: draft.preview.plan_sha256,
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  assert.equal(saved.result.start.workspace_id, h.wid);
  assert.equal(saved.result.start.agent_id, 1);
  assert.equal(
    (await h.core.request("automations.preview", { turn_id: h.turn }))
      .registered.id,
    saved.result.id,
  );
  const dispatched = await command(h, "schedules.run", {
    id: saved.result.id,
    expected_revision: saved.result.revision,
    client_trigger_id: crypto.randomUUID(),
  });
  assert.equal(dispatched.state, "committed", JSON.stringify(dispatched.error));
  const id = dispatched.result.run.id;
  await h.done(id);
  const context = await h.core.request("automations.result", {
    turn_id: h.turn,
    run_id: id,
  });
  assert.equal(context.rule_id, saved.result.id);
  assert.equal(context.run_id, id);
  assert.ok(context.content.includes("troop_automation"));
  const unrelated = await h.start();
  await h.done(unrelated);
  await assert.rejects(
    h.core.request("automations.result", {
      turn_id: h.turn,
      run_id: unrelated,
    }),
    /来源自动化/,
  );
});
test("conversation project is durable and membership revocation blocks confirmation", async (t) => {
  const h = await fixture(t, proposal(), "conversation-scope");
  const sessions = await h.core.request("chat.list", {});
  assert.equal(sessions.items[0].project_id, "conversation-scope");
  const draft = await h.core.request("automations.preview", {
    turn_id: h.turn,
  });
  assert.equal(draft.rule.project_id, "conversation-scope");
  await command(h, "memory.membership", {
    agent_id: 1,
    project: "conversation-scope",
    action: "leave",
  });
  const rejected = await confirm(h, draft);
  assert.equal(rejected.state, "rejected");
  assert.match(rejected.error.message, /成员资格/);
  assert.equal((await h.core.request("rules.list", {})).items.length, 0);
});

test("explicit human scope can select another joined project; replay cannot change it", async (t) => {
  const h = await fixture(t, proposal(), "source");
  await command(h, "memory.membership", {
    agent_id: 1,
    project: "target",
    action: "create",
  });
  const scope = { agent_id: 1, project_id: "target", workspace_id: h.wid };
  const draft = await h.core.request("automations.preview", {
    turn_id: h.turn,
    scope,
  });
  assert.equal(draft.rule.project_id, "target");
  const receipt = await confirm(h, draft, { scope });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  assert.equal(receipt.result.project_id, "target");
  await command(h, "memory.membership", {
    agent_id: 1,
    project: "source",
    action: "leave",
  });
  assert.equal(
    (await confirm(h, draft, { scope: { ...scope, project_id: "source" } }))
      .state,
    "rejected",
  );
  assert.equal(
    (await h.core.request("automations.preview", { turn_id: h.turn }))
      .registered.id,
    receipt.result.id,
  );
  await command(h, "memory.membership", {
    agent_id: 1,
    project: "target",
    action: "leave",
  });
  await assert.rejects(
    h.core.request("automations.preview", { turn_id: h.turn }),
  );
  await assert.rejects(
    h.core.request("automations.preview", {
      turn_id: h.turn,
      scope: { ...scope, project_id: "unjoined" },
    }),
    /成员资格/,
  );
});
