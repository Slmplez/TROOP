const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./fixtures/hooks-fixture.cjs");
test("editing a memory preserves its identity and exposes immutable revisions with provenance", async (t) => {
  const h = await setup(t);
  await h.core.request("memory.write", {
    agent_id: 1,
    scope: "agent",
    tier: "profile",
    content: "Project uses version one",
  });
  const before = (await h.core.request("memory.list", { agent_id: 1 }))
    .items[0];
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: before.id,
    expected_revision: before.revision,
    content: "Project uses version two",
  });
  const after = (await h.core.request("memory.list", { agent_id: 1 })).items[0];
  assert.equal(after.id, before.id);
  assert.equal(after.memory_id, before.memory_id);
  assert.notEqual(after.revision_id, before.revision_id);
  assert.equal(after.revision, before.revision + 1);
  const history = await h.core.request("memory.history", {
    agent_id: 1,
    id: after.id,
  });
  assert.deepEqual(
    history.items.map((r) => r.content),
    ["Project uses version two", "Project uses version one"],
  );
  assert.equal(history.items[0].previous_revision_id, before.revision_id);
  assert.equal(history.items[0].source.kind, "user_command");
  assert.equal(history.items[0].protected, true);
  const run = await h.start();
  await h.done(run);
  const usage = await h.core.request("memory.usage", { run_id: run });
  assert.equal(usage.items[0].memory_id, after.id);
  assert.equal(usage.items[0].revision_id, after.revision_id);
  assert.ok(
    h.server.requests[0].body.system.includes(`Revision #${after.revision_id}`),
  );
  await h.core.stop();
  await h.core.start();
  assert.deepEqual(
    (await h.core.request("memory.history", { agent_id: 1, id: after.id }))
      .items,
    history.items,
  );
  const crypto = require("node:crypto");
  const restored = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "memory.restore",
    input: {
      agent_id: 1,
      id: after.id,
      expected_revision: after.revision,
      revision_id: before.revision_id,
    },
  });
  assert.equal(restored.state, "committed", JSON.stringify(restored.error));
  const current = (await h.core.request("memory.list", { agent_id: 1 }))
    .items[0];
  assert.equal(current.id, before.id);
  assert.equal(current.content, "Project uses version one");
  assert.equal(current.revision, after.revision + 1);
});

test("shared forgetting covers every author and blocks another Agent until explicit restore", async (t) => {
  const crypto = require("node:crypto");
  const h = await setup(t, {
    plan: [
      {
        name: "update_state",
        arguments: {
          target: "memory",
          action: "write",
          scope: "user",
          content: "Shared retention rule",
        },
      },
    ],
  });
  const beta = await h.core.request("memory.agent.save", {
    name: "Other maintainer",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  for (const agent_id of [1, beta.id])
    await h.core.request("memory.write", {
      agent_id,
      scope: "user",
      tier: "profile",
      content: "Shared retention rule",
    });
  const original = (
    await h.core.request("memory.list", { agent_id: 1 })
  ).items.find((m) => m.agent_id === 1);
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: original.id,
    expected_revision: original.revision,
    content: null,
  });
  assert.equal(
    (await h.core.request("memory.list", { agent_id: beta.id })).items.length,
    0,
  );
  const gamma = await h.core.request("memory.agent.save", {
    name: "Editor",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  await h.core.request("memory.write", {
    agent_id: gamma.id,
    scope: "user",
    tier: "profile",
    content: "Another shared fact",
  });
  const other = (await h.core.request("memory.list", { agent_id: beta.id }))
    .items[0];
  await assert.rejects(
    h.core.request("memory.edit", {
      agent_id: beta.id,
      id: other.id,
      expected_revision: other.revision,
      content: "Shared retention rule",
    }),
    /遗忘|恢复/,
  );
  await h.core.request("memory.edit", {
    agent_id: beta.id,
    id: other.id,
    expected_revision: other.revision,
    content: null,
  });
  const run = await h.start({ agent_id: beta.id });
  await h.done(run);
  assert.equal((await h.call(run)).result.ok, false);
  assert.equal(
    (await h.core.request("memory.list", { agent_id: beta.id })).items.length,
    0,
  );
  const history = await h.core.request("memory.history", {
    agent_id: beta.id,
    id: original.id,
  });
  assert.equal(history.items[0].deleted, true);
  assert.equal(history.forgetting.active, true);
  const receipt = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "memory.restore",
    input: {
      agent_id: beta.id,
      id: original.id,
      expected_revision: history.items[0].revision,
    },
  });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  assert.equal(
    (await h.core.request("memory.list", { agent_id: beta.id })).items.length,
    1,
  );
  assert.equal(
    (
      await h.core.request("memory.history", {
        agent_id: beta.id,
        id: original.id,
      })
    ).forgetting.active,
    false,
  );
});

test("legacy shared tombstones suppress other authors while baseline history stays explicit", async (t) => {
  const { DatabaseSync } = require("node:sqlite"),
    path = require("node:path");
  const h = await setup(t);
  const beta = await h.core.request("memory.agent.save", {
    name: "Legacy author",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  for (const agent_id of [1, beta.id])
    await h.core.request("memory.write", {
      agent_id,
      scope: "user",
      tier: "profile",
      content: "Legacy forgotten fact",
    });
  await h.core.request("memory.write", {
    agent_id: beta.id,
    scope: "agent",
    tier: "profile",
    content: "Legacy forgotten fact",
  });
  const records = (await h.core.request("memory.list", { agent_id: beta.id }))
    .items;
  const forgotten = records.find((m) => m.scope === "user" && m.agent_id === 1),
    copy = records.find((m) => m.scope === "user" && m.agent_id === beta.id);
  await h.core.stop();
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "DROP TABLE reminder_notifications; DROP TABLE reminder_slots; DROP TABLE reminder_states; DROP TABLE reminder_preferences; DROP TABLE group_executors; DROP TABLE group_chains; DROP TRIGGER group_project_revoked;",
  );
  db.exec(
    "DROP TABLE group_deliveries; DROP TABLE group_messages; DROP TABLE group_chats; DROP TABLE work_item_runs; DROP TABLE work_items;",
  );
  db.exec(
    "DROP TABLE cli_interactions; DROP TABLE memory_conflicts; DROP TRIGGER memory_legacy_no_insert; DROP TRIGGER memory_legacy_no_update; DROP TRIGGER memory_legacy_no_delete; DROP TRIGGER memory_revision_insert; DROP TRIGGER memory_revision_update; INSERT INTO memories SELECT * FROM memory_entries; DROP VIEW active_memory_entries; DROP TABLE memory_entries; DROP VIEW active_memories; DROP TRIGGER memory_revision_no_update; DROP TRIGGER memory_revision_no_delete; DROP TABLE memory_revisions; DROP TABLE memory_forgetting; ALTER TABLE memories DROP COLUMN protected; ALTER TABLE memories DROP COLUMN source_ref;",
  );
  db.prepare(
    "UPDATE memories SET deleted=1,revision=revision+1 WHERE id=?",
  ).run(forgotten.id);
  db.prepare("INSERT INTO memory_tombstones VALUES(?,'user','',?)").run(
    1,
    "legacy forgotten fact",
  );
  db.exec("PRAGMA user_version=17");
  db.close();
  await h.core.start();
  const visible = (await h.core.request("memory.list", { agent_id: beta.id }))
    .items;
  assert.equal(visible.length, 1);
  assert.equal(visible[0].scope, "agent");
  const archive = (
    await h.core.request("memory.list", {
      agent_id: beta.id,
      include_deleted: true,
    })
  ).items;
  assert.equal(archive.filter((m) => m.deleted).length, 2);
  const history = await h.core.request("memory.history", {
    agent_id: beta.id,
    id: copy.id,
  });
  assert.equal(history.items[0].source.kind, "legacy_forgetting");
  assert.ok(
    history.items.every((r) => r.history_completeness === "baseline_only"),
  );
  assert.equal(history.forgetting.active, true);
});

test("context and on-demand recall both honor this Run's selected project scope", async (t) => {
  const h = await setup(t, {
    plan: [{ name: "recall_memory", arguments: { scope: "project" } }],
  });
  for (const project of ["project-a", "project-b"]) {
    await h.core.request("memory.membership", {
      agent_id: 1,
      project,
      action: "create",
    });
    await h.core.request("memory.write", {
      agent_id: 1,
      scope: "project",
      project,
      tier: "profile",
      content: "Fact for " + project,
    });
  }
  const id = await h.start({ project_ids: ["project-a"] });
  await h.done(id);
  const recalled = (await h.call(id)).result.memories;
  assert.deepEqual(
    recalled.map((m) => m.project),
    ["project-a"],
  );
  assert.ok(h.server.requests[0].body.system.includes("Fact for project-a"));
  assert.ok(!h.server.requests[0].body.system.includes("Fact for project-b"));
  const used = await h.core.request("memory.usage", { run_id: id });
  assert.deepEqual(
    used.items.map((m) => m.project),
    ["project-a"],
  );
  await h.core.request("memory.membership", {
    agent_id: 1,
    project: "project-a",
    action: "leave",
  });
  await assert.rejects(
    h.core.request("memory.history", { agent_id: 1, id: recalled[0].id }),
    /无权/,
  );
  assert.equal(
    (await h.core.request("memory.usage", { run_id: id })).items.length,
    0,
  );
});

test("editing a shared fact records suppressed copies as forgotten and recoverable", async (t) => {
  const crypto = require("node:crypto"),
    h = await setup(t);
  const beta = await h.core.request("memory.agent.save", {
    name: "Shared copy",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  for (const agent_id of [1, beta.id])
    await h.core.request("memory.write", {
      agent_id,
      scope: "user",
      tier: "profile",
      content: "Previous agreement",
    });
  const initial = (await h.core.request("memory.list", { agent_id: 1 })).items;
  const original = initial.find((m) => m.agent_id === 1),
    copy = initial.find((m) => m.agent_id === beta.id);
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: original.id,
    expected_revision: original.revision,
    content: "Current agreement",
  });
  const archived = (
    await h.core.request("memory.list", {
      agent_id: beta.id,
      include_deleted: true,
    })
  ).items.find((m) => m.id === copy.id);
  assert.equal(archived.deleted, true);
  const history = await h.core.request("memory.history", {
    agent_id: beta.id,
    id: copy.id,
  });
  assert.equal(history.allowed_actions.restore.allowed, true);
  const receipt = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "memory.restore",
    input: {
      agent_id: beta.id,
      id: copy.id,
      expected_revision: history.current_revision,
    },
  });
  assert.equal(receipt.state, "committed");
});

test("legacy context cache without revision references is rebuilt on explicit continuation", async (t) => {
  const { until } = require("./fixtures/hooks-fixture.cjs"),
    { DatabaseSync } = require("node:sqlite"),
    path = require("node:path");
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    beforeResponse: async (request, requests) => {
      if (requests.length === 1) await gate;
    },
  });
  t.after(() => release());
  await h.core.request("memory.write", {
    agent_id: 1,
    scope: "agent",
    tier: "profile",
    content: "Stable legacy fact",
  });
  const run = await h.start();
  await until(async () => h.server.requests.length === 1);
  await h.core.stop();
  release();
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.prepare(
    "UPDATE agent_runs SET document=json_set(json_remove(document,'$.memory_snapshot.sources'),'$.memory_snapshot.render',?) WHERE id=?",
  ).run("Legacy render without revision identity", run);
  db.close();
  await h.core.start();
  await h.core.request("agent.resume", { id: run });
  await h.done(run);
  const usage = await h.core.request("memory.usage", { run_id: run });
  assert.equal(usage.items.length, 1);
  assert.ok(
    h.server.requests.at(-1).body.system.includes("Stable legacy fact"),
  );
});

test("identical bodies remain distinct knowledge identities until an explicit merge", async (t) => {
  const h = await setup(t);
  for (let i = 0; i < 2; i++)
    await h.core.request("memory.write", {
      agent_id: 1,
      scope: "agent",
      tier: "profile",
      content: "Same wording, separate source",
    });
  const items = (await h.core.request("memory.list", { agent_id: 1 })).items;
  assert.equal(items.length, 2);
  assert.notEqual(items[0].memory_id, items[1].memory_id);
  assert.notEqual(items[0].revision_id, items[1].revision_id);
});

test("forgetting a knowledge ID never adopts another same-body identity's aliases", async (t) => {
  const crypto = require("node:crypto"),
    h = await setup(t);
  for (let i = 0; i < 2; i++)
    await h.core.request("memory.write", {
      agent_id: 1,
      scope: "agent",
      tier: "profile",
      content: "Original fact",
    });
  const copies = (await h.core.request("memory.list", { agent_id: 1 })).items;
  const first = copies[1],
    second = copies[0];
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: second.id,
    expected_revision: second.revision,
    content: "Current fact",
  });
  const deleted = await h.core.request("memory.history", {
    agent_id: 1,
    id: first.id,
  });
  assert.equal(
    (
      await h.core.request("operations.execute", {
        operation_id: crypto.randomUUID(),
        instance_id: h.core.snapshot().storage_instance,
        method: "memory.restore",
        input: {
          agent_id: 1,
          id: first.id,
          expected_revision: deleted.current_revision,
        },
      })
    ).state,
    "committed",
  );
  await h.core.request("memory.write", {
    agent_id: 1,
    scope: "agent",
    tier: "profile",
    content: "Current fact",
  });
  const third = (
    await h.core.request("memory.list", { agent_id: 1 })
  ).items.find((m) => m.id !== second.id && m.content === "Current fact");
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: third.id,
    expected_revision: third.revision,
    content: null,
  });
  assert.ok(
    (await h.core.request("memory.list", { agent_id: 1 })).items.some(
      (m) => m.id === first.id && m.content === "Original fact",
    ),
  );
});

for (const choice of ["candidate", "base", "both"])
  test(`protected maintenance conflict supports ${choice} resolution with current versions`, async (t) => {
    const crypto = require("node:crypto"),
      { user, until } = require("./fixtures/hooks-fixture.cjs");
    let base;
    const h = await setup(t, {
      reply: ({ body }) =>
        user(body).startsWith("<<TROOP_MEMORY_")
          ? JSON.stringify({
              additions: [],
              removals: [],
              conflicts: [
                {
                  memory_id: base.id,
                  expected_revision: base.revision,
                  content: "Project standard is version two",
                  tier: "profile",
                  evidence_quote: "Project standard is version two",
                },
              ],
            })
          : "The proposed project change is available for review.",
    });
    await h.core.request("memory.write", {
      agent_id: 1,
      scope: "agent",
      tier: "profile",
      content: "Project standard is version one",
    });
    base = (await h.core.request("memory.list", { agent_id: 1 })).items[0];
    const profile = (await h.core.request("memory.agents", {}))[0];
    await h.core.request("memory.agent.save", {
      id: 1,
      name: profile.name,
      automatic: true,
      dreaming: false,
      expected_revision: profile.revision,
    });
    assert.equal(
      (
        await h.core.request("operations.execute", {
          operation_id: crypto.randomUUID(),
          instance_id: h.core.snapshot().storage_instance,
          method: "memory.maintenance.save",
          input: {
            agent_id: 1,
            expected_revision: 0,
            enabled: true,
            provider_id: h.provider.id,
            model: "conflict-maintainer",
          },
        })
      ).state,
      "committed",
    );
    await h.done(
      await h.start({
        goal: "Please consider this new project evidence for future tasks. Project standard is version two",
      }),
    );
    const job = await until(async () =>
      (await h.core.request("memory.jobs", { agent_id: 1 })).find((j) =>
        ["completed", "failed"].includes(j.state),
      ),
    );
    assert.equal(job.state, "completed", job.error);
    const conflicts = await h.core.request("memory.conflicts", { agent_id: 1 });
    assert.equal(conflicts.items.length, 1);
    let conflict = conflicts.items[0];
    assert.equal(conflict.base.memory_id, base.id);
    assert.equal(conflict.base.protected, true);
    assert.equal(
      (await h.core.request("memory.list", { agent_id: 1 })).items.find(
        (m) => m.id === base.id,
      ).content,
      "Project standard is version one",
    );
    await h.core.request("memory.edit", {
      agent_id: 1,
      id: base.id,
      expected_revision: base.revision,
      content: "Project standard is version one with a user clarification",
    });
    const stale = await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.resolve",
      input: {
        agent_id: 1,
        id: conflict.id,
        expected_revision: conflict.revision,
        base_revision: conflict.base.revision,
        candidate_revision: conflict.candidate.revision,
        choice,
      },
    });
    assert.equal(stale.state, "rejected");
    conflict = (await h.core.request("memory.conflicts", { agent_id: 1 }))
      .items[0];
    assert.equal(conflict.snapshot_changed, true);
    assert.equal(conflict.base.revision, base.revision + 1);
    if (choice === "candidate") {
      await h.core.request("memory.edit", {
        agent_id: 1,
        id: conflict.candidate.memory_id,
        expected_revision: conflict.candidate.revision,
        content: conflict.candidate.content,
      });
      const currentProfile = (await h.core.request("memory.agents", {}))[0];
      await h.core.request("memory.agent.save", {
        id: 1,
        name: currentProfile.name,
        automatic: false,
        dreaming: false,
        expected_revision: currentProfile.revision,
      });
      const check = await h.start({
        goal: "Inspect the currently adopted project convention.",
      });
      await h.done(check);
      assert.ok(
        !h.server.requests
          .at(-1)
          .body.system.includes("Project standard is version two"),
        "An edited unresolved candidate must remain outside base context",
      );
      conflict = (await h.core.request("memory.conflicts", { agent_id: 1 }))
        .items[0];
    }
    const result = await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.resolve",
      input: {
        agent_id: 1,
        id: conflict.id,
        expected_revision: conflict.revision,
        base_revision: conflict.base.revision,
        candidate_revision: conflict.candidate.revision,
        choice,
      },
    });
    assert.equal(result.state, "committed", JSON.stringify(result.error));
    const current = (await h.core.request("memory.list", { agent_id: 1 }))
      .items;
    assert.equal(current.length, choice === "both" ? 2 : 1);
    const resolvedBase = current.find((entry) => entry.id === base.id);
    assert.equal(
      resolvedBase.content,
      choice === "candidate"
        ? "Project standard is version two"
        : "Project standard is version one with a user clarification",
    );
    assert.equal(resolvedBase.protected, true);
    if (choice === "both")
      assert.ok(
        current.some(
          (entry) =>
            entry.content === "Project standard is version two" &&
            entry.protected,
        ),
      );
    const other = await h.core.request("memory.agent.save", {
      name: "Other conflict reader",
      automatic: false,
      dreaming: false,
      expected_revision: 0,
    });
    assert.equal(
      (await h.core.request("memory.conflicts", { agent_id: other.id })).items
        .length,
      0,
    );
    const denied = await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.resolve",
      input: {
        agent_id: other.id,
        id: conflict.id,
        expected_revision: conflict.revision,
        base_revision: conflict.base.revision,
        candidate_revision: conflict.candidate.revision,
        choice,
      },
    });
    assert.equal(denied.state, "rejected");
    assert.equal(
      (await h.core.request("memory.conflicts", { agent_id: 1 })).items[0]
        .state,
      "resolved",
    );
  });

for (const scenario of [
  "approved",
  "validation denied",
  "unquoted evidence",
  "protected",
])
  test(`automatic revision handles ${scenario} evidence without losing either fact`, async (t) => {
    const crypto = require("node:crypto"),
      { user, until } = require("./fixtures/hooks-fixture.cjs");
    let phase = 0,
      base;
    const next = "Project build cache now uses generation two";
    const h = await setup(t, {
      reply: ({ body }) => {
        const prompt = user(body);
        if (prompt.startsWith("<<TROOP_MEMORY_VALIDATE>>"))
          return JSON.stringify({ approved: scenario !== "validation denied" });
        if (prompt.startsWith("<<TROOP_MEMORY_"))
          return JSON.stringify(
            phase === 0
              ? {
                  additions: [
                    {
                      content: "Project build cache uses generation one",
                      tier: "profile",
                    },
                  ],
                  removals: [],
                }
              : {
                  additions: [],
                  removals: [],
                  revisions: [
                    {
                      memory_id: base.id,
                      expected_revision: base.revision,
                      content: next,
                      tier: "profile",
                      evidence_quote: next,
                    },
                  ],
                },
          );
        return "The task evidence has been recorded.";
      },
    });
    const profile = (await h.core.request("memory.agents", {}))[0];
    await h.core.request("memory.agent.save", {
      id: 1,
      name: profile.name,
      automatic: true,
      dreaming: false,
      expected_revision: profile.revision,
    });
    await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.maintenance.save",
      input: {
        agent_id: 1,
        expected_revision: 0,
        enabled: true,
        provider_id: h.provider.id,
        model: "revision-maintainer",
      },
    });
    const first = await h.start({
      goal: "Please retain the initial project cache convention for future development tasks.",
    });
    await h.done(first);
    await until(async () =>
      (await h.core.request("memory.jobs", { agent_id: 1 })).find(
        (j) => j.source_run_id === first && j.state === "completed",
      ),
    );
    base = (await h.core.request("memory.list", { agent_id: 1 })).items[0];
    assert.equal(base.protected, false);
    if (scenario === "protected") {
      await h.core.request("memory.edit", {
        agent_id: 1,
        id: base.id,
        expected_revision: base.revision,
        content: base.content,
      });
      base = (await h.core.request("memory.list", { agent_id: 1 })).items[0];
    }
    phase = 1;
    const second = await h.start({
      goal:
        "Please apply this current project convention in future tasks. " +
        (scenario === "unquoted evidence"
          ? "A source still needs verification."
          : next),
    });
    await h.done(second);
    const job = await until(async () =>
      (await h.core.request("memory.jobs", { agent_id: 1 })).find(
        (j) =>
          j.source_run_id === second &&
          ["completed", "failed"].includes(j.state),
      ),
    );
    assert.equal(job.state, "completed", job.error);
    assert.equal(job.model_requests, 2);
    const current = (await h.core.request("memory.list", { agent_id: 1 }))
      .items;
    const original = current.find((entry) => entry.id === base.id);
    const conflicts = (
      await h.core.request("memory.conflicts", { agent_id: 1 })
    ).items;
    if (scenario === "approved") {
      assert.equal(current.length, 1);
      assert.equal(original.revision, base.revision + 1);
      assert.equal(original.content, next);
      assert.equal(original.source.kind, "maintenance_revision");
      assert.equal(conflicts.length, 0);
    } else {
      assert.equal(current.length, 2);
      assert.equal(original.revision, base.revision);
      assert.equal(original.content, base.content);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].candidate.content, next);
      if (scenario === "validation denied") {
        assert.equal(job.validation.approved, false);
        const conflict = conflicts[0];
        const resolved = await h.core.request("operations.execute", {
          operation_id: crypto.randomUUID(),
          instance_id: h.core.snapshot().storage_instance,
          method: "memory.resolve",
          input: {
            agent_id: 1,
            id: conflict.id,
            expected_revision: conflict.revision,
            base_revision: conflict.base.revision,
            candidate_revision: conflict.candidate.revision,
            choice: "base",
          },
        });
        assert.equal(resolved.state, "committed");
        const confirmed = (await h.core.request("memory.list", { agent_id: 1 }))
          .items[0];
        assert.equal(confirmed.protected, true);
        assert.equal(confirmed.revision, base.revision + 1);
        assert.equal(confirmed.source.kind, "conflict_resolution");
      }
    }
  });

test("a late-finishing older task cannot supply fresh evidence for automatic replacement", async (t) => {
  const crypto = require("node:crypto"),
    { user, until } = require("./fixtures/hooks-fixture.cjs");
  let release, base;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const replacement = "Project build cache now uses generation two";
  const oldGoal = "Older pending user evidence. " + replacement;
  const h = await setup(t, {
    beforeResponse: async ({ body }) => {
      if (user(body) === oldGoal) await gate;
    },
    reply: ({ body }) => {
      const prompt = user(body);
      if (prompt.startsWith("<<TROOP_MEMORY_VALIDATE>>"))
        return '{"approved":true}';
      if (prompt.startsWith("<<TROOP_MEMORY_"))
        return JSON.stringify(
          base
            ? {
                additions: [],
                removals: [],
                revisions: [
                  {
                    memory_id: base.id,
                    expected_revision: base.revision,
                    content: replacement,
                    tier: "profile",
                    evidence_quote: replacement,
                  },
                ],
              }
            : {
                additions: [
                  {
                    content: "Project build cache uses generation one",
                    tier: "profile",
                  },
                ],
                removals: [],
              },
        );
      return "Evidence recorded.";
    },
  });
  t.after(() => release());
  const profile = (await h.core.request("memory.agents", {}))[0];
  await h.core.request("memory.agent.save", {
    id: 1,
    name: profile.name,
    automatic: true,
    dreaming: false,
    expected_revision: profile.revision,
  });
  await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "memory.maintenance.save",
    input: {
      agent_id: 1,
      expected_revision: 0,
      enabled: true,
      provider_id: h.provider.id,
      model: "time-proof-maintainer",
    },
  });
  const older = await h.start({ goal: oldGoal });
  await until(() =>
    h.server.requests.some((request) => user(request.body) === oldGoal),
  );
  const newer = await h.start({
    goal: "Please retain the initial cache agreement from this more recent user task.",
  });
  await h.done(newer);
  await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find(
      (job) => job.source_run_id === newer && job.state === "completed",
    ),
  );
  base = (await h.core.request("memory.list", { agent_id: 1 })).items[0];
  release();
  await h.done(older);
  const job = await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find(
      (job) =>
        job.source_run_id === older &&
        ["completed", "failed"].includes(job.state),
    ),
  );
  assert.equal(job.state, "completed", job.error);
  assert.equal(
    (await h.core.request("memory.list", { agent_id: 1 })).items.find(
      (entry) => entry.id === base.id,
    ).content,
    base.content,
  );
  assert.equal(
    (await h.core.request("memory.conflicts", { agent_id: 1 })).items.length,
    1,
  );
});

test("each model attempt retains its own memory revision references across restart", async (t) => {
  const { until } = require("./fixtures/hooks-fixture.cjs");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await setup(t, {
    plan: [{ name: "read_file", arguments: { path: "input.txt" } }],
    beforeResponse: async (request, requests) => {
      if (requests.length === 1) await gate;
    },
  });
  t.after(() => release());
  await h.core.request("memory.write", {
    agent_id: 1,
    scope: "agent",
    tier: "profile",
    content: "Convention before the first model request",
  });
  const original = (await h.core.request("memory.list", { agent_id: 1 }))
    .items[0];
  const run = await h.start();
  await until(() => h.server.requests.length === 1);
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: original.id,
    expected_revision: original.revision,
    content: "Convention before the second model request",
  });
  release();
  await h.done(run);
  let usage = await h.core.request("memory.usage", { run_id: run });
  assert.equal(usage.requests.length, 2);
  const older = usage.requests.find((request) => request.step === 1);
  assert.ok(older.attempt);
  assert.notEqual(usage.items[0].revision_id, original.revision_id);
  usage = await h.core.request("memory.usage", {
    run_id: run,
    request_id: older.id,
  });
  assert.equal(usage.items[0].revision_id, original.revision_id);
  assert.equal(usage.evidence, "prepared_model_request");
  await h.core.stop();
  await h.core.start();
  const restored = await h.core.request("memory.usage", {
    run_id: run,
    request_id: older.id,
  });
  assert.deepEqual(restored, usage);
});

test("large historical provenance remains pageable within protocol frame limits", async (t) => {
  const { DatabaseSync } = require("node:sqlite"),
    path = require("node:path");
  const h = await setup(t);
  for (let i = 0; i < 20; i++)
    await h.core.request("memory.write", {
      agent_id: 1,
      scope: "agent",
      tier: "profile",
      content: `Durable fact ${i}`,
    });
  const run = await h.start();
  await h.done(run);
  await h.core.stop();
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  const row = db
    .prepare(
      "SELECT id,payload FROM agent_events WHERE run_id=? AND kind='model_started'",
    )
    .get(run);
  const payload = JSON.parse(row.payload);
  for (const source of payload.memory_sources)
    source.source = {
      kind: "maintenance_revision",
      evidence_quote: String.fromCharCode(92).repeat(2000),
    };
  db.prepare("UPDATE agent_events SET payload=? WHERE id=?").run(
    JSON.stringify(payload),
    row.id,
  );
  db.close();
  await h.core.start();
  let offset = 0,
    ids = [];
  do {
    const page = await h.core.request("memory.usage", { run_id: run, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 65536);
    ids.push(...page.items.map((item) => item.memory_id));
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(new Set(ids).size, 20);
  assert.equal(ids.length, 20);
});

for (const scope of ["user", "project"])
  test(`authorized ${scope} maintenance shares forgetting across authors`, async (t) => {
    const crypto = require("node:crypto"),
      { user, until } = require("./fixtures/hooks-fixture.cjs");
    const project = scope === "project" ? "shared-project" : "";
    const h = await setup(t, {
      reply: ({ body }) =>
        user(body).startsWith("<<TROOP_MEMORY_VALIDATE>>")
          ? '{"approved":true}'
          : user(body).startsWith("<<TROOP_MEMORY_")
            ? JSON.stringify({
                additions: [
                  {
                    content: "Shared convention from new evidence",
                    tier: "profile",
                  },
                  { content: "Forgotten shared convention", tier: "profile" },
                ],
                removals: [],
              })
            : "Evidence recorded.",
    });
    const beta = await h.core.request("memory.agent.save", {
      name: "Original shared author",
      automatic: false,
      dreaming: false,
      expected_revision: 0,
    });
    if (project) {
      await h.core.request("memory.membership", {
        agent_id: 1,
        project,
        action: "create",
      });
      await h.core.request("memory.membership", {
        agent_id: beta.id,
        project,
        action: "join",
      });
    }
    await h.core.request("memory.write", {
      agent_id: beta.id,
      scope,
      project,
      tier: "profile",
      content: "Forgotten shared convention",
    });
    const old = (await h.core.request("memory.list", { agent_id: 1 })).items[0];
    await h.core.request("memory.edit", {
      agent_id: 1,
      id: old.id,
      expected_revision: old.revision,
      content: null,
    });
    const profile = (await h.core.request("memory.agents", {}))[0];
    await h.core.request("memory.agent.save", {
      id: 1,
      name: profile.name,
      automatic: true,
      dreaming: false,
      expected_revision: profile.revision,
    });
    const configured = await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.maintenance.save",
      input: {
        agent_id: 1,
        expected_revision: 0,
        enabled: true,
        provider_id: h.provider.id,
        model: "shared-maintainer",
        target_scope: scope,
        target_project: project,
      },
    });
    assert.equal(
      configured.state,
      "committed",
      JSON.stringify(configured.error),
    );
    const run = await h.start({
      goal: "Please retain this durable shared convention for future work across this project.",
      project_ids: project ? [project] : [],
    });
    await h.done(run);
    const job = await until(async () =>
      (await h.core.request("memory.jobs", { agent_id: 1 })).find(
        (job) =>
          job.source_run_id === run &&
          ["completed", "failed"].includes(job.state),
      ),
    );
    assert.equal(job.state, "completed", job.error);
    const items = (await h.core.request("memory.list", { agent_id: beta.id }))
      .items;
    assert.equal(items.length, 1);
    assert.equal(items[0].scope, scope);
    assert.equal(items[0].project, project);
    assert.equal(items[0].content, "Shared convention from new evidence");
    assert.equal(
      (
        await h.core.request("memory.history", {
          agent_id: beta.id,
          id: old.id,
        })
      ).forgetting.active,
      true,
    );
  });

for (const scope of ["user", "project"])
  test(`${scope} conflicts preserve authors and can be resolved by a currently authorized shared reader`, async (t) => {
    const crypto = require("node:crypto"),
      { user, until } = require("./fixtures/hooks-fixture.cjs");
    const project = scope === "project" ? "shared-conflict" : "";
    let base;
    const h = await setup(t, {
      reply: ({ body }) =>
        user(body).startsWith("<<TROOP_MEMORY_")
          ? JSON.stringify({
              additions: [],
              removals: [],
              conflicts: [
                {
                  memory_id: base.id,
                  expected_revision: base.revision,
                  content: "Shared replacement proposal",
                  tier: "profile",
                  evidence_quote: "Shared replacement proposal",
                },
              ],
            })
          : "Shared evidence recorded.",
    });
    const beta = await h.core.request("memory.agent.save", {
      name: "Shared knowledge author",
      automatic: false,
      dreaming: false,
      expected_revision: 0,
    });
    if (project) {
      await h.core.request("memory.membership", {
        agent_id: 1,
        project,
        action: "create",
      });
      await h.core.request("memory.membership", {
        agent_id: beta.id,
        project,
        action: "join",
      });
    }
    await h.core.request("memory.write", {
      agent_id: beta.id,
      scope,
      project,
      tier: "profile",
      content: "Original shared convention",
    });
    base = (await h.core.request("memory.list", { agent_id: 1 })).items[0];
    const profile = (await h.core.request("memory.agents", {}))[0];
    await h.core.request("memory.agent.save", {
      id: 1,
      name: profile.name,
      automatic: true,
      dreaming: false,
      expected_revision: profile.revision,
    });
    await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.maintenance.save",
      input: {
        agent_id: 1,
        expected_revision: 0,
        enabled: true,
        provider_id: h.provider.id,
        model: "shared-conflict-maintainer",
        target_scope: scope,
        target_project: project,
      },
    });
    const run = await h.start({
      goal: "Please consider this shared change with the original knowledge author. Shared replacement proposal",
      project_ids: project ? [project] : [],
    });
    await h.done(run);
    const job = await until(async () =>
      (await h.core.request("memory.jobs", { agent_id: 1 })).find(
        (job) =>
          job.source_run_id === run &&
          ["completed", "failed"].includes(job.state),
      ),
    );
    assert.equal(job.state, "completed", job.error);
    const conflict = (
      await h.core.request("memory.conflicts", { agent_id: beta.id })
    ).items[0];
    assert.equal(conflict.scope, scope);
    const resolution = await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.resolve",
      input: {
        agent_id: beta.id,
        id: conflict.id,
        expected_revision: conflict.revision,
        base_revision: conflict.base.revision,
        candidate_revision: conflict.candidate.revision,
        choice: "candidate",
      },
    });
    assert.equal(
      resolution.state,
      "committed",
      JSON.stringify(resolution.error),
    );
    const current = (await h.core.request("memory.list", { agent_id: beta.id }))
      .items[0];
    assert.equal(current.agent_id, beta.id);
    assert.equal(current.id, base.id);
    assert.equal(current.content, "Shared replacement proposal");
    if (project) {
      await h.core.request("memory.membership", {
        agent_id: beta.id,
        project,
        action: "leave",
      });
      assert.equal(
        (await h.core.request("memory.conflicts", { agent_id: beta.id })).items
          .length,
        0,
      );
    }
  });

for (const change of ["scope", "membership"])
  test(`project maintenance stops an in-flight proposal after ${change} revocation`, async (t) => {
    const crypto = require("node:crypto"),
      { user, until } = require("./fixtures/hooks-fixture.cjs");
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = await setup(t, {
      beforeResponse: async ({ body }) => {
        if (user(body).startsWith("<<TROOP_MEMORY_")) await gate;
      },
      reply: ({ body }) =>
        user(body).startsWith("<<TROOP_MEMORY_")
          ? '{"additions":[{"content":"Revoked late proposal","tier":"profile"}],"removals":[]}'
          : "Evidence recorded.",
    });
    t.after(() => release());
    await h.core.request("memory.membership", {
      agent_id: 1,
      project: "revoked-project",
      action: "create",
    });
    const profile = (await h.core.request("memory.agents", {}))[0];
    await h.core.request("memory.agent.save", {
      id: 1,
      name: profile.name,
      automatic: true,
      dreaming: false,
      expected_revision: profile.revision,
    });
    const settings = {
      agent_id: 1,
      expected_revision: 0,
      enabled: true,
      provider_id: h.provider.id,
      model: "revocation-maintainer",
      target_scope: "project",
      target_project: "revoked-project",
    };
    await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.maintenance.save",
      input: settings,
    });
    const run = await h.start({
      goal: "Please retain durable project knowledge after this source task completes.",
      project_ids: ["revoked-project"],
    });
    await h.done(run);
    await until(() =>
      h.server.requests.some((request) =>
        user(request.body).startsWith("<<TROOP_MEMORY_"),
      ),
    );
    const queued = await h.start({
      goal: "A second eligible project task must retain its queued cancellation.",
      project_ids: ["revoked-project"],
    });
    await h.done(queued);
    await until(
      async () =>
        (await h.core.request("memory.jobs", { agent_id: 1 })).length === 2,
    );
    if (change === "scope")
      await h.core.request("operations.execute", {
        operation_id: crypto.randomUUID(),
        instance_id: h.core.snapshot().storage_instance,
        method: "memory.maintenance.save",
        input: {
          ...settings,
          expected_revision: 1,
          target_scope: "user",
          target_project: "",
        },
      });
    else
      await h.core.request("memory.membership", {
        agent_id: 1,
        project: "revoked-project",
        action: "leave",
      });
    const job = await until(
      async () =>
        (await h.core.request("memory.jobs", { agent_id: 1 })).find(
          (job) => job.source_run_id === run && job.state === "cancelled",
        ),
      1000,
    );
    assert.ok(job.error);
    await until(
      async () =>
        (await h.core.request("memory.jobs", { agent_id: 1 })).every(
          (item) => item.state === "cancelled",
        ),
      1000,
    );
    if (change === "scope")
      await h.core.request("operations.execute", {
        operation_id: crypto.randomUUID(),
        instance_id: h.core.snapshot().storage_instance,
        method: "memory.maintenance.save",
        input: { ...settings, expected_revision: 2 },
      });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(
      (await h.core.request("memory.jobs", { agent_id: 1 })).every(
        (item) => item.state === "cancelled",
      ),
    );
    assert.equal(
      h.server.requests.filter((request) =>
        user(request.body).startsWith("<<TROOP_MEMORY_"),
      ).length,
      1,
    );
    release();
    assert.equal(
      (await h.core.request("memory.list", { agent_id: 1 })).items.length,
      0,
    );
  });

test("different maintainers serialize requests for the same shared memory scope", async (t) => {
  const crypto = require("node:crypto"),
    { user, until, sleep } = require("./fixtures/hooks-fixture.cjs");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await setup(t, {
    beforeResponse: async ({ body }) => {
      if (user(body).startsWith("<<TROOP_MEMORY_")) await gate;
    },
    reply: ({ body }) =>
      user(body).startsWith("<<TROOP_MEMORY_")
        ? '{"additions":[{"content":"Shared scope result","tier":"profile"}],"removals":[]}'
        : "Shared task evidence recorded.",
  });
  t.after(() => release());
  const beta = await h.core.request("memory.agent.save", {
    name: "Second shared maintainer",
    automatic: true,
    dreaming: false,
    expected_revision: 0,
  });
  const profile = (await h.core.request("memory.agents", {})).find(
    (agent) => agent.id === 1,
  );
  await h.core.request("memory.agent.save", {
    id: 1,
    name: profile.name,
    automatic: true,
    dreaming: false,
    expected_revision: profile.revision,
  });
  for (const agent of [1, beta.id])
    await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.maintenance.save",
      input: {
        agent_id: agent,
        expected_revision: 0,
        enabled: true,
        provider_id: h.provider.id,
        model: "serial-shared-maintainer",
        target_scope: "user",
        target_project: "",
      },
    });
  const first = await h.start({
    goal: "Please keep durable evidence from the first shared maintainer task.",
  });
  await h.done(first);
  await until(() =>
    h.server.requests.some((request) =>
      user(request.body).startsWith("<<TROOP_MEMORY_"),
    ),
  );
  const second = await h.start({
    agent_id: beta.id,
    goal: "Please keep durable evidence from the second shared maintainer task.",
  });
  await h.done(second);
  await until(
    async () =>
      (await h.core.request("memory.jobs", { agent_id: beta.id })).length > 0,
  );
  await sleep(150);
  assert.equal(
    h.server.requests.filter((request) =>
      user(request.body).startsWith("<<TROOP_MEMORY_"),
    ).length,
    1,
  );
  release();
  for (const agent of [1, beta.id]) {
    const job = await until(async () =>
      (await h.core.request("memory.jobs", { agent_id: agent })).find((job) =>
        ["completed", "failed"].includes(job.state),
      ),
    );
    assert.equal(job.state, "completed", job.error);
  }
});

test("unrelated source projects do not create permanently unauthorizable maintenance jobs", async (t) => {
  const crypto = require("node:crypto"),
    { sleep } = require("./fixtures/hooks-fixture.cjs");
  const h = await setup(t);
  await h.core.request("memory.membership", {
    agent_id: 1,
    project: "target-project",
    action: "create",
  });
  const profile = (await h.core.request("memory.agents", {}))[0];
  await h.core.request("memory.agent.save", {
    id: 1,
    name: profile.name,
    automatic: true,
    dreaming: false,
    expected_revision: profile.revision,
  });
  await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "memory.maintenance.save",
    input: {
      agent_id: 1,
      expected_revision: 0,
      enabled: true,
      provider_id: h.provider.id,
      model: "project-maintainer",
      target_scope: "project",
      target_project: "target-project",
    },
  });
  await h.done(
    await h.start({
      goal: "This unrelated private source task has durable information but is outside that project.",
      project_ids: [],
    }),
  );
  await sleep(100);
  assert.deepEqual(await h.core.request("memory.jobs", { agent_id: 1 }), []);
});

test("a project maintenance proposal ignores changes in unrelated private and project scopes", async (t) => {
  const crypto = require("node:crypto"),
    { user, until } = require("./fixtures/hooks-fixture.cjs");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await setup(t, {
    beforeResponse: async ({ body }) => {
      if (user(body).startsWith("<<TROOP_MEMORY_")) await gate;
    },
    reply: ({ body }) =>
      user(body).startsWith("<<TROOP_MEMORY_")
        ? '{"additions":[{"content":"Maintained target project convention","tier":"profile"}],"removals":[]}'
        : "Project evidence recorded.",
  });
  t.after(() => release());
  for (const project of ["target-project", "other-project"])
    await h.core.request("memory.membership", {
      agent_id: 1,
      project,
      action: "create",
    });
  const profile = (await h.core.request("memory.agents", {}))[0];
  await h.core.request("memory.agent.save", {
    id: 1,
    name: profile.name,
    automatic: true,
    dreaming: false,
    expected_revision: profile.revision,
  });
  await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "memory.maintenance.save",
    input: {
      agent_id: 1,
      expected_revision: 0,
      enabled: true,
      provider_id: h.provider.id,
      model: "isolated-project-maintainer",
      target_scope: "project",
      target_project: "target-project",
    },
  });
  const run = await h.start({
    goal: "Please retain the durable convention from this explicitly scoped project task.",
    project_ids: ["target-project"],
  });
  await h.done(run);
  await until(() =>
    h.server.requests.some((request) =>
      user(request.body).startsWith("<<TROOP_MEMORY_"),
    ),
  );
  await h.core.request("memory.write", {
    agent_id: 1,
    scope: "agent",
    tier: "profile",
    content: "Unrelated private fact",
  });
  await h.core.request("memory.write", {
    agent_id: 1,
    scope: "project",
    project: "other-project",
    tier: "profile",
    content: "Unrelated project convention",
  });
  release();
  const job = await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find(
      (job) =>
        job.source_run_id === run &&
        ["completed", "failed"].includes(job.state),
    ),
  );
  assert.equal(job.state, "completed", job.error);
  assert.ok(
    (await h.core.request("memory.list", { agent_id: 1 })).items.some(
      (entry) =>
        entry.project === "target-project" &&
        entry.content === "Maintained target project convention",
    ),
  );
});

test("shared validation finishes before an earlier newly-authorized extraction can claim its scope", async (t) => {
  const crypto = require("node:crypto"),
    { user, until } = require("./fixtures/hooks-fixture.cjs");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await setup(t, {
    beforeResponse: async ({ body }) => {
      if (user(body).startsWith("<<TROOP_MEMORY_SYNTHESIS>>")) await gate;
    },
    reply: ({ body }) => {
      if (user(body).startsWith("<<TROOP_MEMORY_VALIDATE>>"))
        return '{"approved":true}';
      if (user(body).startsWith("<<TROOP_MEMORY_"))
        return '{"additions":[{"content":"Shared completed attempt","tier":"profile"}],"removals":[]}';
      return "Durable evidence is available.";
    },
  });
  t.after(() => release());
  const beta = await h.core.request("memory.agent.save", {
    name: "Shared synthesis maintainer",
    automatic: true,
    dreaming: true,
    expected_revision: 0,
  });
  const profile = (await h.core.request("memory.agents", {})).find(
    (agent) => agent.id === 1,
  );
  await h.core.request("memory.agent.save", {
    id: 1,
    name: profile.name,
    automatic: true,
    dreaming: false,
    expected_revision: profile.revision,
  });
  const settings = {
    agent_id: 1,
    expected_revision: 0,
    enabled: false,
    provider_id: h.provider.id,
    model: "serial-attempt-maintainer",
    target_scope: "user",
    target_project: "",
  };
  const save = (input) =>
    h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method: "memory.maintenance.save",
      input,
    });
  await save(settings);
  await save({ ...settings, agent_id: beta.id, enabled: true });
  await h.done(
    await h.start({
      goal: "Earlier private task with durable evidence queued for this shared maintainer.",
    }),
  );
  await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).some(
      (job) => job.state === "waiting_configuration",
    ),
  );
  await h.done(
    await h.start({
      agent_id: beta.id,
      goal: "A shared task requires synthesis and then a separate independent validation.",
    }),
  );
  await until(() =>
    h.server.requests.some((request) =>
      user(request.body).startsWith("<<TROOP_MEMORY_SYNTHESIS>>"),
    ),
  );
  await save({ ...settings, expected_revision: 1, enabled: true });
  release();
  for (const agent of [1, beta.id]) {
    const job = await until(async () =>
      (await h.core.request("memory.jobs", { agent_id: agent })).find((job) =>
        ["completed", "failed"].includes(job.state),
      ),
    );
    assert.equal(job.state, "completed", job.error);
  }
});
