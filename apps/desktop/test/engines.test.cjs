const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./fixtures/hooks-fixture.cjs");

test("Core distinguishes installed managed adapters from account and per-grant permission evidence", async (t) => {
  const h = await setup(t);
  const engines = await h.core.request("engines.list", {});
  assert.deepEqual(
    engines.map((engine) => engine.id),
    ["claude", "codex", "pi", "opencode"],
  );
  const inventory = require("../../../docs/implementation/TROOP_GUGU_CLI_INVENTORY.json");
  assert.deepEqual(
    engines.map((engine) => engine.id),
    inventory.selected_ids,
  );
  for (const engine of engines) {
    assert.equal(typeof engine.installed, "boolean");
    assert.equal(engine.execution_available, engine.installed);
    assert.equal(engine.permissions, "unverified");
    assert.equal(engine.model_access, "unverified");
    assert.ok(engine.required_action);
    if (engine.installed) assert.ok(engine.launcher);
  }
  const native = await h.core.request("engines.capabilities", {});
  assert.equal(native.engine_id, "native");
  assert.equal(native.version, "native-files-v1");
  await assert.rejects(
    h.core.request("engines.list", { execute: true }),
    /参数/,
  );
});

for (const engine of ["copilot", "grok", "oh-my-pi"])
  test(`${engine} is outside the current CLI scope at start, preview and rule save`, async (t) => {
    const h = await setup(t);
    const input = {
      client_run_id: require("node:crypto").randomUUID(),
      workspace_id: h.wid,
      engine_id: engine,
      authorization_id: "historical-grant",
      goal: "must stay blocked",
    };
    const execute = (method, input) =>
      h.core.request("operations.execute", {
        operation_id: require("node:crypto").randomUUID(),
        instance_id: h.core.snapshot().storage_instance,
        method,
        input,
      });
    const historical = await execute("authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "Historical CLI grant",
        purpose: "cli_start",
        agent_id: 1,
        engine_id: engine,
        workspace_id: h.wid,
        project_ids: [],
        read_roots: [h.workspace],
        write_roots: [h.workspace],
        operations: ["start"],
        network: "none",
        expires_at: Math.floor(Date.now() / 1000) + 300,
        rule_id: null,
      },
    });
    assert.equal(
      historical.state,
      "committed",
      JSON.stringify(historical.error),
    );
    input.authorization_id = historical.result.id;
    const record = await h.core.request("authorizations.get", {
      id: historical.result.id,
    });
    assert.equal(record.engine_id, engine);
    const started = await execute("cli.start", input);
    assert.equal(started.state, "rejected");
    assert.match(JSON.stringify(started.error), /当前仅接入/);
    await assert.rejects(h.core.request("cli.preview", input), /当前仅接入/);
    const saved = await execute("rules.save", {
      expected_revision: 0,
      rule: {
        name: "Retired CLI rule",
        enabled: true,
        event: "run.completed",
        workspace_id: h.wid,
        source_run_id: null,
        expires_at: Math.floor(Date.now() / 1000) + 300,
        start: input,
      },
    });
    assert.equal(saved.state, "rejected");
    assert.match(JSON.stringify(saved.error), /当前仅接入/);
    assert.deepEqual((await h.core.request("agent.list", {})).items, []);
    const revoked = await execute("authorizations.revoke", {
      id: record.id,
      expected_revision: record.revision,
    });
    assert.equal(revoked.state, "committed");
    assert.equal(revoked.result.revoked, true);
  });
