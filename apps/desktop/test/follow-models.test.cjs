const { test } = require("node:test");
const assert = require("node:assert/strict");
const tick = () => new Promise((r) => setImmediate(r));
const value = (revision = 1) => ({
  run: {
    id: 1,
    epoch: 1,
    revision,
    state: "waiting",
    intent: null,
    title: "follow",
    waiting: [],
    goal: "goal",
    output: "preview",
  },
  invocations: [],
  tasks: [],
  hooks_unresolved: false,
  mcp_unresolved: false,
});
const frame = (cursor, from = null, revision = 1, extra = {}) => ({
  state: from === null ? "snapshot" : "delta",
  resource: "run",
  id: 1,
  instance_id: "store",
  generation: "one",
  from_cursor: from,
  cursor,
  has_more: false,
  changes: [],
  snapshot: {
    value: value(revision),
    events: { items: [], next_before: null },
  },
  ...extra,
});

test("invocation follow is negotiated separately and falls back to snapshot on older Core", async () => {
  const calls = [];
  const f = await setup((method) => {
    calls.push(method);
    return {
      id: 1,
      run_id: 1,
      epoch: 1,
      name: "write_file",
      state: "prepared",
      arguments: {},
    };
  });
  await f.models.invocation(1).refresh();
  assert.deepEqual(calls, ["agent.invocation"]);
  f.models.connect({
    ...f.status,
    generation: "two",
    revision: 2,
    follow_resources: ["run", "task", "invocation"],
  });
  f.models.client.request = async (method, input) => {
    calls.push(method);
    return {
      ...frame("inv1"),
      resource: "invocation",
      generation: "two",
      snapshot: {
        value: {
          id: 1,
          run_id: 1,
          epoch: 1,
          name: "write_file",
          state: "prepared",
          approval: null,
          arguments: {},
          allowed_actions: { approve: { allowed: false, reason: "revoked" } },
        },
      },
    };
  };
  await f.models.invocation(1).refresh();
  assert.equal(calls.at(-1), "agent.follow");
  assert.equal(
    f.models.invocation(1).getSnapshot().data.allowed_actions.approve.allowed,
    false,
  );
});
async function setup(request) {
  const { ClientModels } = await import("../renderer/client/models.mjs");
  const timers = new Set();
  const models = new ClientModels(
    { request, onChatEvent: () => () => {} },
    {
      clock: {
        setInterval(fn) {
          timers.add(fn);
          return fn;
        },
        clearInterval(fn) {
          timers.delete(fn);
        },
      },
    },
  );
  const status = {
    state: "ready",
    generation: "one",
    protocol: 10,
    revision: 1,
    storage_instance: "store",
    capabilities: ["agent.follow", "agent.follow-content"],
  };
  models.connect(status);
  return { models, timers, status };
}
test("two observers share follow; reconnect resumes last accepted cursor and ignores old-generation responses", async () => {
  const calls = [];
  let late;
  const f = await setup((method, input) => {
    calls.push({ method, input });
    if (calls.length === 1) return frame("c1");
    if (calls.length === 2) return new Promise((r) => (late = r));
    return frame("c2", "c1", 2, { generation: "two" });
  });
  const a = f.models.run(1),
    b = f.models.run(1);
  assert.equal(a, b);
  const offA = a.subscribe(() => {}),
    offB = b.subscribe(() => {});
  await tick();
  assert.equal(calls.length, 1);
  const inflight = a.refresh();
  await tick();
  f.models.connect({ ...f.status, state: "faulted", revision: 2 });
  f.models.connect({ ...f.status, generation: "two", revision: 3 });
  await tick();
  assert.equal(calls[2].input.cursor, "c1");
  assert.equal(a.getSnapshot().data.run.revision, 2);
  late(frame("wrong", "c1", 99));
  await inflight;
  assert.equal(a.getSnapshot().data.run.revision, 2);
  offA();
  assert.equal(f.timers.size, 1);
  offB();
  assert.equal(f.timers.size, 0);
  assert.ok(calls.every((c) => c.method === "agent.follow"));
});
test("reset_required clears old data and fetches fresh baseline; another storage never receives old cursor", async () => {
  const calls = [];
  let n = 0;
  const f = await setup((method, input) => {
    calls.push(input);
    n++;
    if (n === 1) return frame("c1");
    if (n === 2)
      return frame(null, "c1", 0, { state: "reset_required", snapshot: null });
    if (n === 3) return frame("fresh", null, 3);
    return frame("other", null, 0, { instance_id: "other", generation: "two" });
  });
  const model = f.models.run(1);
  const off = model.subscribe(() => {});
  await tick();
  await model.refresh();
  assert.equal(calls[2].cursor, null);
  assert.equal(model.getSnapshot().data.run.revision, 3);
  f.models.connect({
    ...f.status,
    generation: "two",
    revision: 2,
    storage_instance: "other",
  });
  await tick();
  assert.equal(calls[3].cursor, null);
  assert.equal(model.getSnapshot().data.run.revision, 0);
  off();
});
test("paged replay merges stable event IDs with history and only publishes snapshot after catch-up", async () => {
  let step = 0;
  const f = await setup((method, input) => {
    if (method === "agent.events")
      return { items: [{ id: 1, kind: "old" }], next_before: null };
    step++;
    if (step === 1) return frame("c1");
    if (step === 2)
      return frame("c2", "c1", 1, {
        has_more: true,
        snapshot: null,
        changes: [{ run_id: 1, event: { id: 2, kind: "new" } }],
      });
    return frame("c3", "c2", 3, {
      changes: [
        { run_id: 1, event: { id: 3, kind: "new" } },
        { run_id: 1, event: { id: 2, kind: "new" } },
      ],
    });
  });
  const events = f.models.events(1);
  await events.refresh();
  const model = f.models.run(1);
  await model.refresh();
  await model.refresh();
  assert.equal(model.getSnapshot().data.run.revision, 3);
  assert.deepEqual(
    events.getSnapshot().data.items.map((i) => i.id),
    [3, 2, 1],
  );
  await events.refresh();
  assert.deepEqual(
    events.getSnapshot().data.items.map((i) => i.id),
    [3, 2, 1],
  );
});
test("stale content retains consistent preview; released subscription discards late frames", async () => {
  let late,
    n = 0;
  const f = await setup((method) => {
    if (method === "agent.follow-content")
      return {
        state: "reset_required",
        revision: 2,
        text: "",
        next_offset: null,
      };
    n++;
    if (n === 1) {
      const out = frame("c1");
      out.snapshot.value.run.output_truncated = true;
      return out;
    }
    return new Promise((r) => (late = r));
  });
  const model = f.models.run(1);
  const off = model.subscribe(() => {});
  await tick();
  assert.equal(model.getSnapshot().data.run.output, "preview");
  assert.equal(model.getSnapshot().data.run.output_truncated, true);
  const pending = model.refresh();
  await tick();
  off();
  late(frame("late", "c1", 100));
  await pending;
  assert.equal(model.getSnapshot().data.run.revision, 1);
  assert.equal(model.followCursor, "c1");
});
test("mismatched frame identity does not advance cursor", async () => {
  let n = 0;
  const f = await setup(() =>
    ++n === 1 ? frame("c1") : frame("bad", "c1", 2, { id: 2 }),
  );
  const model = f.models.run(1);
  await model.refresh();
  await model.refresh();
  assert.equal(model.followCursor, "c1");
  assert.equal(model.getSnapshot().error.kind, "invalid_response");
  f.models.client.request = () => frame("regressed", "c1", 0);
  await model.refresh();
  assert.equal(model.followCursor, "c1");
  assert.equal(model.getSnapshot().data.run.revision, 1);
  assert.equal(model.getSnapshot().error.kind, "invalid_response");
});
