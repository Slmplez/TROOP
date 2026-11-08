const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");
before(() => {
  const result = require("node:child_process").spawnSync(
    "cargo",
    [
      "build",
      "--offline",
      "--locked",
      "-p",
      "troop-core",
      "--example",
      "claude_protocol_probe",
    ],
    {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr);
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
for (const native of [false, true])
  test(`Claude uses bound settings and seals ${native ? "33 complete tools" : "text"} without public credentials`, async (t) => {
    const h = await setup(t);
    const shell = require("node:child_process").spawnSync(
      "where.exe",
      ["pwsh.exe"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(shell.status, 0);
    const shellRoot = path.dirname(shell.stdout.trim().split(/\r?\n/)[0]);
    const file = path.join(h.directory, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          ANTHROPIC_MODEL: "owned-claude-model",
          ANTHROPIC_AUTH_TOKEN: "TROOP_CLAUDE_TEST_CREDENTIAL",
          TROOP_UNSELECTED_TOKEN: "bad",
        },
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "must not run" }] },
          ],
        },
      }),
    );
    const grant = await command(h, "authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "Configured Claude text",
        purpose: "cli_start",
        engine_id: "claude",
        agent_id: 1,
        workspace_id: h.wid,
        project_ids: [],
        read_roots: [h.workspace, ...(native ? [shellRoot] : [])],
        write_roots: [h.workspace],
        operations: ["start"],
        network: "any",
        expires_at: Math.floor(Date.now() / 1000) + 300,
        program: path.resolve(
          __dirname,
          "../../../target/debug/examples/claude_protocol_probe.exe",
        ),
        model_settings: { file },
      },
    });
    const started = await command(h, "cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "claude",
      tool_mode: native ? "native" : "disabled",
      authorization_id: grant.id,
      goal: native
        ? "33 complete tools"
        : "Return the owned synthetic text answer",
    });
    await until(async () =>
      (await h.get(started.run.id)).run.waiting.includes("review"),
    );
    const task = await h.core.request("agent.task", { id: started.task_id });
    assert.equal(task.evidence.result.text, "Owned Claude text result");
    if (native) {
      assert.equal(task.evidence.result.tool_call_count, 33);
      assert.equal(task.evidence.result.tool_calls.length, 32);
    }
    assert.equal(
      task.evidence.permission_plan.model_selection.source_sha256,
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    );
    assert.equal(
      JSON.stringify(task).includes("TROOP_CLAUDE_TEST_CREDENTIAL"),
      false,
    );
    assert.equal(
      JSON.stringify(grant).includes("TROOP_CLAUDE_TEST_CREDENTIAL"),
      false,
    );
  });

test("Claude rejects an unowned background task and retains an uncertain result for reconciliation", async (t) => {
  const h = await setup(t);
  const file = path.join(h.directory, "settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        ANTHROPIC_MODEL: "owned-claude-model",
        ANTHROPIC_AUTH_TOKEN: "TROOP_CLAUDE_TEST_CREDENTIAL",
      },
    }),
  );
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned Claude lifecycle",
      purpose: "cli_start",
      engine_id: "claude",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/claude_protocol_probe.exe",
      ),
      model_settings: { file },
    },
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "claude",
    tool_mode: "disabled",
    authorization_id: grant.id,
    goal: "unexpected background task",
  });
  const result = await until(async () => {
    const value = await h.get(started.run.id);
    return value.run.waiting.includes("review") ||
      ["failed", "interrupted"].includes(value.run.state)
      ? value
      : false;
  });
  assert.equal(result.run.state, "interrupted");
  const task = await h.core.request("agent.task", { id: started.task_id });
  assert.equal(task.state, "indeterminate");
  assert.equal(task.stopped, true);
});
