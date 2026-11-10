const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  setup,
  until,
  sleep,
  results,
  hook,
} = require("./fixtures/hooks-fixture.cjs");
const { writeTestClock } = require("./fixtures/test-clock.cjs");
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const { DatabaseSync } = require("node:sqlite");
const {
  createBackup,
  restoreBackup,
  sha256,
} = require("../src/event-deployment.cjs");
const executable =
  process.env.TROOP_C7_CORE ?? path.resolve(__dirname, "../bin", coreBinary);
const command = async (
  core,
  method,
  input,
  operation = crypto.randomUUID(),
) => {
  const receipt = await core.request("operations.execute", {
    operation_id: operation,
    instance_id: core.snapshot().storage_instance,
    method,
    input,
  });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return receipt.result;
};
async function accept(core, id) {
  const work = await core.request("work_items.get", { id });
  const evidence = (await core.request("work_items.runs", { id })).items[0];
  return command(core, "work_items.accept", {
    id,
    expected_revision: work.revision,
    run_id: evidence.run.id,
    expected_run_revision: evidence.run.revision,
    evidence_sha256: evidence.evidence_sha256,
    note: "C7 reviewed the fixed Office result",
  });
}

test("C7 composes conversation automation, scoped context, Office editing, acceptance, dependency and later recheck", async (t) => {
  const clockDirectory = path.resolve(__dirname, "../../../.tmp-c7-clock");
  fs.mkdirSync(clockDirectory, { recursive: true });
  const clock = path.join(
    fs.mkdtempSync(path.join(clockDirectory, "case-")),
    "clock",
  );
  let current = Math.floor(Date.now() / 1000) * 1000;
  const due = current + 4000;
  fs.writeFileSync(clock, String(current));
  let phase = "edit";
  const proposal = {
    troop_automation: {
      kind: "scheduled",
      name: "C7 Office recheck",
      goal: "Use the fixed reference and prepare the Office result",
      schedule: {
        kind: "once",
        timezone: "UTC",
        date: new Date(due).toISOString().slice(0, 10),
        time: new Date(due).toISOString().slice(11, 19),
        weekdays: [],
      },
    },
  };
  const h = await setup(t, {
    executable,
    coreArgs: ["--test-clock-file", clock],
    plan: ({ body }) => {
      if (hook(body) || !body.tools?.length) return [];
      const previous = results(body);
      if (!previous.length)
        return [{ name: "office_read", arguments: { path: "result.md" } }];
      if (phase === "edit" && previous.length === 1) {
        const value = previous[0].value;
        return [
          {
            name: "office_edit",
            arguments: {
              path: "result.md",
              content: "# C7 reviewed result\n\nC7_OFFICE_VERSION_TWO\n",
              expected_hash: value.document.sha256,
              expected_revision: String(value.document.revision),
            },
          },
        ];
      }
      return [];
    },
    reply: ({ body }) =>
      hook(body)
        ? JSON.stringify({
            permission: "allow",
            additional_context: "C7_HOOK_CONTEXT",
          })
        : body.tools?.length
          ? "C7_FIXED_RESULT_READY"
          : JSON.stringify(proposal),
  });
  const call = (method, input, key) => command(h.core, method, input, key);
  fs.writeFileSync(
    path.join(h.workspace, "result.md"),
    "# C7 original\n\nC7_FROZEN_REFERENCE\n",
  );
  const document = (
    await call("office.open", { workspace_id: h.wid, path: "result.md" })
  ).document;
  const reference = await call("office.reference.create", {
    id: document.id,
    revision: 1,
    kind: "paragraphs",
    start: 1,
    end: 2,
  });
  await h.core.request("memory.write", {
    agent_id: 1,
    scope: "agent",
    tier: "profile",
    content: "C7_MEMORY_CONTEXT",
  });
  const skillDirectory = path.join(h.directory, "c7-skill");
  fs.mkdirSync(skillDirectory);
  fs.writeFileSync(
    path.join(skillDirectory, "SKILL.md"),
    "---\nname: C7 Office\nid: c7-office\ndescription: C7_SKILL_CONTEXT\n---\nInspect versioned Office evidence before acceptance.\n",
  );
  const skillSource = {
    path: skillDirectory,
    id: "c7-office",
    mode: "copy",
    source_kind: "local",
  };
  const skillPreview = await h.core.request("skills.preview", skillSource);
  await h.core.request("skills.import", {
    source: skillSource,
    preview_hash: skillPreview.preview_hash,
    expected_revision: skillPreview.expected_revision,
  });
  const guard = await h.save({
    name: "C7 Office guard",
    kind: "prompt",
    command: "",
    prompt: "Return permission allow and additional_context C7_HOOK_CONTEXT.",
  });
  const grant = await call("authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "C7 scoped Office",
      purpose: "tool_call",
      engine_id: "native",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["read_file", "write_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
      prompt_hooks: [{ id: guard.id, revision: guard.revision }],
    },
  });
  const makeWork = (title, dependencies = []) =>
    call("work_items.save", {
      expected_revision: 0,
      item: {
        title,
        goal: title,
        acceptance: "User accepts fixed version evidence",
        owner_agent_id: 1,
        workspace_id: h.wid,
        dependency_ids: dependencies,
      },
    });
  const first = await makeWork("C7 Office delivery");
  const dependent = await makeWork("C7 dependent review", [first.id]);
  assert.equal(dependent.allowed_actions.start.allowed, false);
  const conversation = await h.core.request("chat.create", {
    title: "C7 Office automation",
    workspace_id: h.wid,
  });
  const turn = await h.core.request("chat.send", {
    conversation_id: conversation.id,
    provider_id: h.provider.id,
    client_turn_id: crypto.randomUUID(),
    text: "C7_CREATOR_CHAT_ONLY. Schedule this selected fixed reference",
    automation: true,
    office_reference_ids: [reference.id],
  });
  await until(async () =>
    (
      await h.core.request("chat.messages", {
        conversation_id: conversation.id,
      })
    ).items.some(
      (m) =>
        m.turn_id === turn.turn_id &&
        m.role === "assistant" &&
        m.status === "completed",
    ),
  );
  assert.equal((await h.core.request("rules.list", {})).items.length, 0);
  const preview = await h.core.request("automations.preview", {
    turn_id: turn.turn_id,
    authorization_id: grant.id,
  });
  const confirmation = {
    turn_id: turn.turn_id,
    authorization_id: grant.id,
    source_sha256: preview.source_sha256,
    expected_plan_sha256: preview.preview.plan_sha256,
  };
  const [saved, duplicate] = await Promise.all([
    call("automations.confirm", confirmation),
    call("automations.confirm", confirmation),
  ]);
  assert.equal(saved.id, duplicate.id);
  const definition = {
    ...preview.rule,
    work_item_id: first.id,
    expected_plan_sha256: null,
  };
  definition.expected_plan_sha256 = (
    await h.core.request("schedules.preview", {
      id: saved.id,
      rule: definition,
    })
  ).plan_sha256;
  await call("rules.save", {
    id: saved.id,
    expected_revision: saved.revision,
    rule: definition,
  });
  await h.core.stop();
  await h.core.start();
  current = due;
  await writeTestClock(clock, current);
  const execution = await until(async () =>
    (await h.core.request("schedules.history", { id: saved.id })).items.find(
      (x) => x.run_id,
    ),
  );
  const completed = await h.done(execution.run_id);
  assert.equal(completed.run.state, "completed", JSON.stringify(completed));
  assert.equal(completed.run.office_references[0].id, reference.id);
  assert.ok(
    completed.invocations.every((value) => value.state === "succeeded"),
  );
  assert.ok(
    fs
      .readFileSync(path.join(h.workspace, "result.md"), "utf8")
      .includes("C7_OFFICE_VERSION_TWO"),
  );
  assert.equal(
    (await h.core.request("office.version", { id: document.id, revision: 2 }))
      .source_run_id,
    execution.run_id,
  );
  const nativeRequests = h.server.requests.filter(
    (request) => request.body.tools?.length && !hook(request.body),
  );
  const initial = nativeRequests.find(
    (request) => results(request.body).length === 0,
  );
  assert.ok(initial, "Scheduled Run initial model request");
  const initialContext = JSON.stringify(initial.body);
  for (const marker of [
    "C7_MEMORY_CONTEXT",
    "C7_SKILL_CONTEXT",
    "C7_FROZEN_REFERENCE",
  ])
    assert.ok(initialContext.includes(marker), marker);
  assert.ok(!initialContext.includes("C7_CREATOR_CHAT_ONLY"));
  assert.ok(
    nativeRequests.some(
      (request) =>
        results(request.body).length > 0 &&
        JSON.stringify(request.body).includes("C7_HOOK_CONTEXT"),
    ),
  );
  assert.equal(
    (await h.core.request("work_items.get", { id: dependent.id }))
      .allowed_actions.start.allowed,
    false,
  );
  await accept(h.core, first.id);
  assert.equal(
    (await h.core.request("work_items.get", { id: dependent.id }))
      .allowed_actions.start.allowed,
    true,
  );
  assert.ok(
    (
      await h.core.request("automations.result", {
        turn_id: turn.turn_id,
        run_id: execution.run_id,
      })
    ).content.includes("C7_FIXED_RESULT_READY"),
  );
  phase = "recheck";
  const policy = {
    name: "C7 later Office review",
    enabled: true,
    work_item_id: dependent.id,
    agent_id: 1,
    workspace_id: h.wid,
    project_id: null,
    start: {
      client_run_id: crypto.randomUUID(),
      agent_id: 1,
      workspace_id: h.wid,
      provider_id: h.provider.id,
      authorization_id: grant.id,
      project_ids: [],
      office_reference_ids: [reference.id],
      goal: "Recheck the result with its original fixed reference",
    },
    expected_plan_sha256: null,
    expires_at_ms: Date.now() + 300000,
    min_interval_ms: 60000,
    max_runs: 2,
    handoff_policy_ids: [],
  };
  policy.expected_plan_sha256 = (
    await h.core.request("followups.preview", { policy })
  ).plan_sha256;
  const follow = await call("followups.save", { expected_revision: 0, policy });
  const at = Math.max(Date.now(), current) + 60000;
  const appointment = await call("followups.request", {
    id: follow.id,
    expected_revision: follow.revision,
    client_request_id: crypto.randomUUID(),
    at_ms: at,
    reason: "Review after accepted prerequisite",
    expected_change: "The accepted Office result remains available",
  });
  await h.core.stop();
  await h.core.start();
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  current = at;
  await writeTestClock(clock, current);
  const recheck = await until(async () =>
    (await h.core.request("followups.history", { id: follow.id })).items.find(
      (row) => row.id === appointment.id && row.run_id,
    ),
  );
  assert.equal((await h.done(recheck.run_id)).run.state, "completed");
  await accept(h.core, dependent.id);
  assert.equal(
    (await h.core.request("work_items.get", { id: dependent.id })).progress
      .state,
    "completed",
  );
  assert.equal(
    (await h.core.request("office.reference.get", { id: reference.id })).stale,
    true,
  );
  const actor = crypto.randomUUID();
  await call("office.draft.save", {
    id: document.id,
    actor,
    expected_revision: 0,
    base_revision: 2,
    content: "C7_RETAINED_UNSAVED_DRAFT",
  });
  const snapshotDirectory = path.join(h.directory, "backup");
  const manifest = await createBackup(
    {
      version: 1,
      mode: "local",
      executable,
      core_sha256: sha256(executable),
      data_directory: h.data,
      listen: "127.0.0.1:18743",
      health_file: path.join(h.directory, "health.json"),
    },
    snapshotDirectory,
  );
  assert.equal(manifest.schema, 33);
  await h.core.stop();
  const restored = path.join(h.directory, "restored");
  restoreBackup(snapshotDirectory, restored);
  const recovered = new CoreSupervisor({
    executable,
    args: ["--data-dir", restored, "--test-clock-file", clock],
  });
  t.after(() => recovered.stop());
  await recovered.start();
  assert.equal(recovered.snapshot().storage_instance, manifest.instance_id);
  assert.equal(
    (await recovered.request("office.draft.get", { id: document.id, actor }))
      .content,
    "C7_RETAINED_UNSAVED_DRAFT",
  );
  assert.equal(
    (await recovered.request("office.reference.get", { id: reference.id }))
      .content,
    "C7_FROZEN_REFERENCE\n",
  );
  assert.equal(
    (await recovered.request("work_items.get", { id: dependent.id })).progress
      .state,
    "completed",
  );
  assert.equal((await recovered.request("agent.list", {})).items.length, 2);
  assert.equal(
    (await recovered.request("schedules.history", { id: saved.id })).items
      .length,
    1,
  );
  const restoredVersion = await command(recovered, "office.restore", {
    id: document.id,
    expected_revision: 2,
    source_revision: 1,
    actor,
  });
  assert.equal(restoredVersion.revision, 3);
  assert.ok(
    fs
      .readFileSync(path.join(h.workspace, "result.md"), "utf8")
      .includes("C7_FROZEN_REFERENCE"),
  );
  assert.equal(
    (await recovered.request("office.draft.get", { id: document.id, actor }))
      .content,
    "C7_RETAINED_UNSAVED_DRAFT",
  );
});

test("C7 reconciles an Office Worker effect after Core crash and revocation without replaying the write", async (t) => {
  const h = await setup(t, { executable });
  const call = (method, input) => command(h.core, method, input);
  fs.writeFileSync(path.join(h.workspace, "crash.md"), "C7_BEFORE_CRASH");
  const document = (
    await call("office.open", { workspace_id: h.wid, path: "crash.md" })
  ).document;
  const grant = await call("authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "C7 crash grant",
      purpose: "tool_call",
      engine_id: "native",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["read_file", "write_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER c7_worker_version_fault BEFORE INSERT ON office_versions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'C7 controlled version fault'); END",
  );
  const started = await call("agent.start", {
    client_run_id: crypto.randomUUID(),
    agent_id: 1,
    workspace_id: h.wid,
    authorization_id: grant.id,
    goal: "C7 one Office write",
    action: {
      name: "office_edit",
      arguments: {
        path: "crash.md",
        expected_revision: "1",
        expected_hash: document.sha256,
        content: "C7_WRITE_ONCE",
      },
    },
  });
  const interrupted = await h.done(started.run.id);
  assert.equal(
    interrupted.run.state,
    "interrupted",
    JSON.stringify(interrupted),
  );
  const invocation = interrupted.invocations[0];
  assert.equal(invocation.state, "indeterminate");
  const pending = (await h.core.request("office.get", { id: document.id }))
    .document.pending;
  assert.ok(pending.effect_id);
  await call("authorizations.revoke", {
    id: grant.id,
    expected_revision: grant.revision,
  });
  const exit = new Promise((resolve) => h.core.child.once("exit", resolve));
  h.core.child.kill();
  await exit;
  await sleep(100);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "crash.md"), "utf8"),
    "C7_WRITE_ONCE",
  );
  await h.core.start();
  assert.equal((await h.get(started.run.id)).invocations.length, 1);
  db.exec("DROP TRIGGER c7_worker_version_fault");
  await call("office.reconcile", {
    id: document.id,
    effect_id: pending.effect_id,
    expected_disk_sha256: crypto
      .createHash("sha256")
      .update("C7_WRITE_ONCE")
      .digest("hex"),
    decision: "accept",
  });
  await call("agent.reconcile", {
    id: invocation.id,
    epoch: invocation.epoch,
    source: "receipt",
    note: "C7 matched the stopped Worker receipt and Office version",
  });
  await assert.rejects(call("agent.resume", { id: started.run.id }));
  assert.equal(
    (await h.core.request("office.history", { id: document.id })).items.length,
    2,
  );
  assert.equal(
    await h.core.request("office.pending", { id: document.id }),
    null,
  );
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "crash.md"), "utf8"),
    "C7_WRITE_ONCE",
  );
  assert.equal(h.server.requests.length, 0);
});

test(
  "C7 upgrades an actual previous Core profile and retains its conversation, provider and workspace",
  {
    skip: process.env.TROOP_C7_PREVIOUS_CORE
      ? false
      : "Previous released Core executable is supplied for local migration acceptance",
  },
  async (t) => {
    const { agentServer } = require("./fixtures/agent-server.cjs");
    const { seedPreviousCore } = require("./fixtures/previous-core.cjs");
    const directory = path.resolve(__dirname, "../../../.tmp-c7-legacy");
    fs.mkdirSync(directory, { recursive: true });
    const folder = fs.mkdtempSync(path.join(directory, "profile-")),
      data = path.join(folder, "data");
    const server = await agentServer({
      plan: () => [],
      reply: "C7_LEGACY_MODEL_RESULT",
    });
    t.after(() => server.close());
    const seeded = await seedPreviousCore(
      process.env.TROOP_C7_PREVIOUS_CORE,
      data,
      server.origin,
    );
    const core = new CoreSupervisor({ executable, args: ["--data-dir", data] });
    t.after(async () => {
      if (core.state !== "ready") await core.start();
      try {
        await command(core, "provider.remove", { id: seeded.provider.id });
      } finally {
        await core.stop();
      }
    });
    await core.start();
    assert.notEqual(core.snapshot().version, seeded.version);
    const messages = await core.request("chat.messages", {
      conversation_id: seeded.conversation_id,
    });
    assert.deepEqual(messages.items, seeded.messages);
    const provider = (await core.request("provider.list", {})).find(
      (value) => value.id === seeded.provider.id,
    );
    assert.equal(provider.has_key, true);
    const workspace = (await core.request("workspace.list", {})).items.find(
      (value) => value.id === seeded.workspace_id,
    );
    fs.writeFileSync(
      path.join(workspace.path, "upgraded.md"),
      "C7_UPGRADE_OFFICE\n",
    );
    const document = (
      await command(core, "office.open", {
        workspace_id: workspace.id,
        path: "upgraded.md",
      })
    ).document;
    const reference = await command(core, "office.reference.create", {
      id: document.id,
      revision: 1,
      kind: "paragraphs",
      start: 0,
      end: 1,
    });
    assert.equal(reference.content, "C7_UPGRADE_OFFICE\n");
    const db = new DatabaseSync(path.join(data, "troop.sqlite3"), {
      readOnly: true,
    });
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 35);
    db.close();
  },
);
