const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setup, until, results } = require("./fixtures/hooks-fixture.cjs");
const grant = async (h, overrides = {}) =>
  (
    await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "authorizations.save",
      input: {
        expected_revision: 0,
        grant: {
          name: "Controlled files",
          purpose: "tool_call",
          agent_id: 1,
          engine_id: "native",
          workspace_id: h.wid,
          project_ids: [],
          read_roots: [h.workspace],
          write_roots: [h.workspace],
          operations: ["write_file", "read_file"],
          network: "none",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          rule_id: null,
          ...overrides,
        },
      },
    })
  ).result;
test("bound native run automatically authorizes exact file arguments and records enforcement", async (t) => {
  const h = await setup(t, {
    plan: [
      {
        name: "write_file",
        arguments: {
          path: "authorized.txt",
          content: "bounded",
          expected_hash: "missing",
        },
      },
    ],
  });
  const g = await grant(h);
  const id = await h.start({ authorization_id: g.id });
  const d = await h.done(id);
  assert.equal(d.run.state, "completed");
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "authorized.txt"), "utf8"),
    "bounded",
  );
  const inv = await h.call(id);
  assert.equal(inv.permission_plan.grant_revision, 1);
  assert.equal(inv.permission_plan.action.operation, "write_file");
});
module.exports = { grant };
test("revoked grant stops a bound run before later effects; shell cannot bypass restrictions", async (t) => {
  const h = await setup(t, {
    plan: [
      {
        name: "run_command",
        arguments: { command: "Set-Content forbidden.txt bypass" },
      },
    ],
  });
  const g = await grant(h);
  const id = await h.start({ authorization_id: g.id });
  await h.done(id);
  assert.equal(fs.existsSync(path.join(h.workspace, "forbidden.txt")), false);
  const inv = await h.call(id);
  assert.equal(inv.state, "failed");
  assert.match(inv.result.error, /操作集合|权限/);
  await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "authorizations.revoke",
    input: { id: g.id, expected_revision: 1 },
  });
  await assert.rejects(h.start({ authorization_id: g.id }), /授权/);
});

test("direct file action creates one durable Run with zero model requests", async (t) => {
  const h = await setup(t);
  const g = await grant(h);
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    agent_id: 1,
    goal: "Direct write",
    authorization_id: g.id,
    action: {
      name: "write_file",
      arguments: {
        path: "direct.txt",
        content: "zero model",
        expected_hash: "missing",
      },
    },
  };
  require("../contracts/execution.cjs").validate("agent.start", input);
  const op = {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "agent.start",
    input,
  };
  const accepted = await h.core.request("operations.execute", op);
  assert.equal(accepted.state, "committed");
  assert.deepEqual(await h.core.request("operations.execute", op), accepted);
  const d = await h.done(accepted.result.run.id);
  assert.equal(d.run.kind, "tool_action");
  assert.equal(d.run.state, "completed");
  assert.equal(h.server.requests.length, 0);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "direct.txt"), "utf8"),
    "zero model",
  );
});
test("revocation closes a queued direct action and direct actions reject model controls", async (t) => {
  const h = await setup(t, {
    plan: [
      { name: "run_command", arguments: { command: "Start-Sleep -Seconds 2" } },
    ],
  });
  const lock = await h.start();
  await h.approve(await h.approval(lock));
  await until(async () => (await h.call(lock)).state === "running");
  const g = await grant(h);
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    agent_id: 1,
    goal: "Queued write",
    authorization_id: g.id,
    action: {
      name: "write_file",
      arguments: {
        path: "revoked.txt",
        content: "forbidden",
        expected_hash: "missing",
      },
    },
  };
  const op = {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "agent.start",
    input,
  };
  const accepted = await h.core.request("operations.execute", op);
  assert.equal(accepted.state, "committed");
  const id = accepted.result.run.id;
  assert.equal((await h.get(id)).allowed_actions.steer.allowed, false);
  await assert.rejects(
    h.core.request("agent.steer", {
      id,
      client_input_id: crypto.randomUUID(),
      text: "change",
    }),
    /直接工具/,
  );
  await assert.rejects(h.core.request("agent.compact", { id }), /直接工具/);
  await assert.rejects(
    h.core.request("agent.start", {
      ...input,
      client_run_id: crypto.randomUUID(),
    }),
    /operations.execute/,
  );
  await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "authorizations.revoke",
    input: { id: g.id, expected_revision: 1 },
  });
  await h.done(id);
  await h.done(lock);
  assert.equal(fs.existsSync(path.join(h.workspace, "revoked.txt")), false);
  assert.equal((await h.core.request("agent.list", {})).items.length, 2);
});
test("internal completion rule dispatches one authorized Run and survives restart without replay", async (t) => {
  const h = await setup(t);
  const g = await grant(h);
  const start = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    agent_id: 1,
    goal: "Rule write",
    authorization_id: g.id,
    action: {
      name: "write_file",
      arguments: {
        path: "rule.txt",
        content: "event",
        expected_hash: "missing",
      },
    },
  };
  const saved = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "rules.save",
    input: {
      expected_revision: 0,
      rule: {
        name: "On completion",
        enabled: true,
        event: "run.completed",
        workspace_id: h.wid,
        source_run_id: null,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        start,
      },
    },
  });
  assert.equal(saved.state, "committed");
  const rule = saved.result;
  const source = await h.start();
  await h.done(source);
  await until(async () =>
    (await h.core.request("rules.history", { id: rule.id })).deliveries.some(
      (d) => d.state === "dispatched",
    ),
  );
  const history = await h.core.request("rules.history", { id: rule.id });
  const target = history.deliveries.find(
    (d) => d.state === "dispatched",
  ).run_id;
  await h.done(target);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "rule.txt"), "utf8"),
    "event",
  );
  const count = (await h.core.request("agent.list", {})).items.length;
  await h.core.stop();
  await h.core.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await h.core.request("agent.list", {})).items.length, count);
  assert.equal(
    (await h.core.request("rules.simulate", { id: rule.id, run_id: source }))
      .matched,
    true,
  );
});
test("Agent rule management requires its own scope and cannot adopt an unscoped rule", async (t) => {
  let definition;
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "manage_rule",
              arguments: {
                id: definition.id ?? "",
                expected_revision: definition.revision ?? "0",
                definition: JSON.stringify(definition.rule),
              },
            },
          ],
  });
  await h.core.request("memory.membership", {
    agent_id: 1,
    project: "A",
    action: "create",
  });
  const tool = await grant(h);
  const management = await grant(h, {
    purpose: "rule_management",
    operations: ["create_rule", "edit_rule", "toggle_rule"],
    project_ids: ["A"],
  });
  const rule = {
    name: "Managed",
    enabled: false,
    event: "run.completed",
    workspace_id: h.wid,
    source_run_id: null,
    expires_at: management.expires_at,
    start: {
      client_run_id: crypto.randomUUID(),
      agent_id: 1,
      workspace_id: h.wid,
      goal: "Managed read",
      authorization_id: tool.id,
      action: { name: "read_file", arguments: { path: "input.txt" } },
    },
  };
  definition = { rule };
  const run = await h.start({
    rule_management_authorization_id: management.id,
    project_ids: ["A"],
  });
  await h.done(run);
  assert.equal((await h.call(run)).state, "failed");
  assert.equal((await h.core.request("rules.list", {})).items.length, 0);
  definition = {
    rule: { ...rule, start: { ...rule.start, project_ids: ["A"] } },
  };
  const allowed = await h.start({
    rule_management_authorization_id: management.id,
    project_ids: ["A"],
  });
  await h.done(allowed);
  assert.equal((await h.call(allowed)).state, "succeeded");
  const saved = (
    await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "rules.save",
      input: { expected_revision: 0, rule },
    })
  ).result;
  definition = {
    id: saved.id,
    revision: "1",
    rule: { ...rule, start: { ...rule.start, project_ids: ["A"] } },
  };
  const denied = await h.start({
    rule_management_authorization_id: management.id,
    project_ids: ["A"],
  });
  await h.done(denied);
  assert.equal((await h.call(denied)).state, "failed");
  assert.equal(
    (await h.core.request("rules.get", { id: saved.id })).revision,
    1,
  );
});
test("a rule cannot impersonate another rule to borrow its bound grant", async (t) => {
  const h = await setup(t);
  const source = await h.start();
  await h.done(source);
  const otherRule = crypto.randomUUID();
  const tool = await grant(h, { rule_id: otherRule });
  const saved = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "rules.save",
    input: {
      expected_revision: 0,
      rule: {
        name: "Impersonation",
        enabled: true,
        event: "run.completed",
        workspace_id: h.wid,
        source_run_id: source,
        expires_at: tool.expires_at,
        start: {
          client_run_id: crypto.randomUUID(),
          workspace_id: h.wid,
          agent_id: 1,
          rule_id: otherRule,
          authorization_id: tool.id,
          goal: "Borrowed grant",
          action: { name: "read_file", arguments: { path: "input.txt" } },
        },
      },
    },
  });
  assert.equal(saved.state, "committed");
  require("../contracts/execution.cjs").validate(
    "rules.get",
    saved.result,
    true,
  );
  const simulation = await h.core.request("rules.simulate", {
    id: saved.result.id,
    run_id: source,
  });
  assert.equal(simulation.matched, true);
  assert.equal(simulation.executable, false);
});
