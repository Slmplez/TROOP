const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const contract = require("../contracts/execution.cjs");
const { setup, until, results } = require("./fixtures/hooks-fixture.cjs");
const held = () => [
  {
    name: "write_file",
    arguments: { path: "hold.txt", content: "once", expected_hash: "missing" },
  },
];
async function frame(h, id, cursor = null, resource = "run") {
  const input = { resource, id, cursor };
  contract.validate("agent.follow", input);
  return contract.validate(
    "agent.follow",
    await h.core.request("agent.follow", input),
    true,
  );
}
test("follow first frame binds snapshot and cursor; replay is paged, scoped and repeatable across Core restart", async (t) => {
  const h = await setup(t, { plan: held });
  const id = await h.start();
  await until(async () => (await h.get(id)).invocations.length);
  const baseline = await frame(h, id);
  assert.equal(baseline.state, "snapshot");
  assert.equal(baseline.snapshot.value.run.id, id);
  assert.equal(baseline.generation, h.core.generation);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  const insert = db.prepare(
    "INSERT INTO agent_events(run_id,epoch,kind,payload) VALUES(?,1,'fixture','{}')",
  );
  db.exec("BEGIN");
  for (let i = 0; i < 75; i++) insert.run(id);
  db.exec("COMMIT");
  let cursor = baseline.cursor,
    ids = [],
    pages = 0;
  do {
    const f = await frame(h, id, cursor);
    assert.equal(f.from_cursor, cursor);
    assert.ok(f.changes.length <= 32);
    ids.push(
      ...f.changes
        .filter((c) => c.resource === "event")
        .map((c) => c.resource_id),
    );
    cursor = f.cursor;
    pages++;
    if (!f.has_more) {
      assert.ok(f.snapshot);
      break;
    }
    assert.equal(f.snapshot, null);
  } while (pages < 10);
  assert.equal(ids.length, 75);
  assert.equal(new Set(ids).size, 75);
  assert.ok(pages >= 3);
  const repeat = await frame(h, id, baseline.cursor);
  assert.equal(repeat.changes[0].resource_id, ids[0]);
  await h.core.stop();
  await h.core.start();
  const restored = await frame(h, id, cursor);
  assert.equal(restored.state, "delta");
  assert.notEqual(restored.generation, baseline.generation);
  assert.equal(restored.snapshot.value.run.state, "interrupted");
  const another = await h.start();
  assert.equal((await frame(h, another, cursor)).state, "reset_required");
});
test("retention expiry and missing log entries explicitly reset; refreshed snapshot does not replay execution", async (t) => {
  const h = await setup(t, { plan: held });
  const id = await h.start();
  await until(async () => (await h.get(id)).invocations.length);
  const base = await frame(h, id);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    `WITH RECURSIVE s(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM s WHERE x<4100) INSERT INTO execution_changes(resource,resource_id,run_id,revision) SELECT 'run',${id},${id},0 FROM s`,
  );
  assert.equal((await frame(h, id, base.cursor)).state, "reset_required");
  const fresh = await frame(h, id);
  assert.equal(fresh.state, "snapshot");
  assert.equal((await h.core.request("agent.list")).total, 1);
  assert.equal((await frame(h, id, fresh.cursor)).changes.length, 0);
});
test("large content is chunked at an exact revision and refuses mixed-revision text", async (t) => {
  const h = await setup(t, { plan: held });
  const goal = "a".repeat(10000);
  const id = await h.start({ goal });
  await until(async () => (await h.get(id)).invocations.length);
  const base = await frame(h, id);
  const revision = base.snapshot.value.run.revision;
  assert.equal(base.snapshot.value.run.goal_truncated, true);
  let offset = 0,
    text = "",
    parts = 0;
  do {
    const part = await h.core.request("agent.follow-content", {
      id,
      field: "goal",
      revision,
      offset,
    });
    text += part.text;
    parts++;
    offset = part.next_offset;
  } while (offset !== null);
  assert.equal(text, goal);
  assert.equal(parts, 3);
  await h.core.request("agent.cancel", { id });
  const stale = await h.core.request("agent.follow-content", {
    id,
    field: "goal",
    revision,
    offset: 0,
  });
  assert.equal(stale.state, "reset_required");
  assert.equal(stale.text, "");
});
test("Task follow observes actual owned completion and provides monotonic resource revision", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "start_background",
              arguments: {
                command: "Write-Output 'follow-task'",
                timeout_seconds: "10",
              },
            },
          ],
  });
  const id = await h.start();
  const invocation = await until(async () =>
    (await h.get(id)).invocations.find((i) => i.state === "prepared"),
  );
  await h.core.request("agent.approve", {
    id: invocation.id,
    epoch: invocation.epoch,
    approved: true,
  });
  const task = await until(async () => (await h.get(id)).tasks[0]);
  const initial = await frame(h, task.id, null, "task");
  await h.done(id);
  let final = initial;
  for (let i = 0; i < 10; i++) {
    final = await frame(h, task.id, final.cursor, "task");
    if (!final.has_more) break;
  }
  assert.equal(final.snapshot.value.state, "succeeded");
  assert.ok(final.snapshot.value.revision >= initial.snapshot.value.revision);
  assert.match(JSON.stringify(final.snapshot.value), /follow-task/);
});
