const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite"),
  { once } = require("node:events");
const { CoreSupervisor } = require("../src/core-client.cjs"),
  { coreBinary } = require("../src/core-path.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const base = path.resolve(__dirname, "../../../.tmp-troop-memory");
fs.mkdirSync(base, { recursive: true });
test("compaction omits opaque thinking and signatures while preserving their original archive", async (t) => {
  const h = await setup(t, {
    thinking: true,
    plan: ({ body }) =>
      hasResults(body) || user(body).startsWith("Original task:")
        ? []
        : [
            {
              name: "write_file",
              arguments: {
                path: "opaque.txt",
                content: "owned",
                expected_hash: "missing",
              },
            },
          ],
    reply: () => "Summary contains only visible results",
  });
  const id = await h.start(),
    inv = await h.approval(id);
  await h.core.request("agent.compact", { id });
  await h.approve(inv);
  await h.done(id);
  const compact = h.server.requests.find((r) =>
    user(r.body).startsWith("<<TROOP_COMPACTION>>"),
  );
  assert.ok(compact);
  for (const opaque of ["owned reasoning", "owned-signature", "owned-opaque"])
    assert.ok(!JSON.stringify(compact.body).includes(opaque));
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"), {
    readOnly: true,
  });
  const raw = db
    .prepare("SELECT document FROM agent_runs WHERE id=?")
    .get(id).document;
  db.close();
  assert.ok(raw.includes("owned-signature"));
  assert.ok(raw.includes("owned-opaque"));
});
test("unexpected proposal fields are rejected rather than retained in public maintenance details", async (t) => {
  const h = await setup(t, {
    automatic: true,
    reply: () =>
      '{"additions":[],"removals":[],"unexpected":"sensitive-extra"}',
  });
  await h.done(await h.start());
  const [job] = await h.settled();
  assert.equal(job.state, "failed");
  const detail = await h.core.request("memory.job", { id: job.id });
  assert.ok(!JSON.stringify(detail).includes("sensitive-extra"));
  assert.equal((await h.list()).length, 0);
});
test("large shared archives cannot displace private recall or prevent paged editing", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      hasResults(body)
        ? []
        : [
            {
              name: "recall_memory",
              arguments: { text: "Old private preference" },
            },
          ],
  });
  await h.write("Old private preference");
  const agents = [];
  for (let n = 0; n < 3; n++) {
    agents.push(
      await h.core.request("memory.agent.save", {
        name: "Archive " + n,
        automatic: false,
        dreaming: false,
        expected_revision: 0,
      }),
    );
  }
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec("BEGIN");
  db.exec("UPDATE memories SET created_at='2000-01-01T00:00:00Z' WHERE id=1");
  const put = db.prepare(
    "INSERT INTO memories(agent_id,scope,project,fact_key,content,kind,origin) VALUES(?,'user','',?,?,'profile','explicit')",
  );
  for (const a of agents)
    for (let i = 0; i < 1400; i++) {
      const fact = "Shared filler " + a.id + " " + i;
      put.run(a.id, fact.toLowerCase(), fact);
    }
  db.exec("COMMIT");
  db.close();
  const page = await h.core.request("memory.list", {
    agent_id: 1,
    offset: 4200,
  });
  assert.equal(page.total, 4201);
  assert.equal(page.items[0].content, "Old private preference");
  const final = await h.done(await h.start());
  assert.equal(final.run.state, "completed");
  const inv = await h.core.request("agent.invocation", {
    id: final.invocations[0].id,
  });
  assert.equal(inv.result.memories[0].content, "Old private preference");
  assert.ok(
    h.server.requests[0].body.system.includes("Old private preference"),
  );
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: 1,
    expected_revision: 1,
    content: "Older fact edited",
  });
  assert.ok((await h.list()).some((m) => m.content === "Older fact edited"));
});
test("four maintenance streams share the global model quota and independent Agents commit independently", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    automatic: true,
    beforeResponse: async ({ body }) => {
      if (maintenance(body)) await gate;
    },
    reply: () =>
      '{"additions":[{"content":"Independent fact","tier":"profile"}],"removals":[]}',
  });
  const ids = [1];
  for (let i = 0; i < 3; i++) {
    const a = await h.core.request("memory.agent.save", {
      name: "Parallel " + i,
      automatic: true,
      dreaming: false,
      expected_revision: 0,
    });
    ids.push(a.id);
  }
  for (const aid of ids)
    await h.done(await h.start("Parallel maintenance evidence", aid));
  await until(
    () => h.server.requests.filter((r) => maintenance(r.body)).length === 4,
  );
  const queued = await h.start("Must wait for model capacity");
  await sleep(120);
  assert.equal((await h.get(queued)).run.state, "queued");
  await h.core.request("agent.cancel", { id: queued });
  release();
  for (const aid of ids)
    await until(async () => {
      const jobs = await h.core.request("memory.jobs", { agent_id: aid });
      return jobs.length && jobs.every((j) => j.state === "completed");
    });
  for (const aid of ids)
    assert.ok(
      (await h.list(aid)).some((m) => m.content === "Independent fact"),
    );
});
test("child completion arriving during compaction is consumed once after the checkpoint", async (t) => {
  let childRelease, compactRelease, compactSignal;
  const childGate = new Promise((r) => (childRelease = r)),
    compactGate = new Promise((r) => (compactRelease = r)),
    started = new Promise((r) => (compactSignal = r));
  const h = await setup(t, {
    plan: ({ body }) => {
      const first = user(body);
      if (first === "delayed child" || first.startsWith("Original task:"))
        return [];
      if (!hasResults(body))
        return [
          {
            name: "spawn_agent",
            arguments: { goal: "delayed child", access: "read_only" },
          },
        ];
      return [
        {
          name: "write_file",
          arguments: {
            path: "wake.txt",
            content: "once",
            expected_hash: "missing",
          },
        },
      ];
    },
    beforeResponse: async ({ body }) => {
      if (user(body) === "delayed child") await childGate;
      if (user(body).startsWith("<<TROOP_COMPACTION>>")) {
        compactSignal();
        await compactGate;
      }
    },
    reply: () => "Summary: child result may still arrive; write is complete.",
  });
  const id = await h.start("completion race"),
    inv = await h.approval(id);
  await h.core.request("agent.compact", { id });
  await h.approve(inv);
  await started;
  childRelease();
  await until(
    async () =>
      (await h.core.request("agent.tasks", { id })).items[0].state ===
      "succeeded",
  );
  compactRelease();
  assert.equal((await h.done(id)).run.state, "completed");
  const task = (await h.core.request("agent.tasks", { id })).items[0];
  assert.equal(task.consumed, true);
  assert.equal(
    JSON.stringify(h.server.requests.at(-1).body).split(task.completion_id)
      .length - 1,
    1,
  );
});
test("a failed automatic memory batch rolls back all additions without failing the completed run", async (t) => {
  const h = await setup(t, {
    automatic: true,
    reply: () =>
      '{"additions":[{"content":"First addition","tier":"profile"},{"content":"Reject addition","tier":"log"}],"removals":[]}',
  });
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER reject_batch BEFORE INSERT ON memories WHEN NEW.content='Reject addition' BEGIN SELECT RAISE(ABORT,'reject-batch'); END",
  );
  const id = await h.start();
  await h.done(id);
  assert.equal((await h.settled())[0].state, "failed");
  assert.equal((await h.list()).length, 0);
  assert.equal((await h.get(id)).run.state, "completed");
  db.close();
});
test("maintenance snapshot conflicts never overwrite a concurrent explicit edit", async (t) => {
  let signal, release;
  const started = new Promise((r) => (signal = r)),
    gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    automatic: true,
    beforeResponse: async ({ body }) => {
      if (user(body).startsWith("<<TROOP_MEMORY_EXTRACTION>>")) {
        signal();
        await gate;
      }
    },
    reply: () =>
      JSON.stringify({
        additions: [{ content: "Stale automatic fact", tier: "profile" }],
        removals: [],
      }),
  });
  const id = await h.start();
  await h.done(id);
  await started;
  await h.write("Concurrent explicit fact");
  release();
  const [job] = await h.settled();
  assert.equal(job.state, "failed");
  assert.match(job.error, /snapshot changed/);
  assert.deepEqual(
    (await h.list()).map((m) => m.content),
    ["Concurrent explicit fact"],
  );
  assert.equal((await h.get(id)).run.state, "completed");
});
test("disabling maintenance aborts an in-flight proposal and prevents late writes", async (t) => {
  let signal, release;
  const started = new Promise((r) => (signal = r)),
    gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    automatic: true,
    beforeResponse: async ({ body }) => {
      if (maintenance(body)) {
        signal();
        await gate;
      }
    },
    reply: () =>
      '{"additions":[{"content":"Too late","tier":"profile"}],"removals":[]}',
  });
  await h.done(await h.start());
  await started;
  const agent = (await h.core.request("memory.agents", {}))[0];
  await h.core.request("memory.agent.save", {
    id: 1,
    name: agent.name,
    automatic: false,
    dreaming: false,
    expected_revision: agent.revision,
  });
  release();
  await sleep(150);
  assert.equal((await h.jobs())[0].state, "cancelled");
  assert.equal((await h.list()).length, 0);
  await assert.rejects(
    h.core.request("memory.job.retry", { id: (await h.jobs())[0].id }),
  );
});
test("interrupted maintenance does not restart itself after Core restart", async (t) => {
  let signal, release;
  const started = new Promise((r) => (signal = r)),
    gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    automatic: true,
    beforeResponse: async ({ body }) => {
      if (maintenance(body)) {
        signal();
        await gate;
      }
    },
    reply: () => '{"additions":[],"removals":[]}',
  });
  const id = await h.start();
  await h.done(id);
  await started;
  const ended = once(h.core.child, "exit");
  h.core.child.kill();
  await ended;
  release();
  const count = h.server.requests.length;
  await h.core.start();
  await sleep(150);
  assert.equal(h.server.requests.length, count);
  assert.equal((await h.jobs())[0].state, "interrupted");
  assert.equal((await h.get(id)).run.state, "completed");
});
test("an unapproved removal of an explicit fact fails the entire automatic proposal", async (t) => {
  const h = await setup(t, {
    automatic: true,
    reply: () =>
      '{"additions":[{"content":"Side addition","tier":"log"}],"removals":["Explicit protected"]}',
  });
  await h.write("Explicit protected");
  await h.done(await h.start());
  assert.equal((await h.settled())[0].state, "failed");
  assert.deepEqual(
    (await h.list()).map((m) => m.content),
    ["Explicit protected"],
  );
});
test("invalid memory tool input fails one invocation without crashing Core", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      hasResults(body)
        ? []
        : [
            {
              name: "update_state",
              arguments: {
                target: "memory",
                action: "write",
                scope: "project",
                project: "missing",
                content: "Denied",
              },
            },
          ],
  });
  const final = await h.done(await h.start());
  assert.equal(final.run.state, "completed");
  assert.equal(final.invocations[0].state, "failed");
  assert.equal((await h.list()).length, 0);
});
test("compaction stopped mid-stream cannot commit a late checkpoint", async (t) => {
  let signal, release;
  const started = new Promise((r) => (signal = r)),
    gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    plan: ({ body }) =>
      hasResults(body)
        ? []
        : [
            {
              name: "write_file",
              arguments: {
                path: "stop.txt",
                content: "retained",
                expected_hash: "missing",
              },
            },
          ],
    beforeResponse: async ({ body }) => {
      if (user(body).startsWith("<<TROOP_COMPACTION>>")) {
        signal();
        await gate;
      }
    },
    reply: () => "Late summary must not be committed",
  });
  const id = await h.start(),
    inv = await h.approval(id);
  await h.core.request("agent.compact", { id });
  await h.approve(inv);
  await started;
  await h.core.request("agent.cancel", { id });
  release();
  assert.equal((await h.done(id)).run.state, "cancelled");
  await sleep(150);
  assert.equal((await h.core.request("agent.checkpoints", { id })).length, 0);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "stop.txt"), "utf8"),
    "retained",
  );
});
test("compaction commit failure preserves raw history and requires manual recovery", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      hasResults(body)
        ? []
        : [
            {
              name: "write_file",
              arguments: {
                path: "checkpoint.txt",
                content: "once",
                expected_hash: "missing",
              },
            },
          ],
    reply: () => "Summary proof",
  });
  const id = await h.start(),
    inv = await h.approval(id);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER checkpoint_fault BEFORE INSERT ON context_checkpoints BEGIN SELECT RAISE(ABORT,'checkpoint-fault'); END",
  );
  await h.core.request("agent.compact", { id });
  const exit = once(h.core.child, "exit");
  await h.approve(inv);
  await exit;
  const doc = JSON.parse(
    db.prepare("SELECT document FROM agent_runs WHERE id=?").get(id).document,
  );
  assert.ok(doc.history.length >= 3);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM context_checkpoints").get().n,
    0,
  );
  db.exec("DROP TRIGGER checkpoint_fault");
  db.close();
  const count = h.server.requests.length;
  await h.core.start();
  await sleep(150);
  assert.equal((await h.get(id)).run.state, "interrupted");
  assert.equal(h.server.requests.length, count);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "checkpoint.txt"), "utf8"),
    "once",
  );
});
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  throw Error("Memory condition timed out");
}
const user = (body) =>
  (body.messages ?? body.input).find(
    (m) => m.role === "user" && typeof m.content === "string",
  )?.content ?? "";
const maintenance = (body) => user(body).startsWith("<<TROOP_");
function hasResults(body) {
  return (body.messages ?? body.input).some(
    (m) =>
      m.role === "tool" ||
      m.type === "function_call_output" ||
      (Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result")),
  );
}
async function setup(
  t,
  {
    protocol = "anthropic",
    automatic = false,
    dreaming = false,
    plan = () => [],
    reply = () => JSON.stringify({ additions: [], removals: [] }),
    beforeResponse,
    thinking = false,
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(base, "case-")),
    workspace = path.join(directory, "workspace"),
    data = path.join(directory, "data");
  fs.mkdirSync(workspace);
  const server = await agentServer({
    plan: (r) => (maintenance(r.body) ? [] : plan(r)),
    reply: (r) => (maintenance(r.body) ? reply(r) : "Task completed."),
    beforeResponse,
    thinking,
  });
  const core = new CoreSupervisor({
    executable: path.resolve(__dirname, "../bin", coreBinary),
    args: ["--data-dir", data],
  });
  await core.start();
  t.after(async () => {
    await core.stop();
    await server.close();
  });
  await core.request("memory.agent.save", {
    id: 1,
    name: "Alpha",
    automatic,
    dreaming,
    expected_revision: 1,
  });
  const w = (await core.request("workspace.add", { path: workspace })).items[0];
  const p = await core.request("provider.save", {
    config: {
      name: "Owned memory fixture",
      protocol,
      base_url: server.origin,
      model: "owned-memory",
      max_output_tokens: 4096,
      idle_timeout_secs: 5,
    },
  });
  const start = async (goal = "Remember the project decision", agent_id = 1) =>
    (
      await core.request("agent.start", {
        client_run_id: crypto.randomUUID(),
        workspace_id: w.id,
        provider_id: p.id,
        goal,
        agent_id,
      })
    ).run.id;
  const get = (id) => core.request("agent.get", { id });
  const done = (id) =>
    until(async () => {
      const s = await get(id);
      return ["completed", "failed", "cancelled", "interrupted"].includes(
        s.run.state,
      )
        ? s
        : false;
    });
  const list = async (agent = 1) =>
    (await core.request("memory.list", { agent_id: agent, offset: 0 })).items;
  const write = (
    content,
    scope = "agent",
    agent_id = 1,
    project = "",
    tier = "profile",
  ) =>
    core.request("memory.write", { agent_id, scope, project, tier, content });
  const jobs = async () => core.request("memory.jobs", { agent_id: 1 });
  const settled = () =>
    until(async () => {
      const j = await jobs();
      return j.length &&
        j.every((j) => !["queued", "running", "validating"].includes(j.state))
        ? j
        : false;
    });
  const approval = (id) =>
    until(async () =>
      (await get(id)).invocations.find(
        (i) =>
          i.state === "prepared" &&
          i.approval === null &&
          ["write_file", "run_command"].includes(i.name),
      ),
    );
  const approve = (i) =>
    core.request("agent.approve", { id: i.id, epoch: i.epoch, approved: true });
  return {
    directory,
    workspace,
    data,
    server,
    core,
    start,
    get,
    done,
    list,
    write,
    jobs,
    settled,
    approval,
    approve,
  };
}
for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(
    protocol +
      ": explicit default-scope memory survives restart and is injected into another run",
    async (t) => {
      const h = await setup(t, {
        protocol,
        plan: ({ body }) =>
          user(body) === "save fact" && !hasResults(body)
            ? [
                {
                  name: "update_state",
                  arguments: {
                    target: "memory",
                    action: "write",
                    content: "User prefers Rust",
                  },
                },
              ]
            : [],
      });
      const id = await h.start("save fact");
      assert.equal((await h.done(id)).run.state, "completed");
      const facts = await h.list();
      assert.equal(facts.length, 1);
      assert.equal(facts[0].origin, "explicit");
      await h.core.stop();
      await h.core.start();
      assert.equal(
        (await h.done(await h.start("recall fact"))).run.state,
        "completed",
      );
      const request = h.server.requests.findLast(
        (r) => user(r.body) === "recall fact",
      );
      assert.ok(JSON.stringify(request.body).includes("User prefers Rust"));
      if (protocol === "anthropic") {
        assert.ok(request.body.system.includes("User prefers Rust"));
        assert.ok(request.body.messages.every((m) => m.role !== "system"));
      }
    },
  );
test("Agent-private, user-shard and project-membership boundaries remain distinct", async (t) => {
  const h = await setup(t);
  const beta = await h.core.request("memory.agent.save", {
    name: "Beta",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  await h.write("Alpha private");
  await h.write("User shared", "user");
  await h.core.request("memory.membership", {
    agent_id: 1,
    project: "troop",
    action: "create",
  });
  await h.write("Project shared", "project", 1, "troop");
  assert.deepEqual(
    (await h.list(beta.id)).map((m) => m.content),
    ["User shared"],
  );
  await assert.rejects(h.write("Not a member", "project", beta.id, "troop"));
  await h.core.request("memory.membership", {
    agent_id: beta.id,
    project: "troop",
    action: "join",
  });
  assert.equal((await h.list(beta.id)).length, 2);
  await h.core.request("memory.membership", {
    agent_id: beta.id,
    project: "troop",
    action: "leave",
  });
  assert.equal((await h.list(beta.id)).length, 1);
  await assert.rejects(
    h.core.request("memory.edit", {
      agent_id: beta.id,
      id: (await h.list())[0].id,
      expected_revision: 999,
      content: "stale",
    }),
  );
});
test("automatic extraction writes facts without approval, preserves explicit facts and deletion tombstones", async (t) => {
  const h = await setup(t, {
    automatic: true,
    reply: () =>
      JSON.stringify({
        additions: [
          { content: "User prefers Rust", tier: "profile" },
          { content: "Never resurrect", tier: "profile" },
          { content: "Project uses SQLite", tier: "log" },
        ],
        removals: [],
      }),
  });
  await h.write("User prefers Rust");
  await h.write("Never resurrect");
  const old = (await h.list()).find((m) => m.content === "Never resurrect");
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: old.id,
    expected_revision: old.revision,
    content: null,
  });
  assert.equal((await h.done(await h.start())).run.state, "completed");
  assert.equal((await h.settled())[0].state, "completed");
  assert.equal((await h.jobs())[0].applied, 1);
  const facts = await h.list();
  assert.ok(
    facts.some((m) => m.content === "Project uses SQLite" && m.kind === "log"),
  );
  assert.ok(
    facts.some(
      (m) => m.content === "User prefers Rust" && m.origin === "explicit",
    ),
  );
  assert.ok(!facts.some((m) => m.content === "Never resurrect"));
  assert.ok(!JSON.stringify(await h.jobs()).includes("secret_ref"));
});
test("maintenance failure is visible, does not change completed run, and retries only manually", async (t) => {
  let valid = false;
  const h = await setup(t, {
    automatic: true,
    reply: () => (valid ? '{"additions":[],"removals":[]}' : "invalid JSON"),
  });
  const id = await h.start();
  assert.equal((await h.done(id)).run.state, "completed");
  const [job] = await h.settled();
  assert.equal(job.state, "failed");
  const count = h.server.requests.length;
  await sleep(200);
  assert.equal(h.server.requests.length, count);
  valid = true;
  await h.core.request("memory.job.retry", { id: job.id });
  assert.equal((await h.settled())[0].state, "completed");
  assert.equal((await h.get(id)).run.state, "completed");
});
test("trivial exchanges do not trigger maintenance", async (t) => {
  const h = await setup(t, { automatic: true });
  await h.done(await h.start("ok"));
  await sleep(200);
  assert.equal((await h.jobs()).length, 0);
  assert.equal(h.server.requests.length, 1);
});
test("six eligible completed runs produce one dated episode", async (t) => {
  const h = await setup(t, {
    automatic: true,
    reply: ({ body }) =>
      JSON.stringify({
        additions: user(body).startsWith("<<TROOP_MEMORY_EPISODE>>")
          ? [
              {
                content:
                  "[episode] Completed six project decisions on the recorded dates.",
                tier: "log",
              },
            ]
          : [],
        removals: [],
      }),
  });
  for (let i = 0; i < 6; i++) {
    await h.done(await h.start("Project decision " + i));
    await h.settled();
  }
  const j = await h.settled();
  assert.equal(j.filter((j) => j.kind === "episode").length, 1);
  assert.ok(j.every((j) => j.state === "completed"));
  assert.ok(
    (await h.list()).some(
      (m) => m.content.startsWith("[episode]") && m.kind === "log",
    ),
  );
});
test("advanced synthesis requires a separate validation response before applying a proposal", async (t) => {
  const h = await setup(t, {
    automatic: true,
    dreaming: true,
    reply: ({ body }) =>
      user(body).startsWith("<<TROOP_MEMORY_VALIDATE>>")
        ? '{"approved":true}'
        : '{"additions":[{"content":"Validated synthesis fact","tier":"profile"}],"removals":[]}',
  });
  await h.done(await h.start());
  const [job] = await h.settled();
  assert.equal(job.kind, "synthesis");
  assert.equal(job.state, "completed");
  assert.deepEqual(job.validation, { approved: true });
  assert.equal(h.server.requests.filter((r) => maintenance(r.body)).length, 2);
  assert.ok(
    (await h.list()).some((m) => m.content === "Validated synthesis fact"),
  );
  await h.done(await h.start("Another decision"));
  await sleep(150);
  assert.equal((await h.jobs()).length, 1);
});
test("advanced validation rejection and explicit-fact removal proposals never alter memory", async (t) => {
  const h = await setup(t, {
    automatic: true,
    dreaming: true,
    reply: ({ body }) =>
      user(body).startsWith("<<TROOP_MEMORY_VALIDATE>>")
        ? '{"approved":false}'
        : '{"additions":[{"content":"Unapproved fact","tier":"profile"}],"removals":[]}',
  });
  await h.done(await h.start());
  assert.equal((await h.settled())[0].state, "failed");
  assert.equal((await h.list()).length, 0);
});
for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(
    protocol +
      ": automatic compaction retains every raw tool record and continues with a checkpoint",
    async (t) => {
      const h = await setup(t, {
        protocol,
        plan: ({ body }) => {
          const m = body.messages ?? body.input;
          if (
            m.some(
              (m) =>
                typeof m.content === "string" &&
                m.content.startsWith("Original task:"),
            )
          )
            return [];
          const n = JSON.stringify(m).split("owned-call-").length - 1;
          if (!hasResults(body))
            return Array.from({ length: 8 }, () => ({
              name: "read_file",
              arguments: { path: "large.txt" },
            }));
          if (n < 25)
            return Array.from({ length: 6 }, () => ({
              name: "read_file",
              arguments: { path: "large.txt" },
            }));
          return [];
        },
        reply: () =>
          "Summary: completed tool reads; preserve original goal and do not replay them.",
      });
      fs.writeFileSync(
        path.join(h.workspace, "large.txt"),
        "owned-data ".repeat(720),
      );
      const id = await h.start("Read several large records");
      const final = await h.done(id);
      assert.equal(final.run.state, "completed");
      const cp = await h.core.request("agent.checkpoints", { id });
      assert.equal(cp.length, 1);
      assert.equal(final.invocations.length, 14);
      assert.ok(final.invocations.every((i) => i.state === "succeeded"));
      const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"), {
          readOnly: true,
        }),
        doc = JSON.parse(
          db.prepare("SELECT document FROM agent_runs WHERE id=?").get(id)
            .document,
        );
      db.close();
      assert.ok(doc.history.length > 14);
      assert.ok(doc.context_start > 14);
      assert.equal(doc.compaction_epoch, 1);
      assert.ok(
        h.server.requests.some((r) =>
          user(r.body).startsWith("<<TROOP_COMPACTION>>"),
        ),
      );
      assert.ok(
        h.server.requests.some((r) =>
          user(r.body).startsWith("Original task:"),
        ),
      );
    },
  );
test("new input during compaction is preserved and no tool is replayed", async (t) => {
  let release, signal;
  const paused = new Promise((r) => {
      signal = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const h = await setup(t, {
    plan: ({ body }) =>
      !hasResults(body) && user(body) === "race goal"
        ? [
            {
              name: "write_file",
              arguments: {
                path: "once.txt",
                content: "once",
                expected_hash: "missing",
              },
            },
          ]
        : [],
    beforeResponse: async ({ body }) => {
      if (user(body).startsWith("<<TROOP_COMPACTION>>")) {
        signal();
        await gate;
      }
    },
    reply: () => "Summary: write completed, do not repeat it.",
  });
  const id = await h.start("race goal");
  const inv = await h.approval(id);
  await h.core.request("agent.compact", { id });
  await h.approve(inv);
  await paused;
  await h.core.request("agent.steer", {
    id,
    client_input_id: crypto.randomUUID(),
    text: "Keep the new instruction after the summary",
  });
  release();
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal((await h.get(id)).invocations.length, 1);
  assert.ok(
    JSON.stringify(h.server.requests.at(-1).body).includes(
      "Keep the new instruction after the summary",
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "once.txt"), "utf8"),
    "once",
  );
});
test("explicit edit invalidates frozen memory before the next model step", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      !hasResults(body)
        ? [
            {
              name: "write_file",
              arguments: {
                path: "proof.txt",
                content: "proof",
                expected_hash: "missing",
              },
            },
          ]
        : [],
  });
  const id = await h.start(),
    inv = await h.approval(id);
  await h.write("New explicit preference");
  await h.approve(inv);
  await h.done(id);
  assert.ok(
    JSON.stringify(h.server.requests.at(-1).body).includes(
      "New explicit preference",
    ),
  );
});
test("memory tool state and ledger result roll back together on SQLite failure", async (t) => {
  const h = await setup(t, {
    plan: () => [
      {
        name: "update_state",
        arguments: {
          target: "memory",
          action: "write",
          content: "No ghost fact",
        },
      },
    ],
  });
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER memory_fault BEFORE INSERT ON agent_events WHEN NEW.kind='memory_tool_result' BEGIN SELECT RAISE(ABORT,'memory-fault'); END",
  );
  const exit = once(h.core.child, "exit");
  await h.start();
  await exit;
  assert.equal(db.prepare("SELECT count(*) AS n FROM memories").get().n, 0);
  db.exec("DROP TRIGGER memory_fault");
  db.close();
  await h.core.start();
  assert.equal((await h.list()).length, 0);
});
