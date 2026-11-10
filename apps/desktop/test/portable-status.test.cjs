const { test } = require("node:test");
const assert = require("node:assert/strict");

test("portable startup status survives only a destroyed navigation context", async () => {
  const { readPortableStatus } = await import("../scripts/portable-status.mjs");
  let calls = 0;
  const evaluate = async (expression) => {
    assert.equal(expression, "window.troop?.status()");
    if (++calls === 1) throw Error("Execution context was destroyed.");
    return { state: "ready", pid: 123, storage_instance: "owned" };
  };
  assert.equal(await readPortableStatus(evaluate), undefined);
  assert.deepEqual(await readPortableStatus(evaluate), {
    state: "ready",
    pid: 123,
    storage_instance: "owned",
  });
});

test("portable startup preserves Core faults and other CDP failures", async () => {
  const { readPortableStatus } = await import("../scripts/portable-status.mjs");
  const fault = { state: "faulted", error: "owned failure" };
  assert.equal(await readPortableStatus(async () => fault), fault);
  const failure = Error("Owned CDP request failed");
  await assert.rejects(
    readPortableStatus(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});
