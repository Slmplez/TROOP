const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("CI setup failure removes stale reports and records this run's environment error", (t) => {
  const app = path.resolve(__dirname, "..");
  const parent = path.resolve(app, "../../.tmp-ci-startup");
  fs.mkdirSync(parent, { recursive: true });
  const folder = fs.mkdtempSync(path.join(parent, "case-"));
  t.after(() => {
    assert.equal(path.dirname(folder), parent);
    fs.rmSync(folder, { recursive: true, force: true });
  });
  for (const name of ["desktop.junit.xml", "skips.jsonl"]) {
    fs.writeFileSync(path.join(folder, name), "OWNED_PREVIOUS_RUN");
  }
  fs.writeFileSync(
    path.join(folder, "environment.json"),
    JSON.stringify({ previous_run: true }),
  );
  const preload = path.join(folder, "probe-failure.cjs");
  fs.writeFileSync(
    preload,
    `
const Module = require('node:module');
const load = Module._load;
Module._load = function(request) {
  if (request.includes('fixtures/sandbox-support.cjs')) throw Error('OWNED_FAILED_PROBE');
  return load.apply(this, arguments);
};
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--require", preload, path.join(app, "scripts/test-ci.mjs")],
    {
      cwd: app,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, TROOP_CI_REPORT_DIR: folder },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(path.join(folder, "desktop.junit.xml")), false);
  assert.equal(fs.existsSync(path.join(folder, "skips.jsonl")), false);
  const environment = JSON.parse(
    fs.readFileSync(path.join(folder, "environment.json"), "utf8"),
  );
  assert.equal(environment.previous_run, undefined);
  assert.equal(environment.node, process.version);
  assert.equal(environment.setup_error, "OWNED_FAILED_PROBE");
});
