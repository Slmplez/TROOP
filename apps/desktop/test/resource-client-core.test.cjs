const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const contract = require("../contracts/execution.cjs");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");
const operation = (h, method, input) => ({
  operation_id: crypto.randomUUID(),
  instance_id: h.core.snapshot().storage_instance,
  method,
  input,
});
async function request(h, method, input = {}) {
  contract.validate(method, input);
  const value = await h.core.request(method, input);
  return contract.validate(method, value, true);
}
async function execute(h, op) {
  const receipt = await request(h, "operations.execute", op);
  if (receipt.state === "committed")
    contract.validate(op.method, receipt.result, true);
  return receipt;
}
test("typed resource surface accepts actual Core records and atomic resource commands replay once", async (t) => {
  const h = await setup(t);
  for (const [m, p] of [
    ["provider.list", {}],
    ["workspace.list", {}],
    ["memory.projects", { agent_id: 1 }],
    ["memory.jobs", { agent_id: 1 }],
    ["memory.list", { agent_id: 1 }],
    ["hooks.list", {}],
    ["skills.list", {}],
    ["mcp.list", {}],
  ])
    await request(h, m, p);
  const mem = operation(h, "memory.write", {
    agent_id: 1,
    scope: "agent",
    tier: "note",
    content: "Contract fixture memory",
  });
  const saved = await execute(h, mem);
  assert.equal(saved.state, "committed");
  assert.deepEqual(await execute(h, mem), saved);
  const memories = await request(h, "memory.list", { agent_id: 1 });
  assert.equal(memories.items.length, 1);
  const record = memories.items[0];
  assert.equal(
    (
      await execute(
        h,
        operation(h, "memory.edit", {
          agent_id: 1,
          id: record.id,
          expected_revision: record.revision,
          content: "Changed once",
        }),
      )
    ).state,
    "committed",
  );
  const skill = path.join(h.directory, "skill");
  fs.mkdirSync(skill);
  fs.writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\nname: Fixture skill\ndescription: Description\n---\nDo a careful review.",
  );
  const source = {
    path: skill,
    id: "fixture-skill",
    mode: "copy",
    source_kind: "local",
  };
  const preview = await request(h, "skills.preview", source);
  const op = operation(h, "skills.import", {
    source,
    preview_hash: preview.preview_hash,
    expected_revision: 0,
  });
  const imported = await execute(h, op);
  assert.equal(imported.state, "committed");
  assert.deepEqual(await execute(h, op), imported);
  await request(h, "skills.get", { id: "fixture-skill" });
  assert.equal(
    (await request(h, "skills.versions", { id: "fixture-skill" })).items.length,
    1,
  );
  const hook = await execute(
    h,
    operation(h, "hooks.save", {
      name: "Typed Hook",
      event: "preToolUse",
      kind: "command",
      location: "windows-host",
      enabled: false,
      command: "Write-Output '{}'",
      expected_revision: 0,
    }),
  );
  assert.equal(hook.state, "committed");
  await request(h, "hooks.definition", { id: hook.result.id });
  const mcp = await execute(
    h,
    operation(h, "mcp.save", {
      expected_revision: 0,
      definition: {
        name: "Typed MCP",
        transport: "http",
        location: "remote",
        url: "http://127.0.0.1:1337/mcp",
        enabled: false,
      },
    }),
  );
  assert.equal(mcp.state, "committed");
  await request(h, "mcp.list", {});
  await request(h, "mcp.get", { id: mcp.result.id });
  await request(h, "mcp.revisions", { id: mcp.result.id });
  await request(h, "mcp.oauth.status", { id: mcp.result.id });
});
test("atomic resource receipt failure rolls back memory; external receipt failure is quarantined and never replays credentials or configuration", async (t) => {
  const h = await setup(t);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER receipt_fault BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await assert.rejects(
    execute(
      h,
      operation(h, "memory.write", {
        agent_id: 1,
        scope: "agent",
        tier: "note",
        content: "Must roll back",
      }),
    ),
  );
  assert.equal(
    (await request(h, "memory.list", { agent_id: 1 })).items.length,
    0,
  );
  const op = operation(h, "provider.save", {
    config: { ...h.provider.config, name: "Unconfirmed external save" },
    api_key: "fixture-resource-secret",
    expected_revision: 0,
  });
  await assert.rejects(execute(h, op));
  db.exec("DROP TRIGGER receipt_fault");
  const list = await request(h, "provider.list");
  const created = list.find(
    (p) => p.config.name === "Unconfirmed external save",
  );
  assert.ok(created);
  try {
    await h.core.stop();
    await h.core.start();
    const replay = await execute(h, op);
    assert.equal(replay.state, "needs_reconciliation");
    assert.equal((await request(h, "provider.list")).length, list.length);
    const stored = db
      .prepare("SELECT * FROM operations WHERE operation_id=?")
      .get(op.operation_id);
    assert.ok(!JSON.stringify(stored).includes("fixture-resource-secret"));
  } finally {
    await h.core.request("provider.remove", { id: created.id });
  }
});
test("backend action projections and invocation follow reject stale approval after cancellation", async (t) => {
  const h = await setup(t, {
    plan: () => [
      {
        name: "write_file",
        arguments: {
          path: "permission.txt",
          content: "no",
          expected_hash: "missing",
        },
      },
    ],
  });
  const id = await h.start();
  const snapshot = await until(async () => {
    const s = await h.get(id);
    return s.invocations.length && s;
  });
  const inv = snapshot.invocations[0];
  assert.equal(inv.allowed_actions.approve.allowed, true);
  assert.equal(snapshot.allowed_actions.stop.allowed, true);
  const base = await request(h, "agent.follow", {
    resource: "invocation",
    id: inv.id,
    cursor: null,
  });
  assert.equal(base.snapshot.value.allowed_actions.approve.allowed, true);
  await h.core.request("agent.cancel", { id });
  let next = await request(h, "agent.follow", {
    resource: "invocation",
    id: inv.id,
    cursor: base.cursor,
  });
  while (next.has_more)
    next = await request(h, "agent.follow", {
      resource: "invocation",
      id: inv.id,
      cursor: next.cursor,
    });
  assert.equal(next.snapshot.value.allowed_actions.approve.allowed, false);
  const late = await execute(
    h,
    operation(h, "agent.approve", {
      id: inv.id,
      epoch: inv.epoch,
      approved: true,
    }),
  );
  assert.equal(late.state, "rejected");
  assert.equal(fs.existsSync(path.join(h.workspace, "permission.txt")), false);
});
