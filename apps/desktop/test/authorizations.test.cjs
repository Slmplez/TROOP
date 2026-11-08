const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { setup } = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");
async function rpc(h, method, input = {}) {
  contract.validate(method, input);
  const value = await h.core.request(method, input);
  return contract.validate(method, value, true);
}
const operation = (h, method, input) => ({
  operation_id: crypto.randomUUID(),
  instance_id: h.core.snapshot().storage_instance,
  method,
  input,
});
const grant = (h) => ({
  name: "Workspace files",
  purpose: "tool_call",
  agent_id: 1,
  engine_id: "native",
  workspace_id: h.wid,
  project_ids: [],
  read_roots: [h.workspace],
  write_roots: [h.workspace],
  operations: ["read_file", "write_file"],
  network: "none",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  rule_id: null,
});
const action = (h, id, extra = {}) => ({
  id,
  agent_id: 1,
  engine_id: "native",
  workspace_id: h.wid,
  project_ids: [],
  rule_id: null,
  operation: "read_file",
  path: path.join(h.workspace, "input.txt"),
  network: "none",
  ...extra,
});
test("authorization create/evaluate/revoke is typed, durable and idempotent", async (t) => {
  const h = await setup(t);
  const op = operation(h, "authorizations.save", {
    id: crypto.randomUUID(),
    expected_revision: 0,
    grant: grant(h),
  });
  const saved = await rpc(h, "operations.execute", op);
  assert.equal(saved.state, "committed");
  const record = saved.result;
  assert.deepEqual(await rpc(h, "operations.execute", op), saved);
  assert.equal((await rpc(h, "authorizations.list")).items.length, 1);
  const allowed = await rpc(h, "authorizations.evaluate", action(h, record.id));
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.executable, false);
  assert.equal(allowed.grant_revision, 1);
  assert.equal(
    (
      await rpc(
        h,
        "authorizations.evaluate",
        action(h, record.id, { path: path.join(h.directory, "outside.txt") }),
      )
    ).decision,
    "deny",
  );
  assert.equal(
    (
      await rpc(
        h,
        "authorizations.evaluate",
        action(h, record.id, { operation: "run_command" }),
      )
    ).decision,
    "needs_user",
  );
  const stale = await rpc(
    h,
    "operations.execute",
    operation(h, "authorizations.save", {
      id: record.id,
      expected_revision: 0,
      grant: grant(h),
    }),
  );
  assert.equal(stale.state, "rejected");
  assert.equal(stale.error.kind, "revision_conflict");
  assert.equal(stale.error.currentRevision, 1);
  const observation = await rpc(
    h,
    "authorizations.evaluate",
    action(h, record.id),
  );
  await assert.rejects(
    rpc(
      h,
      "authorizations.evaluate",
      action(h, record.id, { operation: "x".repeat(45000) }),
    ),
  );
  assert.equal(
    (await rpc(h, "authorizations.history", { id: record.id })).items[0]
      .last_evaluation.evaluation_id,
    observation.evaluation_id,
  );
  await h.core.stop();
  await h.core.start();
  assert.equal(
    (await rpc(h, "authorizations.get", { id: record.id })).last_evaluation
      .evaluation_id,
    observation.evaluation_id,
  );
  assert.equal(
    (await rpc(h, "authorizations.get", { id: record.id })).revision,
    1,
  );
  const revoke = await rpc(
    h,
    "operations.execute",
    operation(h, "authorizations.revoke", {
      id: record.id,
      expected_revision: 1,
    }),
  );
  assert.equal(revoke.state, "committed");
  assert.equal(
    (await rpc(h, "authorizations.evaluate", action(h, record.id))).decision,
    "deny",
  );
  assert.equal(
    (await rpc(h, "authorizations.history", { id: record.id })).items.length,
    2,
  );
});
test("authorization receipts roll back partial writes and root order cannot change a decision", async (t) => {
  const h = await setup(t);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_grant_history BEFORE INSERT ON authorization_history BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  const receipt = await rpc(
    h,
    "operations.execute",
    operation(h, "authorizations.save", {
      expected_revision: 0,
      grant: grant(h),
    }),
  );
  assert.equal(receipt.state, "rejected");
  assert.equal((await rpc(h, "authorizations.list")).items.length, 0);
  db.exec("DROP TRIGGER fail_grant_history");
  const a = path.join(h.workspace, "a"),
    b = path.join(h.workspace, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, "file.txt"), "owned");
  const ids = [];
  for (const roots of [
    [a, b],
    [b, a],
  ]) {
    const r = await rpc(
      h,
      "operations.execute",
      operation(h, "authorizations.save", {
        expected_revision: 0,
        grant: { ...grant(h), read_roots: roots },
      }),
    );
    ids.push(r.result.id);
  }
  fs.rmdirSync(a);
  const results = [];
  for (const id of ids)
    results.push(
      (
        await rpc(
          h,
          "authorizations.evaluate",
          action(h, id, { path: path.join(b, "file.txt") }),
        )
      ).decision,
    );
  assert.deepEqual(results, ["deny", "deny"]);
  await assert.rejects(
    h.core.request("authorizations.save", {
      expected_revision: 0,
      grant: grant(h),
    }),
  );
});
test("authorization evaluation fences identity, expiry, roots and unverified engines", async (t) => {
  const h = await setup(t);
  const create = async (g) =>
    (
      await rpc(
        h,
        "operations.execute",
        operation(h, "authorizations.save", { expected_revision: 0, grant: g }),
      )
    ).result;
  const record = await create(grant(h));
  assert.equal(
    (
      await rpc(
        h,
        "authorizations.evaluate",
        action(h, record.id, { agent_id: 999 }),
      )
    ).decision,
    "deny",
  );
  assert.equal(
    (
      await rpc(
        h,
        "authorizations.evaluate",
        action(h, record.id, { project_ids: ["unknown"] }),
      )
    ).decision,
    "deny",
  );
  const expired = await create({ ...grant(h), expires_at: 1 });
  assert.equal(
    (await rpc(h, "authorizations.evaluate", action(h, expired.id))).decision,
    "deny",
  );
  const cli = await create({
    ...grant(h),
    purpose: "cli_start",
    engine_id: "codex",
    operations: ["start"],
  });
  const evaluation = await rpc(
    h,
    "authorizations.evaluate",
    action(h, cli.id, { engine_id: "codex", operation: "start" }),
  );
  assert.equal(evaluation.decision, "needs_user");
  assert.ok(evaluation.missing_capabilities.length);
});
