const { test, before } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  path = require("node:path");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");
const { DatabaseSync } = require("node:sqlite");
const { once } = require("node:events");
const fs = require("node:fs");
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
      "cli_protocol_probe",
      "--example",
      "omp_protocol_probe",
      "--example",
      "pi_protocol_probe",
    ],
    {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
const command = (h, method, input) =>
  h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
async function grant(h, extra = {}) {
  const result = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned CLI fixture",
      purpose: "cli_start",
      agent_id: 1,
      engine_id: "codex",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/cli_protocol_probe.exe",
      ),
      ...extra,
    },
  });
  assert.equal(result.state, "committed", JSON.stringify(result.error));
  return result.result;
}

for (const revoked of [false, true])
  test(`an event rule ${revoked ? "blocks a revoked CLI grant" : "starts one authorized CLI task and retains review evidence"}`, async (t) => {
    const h = await setup(t);
    const ruleId = crypto.randomUUID();
    const permission = await grant(h, {
      engine_id: "pi",
      rule_id: ruleId,
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/pi_protocol_probe.exe",
      ),
    });
    const saved = await command(h, "rules.save", {
      id: ruleId,
      expected_revision: 0,
      rule: {
        name: "Owned CLI event rule",
        enabled: true,
        event: "run.completed",
        workspace_id: h.wid,
        source_run_id: null,
        expires_at: permission.expires_at,
        start: {
          client_run_id: crypto.randomUUID(),
          workspace_id: h.wid,
          engine_id: "pi",
          tool_mode: "disabled",
          authorization_id: permission.id,
          rule_id: ruleId,
          goal: "Owned event CLI text task",
        },
      },
    });
    assert.equal(saved.state, "committed", JSON.stringify(saved.error));
    assert.equal(saved.result.start.agent_id, 1);
    assert.deepEqual(saved.result.start.project_ids, []);
    assert.equal(saved.result.start.timeout_seconds, 3600);
    if (revoked)
      await command(h, "authorizations.revoke", {
        id: permission.id,
        expected_revision: permission.revision,
      });
    const source = await h.start();
    await h.done(source);
    const delivery = await until(
      async () =>
        (await h.core.request("rules.history", { id: ruleId })).deliveries[0],
    );
    assert.equal(
      delivery.state,
      revoked ? "skipped" : "dispatched",
      JSON.stringify(delivery),
    );
    if (revoked) {
      assert.match(delivery.reason, /撤销|变化/);
      assert.equal((await h.core.request("agent.list", {})).items.length, 1);
      return;
    }
    await until(async () =>
      (await h.get(delivery.run_id)).run.waiting.includes("review"),
    );
    const run = await h.get(delivery.run_id);
    assert.equal(run.run.kind, "external_cli");
    assert.equal(run.run.trigger.rule_id, ruleId);
    assert.equal(run.run.rule_id, ruleId);
    const task = await h.core.request("agent.task", { id: run.tasks[0].id });
    assert.equal(
      task.evidence.permission_plan.grant_revision,
      permission.revision,
    );
    assert.equal(task.evidence.result.text, "Owned Pi text result");
    await h.core.stop();
    await h.core.start();
    assert.equal((await h.get(delivery.run_id)).tasks.length, 1);
    assert.equal(
      (await h.core.request("rules.history", { id: ruleId })).deliveries.length,
      1,
    );
    const reviewed = await command(h, "cli.review", {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: task.evidence.sha256,
      accepted: true,
      note: "Inspected event task",
    });
    assert.equal(reviewed.state, "committed", JSON.stringify(reviewed.error));
  });

test("CLI receives scoped memory with immutable delivery evidence and excludes unselected projects", async (t) => {
  const h = await setup(t);
  for (const project of ["selected", "other"])
    await h.core.request("memory.membership", {
      agent_id: 1,
      project,
      action: "create",
    });
  for (const [scope, project, content] of [
    ["agent", "", "TROOP_PRIVATE_CLI_CONTEXT"],
    ["project", "selected", "TROOP_SELECTED_CLI_CONTEXT"],
    ["project", "other", "TROOP_UNSELECTED_CLI_CONTEXT"],
  ])
    await h.core.request("memory.write", {
      agent_id: 1,
      scope,
      project,
      tier: "profile",
      content,
    });
  const permission = await grant(h, {
    engine_id: "pi",
    project_ids: ["selected"],
    program: path.resolve(
      __dirname,
      "../../../target/debug/examples/pi_protocol_probe.exe",
    ),
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "pi",
    tool_mode: "disabled",
    authorization_id: permission.id,
    project_ids: ["selected"],
    goal: "check delegated memory",
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.evidence.result.text, "Owned scoped CLI memory received");
  assert.equal(task.evidence.context_delivery.sources.length, 2);
  assert.equal(task.evidence.context_delivery.adoption, "unproven");
  const usage = await h.core.request("memory.usage", {
    run_id: started.result.run.id,
  });
  assert.equal(usage.evidence, "prepared_cli_prompt");
  assert.deepEqual(usage.items, task.evidence.context_delivery.sources);
  const ids = task.evidence.context_delivery.sources.map(
    (source) => source.memory_id,
  );
  const facts = (await h.core.request("memory.list", { agent_id: 1 })).items;
  assert.equal(
    ids.includes(
      facts.find((fact) => fact.content === "TROOP_UNSELECTED_CLI_CONTEXT").id,
    ),
    false,
  );
});

test("forgetting a delivered fact stops the active CLI and prevents automatic continuation", async (t) => {
  const h = await setup(t);
  await h.core.request("memory.write", {
    agent_id: 1,
    scope: "agent",
    tier: "profile",
    content: "TROOP_DELIVERED_PRIVATE_FACT",
  });
  const fact = (await h.core.request("memory.list", { agent_id: 1 })).items[0];
  const permission = await grant(h, {
    engine_id: "pi",
    program: path.resolve(
      __dirname,
      "../../../target/debug/examples/pi_protocol_probe.exe",
    ),
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "pi",
    tool_mode: "disabled",
    authorization_id: permission.id,
    goal: "wait for settled",
  });
  assert.equal(started.state, "committed");
  await until(async () =>
    (await h.get(started.result.run.id)).run.output.includes(
      "Owned Pi text result",
    ),
  );
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: fact.id,
    expected_revision: fact.revision,
    content: null,
  });
  const stopped = await until(async () => {
    const value = await h.get(started.result.run.id);
    return (
      ["failed", "cancelled", "interrupted"].includes(value.run.state) && value
    );
  });
  assert.match(stopped.run.error, /记忆|上下文/);
  assert.equal(stopped.allowed_actions.resume.allowed, false);
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.stopped, true);
});

test("accepted CLI evidence queues independent memory maintenance once through its review receipt", async (t) => {
  const h = await setup(t, {
    reply: () =>
      '{"additions":[{"content":"Release checks run on Sundays","tier":"profile"}],"removals":[]}',
  });
  const agent = (await h.core.request("memory.agents", {}))[0];
  await h.core.request("memory.agent.save", {
    id: 1,
    name: agent.name,
    automatic: true,
    dreaming: false,
    expected_revision: agent.revision,
  });
  assert.equal(
    (
      await command(h, "memory.maintenance.save", {
        agent_id: 1,
        expected_revision: 0,
        enabled: true,
        provider_id: h.provider.id,
        model: "independent-release-maintainer",
        target_scope: "agent",
        target_project: "",
      })
    ).state,
    "committed",
  );
  const permission = await grant(h, {
    engine_id: "pi",
    program: path.resolve(
      __dirname,
      "../../../target/debug/examples/pi_protocol_probe.exe",
    ),
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "pi",
    tool_mode: "disabled",
    authorization_id: permission.id,
    goal: "Complete this synthetic release task. Release checks run on Sundays.",
  });
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  assert.equal(
    (await h.core.request("memory.jobs", { agent_id: 1 })).length,
    0,
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  const review = {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "cli.review",
    input: {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: task.evidence.sha256,
      accepted: true,
      note: "Inspected synthetic release result",
    },
  };
  assert.equal(
    (await h.core.request("operations.execute", review)).state,
    "committed",
  );
  assert.equal(
    (await h.core.request("operations.execute", review)).state,
    "committed",
  );
  const job = await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find(
      (entry) => entry.state === "completed",
    ),
  );
  assert.equal(job.source_run_id, started.result.run.id);
  assert.equal(
    (await h.core.request("memory.jobs", { agent_id: 1 })).length,
    1,
  );
  assert.equal(
    (await h.core.request("memory.list", { agent_id: 1 })).items[0].content,
    "Release checks run on Sundays",
  );
});

test("large workspace baseline metadata stays bounded and reports incomplete coverage without blocking the CLI", async (t) => {
  const h = await setup(t);
  for (let index = 0; index < 100; index++)
    fs.writeFileSync(
      path.join(h.workspace, `entry-${index}-${"x".repeat(140)}.txt`),
      "owned",
    );
  const permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "write owned output",
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.evidence.coverage_complete, false);
});

test("a committed CLI review survives a crash before memory maintenance is enqueued", async (t) => {
  const h = await setup(t, {
    reply: () =>
      '{"additions":[{"content":"Release checks run on Sundays","tier":"profile"}],"removals":[]}',
  });
  const agent = (await h.core.request("memory.agents", {}))[0];
  await h.core.request("memory.agent.save", {
    id: 1,
    name: agent.name,
    automatic: true,
    dreaming: false,
    expected_revision: agent.revision,
  });
  await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    provider_id: h.provider.id,
    model: "independent-release-maintainer",
    target_scope: "agent",
    target_project: "",
  });
  const permission = await grant(h, {
    engine_id: "pi",
    program: path.resolve(
      __dirname,
      "../../../target/debug/examples/pi_protocol_probe.exe",
    ),
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "pi",
    tool_mode: "disabled",
    authorization_id: permission.id,
    goal: "Complete synthetic release work. Release checks run on Sundays.",
  });
  const run = started.result.run.id;
  await until(async () => (await h.get(run)).run.waiting.includes("review"));
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TRIGGER memory_enqueue_fault BEFORE INSERT ON memory_evidence BEGIN SELECT RAISE(ABORT,'owned-enqueue-fault'); END",
  );
  const operation_id = crypto.randomUUID();
  const instance_id = h.core.snapshot().storage_instance;
  const exited = once(h.core.child, "exit");
  await h.core.request("operations.execute", {
    operation_id,
    instance_id,
    method: "cli.review",
    input: {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: task.evidence.sha256,
      accepted: true,
      note: "Inspected the fixed result before queue interruption",
    },
  });
  await exited;
  db.exec("DROP TRIGGER memory_enqueue_fault");
  db.close();
  await h.core.start();
  assert.equal(
    (await h.core.request("operations.get", { operation_id, instance_id }))
      .state,
    "committed",
  );
  assert.equal((await h.get(run)).run.state, "completed");
  const job = await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find(
      (entry) => entry.source_run_id === run && entry.state === "completed",
    ),
  );
  assert.ok(job.id > 0);
  assert.equal(
    (await h.core.request("memory.jobs", { agent_id: 1 })).length,
    1,
  );
});

for (const [engine, peer] of [
  ["pi", "pi_protocol_probe"],
  ["oh-my-pi", "omp_protocol_probe"],
])
  for (const revoke of [false, true])
    test(
      `${engine} contained native tools enforce roots and ${revoke ? "stop on revocation without replay" : "seal artifacts for exact review"}`,
      {
        skip:
          engine === "oh-my-pi" ? "Outside the current four-CLI scope" : false,
      },
      async (t) => {
        process.env.TROOP_PI_TEST_API_KEY = "TROOP_SELECTED_FAKE";
        process.env.TROOP_PI_OTHER_API_KEY = "TROOP_UNSELECTED_FAKE";
        t.after(() => {
          delete process.env.TROOP_PI_TEST_API_KEY;
          delete process.env.TROOP_PI_OTHER_API_KEY;
        });
        const h = await setup(t);
        const readonly = path.join(h.directory, "readonly");
        fs.mkdirSync(readonly);
        const readonlyFile = path.join(readonly, "input.txt");
        const outside = path.join(h.directory, "outside.txt");
        fs.writeFileSync(readonlyFile, "original readonly");
        fs.writeFileSync(outside, "original outside");
        const permission = await grant(h, {
          engine_id: engine,
          credential_env_keys: ["TROOP_PI_TEST_API_KEY"],
          program: path.resolve(
            __dirname,
            `../../../target/debug/examples/${peer}.exe`,
          ),
          read_roots: [h.workspace, readonly],
        });
        const started = await command(h, "cli.start", {
          client_run_id: crypto.randomUUID(),
          workspace_id: h.wid,
          engine_id: engine,
          tool_mode: "native",
          authorization_id: permission.id,
          goal: JSON.stringify({
            task: "contained boundary probe",
            outside,
            readonly: readonlyFile,
            wait: revoke,
          }),
        });
        assert.equal(started.state, "committed", JSON.stringify(started.error));
        const id = started.result.run.id;
        await until(() =>
          fs.existsSync(path.join(h.workspace, "boundary.json")),
        );
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(h.workspace, "boundary.json"))),
          {
            workspace: true,
            outside: false,
            readonly: false,
            selected_credential: true,
            unselected_credential: false,
          },
        );
        assert.equal(fs.readFileSync(outside, "utf8"), "original outside");
        assert.equal(
          fs.readFileSync(readonlyFile, "utf8"),
          "original readonly",
        );
        if (revoke) {
          await command(h, "authorizations.revoke", {
            id: permission.id,
            expected_revision: permission.revision,
          });
          await h.done(id);
          await h.core.stop();
          await h.core.start();
          const task = await h.core.request("agent.task", {
            id: started.result.task_id,
          });
          assert.equal(task.stopped, true);
          assert.equal((await h.get(id)).allowed_actions.resume.allowed, false);
          assert.equal(
            fs.existsSync(path.join(h.workspace, "late.txt")),
            false,
          );
          assert.equal((await h.get(id)).tasks.length, 1);
        } else {
          await until(async () =>
            (await h.get(id)).run.waiting.includes("review"),
          );
          const task = await h.core.request("agent.task", {
            id: started.result.task_id,
          });
          assert.equal(task.evidence.result.tools_disabled, false);
          assert.equal(task.evidence.permission_plan.sandbox.network, "any");
          assert.ok(
            task.evidence.artifacts.some(
              (artifact) => artifact.path === "result.txt",
            ),
          );
          const reviewed = await command(h, "cli.review", {
            id: task.id,
            epoch: task.epoch,
            expected_task_revision: task.revision,
            evidence_sha256: task.evidence.sha256,
            accepted: true,
            note: "Inspected contained files",
          });
          assert.equal(
            reviewed.state,
            "committed",
            JSON.stringify(reviewed.error),
          );
        }
        assert.equal(h.server.requests.length, 0);
      },
    );

for (const [name, extra] of [
  ["tool-only network denial", { network: "none" }],
  ["unbounded filesystem reads", { read_all: true }],
  ["missing runtime write authority", { write_roots: [] }],
])
  test(`Pi contained mode rejects ${name} before creating a Run`, async (t) => {
    const h = await setup(t);
    const permission = await grant(h, {
      engine_id: "pi",
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/pi_protocol_probe.exe",
      ),
      ...extra,
    });
    const result = await command(h, "cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "pi",
      tool_mode: "native",
      authorization_id: permission.id,
      goal: "Do not execute",
    });
    assert.equal(result.state, "rejected");
    assert.equal((await h.core.request("agent.list", {})).items.length, 0);
  });

test("Pi native failure after a tool effect requires reconciliation", async (t) => {
  const h = await setup(t);
  const readonly = path.join(h.directory, "readonly.txt");
  const outside = path.join(h.directory, "outside.txt");
  fs.writeFileSync(readonly, "original");
  fs.writeFileSync(outside, "original");
  const permission = await grant(h, {
    engine_id: "pi",
    program: path.resolve(
      __dirname,
      "../../../target/debug/examples/pi_protocol_probe.exe",
    ),
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "pi",
    tool_mode: "native",
    authorization_id: permission.id,
    goal: JSON.stringify({
      task: "contained boundary probe model failure",
      readonly,
      outside,
      wait: false,
    }),
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  assert.equal((await h.done(started.result.run.id)).run.state, "interrupted");
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.state, "indeterminate");
  assert.equal(task.stopped, true);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "result.txt"), "utf8"),
    "contained native artifact",
  );
  await h.core.stop();
  await h.core.start();
  assert.equal(
    (await h.get(started.result.run.id)).allowed_actions.resume.allowed,
    false,
  );
});

test("Pi text-only RPC seals a settled model result through the public operation ledger", async (t) => {
  const h = await setup(t);
  const permission = await grant(h, {
    engine_id: "pi",
    network: "none",
    read_roots: [],
    write_roots: [],
    program: path.resolve(
      __dirname,
      "../../../target/debug/examples/pi_protocol_probe.exe",
    ),
  });
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "pi",
    tool_mode: "disabled",
    authorization_id: permission.id,
    goal: "Return an owned text response",
  };
  const started = await command(h, "cli.start", input);
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  assert.equal(
    (await command(h, "cli.start", input)).result.run.id,
    started.result.run.id,
  );
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.stopped, true);
  assert.equal(task.evidence.result.text, "Owned Pi text result");
  assert.equal(task.evidence.result.session_settled, true);
  assert.equal(task.evidence.permission_plan.adapter, "pi-rpc-text-v1");
  assert.deepEqual(task.evidence.artifacts, []);
  assert.equal(h.server.requests.length, 0);
  const reviewed = await command(h, "cli.review", {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted: true,
    note: "The exact text-only result was reviewed",
  });
  assert.equal(reviewed.state, "committed", JSON.stringify(reviewed.error));
  assert.equal((await h.get(started.result.run.id)).run.state, "completed");
});

test.skip("OMP text-only execution seals its native result and waits for exact evidence review", async (t) => {
  const h = await setup(t),
    permission = await grant(h, {
      engine_id: "oh-my-pi",
      network: "none",
      read_roots: [],
      write_roots: [],
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/omp_protocol_probe.exe",
      ),
    });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "oh-my-pi",
    authorization_id: permission.id,
    tool_mode: "disabled",
    goal: "Write a textual answer",
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.evidence.permission_plan.tool_mode, "disabled");
  assert.equal(task.evidence.result.tools_disabled, true);
  assert.equal(task.evidence.result.text, "Owned OMP text result");
  assert.equal(task.stopped, true);
  assert.deepEqual(task.evidence.artifacts, []);
  assert.equal(fs.existsSync(path.join(h.workspace, "result.txt")), false);
  const reviewed = await command(h, "cli.review", {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted: true,
    note: "Reviewed the exact text-only native output.",
  });
  assert.equal(reviewed.state, "committed");
  assert.equal((await h.get(started.result.run.id)).run.state, "completed");
});

test("Pi ignores early idle notifications and waits for settlement after the completed assistant message", async (t) => {
  const h = await setup(t),
    permission = await grant(h, {
      engine_id: "pi",
      network: "none",
      read_roots: [],
      write_roots: [],
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/pi_protocol_probe.exe",
      ),
    });
  const receipt = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "pi",
    tool_mode: "disabled",
    authorization_id: permission.id,
    goal: "wait for settled",
  });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  await until(
    async () =>
      (await h.get(receipt.result.run.id)).run.output ===
      "Owned Pi text result",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    (await h.core.request("agent.task", { id: receipt.result.task_id })).state,
    "running",
  );
  await until(async () =>
    (await h.get(receipt.result.run.id)).run.waiting.includes("review"),
  );
});

for (const [goal, expected] of [
  ["model failure", "failed"],
  ["changed session", "failed"],
  ["unexpected tool event", "indeterminate"],
  ["late resources", "indeterminate"],
  ["long text result", "awaiting_review"],
])
  test(`Pi ${goal} keeps native outcome and resource facts distinct`, async (t) => {
    const h = await setup(t),
      permission = await grant(h, {
        engine_id: "pi",
        network: "none",
        read_roots: [],
        write_roots: [],
        program: path.resolve(
          __dirname,
          "../../../target/debug/examples/pi_protocol_probe.exe",
        ),
      });
    const base = {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "pi",
      authorization_id: permission.id,
      goal,
    };
    assert.equal((await command(h, "cli.start", base)).state, "rejected");
    assert.equal((await h.core.request("agent.list", {})).items.length, 0);
    const receipt = await command(h, "cli.start", {
      ...base,
      tool_mode: "disabled",
    });
    assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
    await until(
      async () =>
        (await h.core.request("agent.task", { id: receipt.result.task_id }))
          .state === expected,
    );
    const task = await h.core.request("agent.task", {
      id: receipt.result.task_id,
    });
    assert.equal(task.stopped, true);
    if (goal === "long text result") {
      assert.equal(task.evidence.result.text, "记忆😀".repeat(1200));
      assert.equal(task.evidence.coverage_complete, false);
      assert.equal(task.evidence.result.text_truncated, true);
    } else assert.equal(task.allowed_actions.review.allowed, false);
  });

for (const [mode, reason] of [
  ["old-version", /版本/],
  ["extra-resources", /额外命令资源/],
])
  test(`Pi ${mode} fails before submitting the model goal`, async (t) => {
    const h = await setup(t),
      program = path.join(h.directory, `pi-${mode}.exe`);
    fs.copyFileSync(
      path.resolve(
        __dirname,
        "../../../target/debug/examples/pi_protocol_probe.exe",
      ),
      program,
    );
    const permission = await grant(h, {
      engine_id: "pi",
      network: "none",
      read_roots: [],
      write_roots: [],
      program,
    });
    const receipt = await command(h, "cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "pi",
      tool_mode: "disabled",
      authorization_id: permission.id,
      goal: "must not be submitted",
    });
    assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
    const done = await h.done(receipt.result.run.id);
    assert.equal(done.run.state, "failed");
    assert.match(done.run.error, reason);
  });

test.skip("OMP requires an explicit text-only mode and blocks an unexpected initial tool inventory", async (t) => {
  const h = await setup(t);
  const unsafe = path.join(h.directory, "omp-unsafe-tools.exe");
  fs.copyFileSync(
    path.resolve(
      __dirname,
      "../../../target/debug/examples/omp_protocol_probe.exe",
    ),
    unsafe,
  );
  const permission = await grant(h, {
    engine_id: "oh-my-pi",
    network: "none",
    read_roots: [],
    write_roots: [],
    program: unsafe,
  });
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "oh-my-pi",
    authorization_id: permission.id,
    goal: "must not run",
  };
  assert.equal((await command(h, "cli.start", input)).state, "rejected");
  assert.equal((await h.core.request("agent.list", {})).items.length, 0);
  const started = await command(h, "cli.start", {
    ...input,
    tool_mode: "disabled",
  });
  assert.equal(started.state, "committed");
  const done = await h.done(started.result.run.id);
  assert.equal(done.run.state, "failed");
  assert.match(done.run.error, /工具集合/);
});

test.skip("OMP waits for its own prompt and settled session before sealing evidence", async (t) => {
  const h = await setup(t),
    permission = await grant(h, {
      engine_id: "oh-my-pi",
      network: "none",
      read_roots: [],
      write_roots: [],
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/omp_protocol_probe.exe",
      ),
    });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "oh-my-pi",
    tool_mode: "disabled",
    authorization_id: permission.id,
    goal: "wait for settled",
  });
  await until(
    async () =>
      (await h.get(started.result.run.id)).run.output ===
      "Owned OMP text result",
  );
  assert.equal(
    (await h.core.request("agent.task", { id: started.result.task_id })).state,
    "running",
  );
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
});

test.skip("OMP marks a bounded text result incomplete when native output exceeds its capture limit", async (t) => {
  const h = await setup(t),
    permission = await grant(h, {
      engine_id: "oh-my-pi",
      network: "none",
      read_roots: [],
      write_roots: [],
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/omp_protocol_probe.exe",
      ),
    });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "oh-my-pi",
    tool_mode: "disabled",
    authorization_id: permission.id,
    goal: "long text result",
  });
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.evidence.result.text_truncated, true);
  assert.equal(task.evidence.coverage_complete, false);
  assert.equal(task.evidence.result.text, "记忆😀".repeat(1200));
});

for (const [goal, expected] of [
  ["model failure", "failed"],
  ["unexpected tool event", "interrupted"],
  ["late tool inventory", "interrupted"],
]) {
  test.skip(`OMP ${goal} preserves its failure semantics without accepting a result`, async (t) => {
    const h = await setup(t),
      permission = await grant(h, {
        engine_id: "oh-my-pi",
        network: "none",
        read_roots: [],
        write_roots: [],
        program: path.resolve(
          __dirname,
          "../../../target/debug/examples/omp_protocol_probe.exe",
        ),
      });
    const started = await command(h, "cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "oh-my-pi",
      tool_mode: "disabled",
      authorization_id: permission.id,
      goal,
    });
    assert.equal(started.state, "committed");
    const done = await h.done(started.result.run.id);
    assert.equal(done.run.state, expected);
    const task = await h.core.request("agent.task", {
      id: started.result.task_id,
    });
    assert.equal(task.stopped, true);
    assert.equal(task.allowed_actions.review.allowed, false);
    assert.equal(
      task.state,
      expected === "interrupted" ? "indeterminate" : "failed",
    );
  });
}
test("an external CLI Run seals stopped evidence and requires an exact user result review", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "write owned output",
  };
  const started = await command(h, "cli.start", input);
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  const run = started.result.run.id;
  const snapshot = await until(async () => {
    const value = await h.get(run);
    return value.run.waiting.includes("review") && value;
  });
  const task = await h.core.request("agent.task", { id: snapshot.tasks[0].id });
  assert.equal(task.kind, "external_cli");
  assert.equal(task.state, "awaiting_review");
  assert.equal(task.stopped, true);
  assert.equal(task.evidence.artifacts[0].path, "result.txt");
  assert.equal(h.server.requests.length, 0);
  assert.equal(snapshot.allowed_actions.steer.allowed, false);
  assert.equal(snapshot.allowed_actions.compact.allowed, false);
  const revoked = await command(h, "authorizations.revoke", {
    id: permission.id,
    expected_revision: permission.revision,
  });
  assert.equal(revoked.state, "committed", JSON.stringify(revoked.error));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok((await h.get(run)).run.waiting.includes("review"));
  await h.core.stop();
  await h.core.start();
  assert.ok((await h.get(run)).run.waiting.includes("review"));
  const afterRestart = await h.core.request("agent.task", { id: task.id });
  assert.deepEqual(afterRestart.evidence, task.evidence);
  const stale = {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: afterRestart.revision,
    evidence_sha256: "wrong-evidence",
    accepted: true,
    note: "Stale result view",
  };
  assert.equal((await command(h, "cli.review", stale)).state, "rejected");
  const reviewed = await command(h, "cli.review", {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: afterRestart.revision,
    evidence_sha256: task.evidence.sha256,
    accepted: true,
    note: "The captured result meets the requested goal.",
  });
  assert.equal(reviewed.state, "committed", JSON.stringify(reviewed.error));
  assert.equal((await h.get(run)).run.state, "completed");
});

test("revoking a running CLI grant stops its owned process tree and forbids another start", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "hold",
  };
  const started = await command(h, "cli.start", input);
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  await until(() => fs.existsSync(path.join(h.workspace, "heartbeat.txt")));
  const revoked = await command(h, "authorizations.revoke", {
    id: permission.id,
    expected_revision: permission.revision,
  });
  assert.equal(revoked.state, "committed");
  const ended = await h.done(started.result.run.id);
  assert.equal(ended.run.state, "interrupted");
  const task = await h.core.request("agent.task", { id: ended.tasks[0].id });
  assert.equal(task.stopped, true);
  assert.equal(task.state, "indeterminate");
  assert.equal(task.allowed_actions.reconcile.allowed, true);
  const stamp = fs.statSync(path.join(h.workspace, "heartbeat.txt")).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    fs.statSync(path.join(h.workspace, "heartbeat.txt")).mtimeMs,
    stamp,
  );
  assert.equal(fs.existsSync(path.join(h.workspace, "result.txt")), false);
  assert.equal(
    (
      await command(h, "cli.start", {
        ...input,
        client_run_id: crypto.randomUUID(),
      })
    ).state,
    "rejected",
  );
});

test("an unconfirmed native permission profile blocks the goal before tools execute", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  fs.writeFileSync(path.join(h.workspace, "profile-mismatch"), "mismatch");
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "write owned output",
  });
  assert.equal(started.state, "committed");
  assert.equal((await h.done(started.result.run.id)).run.state, "failed");
  assert.equal(fs.existsSync(path.join(h.workspace, "result.txt")), false);
});

test("stopping the sole external CLI Task terminates its owning Run", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "hold",
  });
  await until(() => fs.existsSync(path.join(h.workspace, "heartbeat.txt")));
  await h.core.request("agent.stop-task", { id: started.result.task_id });
  await until(
    async () =>
      (await h.core.request("agent.task", { id: started.result.task_id }))
        .stopped,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const stopped = await h.get(started.result.run.id);
  assert.ok(["cancelled", "interrupted"].includes(stopped.run.state));
  assert.equal(stopped.run.intent, "cancel");
});

test("stopping a queued CLI Task also terminates its queued Run", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "hold",
  });
  await until(() => fs.existsSync(path.join(h.workspace, "heartbeat.txt")));
  const second = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "queued owned output",
  });
  await command(h, "agent.stop-task", { id: second.result.task_id });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await h.get(second.result.run.id)).run.state, "cancelled");
});

test("a CLI authorization requiring network off is blocked before any Run or tool starts", async (t) => {
  const h = await setup(t),
    permission = await grant(h, { network: "none" });
  const result = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "must not run",
  });
  assert.equal(result.state, "rejected");
  assert.match(result.error.message, /网络/);
  assert.equal((await h.core.request("agent.list", {})).items.length, 0);
  assert.equal(fs.existsSync(path.join(h.workspace, "result.txt")), false);
});

test("sealed CLI evidence records deleted baseline files", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "delete input",
  });
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.evidence.deleted_files?.[0]?.path, "input.txt");
  assert.equal(
    task.evidence.deleted_files?.[0]?.previous_sha256,
    crypto.createHash("sha256").update("owned input").digest("hex"),
  );
});

test("CLI evidence capture reads only frozen authorized workspace paths", async (t) => {
  const h = await setup(t),
    allowed = path.join(h.workspace, "allowed");
  fs.mkdirSync(allowed);
  const permission = await grant(h, {
    read_roots: [allowed],
    write_roots: [allowed],
  });
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "scoped output",
  });
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.deepEqual(
    task.evidence.artifacts.map((row) => row.path),
    ["allowed/result.txt"],
  );
  assert.equal(task.evidence.coverage_complete, false);
});

test("a baseline file replaced by a directory marks CLI evidence incomplete", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "replace input with directory",
  });
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.evidence.coverage_complete, false);
});

test("Core crash stops a running CLI and restart requires reconciliation without replay", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "hold",
  });
  assert.equal(started.state, "committed");
  await until(() => fs.existsSync(path.join(h.workspace, "heartbeat.txt")));
  const exited = once(h.core.child, "exit");
  h.core.child.kill();
  await exited;
  await new Promise((resolve) => setTimeout(resolve, 400));
  const stamp = fs.statSync(path.join(h.workspace, "heartbeat.txt")).mtimeMs;
  await h.core.start();
  const snapshot = await h.get(started.result.run.id);
  assert.equal(snapshot.run.state, "interrupted");
  assert.equal(snapshot.tasks[0].state, "indeterminate");
  await h.core.request("agent.reconcile-task", {
    id: snapshot.tasks[0].id,
    epoch: snapshot.tasks[0].epoch,
    source: "reviewed",
    note: "Verified the owned native heartbeat process has stopped and inspected its effects.",
  });
  await assert.rejects(h.core.request("agent.resume", { id: snapshot.run.id }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    fs.statSync(path.join(h.workspace, "heartbeat.txt")).mtimeMs,
    stamp,
  );
});

test("cancelling a sealed CLI result preserves evidence and closes review", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "write owned output",
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  const run = started.result.run.id;
  const snapshot = await until(async () => {
    const value = await h.get(run);
    return value.run.waiting.includes("review") && value;
  });
  const original = await h.core.request("agent.task", {
    id: snapshot.tasks[0].id,
  });
  await h.core.request("agent.cancel", { id: run });
  await h.done(run);
  const stopped = await h.core.request("agent.task", { id: original.id });
  assert.equal(stopped.state, "cancelled");
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.evidence, original.evidence);
  assert.equal(stopped.allowed_actions.review.allowed, false);
  const review = await command(h, "cli.review", {
    id: stopped.id,
    epoch: stopped.epoch,
    expected_task_revision: stopped.revision,
    evidence_sha256: stopped.evidence.sha256,
    accepted: true,
    note: "Late review",
  });
  assert.equal(review.state, "rejected");
});

test("a finished CLI Worker receipt recovers a lost result for review without replay", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TRIGGER cli_result_fault BEFORE INSERT ON agent_events WHEN NEW.kind='cli_finished' BEGIN SELECT RAISE(ABORT,'cli-result-fault'); END",
  );
  const exited = once(h.core.child, "exit");
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "write owned output",
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  await exited;
  db.exec("DROP TRIGGER cli_result_fault");
  db.close();
  await h.core.start();
  const snapshot = await h.get(started.result.run.id);
  assert.equal(snapshot.run.state, "interrupted");
  const task = await h.core.request("agent.task", { id: snapshot.tasks[0].id });
  assert.equal(task.state, "indeterminate");
  const stamp = require("node:fs").statSync(
    path.join(h.workspace, "result.txt"),
  ).mtimeMs;
  assert.equal(task.allowed_actions.reconcile_receipt.allowed, true);
  await h.core.request("agent.reconcile-task", {
    id: task.id,
    epoch: task.epoch,
    source: "receipt",
    note: "",
  });
  const recovered = await h.core.request("agent.task", { id: task.id });
  assert.equal(recovered.state, "awaiting_review");
  assert.equal(
    recovered.evidence.snapshot_source,
    "current_workspace_after_receipt_reconciliation",
  );
  assert.ok((await h.get(snapshot.run.id)).run.waiting.includes("review"));
  await assert.rejects(h.core.request("agent.resume", { id: snapshot.run.id }));
  assert.equal(
    require("node:fs").statSync(path.join(h.workspace, "result.txt")).mtimeMs,
    stamp,
  );
});

test("Codex question is durable and a ledger answer resumes the same native task once", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "ask owned question",
    timeout_seconds: 60,
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  const taskId = started.result.task_id;
  const request = await until(
    async () =>
      (await h.core.request("cli.interactions", { task_id: taskId })).items[0],
  );
  assert.equal(request.kind, "question");
  assert.equal(request.state, "pending");
  assert.equal(request.body.questions[0].question, "Choose an owned target");
  assert.equal(fs.existsSync(path.join(h.workspace, "answer.txt")), false);
  const input = {
    interaction_id: request.interaction_id,
    expected_revision: request.revision,
    task_epoch: request.task_epoch,
    request_sha256: request.request_sha256,
    answer: { kind: "question", answers: { target: ["alpha"] } },
  };
  const invalid = await command(h, "cli.respond", {
    ...input,
    answer: { kind: "question", answers: { target: ["unknown"] } },
  });
  assert.equal(invalid.state, "rejected");
  assert.equal(
    (
      await h.core.request("cli.interaction", {
        interaction_id: request.interaction_id,
      })
    ).state,
    "pending",
  );
  const result = await command(h, "cli.respond", input);
  assert.equal(result.state, "committed", JSON.stringify(result.error));
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "answer.txt"), "utf8"),
    "alpha",
  );
  const duplicate = await command(h, "cli.respond", input);
  assert.equal(duplicate.state, "committed", JSON.stringify(duplicate.error));
  const answered = await h.core.request("cli.interaction", {
    interaction_id: request.interaction_id,
  });
  assert.equal(answered.decision.answer.answers.target[0], "alpha");
  assert.equal(answered.delivery.write_state, "written");
  await h.core.stop();
  await h.core.start();
  const restored = await h.core.request("cli.interaction", {
    interaction_id: request.interaction_id,
  });
  assert.equal(restored.decision.answer.answers.target[0], "alpha");
  assert.equal((await h.get(started.result.run.id)).tasks.length, 1);
});

for (const mode of ["stop", "crash"])
  test(`a pending native question rejects old answers after ${mode}`, async (t) => {
    const h = await setup(t),
      permission = await grant(h);
    const started = await command(h, "cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "codex",
      authorization_id: permission.id,
      goal: "ask owned question",
      timeout_seconds: 60,
    });
    assert.equal(started.state, "committed", JSON.stringify(started.error));
    const request = await until(
      async () =>
        (
          await h.core.request("cli.interactions", {
            task_id: started.result.task_id,
          })
        ).items[0],
    );
    if (mode === "crash") {
      const exited = once(h.core.child, "exit");
      h.core.child.kill();
      await exited;
      await h.core.start();
    } else {
      await command(h, "agent.stop-task", { id: started.result.task_id });
      await h.done(started.result.run.id);
    }
    const rejected = await command(h, "cli.respond", {
      interaction_id: request.interaction_id,
      expected_revision: request.revision,
      task_epoch: request.task_epoch,
      request_sha256: request.request_sha256,
      answer: { kind: "question", answers: { target: ["alpha"] } },
    });
    assert.equal(rejected.state, "rejected");
    assert.equal(fs.existsSync(path.join(h.workspace, "answer.txt")), false);
    const current = await h.core.request("cli.interaction", {
      interaction_id: request.interaction_id,
    });
    assert.equal(current.allowed_actions.respond.allowed, false);
    assert.equal((await h.get(started.result.run.id)).tasks.length, 1);
  });

test("an unsupported native question preserves earlier effects and requires reconciliation", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  fs.writeFileSync(
    path.join(h.workspace, "unsupported-question"),
    "owned fixture marker",
  );
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "ask owned question",
    timeout_seconds: 60,
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  await until(async () =>
    ["failed", "interrupted"].includes(
      (await h.get(started.result.run.id)).run.state,
    ),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.state, "indeterminate");
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "previous-step.txt"), "utf8"),
    "owned effect",
  );
  assert.equal(task.allowed_actions.reconcile.allowed, true);
});

test("CLI continuation requires reviewed old effects and the explicitly confirmed current plan", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "ask owned question",
    timeout_seconds: 60,
  };
  const started = await command(h, "cli.start", input);
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  await until(
    async () =>
      (
        await h.core.request("cli.interactions", {
          task_id: started.result.task_id,
        })
      ).items[0],
  );
  let old = await h.core.request("agent.task", { id: started.result.task_id });
  let next = {
    ...input,
    client_run_id: crypto.randomUUID(),
    goal: "write owned output",
    continuation_of: {
      task_id: old.id,
      task_epoch: old.epoch,
      expected_task_revision: old.revision,
    },
  };
  await assert.rejects(h.core.request("cli.preview", next));
  await command(h, "agent.stop-task", { id: old.id });
  await h.done(started.result.run.id);
  old = await h.core.request("agent.task", { id: old.id });
  await command(h, "agent.reconcile-task", {
    id: old.id,
    epoch: old.epoch,
    source: "reviewed",
    note: "Reviewed the stopped synthetic task and its workspace effects.",
  });
  old = await h.core.request("agent.task", { id: old.id });
  const expanded = await grant(h, { read_all: true });
  next = {
    ...next,
    authorization_id: expanded.id,
    continuation_of: {
      task_id: old.id,
      task_epoch: old.epoch,
      expected_task_revision: old.revision,
    },
  };
  const preview = await h.core.request("cli.preview", next);
  assert.ok(
    preview.continuation_of.changes.some(
      (change) => change.field === "read_all" && change.requested === true,
    ),
  );
  assert.equal((await command(h, "cli.start", next)).state, "rejected");
  assert.equal(
    (await command(h, "cli.start", { ...next, expected_plan_sha256: "stale" }))
      .state,
    "rejected",
  );
  const continued = await command(h, "cli.start", {
    ...next,
    expected_plan_sha256: preview.plan_sha256,
  });
  assert.equal(continued.state, "committed", JSON.stringify(continued.error));
  assert.equal(continued.result.run.continuation_of.task_id, old.id);
  assert.notEqual(continued.result.run.id, started.result.run.id);
  assert.equal((await h.get(started.result.run.id)).tasks.length, 1);
  await until(async () =>
    (await h.get(continued.result.run.id)).run.waiting.includes("review"),
  );
});

test("Codex plan confirmation binds the exact displayed version and digest", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    collaboration_mode: "plan",
    goal: "write owned output",
    timeout_seconds: 60,
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  const plan = await until(async () =>
    (
      await h.core.request("cli.interactions", {
        task_id: started.result.task_id,
      })
    ).items.find((item) => item.kind === "plan"),
  );
  assert.equal(plan.state, "pending");
  const input = {
    interaction_id: plan.interaction_id,
    expected_revision: plan.revision,
    task_epoch: plan.task_epoch,
    request_sha256: plan.request_sha256,
    answer: { kind: "plan", accepted: true, plan_sha256: "stale" },
  };
  assert.equal((await command(h, "cli.respond", input)).state, "rejected");
  input.answer.plan_sha256 = plan.body.sha256;
  assert.equal((await command(h, "cli.respond", input)).state, "committed");
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const saved = await h.core.request("cli.interaction", {
    interaction_id: plan.interaction_id,
  });
  assert.equal(saved.decision.answer.plan_sha256, plan.body.sha256);
  assert.equal(saved.delivery.write_state, "host_recorded");
});

test("a Codex scope-change decision stops the old task and binds its new continuation", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "request owned permission",
    timeout_seconds: 60,
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  const request = await until(
    async () =>
      (
        await h.core.request("cli.interactions", {
          task_id: started.result.task_id,
        })
      ).items[0],
  );
  assert.equal(request.allowed_actions.approve.allowed, false);
  const input = {
    interaction_id: request.interaction_id,
    expected_revision: request.revision,
    task_epoch: request.task_epoch,
    request_sha256: request.request_sha256,
    answer: {
      kind: "scope_change",
      note: "Explicitly request a new scope after reviewing old effects.",
    },
  };
  assert.equal((await command(h, "cli.respond", input)).state, "committed");
  await h.done(started.result.run.id);
  let task = await h.core.request("agent.task", { id: started.result.task_id });
  assert.equal(task.stopped, true);
  assert.equal(task.scope_change_interaction_id, request.interaction_id);
  await command(h, "agent.reconcile-task", {
    id: task.id,
    epoch: task.epoch,
    source: "reviewed",
    note: "Verified owned process stop and inspected workspace effects.",
  });
  task = await h.core.request("agent.task", { id: task.id });
  const next = {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "write owned output",
    continuation_of: {
      task_id: task.id,
      task_epoch: task.epoch,
      expected_task_revision: task.revision,
    },
  };
  await assert.rejects(h.core.request("cli.preview", next));
  next.continuation_of.interaction_id = request.interaction_id;
  const preview = await h.core.request("cli.preview", next);
  assert.equal(
    preview.continuation_of.interaction_request_sha256,
    request.request_sha256,
  );
  const result = await command(h, "cli.start", {
    ...next,
    expected_plan_sha256: preview.plan_sha256,
  });
  assert.equal(result.state, "committed", JSON.stringify(result.error));
  assert.equal(
    result.result.run.continuation_of.interaction_id,
    request.interaction_id,
  );
});

test("a response write crash preserves its decision without replaying the old native reply", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "ask owned question",
    timeout_seconds: 60,
  });
  const request = await until(
    async () =>
      (
        await h.core.request("cli.interactions", {
          task_id: started.result.task_id,
        })
      ).items[0],
  );
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TRIGGER cli_response_fault BEFORE UPDATE ON cli_interactions WHEN json_extract(NEW.document,'$.delivery.write_state')='written' BEGIN SELECT RAISE(ABORT,'owned write receipt fault'); END",
  );
  const exit = once(h.core.child, "exit");
  const answered = await command(h, "cli.respond", {
    interaction_id: request.interaction_id,
    expected_revision: request.revision,
    task_epoch: request.task_epoch,
    request_sha256: request.request_sha256,
    answer: { kind: "question", answers: { target: ["alpha"] } },
  });
  assert.equal(answered.state, "committed");
  await exit;
  db.exec("DROP TRIGGER cli_response_fault");
  db.close();
  const stamp = fs.statSync(path.join(h.workspace, "answer.txt")).mtimeMs;
  await h.core.start();
  const recovered = await h.core.request("cli.interaction", {
    interaction_id: request.interaction_id,
  });
  assert.equal(recovered.state, "indeterminate");
  assert.equal(recovered.decision.answer.answers.target[0], "alpha");
  assert.equal(recovered.allowed_actions.respond.allowed, false);
  assert.equal((await h.get(started.result.run.id)).tasks.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    fs.statSync(path.join(h.workspace, "answer.txt")).mtimeMs,
    stamp,
  );
});

test("a native question expires and two conflicting windows choose at most one answer", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  for (const expire of [true, false]) {
    const started = await command(h, "cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "codex",
      authorization_id: permission.id,
      goal: "ask owned question",
      human_wait_seconds: expire ? 1 : 60,
      timeout_seconds: 60,
    });
    const request = await until(
      async () =>
        (
          await h.core.request("cli.interactions", {
            task_id: started.result.task_id,
          })
        ).items[0],
    );
    const input = {
      interaction_id: request.interaction_id,
      expected_revision: request.revision,
      task_epoch: request.task_epoch,
      request_sha256: request.request_sha256,
      answer: { kind: "question", answers: { target: ["alpha"] } },
    };
    if (expire) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal((await command(h, "cli.respond", input)).state, "rejected");
      await h.done(started.result.run.id);
    } else {
      const results = await Promise.all([
        command(h, "cli.respond", input),
        command(h, "cli.respond", {
          ...input,
          answer: { kind: "question", answers: { target: ["beta"] } },
        }),
      ]);
      assert.deepEqual(results.map((item) => item.state).sort(), [
        "committed",
        "rejected",
      ]);
    }
  }
});

test("interaction history paginates beyond 32 questions without hiding the current request", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "many owned questions",
    timeout_seconds: 120,
  });
  for (let n = 0; n < 36; n++) {
    const request = await until(async () =>
      (
        await h.core.request("cli.interactions", {
          task_id: started.result.task_id,
        })
      ).items.find((item) => item.state === "pending"),
    );
    const result = await command(h, "cli.respond", {
      interaction_id: request.interaction_id,
      expected_revision: request.revision,
      task_epoch: request.task_epoch,
      request_sha256: request.request_sha256,
      answer: { kind: "question", answers: { target: ["alpha"] } },
    });
    assert.equal(result.state, "committed", JSON.stringify(result.error));
  }
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const first = await h.core.request("cli.interactions", {
    task_id: started.result.task_id,
  });
  assert.equal(first.items.length, 32);
  assert.ok(first.next_cursor);
  const last = await h.core.request("cli.interactions", {
    task_id: started.result.task_id,
    before: first.next_cursor,
  });
  assert.equal(last.items.length, 4);
  assert.equal(last.next_cursor, null);
  assert.equal(
    new Set([...first.items, ...last.items].map((item) => item.interaction_id))
      .size,
    36,
  );
});

for (const conflict of [false, true])
  test(`native request identity ${conflict ? "conflict is recorded and stopped" : "reuses the persisted decision"}`, async (t) => {
    const h = await setup(t),
      permission = await grant(h);
    fs.writeFileSync(
      path.join(
        h.workspace,
        conflict ? "conflicting-question" : "duplicate-question",
      ),
      "owned fixture",
    );
    const started = await command(h, "cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "codex",
      authorization_id: permission.id,
      goal: "ask owned question",
      timeout_seconds: 60,
    });
    const request = await until(
      async () =>
        (
          await h.core.request("cli.interactions", {
            task_id: started.result.task_id,
          })
        ).items[0],
    );
    assert.equal(
      (
        await command(h, "cli.respond", {
          interaction_id: request.interaction_id,
          expected_revision: request.revision,
          task_epoch: request.task_epoch,
          request_sha256: request.request_sha256,
          answer: { kind: "question", answers: { target: ["alpha"] } },
        })
      ).state,
      "committed",
    );
    await until(async () => {
      const run = (await h.get(started.result.run.id)).run;
      return conflict
        ? run.state === "interrupted"
        : run.waiting.includes("review");
    });
    const rows = (
      await h.core.request("cli.interactions", {
        task_id: started.result.task_id,
      })
    ).items;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].interaction_id, request.interaction_id);
    if (conflict) assert.ok(rows[0].protocol_conflict.received_sha256);
    else assert.equal(rows[0].redelivery_count, 1);
  });

test("a final Worker receipt repairs a missing response-write fact without changing the decision", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "ask owned question",
    timeout_seconds: 60,
  });
  const request = await until(
    async () =>
      (
        await h.core.request("cli.interactions", {
          task_id: started.result.task_id,
        })
      ).items[0],
  );
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TRIGGER lose_first_response_write BEFORE UPDATE ON cli_interactions WHEN json_extract(NEW.document,'$.delivery.write_state')='written' AND NOT EXISTS(SELECT 1 FROM agent_events WHERE kind='cli_response_written') BEGIN SELECT RAISE(IGNORE); END",
  );
  await command(h, "cli.respond", {
    interaction_id: request.interaction_id,
    expected_revision: request.revision,
    task_epoch: request.task_epoch,
    request_sha256: request.request_sha256,
    answer: { kind: "question", answers: { target: ["alpha"] } },
  });
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  db.exec("DROP TRIGGER lose_first_response_write");
  db.close();
  const repaired = await h.core.request("cli.interaction", {
    interaction_id: request.interaction_id,
  });
  assert.equal(repaired.delivery.write_state, "written");
  assert.equal(repaired.delivery.source, "worker_final_receipt");
  assert.equal(repaired.decision.answer.answers.target[0], "alpha");
  assert.equal(repaired.state, "closed");
});

test("long native identities keep final delivery evidence within its byte budget", async (t) => {
  const h = await setup(t),
    permission = await grant(h);
  fs.writeFileSync(
    path.join(h.workspace, "long-native-identities"),
    "owned fixture",
  );
  const started = await command(h, "cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    engine_id: "codex",
    authorization_id: permission.id,
    goal: "many owned questions",
    timeout_seconds: 120,
  });
  for (let n = 0; n < 36; n++) {
    const request = await until(async () =>
      (
        await h.core.request("cli.interactions", {
          task_id: started.result.task_id,
        })
      ).items.find((item) => item.state === "pending"),
    );
    assert.equal(
      (
        await command(h, "cli.respond", {
          interaction_id: request.interaction_id,
          expected_revision: request.revision,
          task_epoch: request.task_epoch,
          request_sha256: request.request_sha256,
          answer: { kind: "question", answers: { target: ["alpha"] } },
        })
      ).state,
      "committed",
    );
  }
  await until(async () =>
    (await h.get(started.result.run.id)).run.waiting.includes("review"),
  );
  const task = await h.core.request("agent.task", {
    id: started.result.task_id,
  });
  assert.equal(task.evidence.result.interaction_deliveries_truncated, true);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify(task.evidence.result.interaction_deliveries),
    ) <= 8192,
  );
  assert.equal(task.stopped, true);
});
