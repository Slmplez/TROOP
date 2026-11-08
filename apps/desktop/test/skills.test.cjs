const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const temp = path.resolve(__dirname, "../../../.tmp-troop-skills/tests");
fs.mkdirSync(temp, { recursive: true });

test("workflow expansion becoming over budget at a safe boundary records an input error without crashing Core", async (t) => {
  let release, signal;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (signal = r));
  let first = true;
  const h = await setup(t, {
    beforeResponse: async () => {
      if (first) {
        first = false;
        signal();
        await gate;
      }
    },
  });
  t.after(() => release());
  for (let i = 0; i < 4; i++)
    await h.save(
      h.source(
        "budget-" + i,
        "---\nname: Budget " + i + "\n---\n" + "📘".repeat(8000),
      ),
    );
  const id = await h.start();
  await started;
  for (let i = 0; i < 4; i++)
    await h.core.request("skills.enable", {
      id: "budget-" + i,
      agent_id: 1,
      enabled: false,
    });
  await h.core.request("agent.steer", {
    id,
    client_input_id: crypto.randomUUID(),
    text: "@budget-0 @budget-1 @budget-2 @budget-3",
  });
  for (let i = 0; i < 4; i++)
    await h.core.request("skills.enable", {
      id: "budget-" + i,
      agent_id: 1,
      enabled: true,
    });
  release();
  const final = await h.done(id);
  assert.equal(final.run.state, "completed");
  assert.match(final.run.supplements[0].workflow_error, /budget/);
  assert.ok(
    JSON.stringify(h.server.requests.at(-1).body).includes(
      "no recipe was applied",
    ),
  );
  assert.ok(await h.core.request("system.ping", {}));
});

test("inline creation is versioned, conflicts are explicit, and longest workflow handles win", async (t) => {
  const h = await setup(t);
  const first = await h.core.request("skills.edit", {
    id: "rust",
    expected_revision: 0,
    raw: "---\nname: Rust\n---\nSHORT_RECIPE",
  });
  assert.equal(first.revision, 1);
  await assert.rejects(
    h.core.request("skills.edit", {
      id: "rust",
      expected_revision: 0,
      raw: "stale",
    }),
    /conflict/,
  );
  await h.save(h.source());
  const id = await h.start({ goal: "@Rust review" }),
    final = await h.done(id);
  assert.equal(final.run.workflow_expansions.length, 1);
  assert.equal(final.run.workflow_expansions[0].id, "rust-review");
  assert.ok(
    !JSON.stringify(h.server.requests[0].body).includes("SHORT_RECIPE"),
  );
  const other = await h.start({
    goal: "[wrong](sand-workflow:rust-review-other)",
  });
  assert.equal((await h.done(other)).run.workflow_expansions.length, 0);
});

test("large manifests and frontmatter remain bounded across preview, list and model tools", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "read_skill",
              arguments: { skill_id: "rust-review", file_offset: "32" },
            },
          ],
  });
  const files = {};
  for (let n = 0; n < 100; n++)
    files[
      "reference-" +
        "a".repeat(65) +
        "/file-" +
        n +
        "-" +
        "b".repeat(85) +
        ".txt"
    ] = "owned";
  const s = h.source(
    undefined,
    "---\nname: Bounds\ndescription: " +
      "审查".repeat(700) +
      "\nmetadata:\n  source: " +
      "x".repeat(50000) +
      "\n---\nBOUNDED_RECIPE",
    files,
  );
  const preview = await h.preview(s);
  assert.equal(preview.files.length, 101);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 62000);
  await h.save(s);
  const id = await h.start();
  await h.done(id);
  const output = (await h.invocation(id)).result;
  assert.equal(output.files.length, 32);
  assert.equal(output.file_count, 101);
  assert.equal(output.next_file_offset, 64);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 62000);
});

test("materialized helper modifications are detected without overwriting the changed file", async (t) => {
  const h = await setup(t, {
    beforeResponse: async ({ body }) => {
      const r = results(body);
      if (r.length === 1)
        fs.writeFileSync(
          path.join(r[0].directory, "reference.txt"),
          "CHANGED_EXPORT",
        );
    },
    plan: ({ body }) => {
      const r = results(body);
      return r.length === 0
        ? [{ name: "read_skill", arguments: { skill_id: "rust-review" } }]
        : r.length === 1
          ? [
              {
                name: "read_skill_file",
                arguments: { skill_id: "rust-review", path: "reference.txt" },
              },
            ]
          : [];
    },
  });
  await h.save(
    h.source(undefined, undefined, { "reference.txt": "ORIGINAL_HELPER" }),
  );
  const id = await h.start();
  await h.done(id);
  const first = await h.invocation(id),
    second = await h.invocation(id, 1);
  assert.equal(second.state, "failed");
  assert.match(second.result.error, /changed/);
  assert.equal(
    fs.readFileSync(path.join(first.result.directory, "reference.txt"), "utf8"),
    "CHANGED_EXPORT",
  );
});
const results = (body) =>
  (body.messages ?? body.input).flatMap((m) =>
    m.role === "tool"
      ? [JSON.parse(m.content)]
      : m.type === "function_call_output"
        ? [JSON.parse(m.output)]
        : Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === "tool_result")
              .map((b) => JSON.parse(b.content))
          : [],
  );
async function until(fn) {
  for (let i = 0; i < 600; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  throw Error("Skill condition timed out");
}
async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(temp, "case-")),
    workspace = path.join(directory, "workspace"),
    data = path.join(directory, "data");
  fs.mkdirSync(workspace);
  const server = await agentServer({ plan: () => [], ...options });
  const core = new CoreSupervisor({
    executable: path.resolve(__dirname, "../bin", coreBinary),
    args: ["--data-dir", data],
    timeout: 10000,
  });
  await core.start();
  t.after(async () => {
    await core.stop();
    await server.close();
  });
  await core.request("memory.agent.save", {
    id: 1,
    name: "Owned Skills Agent",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const provider = await core.request("provider.save", {
    config: {
      name: "Owned skills fixture",
      protocol: options.protocol ?? "anthropic",
      base_url: server.origin,
      model: "owned-skill-fixture",
      max_output_tokens: 2048,
      idle_timeout_secs: 5,
    },
  });
  const start = async (extra = {}) =>
    (
      await core.request("agent.start", {
        client_run_id: crypto.randomUUID(),
        workspace_id: wid,
        provider_id: provider.id,
        goal: "Use local skills",
        ...extra,
      })
    ).run.id;
  const get = (id) => core.request("agent.get", { id });
  const done = (id) =>
    until(async () => {
      const s = await get(id);
      return (
        ["completed", "failed", "cancelled", "interrupted"].includes(
          s.run.state,
        ) && s
      );
    });
  function source(
    id = "rust-review",
    raw = "---\nname: Rust review\nid: rust-review\ndescription: Review local Rust code\n---\nOWNED_RECIPE_V1",
    files = {},
  ) {
    const dir = path.join(directory, "source-" + id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), raw);
    for (const [file, bytes] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), bytes);
    }
    return { path: dir, id, mode: "copy", source_kind: "local" };
  }
  const preview = (s) => core.request("skills.preview", s);
  const save = async (s) => {
    const p = await preview(s);
    return core.request("skills.import", {
      source: s,
      preview_hash: p.preview_hash,
      expected_revision: p.expected_revision,
    });
  };
  const list = (agent_id = 1, offset = 0) =>
    core.request("skills.list", { agent_id, offset });
  const invocation = async (run, n = 0) =>
    core.request("agent.invocation", {
      id: (await get(run)).invocations[n].id,
    });
  return {
    directory,
    workspace,
    data,
    server,
    core,
    start,
    get,
    done,
    source,
    preview,
    save,
    list,
    invocation,
  };
}

for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(
    protocol +
      ": frozen skill discovery, body and auxiliary files reach real tool history",
    async (t) => {
      const h = await setup(t, {
        protocol,
        plan: ({ body }) =>
          results(body).length
            ? []
            : [
                { name: "read_skill", arguments: { skill_id: "rust-review" } },
                {
                  name: "read_skill_file",
                  arguments: {
                    skill_id: "rust-review",
                    path: "references/checks.md",
                  },
                },
              ],
      });
      const s = h.source(undefined, undefined, {
        "references/checks.md": "Owned Rust checklist",
        "scripts/proof.ps1": "Write-Output 'owned'",
      });
      const saved = await h.save(s);
      assert.equal(saved.mode, "copy");
      const id = await h.start(),
        final = await h.done(id);
      assert.equal(final.run.state, "completed");
      assert.equal(final.invocations.length, 2);
      const first = await h.invocation(id),
        second = await h.invocation(id, 1);
      assert.match(first.result.content.text, /OWNED_RECIPE_V1/);
      assert.equal(second.result.content.text, "Owned Rust checklist");
      assert.ok(first.result.files.some((f) => f.path === "scripts/proof.ps1"));
      assert.ok(
        fs
          .readFileSync(
            path.join(first.result.directory, "scripts/proof.ps1"),
            "utf8",
          )
          .includes("owned"),
      );
      assert.ok(
        JSON.stringify(h.server.requests[0].body).includes(
          "Review local Rust code",
        ),
      );
      assert.ok(
        JSON.stringify(h.server.requests.at(-1).body).includes(
          "Owned Rust checklist",
        ),
      );
      if (protocol === "anthropic")
        assert.ok(h.server.requests[0].body.system.includes("Local skills"));
      assert.equal(final.run.skill_versions[0].version_id, saved.version_id);
    },
  );

test("import preview fences changing bytes and conflicts retain prior versions without modifying source", async (t) => {
  const h = await setup(t),
    s = h.source();
  const p = await h.preview(s);
  const file = path.join(s.path, "SKILL.md");
  fs.appendFileSync(file, "\nV2");
  await assert.rejects(
    h.core.request("skills.import", {
      source: s,
      preview_hash: p.preview_hash,
      expected_revision: 0,
    }),
    /changed/,
  );
  const v1 = await h.save(s),
    conflict = await h.preview(s);
  assert.equal(conflict.existing.version_id, v1.version_id);
  const bytes = fs.readFileSync(file);
  const v2 = await h.core.request("skills.edit", {
    id: s.id,
    expected_revision: v1.revision,
    raw: "---\nname: Edited\n---\nLOCAL_EDIT",
  });
  assert.ok(fs.readFileSync(file).equals(bytes));
  assert.equal(v2.locally_modified, true);
  await assert.rejects(
    h.core.request("skills.import", {
      source: s,
      preview_hash: conflict.preview_hash,
      expected_revision: conflict.expected_revision,
    }),
    /conflict/,
  );
  const history = await h.core.request("skills.versions", { id: s.id });
  assert.equal(history.items.length, 2);
  const old = await h.core.request("skills.get", {
    id: s.id,
    version_id: v1.version_id,
  });
  assert.match(old.content.text, /OWNED_RECIPE/);
  await assert.rejects(
    h.core.request("skills.remove", {
      id: s.id,
      expected_revision: v1.revision,
    }),
    /conflict/,
  );
});

test("Agent disable blocks discovery, workflow expansion and forced tool loads, without affecting other Agents", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [{ name: "read_skill", arguments: { skill_id: "rust-review" } }],
  });
  await h.save(h.source());
  const beta = await h.core.request("memory.agent.save", {
    name: "Beta",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  await h.core.request("skills.enable", {
    id: "rust-review",
    agent_id: 1,
    enabled: false,
  });
  const id = await h.start({ goal: "@rust-review" });
  await h.done(id);
  assert.equal((await h.invocation(id)).state, "failed");
  assert.ok(
    !JSON.stringify(h.server.requests[0].body).includes("OWNED_RECIPE"),
  );
  assert.ok(
    !JSON.stringify(h.server.requests[0].body).includes(
      "Review local Rust code",
    ),
  );
  await assert.rejects(h.start({ workflow_id: "rust-review" }), /disabled/);
  const bid = await h.start({ agent_id: beta.id });
  await h.done(bid);
  assert.equal((await h.invocation(bid)).state, "succeeded");
  assert.equal((await h.list()).items[0].enabled, false);
  assert.equal((await h.list(beta.id)).items[0].enabled, true);
});

test("manual-only recipes support Run Now and legacy mentions but stay out of automatic discovery", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [{ name: "read_skill", arguments: { skill_id: "rust-review" } }],
  });
  await h.save(
    h.source(
      undefined,
      "---\nname: Rust review\ndisable-model-invocation: true\n---\nEXPLICIT_ONLY",
    ),
  );
  let id = await h.start();
  await h.done(id);
  assert.equal((await h.invocation(id)).state, "failed");
  assert.ok(
    !JSON.stringify(h.server.requests[0].body).includes("EXPLICIT_ONLY"),
  );
  for (const goal of [
    "@rust-review",
    "@Rust review",
    "@Rustreview",
    "[recipe](sand-workflow:rust-review)",
  ]) {
    id = await h.start({ goal });
    const final = await h.done(id);
    assert.equal((await h.invocation(id)).state, "succeeded");
    assert.equal(final.run.workflow_expansions.length, 1);
  }
  id = await h.start({ goal: "Run the review", workflow_id: "rust-review" });
  const final = await h.done(id);
  assert.equal(final.run.workflow_expansions.length, 1);
  id = await h.start({ goal: "email@rust-reviewish" });
  await h.done(id);
  assert.equal((await h.invocation(id)).state, "failed");
});

test("live source changes become new versions for new Runs; old recipes and helpers stay frozen", async (t) => {
  let release, signal;
  const gate = new Promise((r) => (release = r)),
    paused = new Promise((r) => (signal = r));
  let first = true;
  const h = await setup(t, {
    beforeResponse: async () => {
      if (first) {
        first = false;
        signal();
        await gate;
      }
    },
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "read_skill_file",
              arguments: { skill_id: "rust-review", path: "reference.txt" },
            },
          ],
  });
  t.after(() => release());
  const s = {
    ...h.source(undefined, undefined, { "reference.txt": "OLD_HELPER" }),
    mode: "live",
  };
  const old = await h.save(s);
  const id = await h.start({ goal: "@rust-review" });
  await paused;
  fs.writeFileSync(path.join(s.path, "reference.txt"), "NEW_HELPER");
  fs.appendFileSync(path.join(s.path, "SKILL.md"), "\nNEW_RECIPE");
  assert.equal((await h.list()).items[0].source_status, "changed");
  const newer = await h.start({ goal: "@rust-review" });
  release();
  await h.done(id);
  await h.done(newer);
  assert.equal((await h.invocation(id)).result.content.text, "OLD_HELPER");
  assert.equal((await h.invocation(newer)).result.content.text, "NEW_HELPER");
  assert.equal(
    (await h.get(id)).run.skill_versions[0].version_id,
    old.version_id,
  );
  assert.notEqual(
    (await h.get(newer)).run.skill_versions[0].version_id,
    old.version_id,
  );
  assert.ok(!JSON.stringify(h.server.requests[0].body).includes("NEW_RECIPE"));
  const current = (await h.list()).items[0];
  const edited = await h.core.request("skills.edit", {
    id: current.id,
    expected_revision: current.revision,
    raw: "---\nname: Detached\n---\nDETACHED_COPY",
  });
  assert.equal(edited.mode, "copy");
  assert.ok(
    fs
      .readFileSync(path.join(s.path, "SKILL.md"), "utf8")
      .includes("NEW_RECIPE"),
  );
});

test("missing live source is visible and excluded from new Runs; copy versions survive source removal and restart", async (t) => {
  const h = await setup(t),
    s = h.source(),
    live = {
      ...h.source("live", "---\nname: Live\n---\nLIVE_RECIPE"),
      mode: "live",
    };
  await h.save(s);
  await h.save(live);
  fs.unlinkSync(path.join(s.path, "SKILL.md"));
  fs.unlinkSync(path.join(live.path, "SKILL.md"));
  let rows = (await h.list()).items;
  assert.equal(rows.find((r) => r.id === "live").source_status, "unavailable");
  await assert.rejects(h.start({ workflow_id: "live" }), /unavailable/);
  await h.core.stop();
  await h.core.start();
  const id = await h.start({ workflow_id: s.id }),
    final = await h.done(id);
  assert.equal(final.run.skill_versions.length, 1);
  assert.equal(final.run.skill_unavailable[0].id, "live");
  assert.ok(
    JSON.stringify(h.server.requests.at(-1).body).includes("OWNED_RECIPE"),
  );
});

test("automation frontmatter is retained without being scheduled or exposed as an ordinary skill", async (t) => {
  const h = await setup(t);
  await h.save(
    h.source(
      "scheduled",
      "---\nname: Scheduled\nmetadata:\n  source: owned-origin\ntrigger:\n  schedule: '@every 1m'\n  enabled: true\n---\nAUTOMATION_RECIPE",
    ),
  );
  const row = (await h.list()).items[0];
  assert.equal(row.automation, true);
  assert.equal(row.trigger.schedule, "@every 1m");
  assert.equal(row.source_ref, "owned-origin");
  await assert.rejects(h.start({ workflow_id: row.id }), /automation/);
  const id = await h.start();
  await h.done(id);
  assert.equal((await h.get(id)).run.skill_versions.length, 0);
  assert.ok(
    !JSON.stringify(h.server.requests.at(-1).body).includes(
      "AUTOMATION_RECIPE",
    ),
  );
});

test("auxiliary traversal and Windows junctions are rejected; oversized trees are not silently truncated", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "read_skill_file",
              arguments: { skill_id: "rust-review", path: "../outside.txt" },
            },
          ],
  });
  const s = h.source();
  await h.save(s);
  const id = await h.start();
  await h.done(id);
  assert.equal((await h.invocation(id)).state, "failed");
  const outside = path.join(h.directory, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "OWNED_NOT_IMPORTED");
  fs.symlinkSync(outside, path.join(s.path, "junction"), "junction");
  await assert.rejects(h.preview(s), /reparse|symbolic/);
  fs.unlinkSync(path.join(s.path, "junction"));
  for (let i = 0; i < 130; i++)
    fs.writeFileSync(path.join(s.path, "file-" + i), "owned");
  await assert.rejects(h.preview(s), /128 files/);
});

test("skill import transaction rolls back all files and version pointers on storage failure", async (t) => {
  const h = await setup(t),
    s = h.source(undefined, undefined, { "z.txt": "owned" }),
    db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER skill_fault BEFORE INSERT ON skill_files WHEN NEW.path='z.txt' BEGIN SELECT RAISE(ABORT,'skill-fault'); END",
  );
  await assert.rejects(h.save(s), /skill-fault/);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM skill_versions").get().n,
    0,
  );
  assert.equal((await h.list()).total, 0);
  db.exec("DROP TRIGGER skill_fault");
  db.close();
  assert.ok((await h.save(s)).version_id);
});

test("skill instruction and helper pages preserve Unicode boundaries and identify binary bytes", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            { name: "read_skill", arguments: { skill_id: "rust-review" } },
            {
              name: "read_skill_file",
              arguments: { skill_id: "rust-review", path: "image.bin" },
            },
          ],
  });
  await h.save(
    h.source(undefined, "---\nname: Unicode\n---\n" + "中文记录".repeat(2500), {
      "image.bin": Buffer.from([0xff, 0x00, 0xab]),
    }),
  );
  const id = await h.start();
  await h.done(id);
  const a = (await h.invocation(id)).result.content,
    b = (await h.invocation(id, 1)).result.content;
  assert.equal(a.next_offset % 3, 0);
  assert.ok(!a.text.includes("�"));
  assert.equal(b.binary, true);
  assert.equal(b.bytes, 3);
  const raw = await h.core.request("skills.get", {
    id: "rust-review",
    offset: 1,
  });
  assert.ok(raw.content.text);
});

test("imported PowerShell helper remains inert until exact host command approval", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) => {
      const r = results(body);
      if (!r.length)
        return [{ name: "read_skill", arguments: { skill_id: "rust-review" } }];
      if (r.length === 1)
        return [
          {
            name: "run_command",
            arguments: {
              command:
                "& '" +
                path
                  .join(r[0].directory, "scripts/proof.ps1")
                  .replaceAll("'", "''") +
                "'",
            },
          },
        ];
      return [];
    },
  });
  const s = h.source(undefined, undefined, {
    "scripts/proof.ps1":
      "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'skill-proof.txt'), 'owned-helper')",
  });
  await h.save(s);
  assert.ok(!fs.existsSync(path.join(h.workspace, "skill-proof.txt")));
  const id = await h.start();
  await until(async () => (await h.get(id)).run.waiting.includes("approval"));
  const inv = await h.invocation(id, 1);
  assert.equal(inv.name, "run_command");
  assert.ok(!fs.existsSync(path.join(h.workspace, "skill-proof.txt")));
  await h.core.request("agent.approve", {
    id: inv.id,
    epoch: inv.epoch,
    approved: true,
  });
  const final = await h.done(id);
  assert.equal(final.run.state, "completed");
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "skill-proof.txt"), "utf8"),
    "owned-helper",
  );
});

test("disabled and deleted versions cannot be loaded by already-started Runs", async (t) => {
  let release, signal;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (signal = r));
  const h = await setup(t, {
    beforeResponse: async () => {
      signal();
      await gate;
    },
    plan: ({ body }) =>
      results(body).length
        ? []
        : [{ name: "read_skill", arguments: { skill_id: "rust-review" } }],
  });
  t.after(() => release());
  const v = await h.save(h.source()),
    id = await h.start();
  await started;
  await h.core.request("skills.remove", {
    id: v.id,
    expected_revision: v.revision,
  });
  release();
  await h.done(id);
  assert.equal((await h.invocation(id)).state, "failed");
  assert.equal((await h.list()).total, 0);
  assert.equal(
    (await h.core.request("skills.versions", { id: v.id })).items.length,
    1,
  );
});

test("Agent children inherit the frozen library and read-only access does not grant host script execution", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) => {
      const first = (body.messages ?? body.input).find(
        (m) => m.role === "user",
      )?.content;
      if (results(body).length) return [];
      return typeof first === "string" && first.includes("Child owned goal")
        ? [{ name: "read_skill", arguments: { skill_id: "rust-review" } }]
        : [
            {
              name: "spawn_agent",
              arguments: {
                goal: "Child owned goal @rust-review",
                access: "read_only",
              },
            },
          ];
    },
  });
  const v = await h.save(h.source()),
    id = await h.start();
  const final = await h.done(id);
  assert.equal(final.run.state, "completed");
  const childId = final.tasks.find((t) => t.kind === "agent").child_run_id,
    child = await h.get(childId);
  assert.equal(child.run.read_only, true);
  assert.equal(child.run.skill_versions[0].version_id, v.version_id);
  assert.equal((await h.invocation(childId)).state, "succeeded");
});
