// 2026-11-08: this engine is outside the current four-CLI scope.
// Retain protocol regressions for a future explicit reactivation.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");
before(() => {
  const built = require("node:child_process").spawnSync(
    "cargo",
    [
      "build",
      "--offline",
      "--locked",
      "-p",
      "troop-core",
      "--example",
      "grok_protocol_probe",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(built.status, 0, built.stderr);
  process.env.GROK_MODELS_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.GROK_DEFAULT_MODEL = "owned-grok-model";
  process.env.XAI_API_KEY = "TROOP_GROK_TEST_CREDENTIAL";
  process.env.TROOP_GROK_TEST_API_KEY = "TROOP_GROK_TEST_CREDENTIAL";
  process.env.TROOP_UNSELECTED_API_KEY = "must-not-inherit";
});
async function command(h, method, input) {
  const receipt = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return receipt.result;
}
test.skip("Grok uses an explicit model destination and credential reference in its owned text session", async (t) => {
  const h = await setup(t);
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned Grok text",
      purpose: "cli_start",
      engine_id: "grok",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["start"],
      credential_env_keys: ["TROOP_GROK_TEST_API_KEY"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/grok_protocol_probe.exe",
      ),
    },
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "grok",
    tool_mode: "disabled",
    authorization_id: grant.id,
    goal: "Return the owned text result",
  });
  await until(async () =>
    (await h.get(started.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", { id: started.task_id });
  assert.equal(task.evidence.result.text, "Owned Grok text result");
  assert.equal(
    JSON.stringify(task).includes("TROOP_GROK_TEST_CREDENTIAL"),
    false,
  );
  await command(h, "cli.review", {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted: true,
    note: "Inspected the owned text",
  });
  assert.equal((await h.get(started.run.id)).run.state, "completed");
});
test.skip("Grok native mode records admitted tool results in the same fixed review contract", async (t) => {
  const h = await setup(t);
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned Grok native",
      purpose: "cli_start",
      engine_id: "grok",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["start"],
      credential_env_keys: ["XAI_API_KEY"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/grok_protocol_probe.exe",
      ),
    },
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "grok",
    tool_mode: "native",
    authorization_id: grant.id,
    goal: "Return the owned native file result",
  });
  await until(async () =>
    (await h.get(started.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", { id: started.task_id });
  assert.equal(task.evidence.result.tools_disabled, false);
  assert.equal(task.evidence.result.tool_calls[0].name, "read_file");
  assert.equal(task.evidence.result.tool_calls[0].is_error, false);
});
