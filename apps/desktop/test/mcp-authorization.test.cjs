const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"),
  path = require("node:path");
const { setup, until, results } = require("./fixtures/hooks-fixture.cjs");
const { mcpServer } = require("./fixtures/mcp-agent-server.cjs");
const contract = require("../contracts/execution.cjs");

function startInput(h, authorization, operation) {
  return {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    agent_id: 1,
    goal: "Exact remote operation",
    authorization_id: authorization,
    action: { name: "call_mcp", arguments: operation },
  };
}

async function rpc(h, method, input = {}) {
  contract.validate(method, input);
  return contract.validate(method, await h.core.request(method, input), true);
}
function command(h, method, input) {
  return rpc(h, "operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
}
async function fixture(t, options = {}, agentOptions = {}) {
  const h = await setup(t, agentOptions),
    server = await mcpServer(options);
  t.after(() => server.close());
  const definition = {
    name: "Scoped remote service",
    transport: options.legacy ? "sse" : "http",
    location: "remote",
    url: server.url,
    enabled: true,
    agent_ids: [1],
    auth_mode: "none",
  };
  const service = await rpc(h, "mcp.save", {
    expected_revision: 0,
    definition,
  });
  const operation = {
    server_id: service.id,
    tool: "echo",
    arguments: { text: "authorized", count: 2 },
  };
  const grant = {
    name: "One exact remote operation",
    purpose: "mcp_call",
    agent_id: 1,
    engine_id: "native",
    workspace_id: h.wid,
    project_ids: [],
    read_roots: [],
    write_roots: [],
    operations: ["call_mcp"],
    network: "any",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    rule_id: null,
    mcp_calls: [{ ...operation, revision: service.revision }],
  };
  return { h, server, service, definition, operation, grant };
}

for (const transport of ["http", "sse"])
  test(`an exact ${transport} MCP action executes through the ledger without a model or repeated effects`, async (t) => {
    const { h, server, service, operation, grant } = await fixture(t, {
      legacy: transport === "sse",
    });
    const saved = await command(h, "authorizations.save", {
      expected_revision: 0,
      grant,
    });
    assert.equal(saved.state, "committed", JSON.stringify(saved.error));
    const input = {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      agent_id: 1,
      goal: "Exact remote operation",
      authorization_id: saved.result.id,
      action: { name: "call_mcp", arguments: operation },
    };
    const receipt = await command(h, "agent.start", input);
    assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
    const id = receipt.result.run.id;
    const end = await h.done(id);
    assert.equal(end.run.state, "completed", JSON.stringify(end.run.error));
    const inv = await h.call(id);
    assert.equal(inv.state, "succeeded");
    assert.equal(inv.permission_plan.grant_id, saved.result.id);
    assert.equal(inv.permission_plan.mcp.server_id, service.id);
    assert.equal(inv.permission_plan.mcp.revision, service.revision);
    assert.equal(inv.permission_plan.mcp.auth_binding, "configured");
    assert.match(inv.permission_plan.mcp_schema_sha256, /^[a-f0-9]{64}$/);
    assert.match(inv.permission_plan.mcp_directory_sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      server.calls.filter((c) => c.method === "tools/call").length,
      1,
    );
    assert.equal(h.server.requests.length, 0);
    await command(h, "agent.start", input);
    await h.core.stop();
    await h.core.start();
    assert.equal((await h.get(id)).run.state, "completed");
    assert.equal(
      server.calls.filter((c) => c.method === "tools/call").length,
      1,
    );
  });

test("remote arguments named path retain their service JSON meaning", async (t) => {
  const { h, server, operation, grant } = await fixture(t, {
    schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        count: { type: "integer" },
        path: { type: "object" },
      },
      required: ["text", "path"],
      additionalProperties: false,
    },
  });
  operation.arguments.path = { resource: "remote-project" };
  grant.mcp_calls[0].arguments = operation.arguments;
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  assert.equal(saved.state, "committed");
  const started = await command(h, "agent.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    goal: "Structured remote resource",
    authorization_id: saved.result.id,
    action: { name: "call_mcp", arguments: operation },
  });
  assert.equal(started.state, "committed");
  assert.equal((await h.done(started.result.run.id)).run.state, "completed");
  assert.deepEqual(
    server.calls.find((c) => c.method === "tools/call").params.arguments.path,
    operation.arguments.path,
  );
});

test("changed MCP arguments, tools and services are denied before any connection", async (t) => {
  const { h, server, operation, grant } = await fixture(t);
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  for (const candidate of [
    { ...operation, arguments: { text: "different", count: 2 } },
    { ...operation, tool: "different" },
    { ...operation, server_id: crypto.randomUUID() },
  ]) {
    const started = await command(
      h,
      "agent.start",
      startInput(h, saved.result.id, candidate),
    );
    assert.equal(started.state, "rejected");
  }
  assert.equal(server.calls.length, 0);
  for (const replacement of [
    { network: "none" },
    { read_roots: [h.workspace] },
    { operations: ["write_file"] },
  ]) {
    assert.equal(
      (
        await command(h, "authorizations.save", {
          expected_revision: 0,
          grant: { ...grant, ...replacement },
        })
      ).state,
      "rejected",
    );
  }
});

test("only bound HTTP services are discovered and their configuration changes invalidate authority", async (t) => {
  const { h, server, service, definition, operation, grant } = await fixture(t);
  const other = await mcpServer();
  t.after(() => other.close());
  await rpc(h, "mcp.save", {
    expected_revision: 0,
    definition: { ...definition, name: "Unbound", url: other.url },
  });
  const marker = path.join(h.workspace, "unbound-started.txt");
  const native = await rpc(h, "mcp.save", {
    expected_revision: 0,
    definition: {
      name: "Unbound native service",
      transport: "stdio",
      location: "windows-host",
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'unexpected initialization')",
        marker,
      ],
      cwd: h.workspace,
      enabled: true,
      agent_ids: [1],
    },
  });
  const nativeGrant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      ...grant,
      mcp_calls: [
        { ...operation, server_id: native.id, revision: native.revision },
      ],
    },
  });
  assert.equal(nativeGrant.state, "rejected");
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  const started = await command(
    h,
    "agent.start",
    startInput(h, saved.result.id, operation),
  );
  assert.equal((await h.done(started.result.run.id)).run.state, "completed");
  assert.equal(other.calls.length, 0);
  assert.equal(fs.existsSync(marker), false);
  await rpc(h, "mcp.save", {
    id: service.id,
    expected_revision: service.revision,
    definition: { ...definition, enabled: false },
  });
  assert.equal(
    (await command(h, "agent.start", startInput(h, saved.result.id, operation)))
      .state,
    "rejected",
  );
  assert.equal(
    server.calls.filter((call) => call.method === "tools/call").length,
    1,
  );
});

for (const transport of ["http", "sse"])
  test(`revocation during ${transport} MCP preflight prevents tools/call at the Ready gate`, async (t) => {
    let listCount = 0,
      arrived = false,
      release;
    const gate = new Promise((resolve) => (release = resolve));
    const { h, server, operation, grant } = await fixture(t, {
      legacy: transport === "sse",
      beforeResponse: async (call) => {
        if (call.method === "tools/list" && ++listCount === 2) {
          arrived = true;
          await gate;
        }
      },
    });
    t.after(() => release());
    const saved = await command(h, "authorizations.save", {
      expected_revision: 0,
      grant,
    });
    const started = await command(
      h,
      "agent.start",
      startInput(h, saved.result.id, operation),
    );
    await until(() => arrived);
    await command(h, "authorizations.revoke", {
      id: saved.result.id,
      expected_revision: 1,
    });
    release();
    assert.notEqual(
      (await h.done(started.result.run.id)).run.state,
      "completed",
    );
    assert.equal(
      server.calls.filter((call) => call.method === "tools/call").length,
      0,
    );
  });

test("a changed MCP schema prevents the fixed operation from being dispatched", async (t) => {
  let listCount = 0,
    server;
  const f = await fixture(t, {
    beforeResponse: async (call) => {
      if (call.method === "tools/list" && ++listCount === 2)
        server.state.schema = {
          type: "object",
          properties: { changed: { type: "string" } },
          required: ["changed"],
          additionalProperties: false,
        };
    },
  });
  server = f.server;
  const { h, operation, grant } = f;
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  const started = await command(
    h,
    "agent.start",
    startInput(h, saved.result.id, operation),
  );
  assert.equal((await h.done(started.result.run.id)).run.state, "failed");
  assert.equal(
    server.calls.filter((call) => call.method === "tools/call").length,
    0,
  );
  assert.equal(
    (await h.call(started.result.run.id)).result.not_dispatched,
    true,
  );
});

for (const transport of ["http", "sse"])
  test(`revocation after ${transport} dispatch retains an unknown outcome and never replays it on restart`, async (t) => {
    const { h, server, operation, grant } = await fixture(t, {
      hang: true,
      legacy: transport === "sse",
    });
    const saved = await command(h, "authorizations.save", {
      expected_revision: 0,
      grant,
    });
    const started = await command(
      h,
      "agent.start",
      startInput(h, saved.result.id, operation),
    );
    const id = started.result.run.id;
    await until(() =>
      server.calls.some((call) => call.method === "tools/call"),
    );
    await command(h, "authorizations.revoke", {
      id: saved.result.id,
      expected_revision: 1,
    });
    assert.equal((await h.done(id)).run.state, "interrupted");
    const inv = await h.call(id);
    assert.equal(inv.state, "indeterminate");
    await h.core.stop();
    await h.core.start();
    assert.equal((await h.get(id)).allowed_actions.resume.allowed, false);
    const reviewed = await command(h, "agent.reconcile", {
      id: inv.id,
      epoch: inv.epoch,
      source: "reviewed",
      note: "Remote operation inspected; retain outcome without retry",
    });
    assert.equal(reviewed.state, "committed");
    assert.equal(
      server.calls.filter((call) => call.method === "tools/call").length,
      1,
    );
  });

test("internal events dispatch exact MCP actions with zero model requests", async (t) => {
  const { h, server, operation, grant } = await fixture(t);
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  const actor = await rpc(h, "memory.agent.save", {
    name: "Event source",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  const sourceGrant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Event source read",
      purpose: "tool_call",
      engine_id: "native",
      agent_id: actor.id,
      workspace_id: h.wid,
      project_ids: [],
      operations: ["read_file"],
      read_roots: [h.workspace],
      write_roots: [],
      network: "none",
      expires_at: grant.expires_at,
      rule_id: null,
    },
  });
  assert.equal(sourceGrant.state, "committed");
  const sourceInput = () => ({
    client_run_id: crypto.randomUUID(),
    agent_id: actor.id,
    workspace_id: h.wid,
    goal: "Produce event",
    authorization_id: sourceGrant.result.id,
    action: { name: "read_file", arguments: { path: "input.txt" } },
  });
  const source = await command(h, "agent.start", sourceInput());
  await h.done(source.result.run.id);
  const rule = await command(h, "rules.save", {
    expected_revision: 0,
    rule: {
      name: "Event to remote operation",
      enabled: true,
      event: "run.completed",
      workspace_id: h.wid,
      expires_at: grant.expires_at,
      start: startInput(h, saved.result.id, operation),
    },
  });
  assert.equal(rule.state, "committed", JSON.stringify(rule.error));
  assert.equal(
    (
      await rpc(h, "rules.simulate", {
        id: rule.result.id,
        run_id: source.result.run.id,
      })
    ).executable,
    true,
  );
  const next = await command(h, "agent.start", sourceInput());
  await h.done(next.result.run.id);
  const delivery = await until(async () =>
    (await rpc(h, "rules.history", { id: rule.result.id })).deliveries.find(
      (item) => item.state === "dispatched",
    ),
  );
  assert.equal((await h.done(delivery.run_id)).run.state, "completed");
  assert.equal(h.server.requests.length, 0);
  assert.equal(
    server.calls.filter((call) => call.method === "tools/call").length,
    1,
  );
});

test("MCP grant identity survives OAuth refresh but a new login requires new authority", async (t) => {
  const { oauthServer } = require("./fixtures/oauth-server.cjs");
  const { h, service, definition, operation, grant } = await fixture(t);
  const oauth = await oauthServer({ mcp: true });
  t.after(async () => {
    try {
      await h.core.start();
      const auth = await rpc(h, "mcp.oauth.status", { id: service.id });
      await rpc(h, "mcp.oauth.disconnect", {
        id: service.id,
        auth_revision: auth.revision,
      });
      await until(
        async () =>
          (await rpc(h, "mcp.oauth.status", { id: service.id })).state !==
          "revoking",
      );
    } finally {
      await h.core.stop();
    }
  });
  t.after(() => oauth.close());
  const configured = await rpc(h, "mcp.save", {
    id: service.id,
    expected_revision: service.revision,
    definition: { ...definition, auth_mode: "oauth", url: oauth.resource },
  });
  grant.mcp_calls[0].revision = configured.revision;
  operation.arguments = { text: "authorized" };
  grant.mcp_calls[0].arguments = operation.arguments;
  async function login() {
    const auth = await rpc(h, "mcp.oauth.status", { id: service.id });
    await rpc(h, "mcp.oauth.begin", {
      id: service.id,
      expected_revision: configured.revision,
      auth_revision: auth.revision,
      client_id: "owned-client",
      scopes: ["files.read"],
    });
    const ready = await until(async () => {
      const auth = await rpc(h, "mcp.oauth.status", { id: service.id });
      return auth.authorization_url && auth;
    });
    await fetch(ready.authorization_url);
    return until(async () => {
      const auth = await rpc(h, "mcp.oauth.status", { id: service.id });
      return auth.state === "connected" && auth;
    });
  }
  const initial = await login();
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  assert.match(saved.result.mcp_calls[0].auth_binding, /^oauth:/);
  await rpc(h, "mcp.oauth.refresh", {
    id: service.id,
    auth_revision: initial.revision,
  });
  const refreshed = await until(async () => {
    const auth = await rpc(h, "mcp.oauth.status", { id: service.id });
    return auth.state === "connected" && auth;
  });
  assert.equal(refreshed.grant_id, initial.grant_id);
  const first = await command(
    h,
    "agent.start",
    startInput(h, saved.result.id, operation),
  );
  assert.equal((await h.done(first.result.run.id)).run.state, "completed");
  const current = await rpc(h, "mcp.oauth.status", { id: service.id });
  await rpc(h, "mcp.oauth.disconnect", {
    id: service.id,
    auth_revision: current.revision,
  });
  await until(
    async () =>
      (await rpc(h, "mcp.oauth.status", { id: service.id })).state !==
      "revoking",
  );
  const next = await login();
  assert.notEqual(next.grant_id, initial.grant_id);
  assert.equal(
    (await command(h, "agent.start", startInput(h, saved.result.id, operation)))
      .state,
    "rejected",
  );
  assert.equal(
    oauth.calls.filter(
      (call) =>
        call.path === "/mcp" && JSON.parse(call.body).method === "tools/call",
    ).length,
    1,
  );
});

test("a scoped Agent sees only granted remote tools and automatically executes matching parameters", async (t) => {
  let advertised = [];
  const schema = {
    type: "object",
    properties: { text: { type: "string" }, count: { type: "integer" } },
    required: ["text"],
    additionalProperties: false,
  };
  const { h, server, grant } = await fixture(
    t,
    {
      tools: [
        { name: "echo", inputSchema: schema },
        { name: "ungranted", inputSchema: schema },
      ],
    },
    {
      plan: ({ body }) => {
        if (results(body).length) return [];
        advertised = (body.tools ?? [])
          .map((tool) => tool.function ?? tool)
          .filter((tool) => tool.name.startsWith("mcp_"));
        return advertised
          .filter((tool) => tool.description.includes(" / echo."))
          .map((tool) => ({
            name: tool.name,
            arguments: { text: "authorized", count: 2 },
          }));
      },
    },
  );
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  const id = await h.start({ authorization_id: saved.result.id });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal(advertised.length, 1);
  assert.equal((await h.call(id)).approval, true);
  assert.equal(
    server.calls.filter((call) => call.method === "tools/call").length,
    1,
  );
});

test("malformed model calls to the direct MCP action do not fault Core", async (t) => {
  const { h, server, grant } = await fixture(
    t,
    {},
    {
      plan: ({ body }) =>
        results(body).length
          ? []
          : [{ name: "call_mcp", arguments: { invalid: true } }],
    },
  );
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  const id = await h.start({ authorization_id: saved.result.id });
  await h.done(id);
  assert.equal(h.core.state, "ready");
  assert.equal((await h.call(id)).state, "failed");
  assert.equal(
    server.calls.filter((call) => call.method === "tools/call").length,
    0,
  );
});

test("an MCP service grant composes a bound command Hook on direct actions and model Agents", async (t) => {
  const { h, server, operation, grant } = await fixture(
    t,
    { legacy: true },
    {
      plan: ({ body }) =>
        results(body).length
          ? []
          : (body.tools ?? [])
              .map((tool) => tool.function ?? tool)
              .filter(
                (tool) =>
                  tool.name.startsWith("mcp_") &&
                  tool.description.includes(" / echo."),
              )
              .map((tool) => ({
                name: tool.name,
                arguments: { text: "authorized", count: 2 },
              })),
    },
  );
  const marker = path.join(h.directory, "composed-hook-effect");
  const rule = await h.save({
    event: "preToolUse",
    command: `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}','approved'); '{}'`,
  });
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      ...grant,
      command_hooks: [
        { id: rule.id, revision: rule.revision, host_access: "full_host" },
      ],
    },
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  const direct = await command(
    h,
    "agent.start",
    startInput(h, saved.result.id, operation),
  );
  assert.equal(direct.state, "committed", JSON.stringify(direct.error));
  assert.equal((await h.done(direct.result.run.id)).run.state, "completed");
  assert.equal(h.server.requests.length, 0);
  assert.equal(
    server.calls.filter((call) => call.method === "tools/call").length,
    1,
  );
  assert.equal(
    (await rpc(h, "hooks.calls", { run_id: direct.result.run.id })).items[0]
      .permission_plan.grant_id,
    saved.result.id,
  );
  const id = await h.start({ authorization_id: saved.result.id });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal(fs.readFileSync(marker, "utf8"), "approved");
  assert.equal(
    server.calls.filter((call) => call.method === "tools/call").length,
    2,
  );
  const calls = await rpc(h, "hooks.calls", { run_id: id });
  assert.equal(calls.items[0].permission_plan.grant_id, saved.result.id);
});

test("expiry during a dispatched remote operation retains its unknown effect", async (t) => {
  const { h, server, operation, grant } = await fixture(t, { hang: true });
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      ...grant,
      expires_at: Math.floor(Date.now() / 1000) + 4,
    },
  });
  const started = await command(
    h,
    "agent.start",
    startInput(h, saved.result.id, operation),
  );
  assert.equal(started.state, "committed");
  await until(() => server.calls.some((call) => call.method === "tools/call"));
  const id = started.result.run.id;
  assert.equal((await h.done(id)).run.state, "interrupted");
  assert.equal((await h.call(id)).state, "indeterminate");
  assert.equal(
    server.calls.filter((call) => call.method === "tools/call").length,
    1,
  );
});
