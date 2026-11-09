const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { support } = require("./fixtures/sandbox-support.cjs");
const { setup } = require("./fixtures/hooks-fixture.cjs");

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
