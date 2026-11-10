const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { once } = require("node:events");
const { setup, until, results } = require("./fixtures/hooks-fixture.cjs");
const operation = (h, method, input, extra = {}) => ({
  operation_id: crypto.randomUUID(),
  instance_id: h.core.snapshot().storage_instance,
  method,
  input,
  ...extra,
});
const startInput = (h) => ({
  client_run_id: crypto.randomUUID(),
  workspace_id: h.wid,
  provider_id: h.provider.id,
  goal: "Operation ledger acceptance",
});
const execute = (h, request) => h.core.request("operations.execute", request);

test("archived command receipts remain queryable and never replay after restart", async (t) => {
  const h = await setup(t);
  const request = operation(h, "workspace.rename", {
    id: h.wid,
    name: "Archived name",
  });
  const original = await execute(h, request);
  assert.equal(original.state, "committed");
  const settings = await h.core.request("operations.archive.settings", {});
  assert.equal(settings.enabled, false);
  const configured = await execute(
    h,
    operation(h, "operations.archive.configure", {
      expected_revision: settings.revision,
      enabled: true,
      retention_seconds: 60,
    }),
  );
  assert.equal(configured.state, "committed");
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  db.prepare(
    "UPDATE operation_receipt_times SET updated_at=0 WHERE subject='desktop' AND operation_id=?",
  ).run(request.operation_id);
  const compacted = await execute(
    h,
    operation(h, "operations.archive.run", {}),
  );
  assert.equal(compacted.result.archived, 1);
  const stub = await query(h, request);
  assert.equal(stub.state, "archived");
  assert.equal(stub.terminal_state, "committed");
  assert.deepEqual(
    await h.core.request("operations.archive.query", stub.archive_ref),
    original,
  );
  await assert.rejects(
    h.core.request("operations.archive.query", {
      ...stub.archive_ref,
      instance_id: "foreign",
    }),
  );
  await assert.rejects(
    h.core.request("operations.archive.query", {
      ...stub.archive_ref,
      archive_id: "foreign",
    }),
  );
  await h.core.stop();
  await h.core.start();
  assert.deepEqual(await execute(h, request), stub);
  const conflict = await execute(h, {
    ...request,
    input: { ...request.input, name: "Changed" },
  });
  assert.equal(conflict.error.kind, "operation_conflict");
  assert.deepEqual(
    await h.core.request("operations.archive.query", stub.archive_ref),
    original,
  );
  assert.equal(
    (await h.core.request("workspace.list", {})).items.find(
      (w) => w.id === h.wid,
    ).name,
    "Archived name",
  );
});
const query = (h, request) =>
  h.core.request("operations.get", {
    operation_id: request.operation_id,
    instance_id: request.instance_id,
  });
const plan = ({ body }) =>
  results(body).length
    ? []
    : [
        {
          name: "write_file",
          arguments: {
            path: "result.txt",
            content: "once",
            expected_hash: "missing",
          },
        },
      ];

test("same operation ID joins concurrent submissions, normalizes defaults and rejects conflicts", async (t) => {
  const h = await setup(t, { plan });
  const request = operation(h, "agent.start", startInput(h));
  const [a, b] = await Promise.all([execute(h, request), execute(h, request)]);
  assert.equal(a.state, "committed");
  assert.deepEqual(a, b);
  assert.equal((await h.core.request("agent.list")).total, 1);
  assert.deepEqual(
    await execute(h, {
      ...request,
      input: { ...request.input, workflow_id: null, agent_id: 1 },
    }),
    a,
  );
  const conflict = await execute(h, {
    ...request,
    input: { ...request.input, goal: "different" },
  });
  assert.equal(conflict.error.kind, "operation_conflict");
  assert.deepEqual(await query(h, request), a);
});

test("lost response followed by Core crash returns the original receipt without a new Run", async (t) => {
  const h = await setup(t, { plan });
  const request = operation(h, "agent.start", startInput(h));
  const original = await execute(h, request); // Deliberately discard at the client boundary.
  const calls = h.server.requests.length;
  const closed = once(h.core.child, "close");
  h.core.child.kill();
  await closed;
  await h.core.start();
  assert.deepEqual(await query(h, request), original);
  assert.deepEqual(await execute(h, request), original);
  assert.equal((await h.core.request("agent.list")).total, 1);
  assert.equal((await h.get(original.execution_ref)).run.state, "interrupted");
  assert.equal(h.server.requests.length, calls);
  await assert.rejects(query(h, { ...request, instance_id: "other-store" }));
});

test("ledger write failure prevents start and keeps original ID safely resubmittable", async (t) => {
  const h = await setup(t, { plan });
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_operation BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'receipt failure'); END;",
  );
  const request = operation(h, "agent.start", startInput(h));
  await assert.rejects(execute(h, request));
  assert.equal((await query(h, request)).state, "not_found");
  assert.equal((await h.core.request("agent.list")).total, 0);
  assert.equal(h.server.requests.length, 0);
  db.exec("DROP TRIGGER fail_operation");
  assert.equal((await execute(h, request)).state, "committed");
});

test("cancel acceptance and fences roll back together; acknowledged cancellation never resumes", async (t) => {
  const h = await setup(t, { plan });
  const id = await h.start();
  await h.approval(id);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_operation BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'receipt failure'); END;",
  );
  const request = operation(h, "agent.cancel", { id });
  await assert.rejects(execute(h, request));
  assert.equal((await h.get(id)).run.intent, null);
  db.exec("DROP TRIGGER fail_operation");
  const receipt = await execute(h, request);
  assert.equal(receipt.state, "committed");
  await until(async () => (await h.get(id)).run.state === "cancelled");
  assert.deepEqual(await execute(h, request), receipt);
  const resume = operation(h, "agent.resume", { id });
  const rejected = await execute(h, resume);
  assert.equal(rejected.state, "rejected");
  assert.deepEqual(await execute(h, resume), rejected);
});

test("approval duplicates never write twice and a changed revision records a stable rejection", async (t) => {
  const h = await setup(t, { plan });
  const id = await h.start();
  const inv = await h.approval(id);
  const request = operation(h, "agent.approve", {
    id: inv.id,
    epoch: inv.epoch,
    approved: true,
  });
  const receipt = await execute(h, request);
  assert.equal(receipt.state, "committed");
  await h.done(id);
  assert.deepEqual(await execute(h, request), receipt);
  const events = await h.core.request("agent.events", { id });
  assert.equal(
    events.items.filter((e) => e.kind === "approval_decided").length,
    1,
  );
  const stale = operation(h, "agent.cancel", { id }, { expected_revision: 0 });
  const rejected = await execute(h, stale);
  assert.equal(rejected.error.kind, "revision_conflict");
  assert.deepEqual(await execute(h, stale), rejected);
});

test("resume increments epoch once even when its operation is retried after another restart", async (t) => {
  const h = await setup(t, { plan });
  const id = await h.start();
  await h.approval(id);
  await h.core.stop();
  await h.core.start();
  const request = operation(h, "agent.resume", { id });
  const receipt = await execute(h, request);
  assert.equal(receipt.result.epoch, 2);
  await h.core.stop();
  await h.core.start();
  assert.deepEqual(await execute(h, request), receipt);
  assert.equal((await h.get(id)).run.epoch, 2);
});
