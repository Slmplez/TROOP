// 2026-11-08: this engine is outside the current four-CLI scope.
// Retain protocol regressions for a future explicit reactivation.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
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
      "copilot_protocol_probe",
    ],
    {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(built.status, 0, built.stderr);
  process.env.COPILOT_PROVIDER_BASE_URL = "http://127.0.0.1:9";
  process.env.COPILOT_MODEL = "owned-protocol-model";
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
async function permission(h) {
  return command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned Copilot ACP peer",
      purpose: "cli_start",
      agent_id: 1,
      engine_id: "copilot",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/copilot_protocol_probe.exe",
      ),
    },
  });
}
const start = (h, grant, goal, tool_mode = "disabled") =>
  command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "copilot",
    tool_mode,
    authorization_id: grant.id,
    goal,
  });
test.skip("Copilot waits for whole-session idle, seals text and reviews the fixed evidence once", async (t) => {
  const h = await setup(t);
  const grant = await permission(h);
  const began = Date.now();
  const run = await start(h, grant, "wait for session idle");
  await until(async () =>
    (await h.get(run.run.id)).run.waiting.includes("review"),
  );
  assert.ok(Date.now() - began >= 1200);
  const task = await h.core.request("agent.task", { id: run.task_id });
  assert.equal(task.evidence.result.text, "Owned Copilot text result");
  assert.equal(task.evidence.result.session_settled, true);
  await command(h, "cli.review", {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted: true,
    note: "Reviewed fixed text",
  });
  assert.equal((await h.get(run.run.id)).run.state, "completed");
});
for (const goal of ["unexpected tool event", "unexpected client operation"])
  test.skip(`Copilot rejects ${goal} and retains an unreplayed uncertain outcome`, async (t) => {
    const h = await setup(t);
    const grant = await permission(h);
    const run = await start(h, grant, goal);
    const outcome = await h.done(run.run.id);
    assert.equal(outcome.run.state, "interrupted");
    const task = await h.core.request("agent.task", { id: run.task_id });
    assert.equal(task.state, "indeterminate");
    assert.equal(task.stopped, true);
    await h.core.stop();
    await h.core.start();
    assert.equal((await h.get(run.run.id)).tasks.length, 1);
    assert.equal(
      (await h.get(run.run.id)).allowed_actions.resume.allowed,
      false,
    );
  });
test.skip("Copilot grant revocation kills the native process and fences later effects", async (t) => {
  const h = await setup(t);
  const grant = await permission(h);
  const run = await start(h, grant, "hold for revoke", "native");
  const runtime = (await h.core.request("agent.task", { id: run.task_id }))
    .permission_plan.engine_runtime_directory;
  await until(() => fs.existsSync(path.join(runtime, "started.txt")));
  await command(h, "authorizations.revoke", {
    id: grant.id,
    expected_revision: grant.revision,
  });
  await h.done(run.run.id);
  const task = await h.core.request("agent.task", { id: run.task_id });
  assert.equal(task.stopped, true);
  assert.equal(fs.existsSync(path.join(runtime, "late.txt")), false);
  await h.core.stop();
  await h.core.start();
  assert.equal((await h.get(run.run.id)).allowed_actions.resume.allowed, false);
  assert.equal((await h.get(run.run.id)).tasks.length, 1);
});

for (const filtered of [false, true])
  test.skip(`Copilot native allow-once is durably decided before the tool proceeds (${filtered ? "filtered" : "named"})`, async (t) => {
    const h = await setup(t),
      grant = await permission(h);
    const run = await start(
      h,
      grant,
      filtered ? "owned approval filtered" : "owned approval",
      "native",
    );
    await until(async () =>
      (await h.get(run.run.id)).run.waiting.includes("review"),
    );
    const requests = (
      await h.core.request("cli.interactions", { task_id: run.task_id })
    ).items;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].kind, "permission");
    assert.equal(requests[0].decision.actor, "authorization");
    assert.equal(requests[0].decision.answer.option_id, "once");
    const task = await h.core.request("agent.task", { id: run.task_id });
    assert.equal(
      fs.readFileSync(
        path.join(
          task.evidence.permission_plan.engine_runtime_directory,
          "approved.txt",
        ),
        "utf8",
      ),
      "owned approved effect",
    );
    assert.equal(requests[0].delivery.write_state, "written");
  });

for (const selected of ["once", "reject", "revoke"])
  test.skip(`Copilot manual permission ${selected} waits for a valid persisted user decision`, async (t) => {
    const h = await setup(t),
      grant = await permission(h);
    const run = await command(h, "cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "copilot",
      tool_mode: "native",
      authorization_id: grant.id,
      approval_mode: "manual",
      goal: "owned approval",
      timeout_seconds: 60,
    });
    const request = await until(
      async () =>
        (await h.core.request("cli.interactions", { task_id: run.task_id }))
          .items[0],
    );
    assert.equal(request.state, "pending");
    const task = await h.core.request("agent.task", { id: run.task_id });
    const marker = path.join(
      task.permission_plan.engine_runtime_directory,
      "approved.txt",
    );
    assert.equal(fs.existsSync(marker), false);
    if (selected === "revoke") {
      await command(h, "authorizations.revoke", {
        id: grant.id,
        expected_revision: grant.revision,
      });
      await h.done(run.run.id);
      const denied = await h.core.request("operations.execute", {
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
      assert.equal(denied.state, "rejected");
      assert.equal(fs.existsSync(marker), false);
      return;
    }
    await command(h, "cli.respond", {
      interaction_id: request.interaction_id,
      expected_revision: request.revision,
      task_epoch: request.task_epoch,
      request_sha256: request.request_sha256,
      answer: { kind: "permission", option_id: selected },
    });
    await until(async () =>
      (await h.get(run.run.id)).run.waiting.includes("review"),
    );
    assert.equal(fs.existsSync(marker), selected === "once");
    const saved = await h.core.request("cli.interaction", {
      interaction_id: request.interaction_id,
    });
    assert.equal(saved.decision.actor, "user");
    assert.equal(saved.decision.answer.option_id, selected);
  });

test.skip("Copilot SDK question transport gates startup idle and records the real question tool", async (t) => {
  const h = await setup(t),
    grant = await permission(h);
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "copilot",
    tool_mode: "native",
    authorization_id: grant.id,
    native_transport: "sdk_questions",
    approval_mode: "manual",
    goal: "owned sdk question",
    timeout_seconds: 60,
  };
  const preview = await h.core.request("cli.preview", input);
  assert.deepEqual(preview.plan.native_tools, ["ask_user"]);
  assert.equal(
    preview.plan.interaction_capabilities.permissions,
    "unavailable",
  );
  const invalid = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "cli.start",
    input: {
      ...input,
      native_transport: "acp",
      expected_plan_sha256: preview.plan_sha256,
    },
  });
  assert.equal(invalid.state, "rejected");
  const run = await command(h, "cli.start", {
    ...input,
    expected_plan_sha256: preview.plan_sha256,
  });
  const request = await until(async () =>
    (
      await h.core.request("cli.interactions", { task_id: run.task_id })
    ).items.find((item) => item.state === "pending"),
  );
  assert.equal((await h.get(run.run.id)).run.waiting.includes("review"), false);
  await command(h, "cli.respond", {
    interaction_id: request.interaction_id,
    expected_revision: request.revision,
    task_epoch: request.task_epoch,
    request_sha256: request.request_sha256,
    answer: { kind: "question", answers: { choice: ["Alpha"] } },
  });
  await until(async () =>
    (await h.get(run.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", { id: run.task_id });
  assert.deepEqual(task.evidence.permission_plan.native_tools, ["ask_user"]);
  assert.equal(task.evidence.result.tool_calls[0].name, "ask_user");
  assert.equal(task.evidence.result.tool_calls[0].is_error, false);
});

test.skip("Copilot SDK question transport rejects an extra native tool before accepting idle", async (t) => {
  const h = await setup(t),
    grant = await permission(h);
  const run = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "copilot",
    tool_mode: "native",
    authorization_id: grant.id,
    native_transport: "sdk_questions",
    goal: "unexpected sdk tool",
    timeout_seconds: 60,
  });
  await h.done(run.run.id);
  const task = await h.core.request("agent.task", { id: run.task_id });
  assert.equal(task.state, "indeterminate");
  assert.equal(task.stopped, true);
});

test.skip("Copilot SDK rejects a user-message identity arriving after the send response", async (t) => {
  const h = await setup(t),
    grant = await permission(h);
  const run = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "copilot",
    tool_mode: "native",
    authorization_id: grant.id,
    native_transport: "sdk_questions",
    goal: "mismatched sdk message",
    timeout_seconds: 60,
  });
  await h.done(run.run.id);
  const task = await h.core.request("agent.task", { id: run.task_id });
  assert.equal(task.state, "indeterminate");
  assert.equal(task.stopped, true);
  assert.equal(
    (await h.core.request("cli.interactions", { task_id: run.task_id })).items
      .length,
    0,
  );
});
