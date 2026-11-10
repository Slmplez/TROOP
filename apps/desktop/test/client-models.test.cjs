const { test } = require("node:test");
const assert = require("node:assert/strict");
const contract = require("../contracts/execution.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
async function setup(request) {
  const { ClientModels } = await import("../renderer/client/models.mjs");
  const timers = new Map();
  let serial = 0,
    listener,
    subscriptions = 0;
  const client = {
    request,
    onChatEvent(fn) {
      listener = fn;
      subscriptions++;
      return () => {
        listener = null;
        subscriptions--;
      };
    },
  };
  const models = new ClientModels(client, {
    clock: {
      setInterval(fn) {
        const id = ++serial;
        timers.set(id, fn);
        return id;
      },
      clearInterval(id) {
        timers.delete(id);
      },
    },
  });
  models.connect({
    state: "ready",
    generation: "one",
    protocol: 10,
    revision: 1,
  });
  return {
    models,
    timers,
    event: (e) => listener?.(e),
    subscriptions: () => subscriptions,
  };
}
const page = (items, next = null) => ({ items, next_offset: next });

test("two views share queries, final release removes polling/events and never cancels work", async () => {
  const calls = [];
  const f = await setup(async (method) => {
    calls.push(method);
    return page([]);
  });
  const a = f.models.runs(),
    b = f.models.runs();
  assert.equal(a, b);
  const observe = () => {};
  const stopA = a.subscribe(observe),
    stopB = b.subscribe(observe);
  await tick();
  assert.deepEqual(calls, ["agent.list"]);
  assert.equal(f.timers.size, 1);
  assert.equal(f.subscriptions(), 1);
  stopA();
  stopA();
  assert.equal(f.timers.size, 1);
  stopB();
  assert.equal(f.timers.size, 0);
  assert.equal(f.subscriptions(), 0);
  assert.deepEqual(calls, ["agent.list"]);
});

test("disconnect and generation changes discard old success/error and cannot clear a newer request", async () => {
  const requests = [];
  const f = await setup(() => {
    const d = deferred();
    requests.push(d);
    return d.promise;
  });
  const model = f.models.runs();
  const release = model.subscribe(() => {});
  await tick();
  f.models.connect({
    state: "faulted",
    generation: "one",
    protocol: 10,
    revision: 2,
  });
  assert.equal(model.getSnapshot().data, null);
  f.models.connect({
    state: "ready",
    generation: "two",
    protocol: 10,
    revision: 3,
  });
  await tick();
  requests[0].reject(Error("old error"));
  await tick();
  assert.equal(model.getSnapshot().error, null);
  assert.equal(model.getSnapshot().loading, true);
  requests[1].resolve(page([{ id: 2 }]));
  await tick();
  assert.equal(model.getSnapshot().data.items[0].id, 2);
  f.models.connect({
    state: "ready",
    generation: "one",
    protocol: 10,
    revision: 1,
  });
  assert.equal(f.models.generation, "two");
  release();
});

test("switching resources drops a released response without affecting the new selection", async () => {
  const requests = new Map();
  const f = await setup((_method, { id }) => {
    const d = deferred();
    requests.set(id, d);
    return d.promise;
  });
  const old = f.models.task(1),
    current = f.models.task(2);
  const stop = old.subscribe(() => {});
  await tick();
  stop();
  const release = current.subscribe(() => {});
  await tick();
  requests.get(2).resolve({ id: 2 });
  requests.get(1).resolve({ id: 1 });
  await tick();
  assert.equal(old.getSnapshot().data, null);
  assert.equal(current.getSnapshot().data.id, 2);
  release();
});

test("paging and refresh serialize, retain stable IDs and do not overwrite current records with older pages", async () => {
  const requests = [];
  const f = await setup((_method, input) => {
    const d = deferred();
    requests.push({ input, ...d });
    return d.promise;
  });
  const model = f.models.runs();
  const release = model.subscribe(() => {});
  await tick();
  requests[0].resolve(page([{ id: 3, title: "new" }], 1));
  await tick();
  const more = model.more();
  await tick();
  void model.refresh();
  requests[1].resolve(page([{ id: 3, title: "stale" }, { id: 2 }], 2));
  await more;
  await tick();
  requests[2].resolve(page([{ id: 4 }, { id: 3, title: "updated" }], 2));
  await tick();
  assert.deepEqual(
    model.getSnapshot().data.items.map((x) => x.id),
    [4, 3, 2],
  );
  assert.equal(model.getSnapshot().data.items[1].title, "updated");
  assert.equal(model.getSnapshot().data.next_offset, 2);
  assert.ok(Object.isFrozen(model.getSnapshot().data.items));
  release();
});

test("a queued older page gets priority over repeated refreshes and is invalidated on disconnect", async () => {
  const requests = [];
  const f = await setup(() => {
    const d = deferred();
    requests.push(d);
    return d.promise;
  });
  const model = f.models.runs();
  const release = model.subscribe(() => {});
  await tick();
  requests[0].resolve(page([{ id: 3 }], 1));
  await tick();
  const refresh = model.refresh();
  await tick();
  const more = model.more();
  void model.refresh();
  requests[1].resolve(page([{ id: 4 }], 1));
  await refresh;
  await tick();
  assert.equal(requests.length, 3);
  f.models.connect({ state: "stopped", generation: null, revision: 2 });
  requests[2].resolve(page([{ id: 2 }], null));
  await more;
  assert.equal(model.getSnapshot().data, null);
  release();
});

test("lower Run revisions cannot replace newer snapshots", async () => {
  let revision = 8;
  const f = await setup(async () => ({
    run: { id: 1, revision },
    invocations: [],
    tasks: [],
  }));
  const model = f.models.run(1);
  const release = model.subscribe(() => {});
  await tick();
  revision = 7;
  await model.refresh();
  assert.equal(model.getSnapshot().data.run.revision, 8);
  release();
});

test("chat notifications ignore old generations and duplicates; observation owns the listener", async () => {
  let calls = 0;
  const f = await setup(async () => {
    calls++;
    return { items: [], next_before: null };
  });
  const release = f.models.session(1).subscribe(() => {});
  await tick();
  f.event({ generation: "old", seq: 20, conversation_id: 1 });
  await tick();
  assert.equal(calls, 1);
  f.event({ generation: "one", seq: 2, conversation_id: 1 });
  await tick();
  assert.equal(calls, 2);
  f.event({ generation: "one", seq: 2, conversation_id: 1 });
  await tick();
  assert.equal(calls, 2);
  release();
});

test("commands are never replayed after lost response or generation change", async () => {
  let calls = 0;
  const pending = deferred();
  const f = await setup(() => {
    calls++;
    return pending.promise;
  });
  const command = f.models.command("agent.cancel", { id: 1 });
  f.models.connect({
    state: "ready",
    generation: "two",
    protocol: 10,
    revision: 2,
  });
  pending.resolve({ id: 1 });
  await assert.rejects(command, { kind: "stale_generation" });
  assert.equal(calls, 1);
  const failed = await setup(async () => {
    throw Error("lost result");
  });
  await assert.rejects(failed.models.command("agent.start", {}), /lost result/);
});

test("fixed facade rejects invalid inputs, unavailable methods, wrong resources and malformed responses", async () => {
  const { TroopClient } = await import("../renderer/client/troop-client.mjs");
  let calls = 0;
  const client = new TroopClient({
    getOwnedTask: async () => {
      calls++;
      return {
        ok: true,
        value: {
          id: 2,
          owner_run_id: 1,
          epoch: 1,
          kind: "background",
          state: "running",
        },
      };
    },
  });
  await assert.rejects(client.request("agent.task", { id: -1 }), {
    kind: "invalid_request",
  });
  await assert.rejects(
    client.request("agent.task", { id: 1, command: "arbitrary" }),
    { kind: "invalid_request" },
  );
  assert.equal(calls, 0);
  await assert.rejects(client.request("agent.task", { id: 1 }), {
    kind: "invalid_response",
  });
  await assert.rejects(client.request("agent.get", { id: 1 }), {
    kind: "capability_unavailable",
  });
  await assert.rejects(
    new TroopClient({
      listRuns: async () => ({ ok: true, value: {} }),
    }).request("agent.list", {}),
    { kind: "invalid_response" },
  );
});

test("structured failures retain actionable metadata; transport command failures require reconciliation", async () => {
  const { TroopClient } = await import("../renderer/client/troop-client.mjs");
  const client = new TroopClient({
    resumeRun: async () => ({
      ok: false,
      error: "review first",
      details: {
        kind: "needs_reconciliation",
        requiredAction: "review",
        currentRevision: 8,
      },
    }),
  });
  await assert.rejects(client.request("agent.resume", { id: 1 }), {
    kind: "needs_reconciliation",
    requiredAction: "review",
    currentRevision: 8,
  });
  await assert.rejects(
    new TroopClient({
      cancelRun: async () => {
        throw Error("disconnected");
      },
    }).request("agent.cancel", { id: 1 }),
    { kind: "transport_error", retryability: "reconcile" },
  );
});

test("contract registry has fixed unique channels and generated bindings/types are current", () => {
  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const defs = Object.values(contract.methods);
  assert.equal(new Set(defs.map((d) => d.channel)).size, defs.length);
  execFileSync(process.execPath, [
    path.resolve(__dirname, "../scripts/generate-client-contract.mjs"),
    "--check",
  ]);
});

test("two observers submitting the same in-flight command share one dispatch", async () => {
  let calls = 0;
  const d = deferred();
  const f = await setup(() => {
    calls++;
    return d.promise;
  });
  const a = f.models.command("agent.cancel", { id: 1 });
  const b = f.models.command("agent.cancel", { id: 1 });
  assert.equal(calls, 1);
  d.resolve({ id: 1 });
  assert.deepEqual(await a, await b);
});

test("ledger revision conflicts retain the current revision and operation identity", async () => {
  const f = await setup(() => assert.fail("journal owns dispatch"));
  f.models.journal = {
    prepare: () => ({ request: { operation_id: "original-operation" } }),
    resolve: async () => ({
      state: "rejected",
      error: {
        kind: "revision_conflict",
        message: "Refresh authorization",
        currentRevision: 4,
      },
    }),
  };
  await assert.rejects(
    f.models.command("authorizations.revoke", {
      id: "grant",
      expected_revision: 2,
    }),
    {
      kind: "revision_conflict",
      currentRevision: 4,
      operationRef: "original-operation",
    },
  );
});

test("a disconnected command is stale even if the same generation becomes ready again", async () => {
  const d = deferred();
  const f = await setup(() => d.promise);
  const result = f.models.command("agent.cancel", { id: 1 });
  f.models.connect({
    state: "faulted",
    generation: "one",
    protocol: 10,
    revision: 2,
  });
  f.models.connect({
    state: "ready",
    generation: "one",
    protocol: 10,
    revision: 3,
  });
  d.resolve({ id: 1 });
  await assert.rejects(result, { kind: "stale_generation" });
});

test("resource pages share reads, fence disconnects and keep secret previews out of shared cache", async () => {
  const requests = [];
  const f = await setup((method, input) => {
    const d = deferred();
    requests.push({ method, input, ...d });
    return d.promise;
  });
  assert.equal(
    f.models.resource("memory.list", { agent_id: 1, offset: 0 }),
    f.models.resource("memory.list", { offset: 0, agent_id: 1 }),
  );
  const a = f.models.fetchResource("provider.list", {});
  const b = f.models.fetchResource("provider.list", {});
  await tick();
  assert.equal(requests.length, 1);
  requests[0].resolve([]);
  assert.deepEqual(await a, await b);
  const late = f.models.fetchResource("memory.list", { agent_id: 1 });
  await tick();
  f.models.connect({
    state: "faulted",
    generation: "one",
    protocol: 10,
    revision: 2,
  });
  f.models.connect({
    state: "ready",
    generation: "one",
    protocol: 10,
    revision: 3,
  });
  const current = f.models.fetchResource("memory.list", { agent_id: 1 });
  await tick();
  requests[2].resolve({
    items: [{ id: 2, revision: 2, content: "new" }],
    total: 1,
    next_offset: null,
  });
  await current;
  requests[1].resolve({
    items: [{ id: 1, revision: 1, content: "old" }],
    total: 1,
    next_offset: null,
  });
  await assert.rejects(late, { kind: "stale_generation" });
  assert.equal(
    f.models.resource("memory.list", { agent_id: 1 }).getSnapshot().data
      .items[0].id,
    2,
  );
  const preview = f.models.fetchResource("mcp.preview", {
    json: '{"secret":"fixture-secret"}',
    location: "remote",
  });
  await tick();
  requests[3].resolve({ items: [] });
  await preview;
  assert.equal(
    [...f.models.cache.keys()].some(
      (key) => key.includes("fixture-secret") || key.includes("mcp.preview"),
    ),
    false,
  );
});

test("resource view facade preserves positional arguments and routes writes exclusively through commands", async () => {
  const { createResourceFacade } = await import(
    "../renderer/client/resource-facade.mjs"
  );
  const calls = [];
  const facade = createResourceFacade(
    {
      fetchResource: async (method, input) => {
        calls.push(["read", method, input]);
        return [];
      },
      command: async (method, input) => {
        calls.push(["command", method, input]);
        return method === "provider.remove"
          ? { cancelled: true }
          : { items: [] };
      },
      read: async () => "C:/owned",
    },
    {},
  );
  await facade.listMemories(2, 20);
  await facade.renameWorkspace(3, "renamed");
  assert.deepEqual(await facade.removeProvider("p"), {
    ok: true,
    value: { removed: false },
  });
  await facade.chooseWorkspace();
  assert.deepEqual(calls, [
    ["read", "memory.list", { agent_id: 2, offset: 20 }],
    ["command", "workspace.rename", { id: 3, name: "renamed" }],
    ["command", "provider.remove", { id: "p" }],
    ["command", "workspace.add", { path: "C:/owned" }],
  ]);
});
test("observed rule history refreshes and releases its shared timer on final unsubscribe", async () => {
  const f = await setup(async () => ({
    items: [],
    deliveries: [],
    next_offset: null,
  }));
  const a = f.models.resource("rules.history", { id: "rule", offset: 0 });
  const b = f.models.resource("rules.history", { offset: 0, id: "rule" });
  assert.equal(a, b);
  const releaseA = a.subscribe(() => {}),
    releaseB = b.subscribe(() => {});
  await tick();
  assert.equal(f.timers.size, 1);
  releaseA();
  assert.equal(f.timers.size, 1);
  releaseB();
  assert.equal(f.timers.size, 0);
});

test("a rejected memory read clears cached history before any subsequent refresh", async () => {
  let calls = 0;
  const later = deferred();
  const f = await setup(async () => {
    calls++;
    if (calls === 1)
      return { items: [{ content: "private history" }], next_offset: null };
    if (calls === 2)
      throw Object.assign(Error("membership revoked"), {
        kind: "request_rejected",
      });
    return later.promise;
  });
  const model = f.models.resource("memory.history", { agent_id: 1, id: 1 });
  await model.refresh();
  await model.refresh();
  assert.equal(model.getSnapshot().data, null);
  const loading = model.refresh();
  assert.equal(model.getSnapshot().data, null);
  later.resolve({ items: [], next_offset: null });
  await loading;
});

test("observed memory usage refreshes and releases its timer on final unsubscribe", async () => {
  const f = await setup(async () => ({ items: [], next_offset: null }));
  const model = f.models.resource("memory.usage", { run_id: 1 });
  const release = model.subscribe(() => {});
  await tick();
  assert.equal(f.timers.size, 1);
  release();
  assert.equal(f.timers.size, 0);
});

test("CLI interaction pages merge by interaction identity and retain new pending questions", async () => {
  let fresh = false;
  const { models } = await setup(async (method, input) => {
    assert.equal(method, "cli.interactions");
    if (input.before)
      return {
        items: [{ interaction_id: "old", created_at: 1, state: "closed" }],
        next_cursor: null,
      };
    return {
      items: [
        ...(fresh
          ? [{ interaction_id: "new", created_at: 3, state: "pending" }]
          : []),
        {
          interaction_id: "current",
          created_at: 2,
          state: fresh ? "closed" : "pending",
        },
      ],
      next_cursor: 2,
    };
  });
  const model = models.resource("cli.interactions", { task_id: 1 });
  await model.refresh();
  await model.more();
  assert.equal(model.getSnapshot().data.items.length, 2);
  fresh = true;
  await model.refresh();
  assert.deepEqual(
    model.getSnapshot().data.items.map((item) => item.interaction_id),
    ["new", "current", "old"],
  );
  assert.equal(model.getSnapshot().data.items[1].state, "closed");
  assert.equal(model.getSnapshot().data.next_cursor, null);
  models.dispose();
});

test("work item views share filter identity and merge stable pages before refreshing", async () => {
  const calls = [];
  const f = await setup(async (method, input) => {
    calls.push({ method, input });
    return input.before
      ? { items: [{ id: 1, revision: 1 }], next_before: null }
      : {
          items: [
            { id: 3, revision: 1 },
            { id: 2, revision: 1 },
          ],
          next_before: 2,
        };
  });
  const model = f.models.resource("work_items.list", {
    owner_agent_id: 1,
    archived: false,
  });
  assert.equal(
    model,
    f.models.resource("work_items.list", {
      archived: false,
      owner_agent_id: 1,
    }),
  );
  const release = model.subscribe(() => {});
  await tick();
  await model.more();
  assert.deepEqual(
    model.getSnapshot().data.items.map((item) => item.id),
    [3, 2, 1],
  );
  assert.equal(calls[1].input.before, 2);
  assert.equal(calls[1].input.owner_agent_id, 1);
  release();
  assert.equal(f.timers.size, 0);
});

test("expanded work item refresh replaces membership and revisions across loaded pages", async () => {
  let changed = false;
  const { models } = await setup(async (_, input) => {
    if (changed)
      return input.before
        ? { items: [{ id: 1, revision: 2 }], next_before: null }
        : { items: [{ id: 3, revision: 2 }], next_before: 3 };
    return input.before
      ? { items: [{ id: 1, revision: 1 }], next_before: null }
      : {
          items: [
            { id: 3, revision: 1 },
            { id: 2, revision: 1 },
          ],
          next_before: 2,
        };
  });
  const model = models.resource("work_items.list", { archived: false });
  await model.refresh();
  await model.more();
  changed = true;
  await model.refresh();
  assert.deepEqual(model.getSnapshot().data.items, [
    { id: 3, revision: 2 },
    { id: 1, revision: 2 },
  ]);
  assert.equal(model.getSnapshot().data.next_before, null);
  models.dispose();
});
test("work execution pages retain distinct Run identities and refresh accepted versions", async () => {
  let accepted = false;
  const f = await setup(async (method, input) => {
    assert.equal(method, "work_items.runs");
    assert.equal(input.id, 7);
    return input.before
      ? {
          items: [
            { run: { id: 1 }, acceptance: accepted ? { note: "fixed" } : null },
          ],
          next_before: null,
        }
      : { items: [{ run: { id: 2 }, acceptance: null }], next_before: 2 };
  });
  const model = f.models.resource("work_items.runs", { id: 7 });
  const release = model.subscribe(() => {});
  await tick();
  await model.more();
  assert.deepEqual(
    model.getSnapshot().data.items.map((item) => item.run.id),
    [2, 1],
  );
  accepted = true;
  await model.refresh();
  assert.equal(model.getSnapshot().data.items[1].acceptance.note, "fixed");
  release();
  assert.equal(f.timers.size, 0);
  f.models.dispose();
});
test("group queries isolate streams, canonicalize filters and refresh old delivery decisions across pages", async () => {
  let cancelled = false;
  const f = await setup(async (method, input) => {
    assert.equal(method, "groups.deliveries");
    return input.before
      ? {
          items: [{ id: 1, state: cancelled ? "cancelled" : "queued" }],
          next_before: null,
        }
      : { items: [{ id: 2, state: "queued" }], next_before: 2 };
  });
  const model = f.models.resource("groups.deliveries", {
    group_id: 1,
    message_id: 7,
  });
  assert.equal(
    model,
    f.models.resource("groups.deliveries", { message_id: 7, group_id: 1 }),
  );
  assert.notEqual(
    model,
    f.models.resource("groups.deliveries", { group_id: 2, message_id: 7 }),
  );
  const release = model.subscribe(() => {});
  await tick();
  await model.more();
  cancelled = true;
  await model.refresh();
  assert.deepEqual(
    model.getSnapshot().data.items.map((item) => item.id),
    [2, 1],
  );
  assert.equal(model.getSnapshot().data.items[1].state, "cancelled");
  release();
  assert.equal(f.timers.size, 0);
  f.models.dispose();
});

test("scheduled history shares one resource identity and refreshes mutable Run state on older pages", async () => {
  let completed = false;
  const f = await setup(async (method, input) => {
    assert.equal(method, "schedules.history");
    return input.before
      ? {
          items: [
            {
              id: 1,
              run: { id: 1, state: completed ? "completed" : "running" },
            },
          ],
          next_before: null,
        }
      : { items: [{ id: 2, run: null }], next_before: 2 };
  });
  const model = f.models.resource("schedules.history", { id: "rule-A" });
  assert.equal(model, f.models.resource("schedules.history", { id: "rule-A" }));
  assert.notEqual(
    model,
    f.models.resource("schedules.history", { id: "rule-B" }),
  );
  const release = model.subscribe(() => {});
  await tick();
  await model.more();
  completed = true;
  await model.refresh();
  assert.equal(model.getSnapshot().data.items[1].run.state, "completed");
  release();
  f.models.dispose();
});

test("authorization choices load older pages and retain them during refresh", async () => {
  const f = await setup(async (method, input) => {
    assert.equal(method, "authorizations.list");
    return input.offset === 0
      ? page([{ id: "new-grant" }], 20)
      : page([{ id: "old-grant" }]);
  });
  const model = f.models.resource("authorizations.list", { offset: 0 });
  const release = model.subscribe(() => {});
  try {
    await tick();
    await model.more();
    assert.deepEqual(
      model.state.data.items.map((x) => x.id),
      ["new-grant", "old-grant"],
    );
    await model.refresh();
    assert.deepEqual(
      model.state.data.items.map((x) => x.id),
      ["new-grant", "old-grant"],
    );
  } finally {
    release();
  }
});
