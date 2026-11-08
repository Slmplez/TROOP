const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { EventEmitter } = require("node:events");
const {
  startReminderNotifications,
} = require("../src/reminder-notifications.cjs");
function fixture(options = {}) {
  const receipts = new Map(),
    calls = [],
    shows = [];
  let pending = true,
    dropClaim = !!options.dropClaim,
    dropComplete = !!options.dropComplete;
  const core = {
    state: "ready",
    generation: "one",
    snapshot() {
      return { generation: this.generation, storage_instance: "owned" };
    },
    async request(method, input) {
      calls.push({ method, input });
      if (method === "notifications.pending") return { pending };
      if (!receipts.has(input.operation_id)) {
        let result;
        if (input.method === "notifications.claim") {
          pending = false;
          result = {
            notification: {
              id: 1,
              revision: 2,
              title: "owned",
              body: "synthetic reminder",
              attempt_id: "owned-attempt",
              claimed_at_ms: 1,
              deadline_ms: 1 + (options.window ?? 5000),
            },
          };
        } else result = { id: 1, state: input.input.outcome };
        receipts.set(input.operation_id, { state: "committed", result });
      }
      if (input.method === "notifications.claim" && dropClaim) {
        dropClaim = false;
        throw Error("lost claim response");
      }
      if (input.method === "notifications.complete" && dropComplete) {
        dropComplete = false;
        throw Error("lost complete response");
      }
      return receipts.get(input.operation_id);
    },
  };
  const bridge = startReminderNotifications({
    core,
    interval: 100000,
    focused: () => false,
    supported: () => true,
    create(value) {
      const native = new EventEmitter();
      native.close = () => native.emit("close");
      native.show = () => {
        shows.push(value);
        native.emit(options.failed ? "failed" : "show", {}, "owned failure");
      };
      return native;
    },
  });
  return { core, bridge, receipts, calls, shows };
}
test("notification claim and completion retain operation identities after lost responses, showing only once", async (t) => {
  const f = fixture({ dropClaim: true, dropComplete: true });
  t.after(() => f.bridge.stop());
  await f.bridge.poll();
  assert.equal(f.shows.length, 0);
  await f.bridge.poll();
  assert.equal(f.shows.length, 1);
  await f.bridge.poll();
  await f.bridge.poll();
  await f.bridge.poll();
  assert.equal(f.shows.length, 1);
  assert.equal(f.receipts.size, 2);
  const claim = f.calls.filter(
      (c) => c.input?.method === "notifications.claim",
    ),
    complete = f.calls.filter(
      (c) => c.input?.method === "notifications.complete",
    );
  assert.equal(claim.length, 2);
  assert.equal(complete.length, 2);
  assert.equal(claim[0].input.operation_id, claim[1].input.operation_id);
  assert.equal(complete[0].input.operation_id, complete[1].input.operation_id);
});
test("native failures are recorded and an idle poll adds no operation", async (t) => {
  const f = fixture({ failed: true });
  t.after(() => f.bridge.stop());
  await f.bridge.poll();
  await f.bridge.poll();
  await f.bridge.poll();
  assert.equal(f.shows.length, 1);
  assert.equal(f.receipts.size, 2);
  assert.equal(
    f.calls.find((c) => c.input?.method === "notifications.complete").input
      .input.outcome,
    "failed",
  );
});
test("a new Core generation discards the old claim instead of replaying its native show", async (t) => {
  const f = fixture({ dropClaim: true });
  t.after(() => f.bridge.stop());
  await f.bridge.poll();
  f.core.generation = "two";
  await f.bridge.poll();
  assert.equal(f.shows.length, 0);
  assert.equal(f.receipts.size, 1);
});

test("a delayed claim response expires without showing the old notification", async (t) => {
  const f = fixture({ dropClaim: true, window: 5 });
  t.after(() => f.bridge.stop());
  await f.bridge.poll();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await f.bridge.poll();
  await f.bridge.poll();
  assert.equal(f.shows.length, 0);
  assert.equal(
    f.calls.find((c) => c.input?.method === "notifications.complete").input
      .input.outcome,
    "expired",
  );
});
