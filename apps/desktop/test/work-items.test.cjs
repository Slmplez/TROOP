const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { setup } = require("./fixtures/hooks-fixture.cjs");
const definition = (h) => ({
  title: "检查发布流程",
  goal: "核对当前项目的发布步骤",
  acceptance: "提交检查结果与依据",
  owner_agent_id: 1,
  workspace_id: h.wid,
  project_id: null,
});
const write = (h, method, input, operation = crypto.randomUUID()) =>
  h.core.request("operations.execute", {
    operation_id: operation,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
test("a work item is created once through the ledger and survives Core restart", async (t) => {
  const h = await setup(t);
  const operation = crypto.randomUUID();
  const input = { expected_revision: 0, item: definition(h) };
  const [first, duplicate] = await Promise.all([
    write(h, "work_items.save", input, operation),
    write(h, "work_items.save", input, operation),
  ]);
  assert.equal(first.state, "committed", JSON.stringify(first.error));
  assert.deepEqual(duplicate, first);
  const item = first.result;
  assert.equal(item.revision, 1);
  assert.equal(item.archived, false);
  assert.equal(item.allowed_actions.save.allowed, true);
  await h.core.stop();
  await h.core.start();
  assert.equal(
    (await h.core.request("work_items.get", { id: item.id })).goal,
    input.item.goal,
  );
  const page = await h.core.request("work_items.list", {});
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, item.id);
});

test("work item revisions fence competing edits and archive restores the same identity", async (t) => {
  const h = await setup(t);
  const first = await write(h, "work_items.save", {
    expected_revision: 0,
    item: definition(h),
  });
  const item = first.result;
  const modified = await write(h, "work_items.save", {
    id: item.id,
    expected_revision: 1,
    item: { ...definition(h), title: "修订发布检查" },
  });
  assert.equal(modified.result.revision, 2);
  const stale = await write(h, "work_items.save", {
    id: item.id,
    expected_revision: 1,
    item: definition(h),
  });
  assert.equal(stale.state, "rejected");
  assert.equal(stale.error.kind, "revision_conflict");
  const archived = await write(h, "work_items.archive", {
    id: item.id,
    expected_revision: 2,
    archived: true,
  });
  assert.equal(archived.result.archived, true);
  assert.equal(archived.result.allowed_actions.save.allowed, false);
  assert.equal((await h.core.request("work_items.list", {})).items.length, 0);
  assert.equal(
    (await h.core.request("work_items.list", { archived: true })).items[0].id,
    item.id,
  );
  const rejected = await write(h, "work_items.save", {
    id: item.id,
    expected_revision: 3,
    item: definition(h),
  });
  assert.equal(rejected.state, "rejected");
  const restored = await write(h, "work_items.archive", {
    id: item.id,
    expected_revision: 3,
    archived: false,
  });
  assert.equal(restored.result.id, item.id);
  assert.equal(restored.result.revision, 4);
});
for (const field of [
  "owner_agent_id",
  "workspace_id",
  "project_id",
  "title",
  "acceptance",
])
  test(`work item rejects invalid ${field} without creating a record`, async (t) => {
    const h = await setup(t);
    const invalid =
      field === "project_id"
        ? "unjoined"
        : field === "title" || field === "acceptance"
          ? " "
          : 999999;
    const result = await write(h, "work_items.save", {
      expected_revision: 0,
      item: { ...definition(h), [field]: invalid },
    });
    assert.equal(result.state, "rejected");
    assert.equal((await h.core.request("work_items.list", {})).items.length, 0);
  });
test("work item pages keep stable identities when another item is added", async (t) => {
  const h = await setup(t);
  for (let index = 0; index < 23; index++)
    assert.equal(
      (
        await write(h, "work_items.save", {
          expected_revision: 0,
          item: { ...definition(h), title: `检查 ${index}` },
        })
      ).state,
      "committed",
    );
  const first = await h.core.request("work_items.list", {
    owner_agent_id: 1,
    workspace_id: h.wid,
  });
  assert.equal(first.items.length, 20);
  await write(h, "work_items.save", {
    expected_revision: 0,
    item: definition(h),
  });
  const second = await h.core.request("work_items.list", {
    before: first.next_before,
    owner_agent_id: 1,
  });
  assert.equal(second.items.length, 3);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
    23,
  );
});
