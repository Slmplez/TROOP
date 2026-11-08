const { test } = require("node:test");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const fs = require("node:fs"),
  path = require("node:path");
const {
  setup,
  until,
  sleep,
  results,
  quote,
} = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");
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
async function nativeFixture(t, mode = "admitted", program = process.execPath) {
  const h = await setup(t);
  if (typeof program === "function") program = program(h);
  const definition = {
    name: "Explicit native MCP",
    transport: "stdio",
    location: "windows-host",
    enabled: true,
    command: program,
    args: [path.join(__dirname, "fixtures/mcp-stdio.cjs"), mode, h.workspace],
    cwd: h.workspace,
    agent_ids: [1],
  };
  const service = await rpc(h, "mcp.save", {
    expected_revision: 0,
    definition,
  });
  const operation = {
    server_id: service.id,
    tool: "echo",
    arguments: { text: "approved" },
  };
  const grant = {
    name: "Explicit host startup and fixed MCP operation",
    purpose: "mcp_call",
    engine_id: "native",
    agent_id: 1,
    workspace_id: h.wid,
    project_ids: [],
    read_roots: [],
    write_roots: [],
    network: "any",
    operations: ["call_mcp"],
    rule_id: null,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    mcp_calls: [
      { ...operation, revision: service.revision, host_access: "full_host" },
    ],
  };
  return { h, service, definition, operation, grant };
}
function startInput(h, grant, operation) {
  return {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    agent_id: 1,
    goal: "Pinned native MCP action",
    authorization_id: grant,
    action: { name: "call_mcp", arguments: operation },
  };
}
test("explicit full_host stdio authority pins its binary before initialization and does not replay", async (t) => {
  const { h, operation, grant } = await nativeFixture(t);
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  assert.match(saved.result.mcp_calls[0].program_sha256, /^[a-f0-9]{64}$/);
  const input = startInput(h, saved.result.id, operation);
  const started = await command(h, "agent.start", input);
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  const id = started.result.run.id;
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "initializations"), "utf8"),
    "start\n",
  );
  assert.equal(
    fs
      .readFileSync(path.join(h.workspace, "invocations"), "utf8")
      .trim()
      .split("\n").length,
    1,
  );
  const sessions = await rpc(h, "agent.mcp-sessions", { run_id: id });
  assert.equal(
    sessions.items[0].startup_authorization.grant_id,
    saved.result.id,
  );
  assert.equal(
    sessions.items[0].startup_authorization.program_sha256,
    saved.result.mcp_calls[0].program_sha256,
  );
  await command(h, "agent.start", input);
  await h.core.stop();
  await h.core.start();
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "initializations"), "utf8"),
    "start\n",
  );
  assert.equal(h.server.requests.length, 0);
});

test("stdio authority requires explicit host access and does not grant a network sandbox", async (t) => {
  const { h, grant } = await nativeFixture(t);
  for (const changed of [
    {
      ...grant,
      mcp_calls: grant.mcp_calls.map(({ host_access, ...binding }) => binding),
    },
    { ...grant, network: "none" },
    {
      ...grant,
      mcp_calls: grant.mcp_calls.map((binding) => ({
        ...binding,
        program_sha256: "0".repeat(64),
      })),
    },
  ]) {
    assert.equal(
      (
        await command(h, "authorizations.save", {
          expected_revision: 0,
          grant: changed,
        })
      ).state,
      "rejected",
    );
  }
  assert.equal(fs.existsSync(path.join(h.workspace, "initializations")), false);
  assert.equal(h.server.requests.length, 0);
});

test("a changed stdio program is blocked before its initialization side effect", async (t) => {
  const { h, definition, operation, grant } = await nativeFixture(
    t,
    "admitted",
    (h) => {
      const copy = path.join(h.workspace, "pinned-node.exe");
      fs.copyFileSync(process.execPath, copy);
      return copy;
    },
  );
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  fs.appendFileSync(definition.command, "changed-after-grant");
  const started = await command(
    h,
    "agent.start",
    startInput(h, saved.result.id, operation),
  );
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  const id = started.result.run.id;
  assert.notEqual((await h.done(id)).run.state, "completed");
  assert.equal(fs.existsSync(path.join(h.workspace, "initializations")), false);
  const sessions = await rpc(h, "agent.mcp-sessions", { run_id: id });
  assert.match(sessions.items[0].startup_error, /program identity changed/);
});

test("failed native initialization keeps its effects reviewable after the process has stopped", async (t) => {
  const { h, operation, grant } = await nativeFixture(t, "admitted-init-error");
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  const started = await command(
    h,
    "agent.start",
    startInput(h, saved.result.id, operation),
  );
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  const id = started.result.run.id;
  const ended = await h.done(id);
  assert.equal(ended.run.state, "interrupted");
  const connection = (await rpc(h, "agent.mcp-sessions", { run_id: id }))
    .items[0];
  assert.equal(connection.stopped, true);
  assert.equal(connection.state, "indeterminate");
  assert.equal(ended.mcp_unresolved, true);
  assert.equal(ended.allowed_actions.resume.allowed, false);
  await h.core.stop();
  await h.core.start();
  assert.equal((await h.get(id)).allowed_actions.resume.allowed, false);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "initializations"), "utf8"),
    "start\n",
  );
  const reviewed = await command(h, "agent.mcp-reconcile", {
    id: connection.id,
    stopped: true,
    note: "Initialization marker inspected and the native process has stopped",
  });
  assert.equal(reviewed.state, "committed", JSON.stringify(reviewed.error));
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "initializations"), "utf8"),
    "start\n",
  );
});

test("revoking stdio authority stops its child tree and keeps the dispatched outcome unreplayed", async (t) => {
  const { h, operation, grant } = await nativeFixture(t, "tree");
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  const started = await command(
    h,
    "agent.start",
    startInput(h, saved.result.id, operation),
  );
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  const id = started.result.run.id,
    heartbeat = path.join(h.workspace, "heartbeat");
  await until(async () => {
    const snapshot = await h.get(id);
    return (
      fs.existsSync(heartbeat) &&
      snapshot.invocations.some((row) => row.state === "running")
    );
  });
  await command(h, "authorizations.revoke", {
    id: saved.result.id,
    expected_revision: 1,
  });
  assert.equal((await h.done(id)).run.state, "failed");
  const inv = await h.call(id);
  assert.equal(inv.state, "indeterminate");
  assert.equal(inv.stopped, true);
  const size = fs.statSync(heartbeat).size;
  await sleep(200);
  assert.equal(fs.statSync(heartbeat).size, size);
  await h.core.stop();
  await h.core.start();
  assert.equal((await h.get(id)).allowed_actions.resume.allowed, false);
  const reconciled = await command(h, "agent.reconcile", {
    id: inv.id,
    epoch: inv.epoch,
    source: "reviewed",
    note: "Owned process tree stopped; preserve the dispatched result without replay",
  });
  assert.equal(reconciled.state, "committed", JSON.stringify(reconciled.error));
  await sleep(100);
  assert.equal(fs.statSync(heartbeat).size, size);
});

test("an explicitly bound full_host command Hook records its actual program and input", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [{ name: "read_file", arguments: { path: "input.txt" } }],
  });
  const marker = path.join(h.directory, "host-hook-effect.txt");
  const rule = await h.save({
    event: "preToolUse",
    command: `[IO.File]::WriteAllText(${quote(marker)},'approved'); '{}'`,
  });
  const grant = {
    name: "Pinned command Hook",
    purpose: "tool_call",
    agent_id: 1,
    engine_id: "native",
    workspace_id: h.wid,
    project_ids: [],
    read_roots: [h.workspace],
    write_roots: [],
    operations: ["read_file"],
    network: "any",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    rule_id: null,
    command_hooks: [
      { id: rule.id, revision: rule.revision, host_access: "full_host" },
    ],
  };
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  const id = await h.start({ authorization_id: saved.result.id });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal(fs.readFileSync(marker, "utf8"), "approved");
  const call = (await rpc(h, "hooks.calls", { run_id: id })).items[0];
  assert.equal(call.permission_plan.host_access, "full_host");
  assert.equal(call.permission_plan.grant_id, saved.result.id);
  assert.match(call.permission_plan.program_sha256, /^[a-f0-9]{64}$/);
  const detail = await rpc(h, "hooks.call", { id: call.id });
  assert.equal(
    detail.raw_result.value.program_sha256,
    call.permission_plan.program_sha256,
  );
});

for (const mutation of ["revoke", "disable", "revise", "expire"])
  test(`command Hook ${mutation} stops its native process and preserves uncertain effects`, async (t) => {
    const h = await setup(t),
      heartbeat = path.join(h.workspace, "command-heartbeat");
    const rule = await h.save({
      event: "sessionStart",
      timeout: 30,
      command: `while($true){[IO.File]::AppendAllText(${quote(heartbeat)},'x');Start-Sleep -Milliseconds 40}`,
    });
    const grant = {
      name: "Revocable native Hook",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [],
      operations: ["read_file"],
      network: "any",
      expires_at:
        Math.floor(Date.now() / 1000) + (mutation === "expire" ? 3 : 3600),
      rule_id: null,
      command_hooks: [
        { id: rule.id, revision: rule.revision, host_access: "full_host" },
      ],
    };
    for (const invalid of [
      { ...grant, network: "none" },
      {
        ...grant,
        command_hooks: [
          { id: rule.id, revision: rule.revision, host_access: "workspace" },
        ],
      },
      {
        ...grant,
        command_hooks: [
          { ...grant.command_hooks[0], command_sha256: "0".repeat(64) },
        ],
      },
    ])
      assert.equal(
        (
          await command(h, "authorizations.save", {
            expected_revision: 0,
            grant: invalid,
          })
        ).state,
        "rejected",
      );
    const saved = await command(h, "authorizations.save", {
      expected_revision: 0,
      grant,
    });
    assert.equal(saved.state, "committed", JSON.stringify(saved.error));
    const id = await h.start({ authorization_id: saved.result.id });
    await until(() => fs.existsSync(heartbeat));
    if (mutation === "revoke") {
      await command(h, "authorizations.revoke", {
        id: saved.result.id,
        expected_revision: 1,
      });
    } else if (mutation !== "expire") {
      await h.save({
        ...rule,
        expected_revision: rule.revision,
        ...(mutation === "disable" ? { enabled: false } : { command: "'{}'" }),
      });
    }
    assert.equal((await h.done(id)).run.state, "interrupted");
    const call = (await h.calls(id)).items[0];
    assert.equal(call.state, "indeterminate");
    assert.equal(call.stopped, true);
    const size = fs.statSync(heartbeat).size;
    await sleep(200);
    assert.equal(fs.statSync(heartbeat).size, size);
    await h.core.stop();
    await h.core.start();
    assert.equal((await h.get(id)).allowed_actions.resume.allowed, false);
    assert.equal((await h.calls(id)).total, 1);
  });

test("a full_host Hook's rewritten file operation still obeys the controlled tool grant", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [{ name: "read_file", arguments: { path: "allowed/input.txt" } }],
  });
  const allowed = path.join(h.workspace, "allowed");
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(allowed, "input.txt"), "allowed");
  fs.writeFileSync(
    path.join(h.workspace, "private.txt"),
    "private-684921-marker",
  );
  const rule = await h.save({
    command: quote(
      JSON.stringify({
        permission: "allow",
        updated_input: { path: "private.txt" },
      }),
    ),
  });
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Hook rewrite keeps file boundary",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [allowed],
      write_roots: [],
      operations: ["read_file"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      rule_id: null,
      command_hooks: [
        { id: rule.id, revision: rule.revision, host_access: "full_host" },
      ],
    },
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  const id = await h.start({ authorization_id: saved.result.id });
  await h.done(id);
  const inv = await h.call(id);
  assert.equal(inv.arguments.path, "private.txt");
  assert.equal(inv.state, "failed");
  assert.match(inv.result.error, /授权/);
  assert.ok(
    !JSON.stringify(h.server.requests).includes("private-684921-marker"),
  );
});
