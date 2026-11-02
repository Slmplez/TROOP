const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { setup, until, results, user } = require("./fixtures/hooks-fixture.cjs");
for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(
    protocol +
      ": old workflow write/rewrite/delete parameters commit through real tool history",
    async (t) => {
      let phase = "create";
      const h = await setup(t, {
        protocol,
        plan: ({ body }) =>
          results(body).length
            ? []
            : [
                {
                  name: "update_state",
                  arguments:
                    phase === "create"
                      ? {
                          target: "workflow",
                          action: "write",
                          name: "Owned recipe",
                          description: "Use when checking the owned project",
                          body: "Read input.txt then report evidence.",
                        }
                      : phase === "edit"
                        ? {
                            target: "workflow",
                            action: "write",
                            id: "owned-recipe",
                            name: "Owned recipe",
                            description: "Use when reviewing",
                            body: "REVISED_RECIPE",
                          }
                        : {
                            target: "workflow",
                            action: "delete",
                            id: "owned-recipe",
                          },
                },
              ],
      });
      let id = await h.start();
      await h.done(id);
      assert.equal((await h.call(id)).result.ok, true);
      let row = (await h.core.request("skills.list", { agent_id: 1 })).items[0];
      assert.equal(row.revision, 1);
      phase = "edit";
      id = await h.start();
      await h.done(id);
      assert.equal((await h.call(id)).result.ok, true);
      assert.equal(
        (await h.core.request("skills.versions", { id: row.id })).items.length,
        2,
      );
      assert.ok(
        (
          await h.core.request("skills.get", { id: row.id })
        ).content.text.includes("REVISED_RECIPE"),
      );
      phase = "delete";
      id = await h.start();
      await h.done(id);
      assert.equal((await h.call(id)).result.ok, true);
      assert.equal(
        (await h.core.request("skills.list", { agent_id: 1 })).total,
        0,
      );
      assert.equal(
        (await h.core.request("skills.versions", { id: row.id })).items.length,
        2,
      );
      assert.ok(
        JSON.stringify(h.server.requests.at(-1).body).includes(
          "Workflow library committed",
        ),
      );
    },
  );
test("workflow mutation rejects concurrent user edit frozen before model response", async (t) => {
  let signal, release;
  const started = new Promise((r) => (signal = r)),
    gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    beforeResponse: async () => {
      signal();
      await gate;
    },
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "update_state",
              arguments: {
                target: "workflow",
                action: "write",
                id: "owned",
                name: "Owned",
                description: "Use when owned",
                body: "MODEL_STALE",
              },
            },
          ],
  });
  t.after(() => release());
  await h.core.request("skills.edit", {
    id: "owned",
    expected_revision: 0,
    raw: "---\nname: Owned\n---\nOLD",
  });
  const id = await h.start();
  await started;
  await h.core.request("skills.edit", {
    id: "owned",
    expected_revision: 1,
    raw: "---\nname: Owned\n---\nUSER_NEW",
  });
  release();
  await h.done(id);
  const inv = await h.call(id);
  assert.equal(inv.result.ok, false);
  assert.match(inv.result.error, /changed/);
  assert.ok(
    (await h.core.request("skills.get", { id: "owned" })).content.text.includes(
      "USER_NEW",
    ),
  );
});
test("workflow writes preserve auxiliary files and leave live sources unchanged", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "update_state",
              arguments: {
                target: "workflow",
                action: "write",
                id: "owned",
                name: "Owned",
                description: "Use when owned",
                body: "EDITED",
              },
            },
          ],
  });
  const dir = path.join(h.directory, "source");
  fs.mkdirSync(dir);
  const raw =
    "---\nname: Owned\ndisable-model-invocation: true\nmetadata:\n  source: original\n---\nSOURCE";
  fs.writeFileSync(path.join(dir, "SKILL.md"), raw);
  fs.writeFileSync(path.join(dir, "helper.txt"), "OWNED_HELPER");
  const source = {
      path: dir,
      id: "owned",
      mode: "live",
      source_kind: "managed",
    },
    p = await h.core.request("skills.preview", source);
  await h.core.request("skills.import", {
    source,
    preview_hash: p.preview_hash,
    expected_revision: 0,
  });
  const id = await h.start();
  await h.done(id);
  assert.equal((await h.call(id)).result.ok, true);
  const row = (await h.core.request("skills.list", { agent_id: 1 })).items[0];
  assert.equal(row.mode, "copy");
  assert.equal(row.disable_model_invocation, true);
  assert.equal(row.source_ref, "original");
  assert.equal(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), raw);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"), {
    readOnly: true,
  });
  assert.equal(
    Buffer.from(
      db
        .prepare(
          "SELECT content FROM skill_files WHERE version_id=? AND path=?",
        )
        .get(row.version_id, "helper.txt").content,
    ).toString(),
    "OWNED_HELPER",
  );
  db.close();
});
test("workflow writes and their invocation roll back together when ledger commit fails", async (t) => {
  const h = await setup(t, {
    plan: () => [
      {
        name: "update_state",
        arguments: {
          target: "workflow",
          action: "write",
          name: "Ghost",
          description: "Use when owned",
          body: "NO_GHOST",
        },
      },
    ],
  });
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER workflow_fault BEFORE INSERT ON agent_events WHEN NEW.kind='memory_tool_result' BEGIN SELECT RAISE(ABORT,'workflow-fault'); END",
  );
  const exit = new Promise((r) => h.core.child.once("exit", r));
  await h.start();
  await exit;
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM skill_versions").get().n,
    0,
  );
  db.exec("DROP TRIGGER workflow_fault");
  db.close();
  await h.core.start();
  assert.equal((await h.core.request("skills.list", { agent_id: 1 })).total, 0);
});
test("disabled skills cannot be mutated by the model; readonly child cannot maintain shared recipes", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : user(body).includes("child-maintain")
          ? [
              {
                name: "update_state",
                arguments: {
                  target: "workflow",
                  action: "write",
                  name: "Child recipe",
                  description: "Use when owned",
                  body: "CHILD",
                },
              },
            ]
          : user(body).includes("parent-maintain")
            ? [
                {
                  name: "spawn_agent",
                  arguments: { goal: "child-maintain", access: "read_only" },
                },
              ]
            : [
                {
                  name: "update_state",
                  arguments: {
                    target: "workflow",
                    action: "delete",
                    id: "owned",
                  },
                },
              ],
  });
  await h.core.request("skills.edit", {
    id: "owned",
    expected_revision: 0,
    raw: "---\nname: Owned\n---\nRECIPE",
  });
  await h.core.request("skills.enable", {
    id: "owned",
    agent_id: 1,
    enabled: false,
  });
  let id = await h.start();
  await h.done(id);
  assert.equal((await h.call(id)).result.ok, false);
  id = await h.start({ goal: "parent-maintain" });
  const final = await h.done(id),
    childId = final.tasks[0].child_run_id;
  assert.equal((await h.call(childId)).state, "failed");
  assert.equal((await h.core.request("skills.list", { agent_id: 1 })).total, 1);
});
