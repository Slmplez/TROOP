const { test } = require("node:test");
const assert = require("node:assert/strict");

test("CI reporter preserves skip reasons, source locations and native summaries", async () => {
  const { default: report } = await import("../scripts/ci-skips.mjs");
  const events = [
    { type: "test:pass", data: { name: "passed" } },
    {
      type: "test:pass",
      data: {
        name: "sandbox",
        file: "test.cjs",
        line: 12,
        skip: "Windows runtime unavailable",
      },
    },
    {
      type: "test:pass",
      data: { name: "legacy scope", file: "test.cjs", line: 20, skip: true },
    },
    {
      type: "test:summary",
      data: { file: "test.cjs", counts: { tests: 3, skipped: 2 } },
    },
    {
      type: "test:summary",
      data: { counts: { tests: 3, skipped: 2 }, success: true },
    },
  ];
  const rows = [];
  for await (const line of report(events)) rows.push(JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    type: "skip",
    name: "sandbox",
    file: "test.cjs",
    line: 12,
    reason: "Windows runtime unavailable",
  });
  assert.match(rows[1].reason, /Explicit skip/);
  assert.equal(rows[2].file, "test.cjs");
  assert.equal(rows[3].success, true);
  assert.equal(rows[3].counts.skipped, 2);
});
