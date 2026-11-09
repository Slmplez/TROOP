const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { support } = require("./fixtures/sandbox-support.cjs");
const { setup } = require("./fixtures/hooks-fixture.cjs");

test(
  "only documented successful MXC probe outcomes can describe capability availability",
  {
    skip:
      process.platform !== "win32" || process.arch !== "x64"
        ? "Windows x64 probe validation"
        : false,
  },
  () => {
    const fixture = path.resolve(__dirname, "fixtures/sandbox-support.cjs");
    for (const capabilities of [
      { tier: "base-container" },
      { tier: "appcontainer-bfs" },
      { tier: "appcontainer-dacl" },
      {
        probes: { baseContainerApiPresent: false },
        error: "DACL fallback required but fallback.allowDaclMutation is false",
      },
    ]) {
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `
const assert = require('node:assert/strict');
require('node:child_process').spawnSync = () => ({status:0, stdout:${JSON.stringify(JSON.stringify(capabilities))}});
const support = require(${JSON.stringify(fixture)}).support;
assert.equal(support.available, ${capabilities.tier === "base-container"});
assert.equal(Boolean(support.reason), ${capabilities.tier !== "base-container"});
`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      assert.equal(child.status, 0, child.stderr);
    }
  },
);

test(
  "failed and unknown MXC probe results cannot become normal capability skips",
  {
    skip:
      process.platform !== "win32" || process.arch !== "x64"
        ? "Windows x64 probe validation"
        : false,
  },
  () => {
    const fixture = path.resolve(__dirname, "fixtures/sandbox-support.cjs");
    for (const result of [
      { status: 1, stdout: '{"tier":"base-container"}' },
      { status: 1, stdout: '{"tier":"appcontainer-dacl"}' },
      { status: null, stdout: '{"tier":"base-container"}' },
      { status: 0, stdout: '{"tier":"unknown"}' },
      {
        status: 0,
        stdout:
          '{"error":"unexpected failure","probes":{"baseContainerApiPresent":false}}',
      },
      {
        status: 0,
        stdout: '{"tier":"base-container","error":"unexpected failure"}',
      },
      {
        status: 0,
        stdout:
          '{"error":"DACL fallback required but fallback.allowDaclMutation is false","probes":{"baseContainerApiPresent":true}}',
      },
    ]) {
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `
require('node:child_process').spawnSync = () => (${JSON.stringify(result)});
try { require(${JSON.stringify(fixture)}); process.exitCode = 2; }
catch (error) { process.exitCode = /probe/i.test(error.message) ? 0 : 3; }
`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      assert.equal(
        child.status,
        0,
        JSON.stringify({ result, stderr: child.stderr }),
      );
    }
  },
);

test(
  "Core refuses a scoped Shell grant on a host without verified BaseContainer support",
  {
    skip:
      process.platform !== "win32"
        ? "Windows capability refusal acceptance"
        : support.available &&
          "This host has BaseContainer; positive native containment cases run instead",
  },
  async (t) => {
    const h = await setup(t);
    const receipt = await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "authorizations.save",
      input: {
        expected_revision: 0,
        grant: {
          name: "Unsupported host refusal",
          purpose: "tool_call",
          agent_id: 1,
          engine_id: "native",
          workspace_id: h.wid,
          project_ids: [],
          read_roots: [h.workspace],
          write_roots: [h.workspace],
          operations: ["run_command"],
          network: "none",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          rule_id: null,
          shell: {},
        },
      },
    });
    assert.equal(receipt.state, "rejected");
    assert.match(receipt.error.message, /BaseContainer|MXC/);
    assert.equal(
      (await h.core.request("authorizations.list", {})).items.length,
      0,
    );
    assert.equal((await h.core.request("agent.list", {})).items.length, 0);
  },
);
