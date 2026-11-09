const { before } = require("node:test");
const { sandboxTest: test } = require("./fixtures/sandbox-support.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
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
      "opencode_protocol_probe",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(built.status, 0, built.stderr);
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
test("OpenCode binds only the selected existing model settings and seals its owned ACP result", async (t) => {
  const h = await setup(t);
  const file = path.join(h.directory, "model-settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      model: "owned/fixture",
      provider: {
        owned: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://127.0.0.1:9/v1",
            apiKey: "TROOP_OPENCODE_TEST_CREDENTIAL",
          },
          models: {
            fixture: {
              name: "Owned model",
              limit: { context: 32768, output: 4096 },
            },
          },
        },
      },
      plugin: ["must-not-load"],
      mcp: { unselected: { command: ["must-not-run"], type: "local" } },
    }),
  );
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned OpenCode settings",
      purpose: "cli_start",
      engine_id: "opencode",
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
        "../../../target/debug/examples/opencode_protocol_probe.exe",
      ),
      model_settings: { file },
    },
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "opencode",
    tool_mode: "disabled",
    authorization_id: grant.id,
    goal: "Produce the owned text-only result",
  });
  await until(async () =>
    (await h.get(started.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", { id: started.task_id });
  assert.equal(task.evidence.result.text, "Owned OpenCode text result");
  assert.equal(
    JSON.stringify(task).includes("TROOP_OPENCODE_TEST_CREDENTIAL"),
    false,
  );
  assert.equal(
    JSON.stringify(grant).includes("TROOP_OPENCODE_TEST_CREDENTIAL"),
    false,
  );
  await command(h, "cli.review", {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted: true,
    note: "Inspected owned text output",
  });
  assert.equal((await h.get(started.run.id)).run.state, "completed");
});
test("OpenCode blocks an ancestor configuration outside the read grant before dispatch", async (t) => {
  const h = await setup(t);
  const file = path.join(h.directory, "opencode.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      model: "owned/fixture",
      provider: {
        owned: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://127.0.0.1:9/v1",
            apiKey: "TROOP_OPENCODE_TEST_CREDENTIAL",
          },
          models: { fixture: { limit: { context: 32768, output: 4096 } } },
        },
      },
    }),
  );
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned OpenCode ancestor boundary",
      purpose: "cli_start",
      engine_id: "opencode",
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
        "../../../target/debug/examples/opencode_protocol_probe.exe",
      ),
      model_settings: { file },
    },
  });
  const receipt = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "cli.start",
    input: {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "opencode",
      tool_mode: "disabled",
      authorization_id: grant.id,
      goal: "Owned ancestor boundary",
    },
  });
  assert.equal(receipt.state, "rejected");
  assert.match(receipt.error.message, /上级目录|读取授权/);
  assert.equal((await h.core.request("agent.list", {})).items.length, 0);
});
test("OpenCode resolves only explicitly authorized environment references without saving credential values", async (t) => {
  process.env.TROOP_OPENCODE_TEST_API_KEY = "TROOP_OPENCODE_TEST_CREDENTIAL";
  const h = await setup(t);
  t.after(() => {
    delete process.env.TROOP_OPENCODE_TEST_API_KEY;
  });
  const file = path.join(h.directory, "model-settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      model: "owned/fixture",
      provider: {
        owned: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://127.0.0.1:9/v1",
            apiKey: "{env:TROOP_OPENCODE_TEST_API_KEY}",
          },
          models: { fixture: { limit: { context: 32768, output: 4096 } } },
        },
      },
    }),
  );
  const definition = {
    name: "Owned OpenCode environment",
    purpose: "cli_start",
    engine_id: "opencode",
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
      "../../../target/debug/examples/opencode_protocol_probe.exe",
    ),
    model_settings: { file },
  };
  const denied = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "authorizations.save",
    input: { expected_revision: 0, grant: definition },
  });
  assert.equal(denied.state, "rejected");
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      ...definition,
      credential_env_keys: ["TROOP_OPENCODE_TEST_API_KEY"],
    },
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "opencode",
    tool_mode: "disabled",
    authorization_id: grant.id,
    goal: "Return the owned environment-configured result",
  });
  await until(async () =>
    (await h.get(started.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", { id: started.task_id });
  assert.equal(task.evidence.result.text, "Owned OpenCode text result");
  assert.equal(
    task.evidence.permission_plan.model_selection.credential_env_key,
    "TROOP_OPENCODE_TEST_API_KEY",
  );
  assert.equal(
    JSON.stringify(task).includes("TROOP_OPENCODE_TEST_CREDENTIAL"),
    false,
  );
  assert.equal(
    fs.readFileSync(file, "utf8").includes("TROOP_OPENCODE_TEST_CREDENTIAL"),
    false,
  );
});

async function approvalFixture(t, mode) {
  const h = await setup(t);
  const file = path.join(h.directory, "approval-model.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      model: "owned/fixture",
      provider: {
        owned: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://127.0.0.1:9/v1",
            apiKey: "TROOP_OPENCODE_TEST_CREDENTIAL",
          },
          models: { fixture: { limit: { context: 32768, output: 4096 } } },
        },
      },
    }),
  );
  const shell = require("node:child_process").spawnSync(
    "where.exe",
    ["pwsh.exe"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(shell.status, 0);
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned correlated approval",
      purpose: "cli_start",
      engine_id: "opencode",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [
        h.workspace,
        path.dirname(shell.stdout.trim().split(/\r?\n/)[0]),
      ],
      write_roots: [h.workspace],
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/opencode_protocol_probe.exe",
      ),
      model_settings: { file },
    },
  });
  fs.writeFileSync(path.join(h.workspace, "approval-case"), mode);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "opencode",
    tool_mode: "native",
    approval_mode: "manual",
    authorization_id: grant.id,
    goal: "Owned correlated approval",
  });
  return { h, started };
}
test("OpenCode correlates empty approval parameters with the same tool update before allowing once", async (t) => {
  const { h, started } = await approvalFixture(t, "correlated");
  const request = await until(
    async () =>
      (await h.core.request("cli.interactions", { task_id: started.task_id }))
        .items[0],
  );
  assert.equal(request.allowed_actions.approve.allowed, true);
  assert.deepEqual(request.body.tool_call.rawInput, {
    path: "approved.txt",
    content: "owned approved effect",
  });
  assert.equal(fs.existsSync(path.join(h.workspace, "approved.txt")), false);
  await command(h, "cli.respond", {
    interaction_id: request.interaction_id,
    expected_revision: request.revision,
    task_epoch: request.task_epoch,
    request_sha256: request.request_sha256,
    answer: { kind: "permission", option_id: "once" },
  });
  await until(async () =>
    (await h.get(started.run.id)).run.waiting.includes("review"),
  );
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "approved.txt"), "utf8"),
    "owned approved effect",
  );
});

test("OpenCode merges compatible partial approval parameters with the same tool update before allowing once", async (t) => {
  const { h, started } = await approvalFixture(t, "partial");
  const request = await until(
    async () =>
      (await h.core.request("cli.interactions", { task_id: started.task_id }))
        .items[0],
  );
  assert.equal(request.allowed_actions.approve.allowed, true);
  assert.deepEqual(request.body.tool_call.rawInput, {
    path: "approved.txt",
    content: "owned approved effect",
  });
  assert.equal(fs.existsSync(path.join(h.workspace, "approved.txt")), false);
  await command(h, "cli.respond", {
    interaction_id: request.interaction_id,
    expected_revision: request.revision,
    task_epoch: request.task_epoch,
    request_sha256: request.request_sha256,
    answer: { kind: "permission", option_id: "once" },
  });
  await until(async () =>
    (await h.get(started.run.id)).run.waiting.includes("review"),
  );
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "approved.txt"), "utf8"),
    "owned approved effect",
  );
});

for (const mode of ["missing", "unrelated", "outside", "oversized"])
  test(`OpenCode correlated approval blocks ${mode} parameters`, async (t) => {
    const { h, started } = await approvalFixture(t, mode);
    const request = await until(
      async () =>
        (await h.core.request("cli.interactions", { task_id: started.task_id }))
          .items[0],
    );
    assert.equal(request.allowed_actions.approve.allowed, false);
    await command(h, "cli.respond", {
      interaction_id: request.interaction_id,
      expected_revision: request.revision,
      task_epoch: request.task_epoch,
      request_sha256: request.request_sha256,
      answer: { kind: "permission", option_id: "reject" },
    });
    await until(async () =>
      (await h.get(started.run.id)).run.waiting.includes("review"),
    );
    assert.equal(fs.existsSync(path.join(h.workspace, "approved.txt")), false);
  });
test("OpenCode conflicting nonempty approval parameters require reconciliation", async (t) => {
  const { h, started } = await approvalFixture(t, "conflict");
  const done = await h.done(started.run.id);
  assert.equal(done.tasks[0].state, "indeterminate");
  const task = await h.core.request("agent.task", { id: started.task_id });
  assert.match(JSON.stringify(task.result), /冲突/);
  assert.equal(fs.existsSync(path.join(h.workspace, "approved.txt")), false);
});

test("OpenCode enriched approval is fenced by grant revocation", async (t) => {
  const { h, started } = await approvalFixture(t, "correlated");
  const request = await until(
    async () =>
      (await h.core.request("cli.interactions", { task_id: started.task_id }))
        .items[0],
  );
  assert.equal(request.allowed_actions.approve.allowed, true);
  const grant = await h.core.request("authorizations.get", {
    id: request.authorization_id,
  });
  await command(h, "authorizations.revoke", {
    id: grant.id,
    expected_revision: grant.revision,
  });
  await h.done(started.run.id);
  const receipt = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "cli.respond",
    input: {
      interaction_id: request.interaction_id,
      expected_revision: request.revision,
      task_epoch: request.task_epoch,
      request_sha256: request.request_sha256,
      answer: { kind: "permission", option_id: "once" },
    },
  });
  assert.equal(receipt.state, "rejected");
  assert.equal(fs.existsSync(path.join(h.workspace, "approved.txt")), false);
});

for (const mode of ["terminal-reopen", "terminal-evicted", "unfinished-tail"])
  test(`OpenCode refuses ${mode} before a stale approval or incomplete result can be accepted`, async (t) => {
    const { h, started } = await approvalFixture(t, mode);
    const task = await until(async () => {
      const current = await h.core.request("agent.task", {
        id: started.task_id,
      });
      const interactions = await h.core.request("cli.interactions", {
        task_id: started.task_id,
      });
      return [
        "awaiting_review",
        "indeterminate",
        "failed",
        "completed",
        "cancelled",
      ].includes(current.state) || interactions.items.length
        ? current
        : false;
    });
    assert.equal(task.state, "indeterminate");
    assert.equal(task.allowed_actions.review.allowed, false);
    assert.equal(fs.existsSync(path.join(h.workspace, "approved.txt")), false);
  });
test("OpenCode still seals a completed native call beyond the display budget", async (t) => {
  const { h, started } = await approvalFixture(t, "finished-tail");
  await until(async () =>
    (await h.get(started.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", { id: started.task_id });
  assert.equal(task.evidence.result.tool_call_count, 33);
  assert.equal(task.evidence.result.tool_calls.length, 32);
});
