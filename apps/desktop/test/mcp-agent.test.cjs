const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { DatabaseSync } = require("node:sqlite");
const {
    setup,
    until,
    results,
    hook,
    emit,
  } = require("./fixtures/hooks-fixture.cjs"),
  { mcpServer } = require("./fixtures/mcp-agent-server.cjs");
const modelTools = (body) => (body.tools ?? []).map((t) => t.function ?? t),
  plan = ({ body }) =>
    hook(body) || results(body).length
      ? []
      : modelTools(body)
          .filter((t) => t.name.startsWith("mcp_"))
          .slice(0, 1)
          .map((t) => ({
            name: t.name,
            arguments: { text: "hello", count: 2 },
          }));
async function approvePrepared(h, id) {
  const s = await h.get(id);
  if (s.run.waiting.includes("approval"))
    for (const i of s.invocations.filter(
      (i) => i.state === "prepared" && i.approval === null,
    ))
      await h.approve(await h.core.request("agent.invocation", { id: i.id }));
  return s;
}

test("MCP inherited children own separate sessions and parent stop reaches pending calls", async (t) => {
  const f = await fixture(
    t,
    { hang: true },
    {
      plan: ({ body }) => {
        if (hook(body) || results(body).length) return [];
        const goal =
          (body.messages ?? body.input).find(
            (m) => m.role === "user" && typeof m.content === "string",
          )?.content ?? "";
        return goal.includes("inherited-child")
          ? plan({ body })
          : [
              {
                name: "spawn_agent",
                arguments: { goal: "inherited-child", access: "inherit" },
              },
            ];
      },
    },
  );
  const id = await f.h.start();
  let child;
  await until(async () => {
    const root = await approvePrepared(f.h, id);
    child = root.tasks.find((t) => t.child_run_id)?.child_run_id;
    if (!child) return false;
    const state = await approvePrepared(f.h, child);
    return (
      state.invocations.some((i) => i.state === "running") &&
      f.server.calls.some((c) => c.method === "tools/call")
    );
  });
  const rootSessions = await f.h.core.request("agent.mcp-sessions", {
    run_id: id,
  });
  const childSessions = await f.h.core.request("agent.mcp-sessions", {
    run_id: child,
  });
  assert.equal(rootSessions.items.length, 1);
  assert.equal(childSessions.items.length, 1);
  assert.notEqual(rootSessions.items[0].id, childSessions.items[0].id);
  await f.h.core.request("agent.cancel", { id });
  await until(async () => {
    const states = await Promise.all([f.h.get(id), f.h.get(child)]);
    return states.every((s) =>
      ["cancelled", "interrupted"].includes(s.run.state),
    );
  });
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    1,
  );
});

test("MCP Core crash stops stdio descendants and requires session and invocation review before resume", async (t) => {
  const h = await setup(t, { plan });
  await h.core.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "Owned crash tree",
      transport: "stdio",
      location: "windows-host",
      command: process.execPath,
      args: [
        path.join(__dirname, "fixtures/mcp-stdio.cjs"),
        "tree",
        h.workspace,
      ],
      cwd: h.workspace,
      enabled: true,
      agent_ids: [1],
    },
  });
  const id = await h.start();
  await until(
    async () =>
      (await approvePrepared(h, id)).invocations.some(
        (i) => i.state === "running",
      ) && fs.existsSync(path.join(h.workspace, "heartbeat")),
  );
  const closed = require("node:events").once(h.core.child, "close");
  h.core.child.kill();
  await closed;
  const heartbeat = path.join(h.workspace, "heartbeat");
  await new Promise((r) => setTimeout(r, 150));
  const size = fs.statSync(heartbeat).size;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fs.statSync(heartbeat).size, size);
  await h.core.start();
  let state = await h.get(id);
  assert.equal(state.run.state, "interrupted");
  await assert.rejects(h.core.request("agent.resume", { id }));
  const inv = await h.core.request("agent.invocation", {
    id: state.invocations[0].id,
  });
  await h.core.request("agent.reconcile", {
    id: inv.id,
    epoch: inv.epoch,
    source: "reviewed",
    note: "Owned heartbeat and descendants inspected stopped",
  });
  await assert.rejects(h.core.request("agent.resume", { id }));
  const sessions = await h.core.request("agent.mcp-sessions", { run_id: id });
  assert.equal(sessions.items[0].state, "indeterminate");
  await h.core.request("agent.mcp-reconcile", {
    id: sessions.items[0].id,
    note: "Owned descendants inspected stopped",
    stopped: true,
  });
  await h.core.request("agent.resume", { id });
  state = await h.done(id);
  assert.equal(state.run.state, "completed");
  assert.equal(fs.statSync(heartbeat).size, size);
});

test("MCP pending and unknown calls retain the host queue until explicit review", async (t) => {
  const f = await fixture(t, { hang: true });
  await f.h.core.request("mcp.save", {
    id: f.service.id,
    expected_revision: 1,
    definition: { ...f.def, timeout_seconds: 1 },
  });
  const first = await f.h.start();
  await until(async () =>
    (await approvePrepared(f.h, first)).invocations.some(
      (i) => i.state === "running",
    ),
  );
  const second = await f.h.start();
  let end = await f.finish(first);
  assert.equal(end.run.state, "interrupted");
  assert.equal(
    f.server.calls.filter((c) => c.method === "initialize").length,
    1,
  );
  assert.ok((await f.h.get(second)).run.waiting.includes("host_resource"));
  f.server.state.hang = false;
  const inv = await f.h.core.request("agent.invocation", {
    id: end.invocations[0].id,
  });
  await f.h.core.request("agent.reconcile", {
    id: inv.id,
    epoch: inv.epoch,
    source: "reviewed",
    note: "Owned pending HTTP effect inspected stopped",
  });
  end = await f.finish(second);
  assert.equal(end.run.state, "completed");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    2,
  );
});

test("MCP new assignments cannot enter a started Run and invalid page offsets are bounded", async (t) => {
  const f = await fixture(t),
    id = await f.h.start();
  await f.h.approval(id);
  const other = await mcpServer();
  t.after(() => other.close());
  await f.h.core.request("mcp.save", {
    expected_revision: 0,
    definition: { ...f.def, url: other.url },
  });
  for (const method of ["agent.mcp-catalogue", "agent.mcp-sessions"])
    await assert.rejects(
      f.h.core.request(method, { run_id: id, offset: Number.MAX_SAFE_INTEGER }),
    );
  assert.equal((await f.finish(id)).run.state, "completed");
  assert.equal(other.calls.length, 0);
});
async function fixture(t, options = {}, model = {}) {
  const h = await setup(t, { plan, ...model }),
    server = await mcpServer(options);
  t.after(() => server.close());
  const def = {
    name: "Owned MCP server",
    transport: options.legacy ? "sse" : "http",
    location: "remote",
    url: server.url,
    enabled: true,
    agent_ids: [1],
  };
  const service = await h.core.request("mcp.save", {
    expected_revision: 0,
    definition: def,
  });
  const finish = async (id, approve = true) =>
    until(async () => {
      const s = await h.get(id);
      if (approve && s.run.waiting.includes("approval")) {
        const inv = s.invocations.find(
          (i) => i.state === "prepared" && i.approval === null,
        );
        if (inv)
          await h.approve(
            await h.core.request("agent.invocation", { id: inv.id }),
          );
      }
      return (
        ["completed", "failed", "interrupted", "cancelled"].includes(
          s.run.state,
        ) && s
      );
    }, 15000);
  return { h, server, service, def, finish };
}
for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(`${protocol}: MCP tools use frozen schemas and exact approval through production history`, async (t) => {
    const f = await fixture(t, {}, { protocol }),
      id = await f.h.start();
    const waiting = await until(async () => {
      const s = await f.h.get(id);
      return s.run.waiting.includes("approval") && s;
    });
    assert.equal(
      f.server.calls.filter((c) => c.method === "tools/call").length,
      0,
    );
    const inv = await f.h.core.request("agent.invocation", {
      id: waiting.invocations[0].id,
    });
    assert.equal(inv.operation.tool, "echo");
    assert.deepEqual(inv.operation.arguments, { text: "hello", count: 2 });
    assert.equal(inv.operation.location, "remote");
    await f.h.approve(inv);
    const done = await f.finish(id);
    assert.equal(done.run.state, "completed");
    assert.equal(
      f.server.calls.filter((c) => c.method === "tools/call").length,
      1,
    );
    const sessions = await f.h.core.request("agent.mcp-sessions", {
      run_id: id,
    });
    assert.ok(sessions.items.every((s) => s.state === "closed" && s.stopped));
  });
for (const mode of ["sse", "legacy"])
  test(`MCP Agent supports ${mode} service transport`, async (t) => {
    const f = await fixture(t, { [mode]: true }),
      id = await f.h.start();
    assert.equal((await f.finish(id)).run.state, "completed");
    assert.equal(
      f.server.calls.filter((c) => c.method === "tools/call").length,
      1,
    );
  });
test("MCP same-name servers have stable separate model tools and routing", async (t) => {
  const f = await fixture(
    t,
    { label: "one" },
    {
      plan: ({ body }) =>
        hook(body) || results(body).length
          ? []
          : modelTools(body)
              .filter((t) => t.name.startsWith("mcp_"))
              .map((t) => ({ name: t.name, arguments: { text: t.name } })),
    },
  );
  const other = await mcpServer({ label: "two" });
  t.after(() => other.close());
  await f.h.core.request("mcp.save", {
    expected_revision: 0,
    definition: { ...f.def, url: other.url },
  });
  const id = await f.h.start();
  const done = await f.finish(id);
  assert.equal(done.run.state, "completed");
  const catalog = await f.h.core.request("agent.mcp-catalogue", { run_id: id });
  const next = await f.h.core.request("agent.mcp-catalogue", {
    run_id: id,
    offset: 1,
  });
  assert.notEqual(catalog.items[0].name, next.items[0].name);
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    1,
  );
  assert.equal(other.calls.filter((c) => c.method === "tools/call").length, 1);
});
test("MCP Hook input changes are revalidated and the final approval shows exact arguments", async (t) => {
  const f = await fixture(t);
  await f.h.save({
    name: "MCP parameter change",
    event: "preToolUse",
    kind: "command",
    command: `Write-Output ${emit({ updated_input: { text: "changed", count: 3 } })}`,
    matcher: "^mcp_",
    prompt: "",
  });
  await f.h.save({
    name: "MCP ask",
    event: "beforeMCPExecution",
    kind: "command",
    command: `Write-Output ${emit({ permission: "ask" })}`,
    matcher: "^mcp_",
    prompt: "",
  });
  await f.h.save({
    name: "MCP post",
    event: "afterMCPExecution",
    kind: "command",
    command: `Write-Output ${emit({ additional_context: "Owned post evidence" })}`,
    matcher: "^mcp_",
    prompt: "",
  });
  const id = await f.h.start();
  assert.equal((await f.finish(id)).run.state, "completed");
  const request = f.server.calls.find((c) => c.method === "tools/call");
  assert.deepEqual(request.params.arguments, { text: "changed", count: 3 });
  const s = await f.h.get(id);
  const inv = await f.h.core.request("agent.invocation", {
    id: s.invocations[0].id,
  });
  assert.deepEqual(inv.operation.arguments, request.params.arguments);
  const hooks = await f.h.core.request("hooks.calls", { run_id: id });
  for (const call of hooks.items.filter((h) =>
    h.event.includes("MCPExecution"),
  )) {
    const detail = await f.h.core.request("hooks.call", { id: call.id });
    assert.equal(detail.input.data.operation.server, "Owned MCP server");
    assert.equal(detail.input.data.operation.tool, "echo");
    assert.deepEqual(detail.input.data.operation.arguments, {
      text: "changed",
      count: 3,
    });
  }
  assert.ok(
    hooks.items.some(
      (h) => h.event === "beforeMCPExecution" && h.state === "succeeded",
    ),
  );
  assert.ok(
    hooks.items.some(
      (h) => h.event === "afterMCPExecution" && h.state === "succeeded",
    ),
  );
});
test("MCP before Hook deny never calls the backend", async (t) => {
  const f = await fixture(t);
  await f.h.save({
    name: "MCP deny",
    event: "beforeMCPExecution",
    kind: "command",
    command: `Write-Output ${emit({ permission: "deny" })}`,
    matcher: "^mcp_",
    prompt: "",
  });
  const id = await f.h.start();
  await f.finish(id);
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    0,
  );
});
test("MCP directory changes after approval do not execute the stale tool plan", async (t) => {
  const f = await fixture(t),
    id = await f.h.start();
  await until(async () => {
    const s = await f.h.get(id);
    return s.run.waiting.includes("approval");
  });
  f.server.state.schema = {
    type: "object",
    properties: { other: { type: "string" } },
    required: ["other"],
  };
  const end = await f.finish(id);
  assert.equal(end.run.state, "completed");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    0,
  );
});
test("MCP configuration revision and tool disable revoke prepared calls", async (t) => {
  const f = await fixture(t),
    id = await f.h.start();
  await until(async () => {
    const s = await f.h.get(id);
    return s.run.waiting.includes("approval");
  });
  await f.h.core.request("mcp.save", {
    id: f.service.id,
    expected_revision: 1,
    definition: { ...f.def, disabled_tools: ["echo"] },
  });
  await f.finish(id);
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    0,
  );
});
test("MCP malformed model arguments are rejected without an approval or backend action", async (t) => {
  const f = await fixture(
      t,
      {},
      {
        plan: ({ body }) =>
          hook(body) || results(body).length
            ? []
            : modelTools(body)
                .filter((t) => t.name.startsWith("mcp_"))
                .map((t) => ({
                  name: t.name,
                  arguments: { text: "hello", count: "bad" },
                })),
      },
    ),
    id = await f.h.start();
  await f.finish(id, false);
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    0,
  );
});
test("MCP timeout is indeterminate, requires review, and never automatically repeats the request", async (t) => {
  const f = await fixture(t, { hang: true });
  await f.h.core.request("mcp.save", {
    id: f.service.id,
    expected_revision: 1,
    definition: { ...f.def, timeout_seconds: 1 },
  });
  const id = await f.h.start();
  const end = await f.finish(id);
  assert.equal(end.run.state, "interrupted");
  assert.equal(end.invocations[0].state, "indeterminate");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    1,
  );
  await assert.rejects(f.h.core.request("agent.resume", { id }));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    1,
  );
});
test("MCP isError is a completed tool failure and post Hook errors do not replay it", async (t) => {
  const f = await fixture(t, { toolError: true });
  await f.h.save({
    name: "post error",
    event: "afterMCPExecution",
    kind: "command",
    command: "exit 2",
    matcher: "^mcp_",
    prompt: "",
  });
  const id = await f.h.start(),
    end = await f.finish(id);
  assert.equal(end.run.state, "completed");
  assert.equal(end.invocations[0].state, "failed");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    1,
  );
});
test("MCP attachments and structured output are bounded, owned, and committed with their tool result", async (t) => {
  const binary = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255]);
  const f = await fixture(t, {
      result: {
        content: [
          { type: "text", text: "x".repeat(16000) },
          {
            type: "image",
            mimeType: "image/png",
            data: binary.toString("base64"),
          },
        ],
        structuredContent: { large: "y".repeat(10000) },
      },
    }),
    id = await f.h.start();
  await f.finish(id);
  const state = await f.h.get(id),
    inv = await f.h.core.request("agent.invocation", {
      id: state.invocations[0].id,
    });
  assert.ok(JSON.stringify(inv.result).length < 16000);
  assert.ok(inv.result.artifacts.length >= 2);
  const artifact = inv.result.artifacts.find(
      (a) => a.mime_type === "image/png",
    ),
    read = await f.h.core.request("agent.mcp-artifact", {
      run_id: id,
      id: artifact.id,
    });
  assert.equal(read.binary, true);
  assert.deepEqual(Buffer.from(read.base64, "base64"), binary);
  await assert.rejects(
    f.h.core.request("agent.mcp-artifact", {
      run_id: id + 100,
      id: artifact.id,
    }),
  );
});
test("MCP stdio retains a Run-owned session across calls and closes its process tree on completion", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      hook(body) || results(body).length >= 2
        ? []
        : modelTools(body)
            .filter((t) => t.name.startsWith("mcp_"))
            .slice(0, 1)
            .map((t) => ({ name: t.name, arguments: { text: "state" } })),
  });
  await h.core.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "Owned stateful stdio",
      transport: "stdio",
      location: "windows-host",
      command: process.execPath,
      args: [
        path.join(__dirname, "fixtures/mcp-stdio.cjs"),
        "stateful",
        h.workspace,
      ],
      cwd: h.workspace,
      enabled: true,
      agent_ids: [1],
    },
  });
  const id = await h.start();
  const end = await until(async () => {
    const s = await h.get(id);
    if (s.run.waiting.includes("approval"))
      for (const i of s.invocations.filter(
        (i) => i.state === "prepared" && i.approval === null,
      ))
        await h.approve(await h.core.request("agent.invocation", { id: i.id }));
    return ["completed", "interrupted", "failed"].includes(s.run.state) && s;
  });
  assert.equal(end.run.state, "completed");
  const values = [];
  for (const i of end.invocations) {
    const inv = await h.core.request("agent.invocation", { id: i.id });
    values.push(inv.result.value.content[0].text);
  }
  assert.deepEqual(values, ["1:state", "2:state"]);
  const sessions = await h.core.request("agent.mcp-sessions", { run_id: id });
  assert.equal(sessions.items.length, 1);
  assert.equal(sessions.items[0].stopped, true);
});
test("MCP stdio cancellation stops a real owned grandchild heartbeat", async (t) => {
  const h = await setup(t, { plan });
  await h.core.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "Owned stdio tree",
      transport: "stdio",
      location: "windows-host",
      command: process.execPath,
      args: [
        path.join(__dirname, "fixtures/mcp-stdio.cjs"),
        "tree",
        h.workspace,
      ],
      cwd: h.workspace,
      enabled: true,
      agent_ids: [1],
    },
  });
  const id = await h.start();
  await until(async () => {
    const s = await h.get(id);
    if (s.run.waiting.includes("approval"))
      for (const i of s.invocations.filter((i) => i.approval === null))
        await h.approve(await h.core.request("agent.invocation", { id: i.id }));
    return (
      s.invocations.some((i) => i.state === "running") &&
      fs.existsSync(path.join(h.workspace, "heartbeat"))
    );
  });
  await h.core.request("agent.cancel", { id });
  const end = await until(async () => {
    const s = await h.get(id);
    return ["cancelled", "interrupted"].includes(s.run.state) && s;
  });
  assert.equal(end.run.state, "cancelled");
  const file = path.join(h.workspace, "heartbeat");
  await new Promise((r) => setTimeout(r, 120));
  const n = fs.statSync(file).size;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fs.statSync(file).size, n);
  assert.ok(
    (await h.core.request("agent.mcp-sessions", { run_id: id })).items.every(
      (s) => s.stopped,
    ),
  );
});
test("MCP read-only children cannot inherit an executable MCP capability or skip approval using server hints", async (t) => {
  let stolen;
  const f = await fixture(
      t,
      {},
      {
        plan: ({ body }) => {
          if (hook(body) || results(body).length) return [];
          const goal =
            (body.messages ?? body.input).find(
              (m) => m.role === "user" && typeof m.content === "string",
            )?.content ?? "";
          if (goal.includes("mcp-child"))
            return [{ name: stolen, arguments: { text: "blocked" } }];
          stolen = modelTools(body).find((t) => t.name.startsWith("mcp_")).name;
          return [
            {
              name: "spawn_agent",
              arguments: { goal: "mcp-child", access: "read_only" },
            },
          ];
        },
      },
    ),
    id = await f.h.start();
  const end = await f.finish(id);
  assert.equal(end.run.state, "completed");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    0,
  );
  const child = end.tasks.find((t) => t.child_run_id).child_run_id;
  assert.equal(
    (await f.h.core.request("agent.mcp-sessions", { run_id: child })).items
      .length,
    0,
  );
});
test("MCP known credential echoes are removed before model history and artifact persistence", async (t) => {
  const token = "owned-mcp-key-" + require("node:crypto").randomUUID(),
    f = await fixture(t, {
      result: {
        content: [{ type: "text", text: `secret ${token}` }],
        structuredContent: { [token]: token },
      },
    });
  await f.h.core.request("mcp.save", {
    id: f.service.id,
    expected_revision: 1,
    definition: { ...f.def, header_keys: ["x-api-key"] },
    secrets: { "header:x-api-key": token },
  });
  const id = await f.h.start();
  await f.finish(id);
  const db = new DatabaseSync(path.join(f.h.data, "troop.sqlite3"));
  const doc = db
    .prepare("SELECT document FROM agent_runs WHERE id=?")
    .get(id).document;
  assert.ok(!doc.includes(token));
  const inv = db
    .prepare("SELECT document FROM agent_invocations WHERE run_id=?")
    .get(id).document;
  assert.ok(!inv.includes(token));
  db.close();
  await f.h.core.request("mcp.remove", {
    id: f.service.id,
    expected_revision: 2,
  });
});
test("MCP Ready ledger failure prevents the external tools/call", async (t) => {
  const f = await fixture(t),
    id = await f.h.start();
  await until(async () => {
    const s = await f.h.get(id);
    return s.run.waiting.includes("approval");
  });
  let db = new DatabaseSync(path.join(f.h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER mcp_ready_fail BEFORE INSERT ON agent_events WHEN NEW.kind='mcp_call_accepted' BEGIN SELECT RAISE(ABORT,'owned MCP Ready fault');END",
  );
  db.close();
  const s = await f.h.get(id);
  await f.h.approve(
    await f.h.core.request("agent.invocation", { id: s.invocations[0].id }),
  );
  await until(() => f.h.core.state === "faulted");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    0,
  );
  db = new DatabaseSync(path.join(f.h.data, "troop.sqlite3"));
  db.exec("DROP TRIGGER mcp_ready_fail");
  db.close();
  await f.h.core.start();
  assert.equal((await f.h.get(id)).run.state, "interrupted");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    0,
  );
});

test("MCP connection identity failure rolls back its row before starting the service", async (t) => {
  const f = await fixture(t);
  let db = new DatabaseSync(path.join(f.h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER mcp_session_fail BEFORE UPDATE ON mcp_connections BEGIN SELECT RAISE(ABORT,'owned MCP session fault');END",
  );
  db.close();
  await f.h.start();
  await until(() => f.h.core.state === "faulted");
  db = new DatabaseSync(path.join(f.h.data, "troop.sqlite3"));
  assert.equal(db.prepare("SELECT count(*) n FROM mcp_connections").get().n, 0);
  db.exec("DROP TRIGGER mcp_session_fail");
  db.close();
  assert.equal(f.server.calls.length, 0);
});
test("MCP artifact bytes and invocation outcome roll back in one transaction", async (t) => {
  const f = await fixture(t, {
      result: { content: [{ type: "text", text: "z".repeat(16000) }] },
    }),
    id = await f.h.start();
  await until(async () => {
    const s = await f.h.get(id);
    return s.run.waiting.includes("approval");
  });
  let db = new DatabaseSync(path.join(f.h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER mcp_result_fail BEFORE INSERT ON agent_events WHEN NEW.kind='tool_result' BEGIN SELECT RAISE(ABORT,'owned MCP result fault');END",
  );
  db.close();
  const s = await f.h.get(id);
  await f.h.approve(
    await f.h.core.request("agent.invocation", { id: s.invocations[0].id }),
  );
  await until(() => f.h.core.state === "faulted");
  db = new DatabaseSync(path.join(f.h.data, "troop.sqlite3"));
  assert.equal(db.prepare("SELECT count(*) n FROM mcp_artifacts").get().n, 0);
  db.exec("DROP TRIGGER mcp_result_fail");
  db.close();
  await f.h.core.start();
  const restored = await f.h.get(id);
  assert.equal(restored.invocations[0].state, "indeterminate");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    1,
  );
});
test("MCP HTTP unknown outcome is manually reconciled before resume without replay", async (t) => {
  const f = await fixture(t, { hang: true });
  await f.h.core.request("mcp.save", {
    id: f.service.id,
    expected_revision: 1,
    definition: { ...f.def, timeout_seconds: 1 },
  });
  const id = await f.h.start();
  let s = await f.finish(id);
  const inv = await f.h.core.request("agent.invocation", {
    id: s.invocations[0].id,
  });
  await f.h.core.request("agent.reconcile", {
    id: inv.id,
    epoch: inv.epoch,
    source: "reviewed",
    note: "Owned fixture external operation inspected and stopped",
  });
  await f.h.core.request("agent.resume", { id });
  s = await f.finish(id);
  assert.equal(s.run.state, "completed");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    1,
  );
});
test("MCP malformed backend outcome is indeterminate and cannot trigger an automatic replay", async (t) => {
  const f = await fixture(t, { result: { unexpected: "payload" } }),
    id = await f.h.start();
  const end = await f.finish(id);
  assert.equal(end.run.state, "interrupted");
  assert.equal(end.invocations[0].state, "indeterminate");
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    1,
  );
});
for (const authCase of ["refresh", "reject401", "disconnect", "opaque"])
  test(`MCP OAuth ${authCase} preserves binding and never replays an old request`, async (t) => {
    const { oauthServer } = require("./fixtures/oauth-server.cjs"),
      server = await oauthServer({
        mcp: true,
        rejectTool401: authCase === "reject401",
        tokenPrefix:
          authCase === "opaque" ? "owned:opaque=token!~+/_%" : undefined,
      }),
      h = await setup(t, {
        plan: ({ body }) =>
          hook(body) || results(body).length
            ? []
            : modelTools(body)
                .filter((t) => t.name.startsWith("mcp_"))
                .map((t) => ({
                  name: t.name,
                  arguments: { text: "authorized" },
                })),
      });
    t.after(() => server.close());
    const service = await h.core.request("mcp.save", {
      expected_revision: 0,
      definition: {
        name: "Owned OAuth MCP",
        transport: "http",
        location: "remote",
        url: server.resource,
        enabled: true,
        agent_ids: [1],
        auth_mode: "oauth",
      },
    });
    t.after(async () => {
      await h.core.start();
      const a = await h.core.request("mcp.oauth.status", { id: service.id });
      await h.core.request("mcp.oauth.disconnect", {
        id: service.id,
        auth_revision: a.revision,
      });
      await h.core.stop();
    });
    await h.core.request("mcp.oauth.begin", {
      id: service.id,
      expected_revision: 1,
      auth_revision: 0,
      client_id: "owned-client",
      scopes: ["files.read"],
    });
    const ready = await until(async () => {
      const a = await h.core.request("mcp.oauth.status", { id: service.id });
      return a.authorization_url && a;
    });
    await fetch(ready.authorization_url);
    const connected = await until(async () => {
      const a = await h.core.request("mcp.oauth.status", { id: service.id });
      return a.state === "connected" && a;
    });
    if (authCase === "refresh") {
      const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
      db.exec(
        "UPDATE mcp_oauth SET document=json_set(document,'$.expires_at',0)",
      );
      db.close();
    }
    const id = await h.start();
    if (authCase === "disconnect") {
      await h.approval(id);
      await h.core.request("mcp.oauth.disconnect", {
        id: service.id,
        auth_revision: connected.revision,
      });
    }
    const end = await until(async () => {
      const s = await h.get(id);
      if (s.run.waiting.includes("approval"))
        for (const i of s.invocations.filter(
          (i) => i.state === "prepared" && i.approval === null,
        ))
          await h.approve(
            await h.core.request("agent.invocation", { id: i.id }),
          );
      return ["completed", "interrupted", "failed"].includes(s.run.state) && s;
    });
    assert.equal(
      end.run.state,
      authCase === "reject401" ? "interrupted" : "completed",
      end.run.error,
    );
    const refreshed = await h.core.request("mcp.oauth.status", {
      id: service.id,
    });
    if (authCase !== "disconnect")
      assert.equal(refreshed.grant_id, connected.grant_id);
    if (authCase === "reject401") assert.equal(refreshed.expires_at, 0);
    assert.equal(
      server.calls.filter((c) => c.path === "/token").length,
      authCase === "refresh" ? 2 : 1,
    );
    assert.equal(
      server.calls.filter(
        (c) => c.path === "/mcp" && JSON.parse(c.body).method === "tools/call",
      ).length,
      authCase === "disconnect" ? 0 : 1,
    );
  });

test("MCP explicit no-auth mode cannot silently begin an OAuth binding", async (t) => {
  const f = await fixture(t);
  await f.h.core.request("mcp.save", {
    id: f.service.id,
    expected_revision: 1,
    definition: { ...f.def, auth_mode: "none" },
  });
  await assert.rejects(
    f.h.core.request("mcp.oauth.begin", {
      id: f.service.id,
      expected_revision: 2,
      auth_revision: 0,
      client_id: "owned-client",
      scopes: [],
    }),
  );
  assert.equal(f.server.calls.length, 0);
});

test("MCP model reads an owned archived result through bounded artifact pages without another external call", async (t) => {
  const f = await fixture(
    t,
    {
      result: {
        content: [{ type: "text", text: "owned archived result ".repeat(900) }],
      },
    },
    {
      plan: ({ body }) => {
        if (hook(body)) return [];
        const previous = results(body);
        if (!previous.length) return plan({ body });
        if (previous.length === 1)
          return [
            {
              name: "read_mcp_artifact",
              arguments: {
                artifact_id: previous[0].artifacts.find(
                  (a) => a.mime_type === "application/json",
                ).id,
                offset: "0",
              },
            },
          ];
        return [];
      },
    },
  );
  const id = await f.h.start(),
    end = await f.finish(id);
  assert.equal(end.run.state, "completed");
  const read = await f.h.core.request("agent.invocation", {
    id: end.invocations[1].id,
  });
  assert.equal(read.name, "read_mcp_artifact");
  assert.equal(read.result.ok, true);
  assert.ok(Buffer.byteLength(read.result.value.text) <= 4000);
  assert.ok(read.result.value.text.includes("owned archived result"));
  assert.ok(read.result.value.next_offset > 0);
  assert.equal(
    f.server.calls.filter((c) => c.method === "tools/call").length,
    1,
  );
});
