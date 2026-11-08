const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");
const command = async (h, method, input, id = crypto.randomUUID()) => {
  const receipt = await h.core.request("operations.execute", {
    operation_id: id,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
  if (receipt.state !== "committed")
    throw Error(receipt.error?.message ?? JSON.stringify(receipt));
  return receipt;
};
async function fixture(t, network = "none", mode = "normal") {
  let h, service;
  // Register before setup's Core shutdown so only this service's credentials are removed.
  t.after(async () => {
    if (h?.core.child && service)
      await h.core.request("mcp.remove", {
        id: service.id,
        expected_revision: service.revision,
      });
  });
  h = await setup(t);
  const readonly = path.join(h.directory, "readonly");
  fs.mkdirSync(readonly);
  fs.writeFileSync(path.join(readonly, "input.txt"), "readonly");
  const outside = path.join(h.directory, "outside.txt");
  fs.writeFileSync(outside, "original");
  const script = path.join(h.workspace, "原生 peer.cjs");
  fs.copyFileSync(path.join(__dirname, "fixtures/mcp-sandbox.cjs"), script);
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.end("TROOP_MCP_NETWORK");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const token = `TROOP_MCP_ENV_${crypto.randomUUID()}`;
  const argument = 'spaces "quoted" trailing\\';
  service = await h.core.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "Scoped stdio",
      transport: "stdio",
      location: "windows-host",
      enabled: true,
      command: mode === "powershell"
        ? path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")
        : process.execPath,
      args: mode === "powershell" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(h.workspace, "peer.ps1")] : [
        script,
        mode,
        h.workspace,
        readonly,
        outside,
        `http://127.0.0.1:${server.address().port}/`,
        argument,
      ],
      cwd: h.workspace,
      env_keys: ["TROOP_SDK_TEST_ENV"],
      agent_ids: [1],
      startup_timeout_seconds: 20,
    },
    secrets: { "env:TROOP_SDK_TEST_ENV": token },
  });
  const operation = {
    server_id: service.id,
    tool: "echo",
    arguments: { text: "authorized" },
  };
  const grantInput = {
    name: "Scoped stdio grant",
    purpose: "mcp_call",
    agent_id: 1,
    engine_id: "native",
    workspace_id: h.wid,
    project_ids: [],
    read_roots: [h.workspace, readonly],
    write_roots: [h.workspace],
    operations: ["call_mcp"],
    network,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    rule_id: null,
    mcp_calls: [
      { ...operation, revision: service.revision, host_access: "sandbox" },
    ],
  };
  if (mode === "powershell")
    fs.copyFileSync(path.join(__dirname, "fixtures/mcp-sandbox.ps1"), path.join(h.workspace, "peer.ps1"));
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: grantInput,
  });
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    agent_id: 1,
    goal: "Scoped native MCP operation",
    authorization_id: saved.result.id,
    action: { name: "call_mcp", arguments: operation },
  };
  return {
    h,
    service,
    grant: saved.result,
    grantInput,
    input,
    token,
    argument,
    outside,
    readonly,
    requests: () => requests,
  };
}

test("scoped system stdio and a scoped command Hook compose without metadata masking the Windows runtime", async (t) => {
  const f = await fixture(t, "none", "powershell");
  const hook = await f.h.save({
    event: "preToolUse",
    timeout: 15,
    command: "[IO.File]::WriteAllText('combined-hook.txt','contained'); '{}'",
  });
  const updated = await command(f.h, "authorizations.save", {
    id: f.grant.id,
    expected_revision: f.grant.revision,
    grant: {
      ...f.grantInput,
      shell: {},
      command_hooks: [{ id: hook.id, revision: hook.revision, host_access: "sandbox" }],
    },
  });
  assert.equal(updated.result.revision, 2);
  const receipt = await command(f.h, "agent.start", f.input);
  const id = receipt.result.run.id;
  assert.equal((await f.h.done(id)).run.state, "completed");
  const invocation = await f.h.call(id);
  assert.equal(invocation.result.value.content[0].text, "TROOP_CONTAINED_POWERSHELL");
  assert.equal(fs.readFileSync(path.join(f.h.workspace, "combined-hook.txt"), "utf8"), "contained");
  const calls = (await f.h.calls(id)).items;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].permission_plan.host_access, "sandbox");
  assert.equal(f.h.server.requests.length, 0);
});

for (const network of ["none", "any"])
  test(`scoped stdio ${network} enforces initialization and call boundaries with in-memory credentials`, async (t) => {
    const f = await fixture(t, network);
    const operation = crypto.randomUUID();
    const receipt = await command(f.h, "agent.start", f.input, operation);
    assert.deepEqual(
      await command(f.h, "agent.start", f.input, operation),
      receipt,
    );
    const id = receipt.result.run.id;
    assert.equal((await f.h.done(id)).run.state, "completed");
    const inv = await f.h.call(id);
    const content = inv.result.value.content.find(
      (value) => value.type === "text",
    ).text;
    const value = JSON.parse(content);
    assert.deepEqual(value.audit, {
      readonly: "readonly",
      outside_write: false,
      readonly_write: false,
      outside_read: false,
      network: network === "any",
    });
    assert.equal(value.argument, f.argument);
    assert.equal(
      value.env_sha256,
      crypto.createHash("sha256").update(f.token).digest("hex"),
    );
    assert.equal(value.secret_in_arguments, false);
    assert.equal(f.requests(), network === "any" ? 1 : 0);
    assert.equal(fs.readFileSync(f.outside, "utf8"), "original");
    assert.equal(fs.existsSync(path.join(f.readonly, "bad.txt")), false);
    assert.equal(
      fs.readFileSync(path.join(f.h.workspace, "initializations"), "utf8"),
      "start\n",
    );
    assert.equal(
      fs
        .readFileSync(path.join(f.h.workspace, "calls"), "utf8")
        .trim()
        .split("\n").length,
      1,
    );
    const connections = await f.h.core.request("agent.mcp-sessions", {
      run_id: id,
    });
    contract.validate("agent.mcp-sessions", connections, true);
    assert.equal(
      connections.items[0].startup_authorization.host_access,
      "sandbox",
    );
    assert.equal(
      connections.items[0].startup_authorization.sandbox.network,
      network,
    );
    assert.equal(f.h.server.requests.length, 0);
  });

test("scoped stdio failed initialization keeps its sandboxed effect and connection identity until reconciliation", async (t) => {
  const f = await fixture(t, "none", "init-error");
  const started = await command(f.h, "agent.start", f.input);
  const run = started.result.run.id;
  assert.equal((await f.h.done(run)).run.state, "interrupted");
  const connection = (
    await f.h.core.request("agent.mcp-sessions", { run_id: run })
  ).items[0];
  assert.equal(connection.state, "indeterminate");
  assert.equal(connection.stopped, true);
  await f.h.core.stop();
  await f.h.core.start();
  assert.equal((await f.h.get(run)).allowed_actions.resume.allowed, false);
  await command(f.h, "agent.mcp-reconcile", {
    id: connection.id,
    stopped: true,
    note: "Temporary initialization effects inspected",
  });
  assert.equal(
    fs.readFileSync(path.join(f.h.workspace, "initializations"), "utf8"),
    "start\n",
  );
  assert.equal(f.requests(), 0);
});

test("scoped stdio in-flight revocation stops the admitted process and restart retains the original call", async (t) => {
  const f = await fixture(t, "none", "hang");
  const started = await command(f.h, "agent.start", f.input);
  const run = started.result.run.id;
  await until(() => fs.existsSync(path.join(f.h.workspace, "calls")));
  await until(() => fs.existsSync(path.join(f.h.workspace, "heartbeat")));
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(f.h.workspace, "child-boundary.json"), "utf8"),
    ),
    { outside_write: false },
  );
  assert.equal(fs.readFileSync(f.outside, "utf8"), "original");
  const original = await f.h.call(run);
  await command(f.h, "authorizations.revoke", {
    id: f.grant.id,
    expected_revision: 1,
  });
  await f.h.done(run);
  const heartbeat = fs.readFileSync(
    path.join(f.h.workspace, "heartbeat"),
    "utf8",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    fs.readFileSync(path.join(f.h.workspace, "heartbeat"), "utf8"),
    heartbeat,
  );
  await f.h.core.stop();
  await f.h.core.start();
  const inv = await f.h.call(run);
  assert.equal(inv.id, original.id);
  assert.equal(inv.stopped, true);
  assert.equal(fs.existsSync(path.join(f.h.workspace, "late.txt")), false);
  assert.equal(
    fs
      .readFileSync(path.join(f.h.workspace, "calls"), "utf8")
      .trim()
      .split("\n").length,
    1,
  );
});

test("one stdio service cannot mix scoped and full-host startup authority in the same grant", async (t) => {
  const f = await fixture(t, "any");
  const binding = f.grantInput.mcp_calls[0];
  await assert.rejects(
    command(f.h, "authorizations.save", {
      expected_revision: 0,
      grant: {
        ...f.grantInput,
        read_roots: [],
        write_roots: [],
        mcp_calls: [
          binding,
          {
            ...binding,
            host_access: "full_host",
            arguments: { text: "other" },
          },
        ],
      },
    }),
    /模式/,
  );
  assert.equal(
    fs.existsSync(path.join(f.h.workspace, "initializations")),
    false,
  );
});

test("scoped stdio rejects hardlinked write input before native initialization", async (t) => {
  const f = await fixture(t);
  fs.linkSync(f.outside, path.join(f.h.workspace, "alias.txt"));
  const started = await command(f.h, "agent.start", f.input);
  const run = started.result.run.id;
  assert.notEqual((await f.h.done(run)).run.state, "completed");
  assert.equal(
    fs.existsSync(path.join(f.h.workspace, "initializations")),
    false,
  );
  assert.equal(fs.readFileSync(f.outside, "utf8"), "original");
  assert.equal(
    (await f.h.core.request("agent.mcp-sessions", { run_id: run })).items[0]
      .stopped,
    true,
  );
});
