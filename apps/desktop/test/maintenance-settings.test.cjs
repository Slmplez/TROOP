const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");
const { agentServer } = require("./fixtures/agent-server.cjs");
test("a completed native Run recovers memory maintenance after a crash before enqueue", async (t) => {
  const { user } = require("./fixtures/hooks-fixture.cjs");
  const { DatabaseSync } = require("node:sqlite");
  const { once } = require("node:events");
  const path = require("node:path");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await setup(t, {
    beforeResponse: async ({ body }) => {
      if (!user(body).startsWith("<<TROOP_MEMORY_")) await gate;
    },
    reply: ({ body }) =>
      user(body).startsWith("<<TROOP_MEMORY_")
        ? '{"additions":[{"content":"Release checks run on Sundays","tier":"profile"}],"removals":[]}'
        : "Release checks run on Sundays. The synthetic project task is complete.",
  });
  const agent = (await h.core.request("memory.agents", {}))[0];
  await h.core.request("memory.agent.save", {
    id: 1,
    name: agent.name,
    automatic: true,
    dreaming: false,
    expected_revision: agent.revision,
  });
  const saved = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "memory.maintenance.save",
    input: {
      agent_id: 1,
      expected_revision: 0,
      enabled: true,
      provider_id: h.provider.id,
      model: "independent-native-maintainer",
      target_scope: "agent",
      target_project: "",
    },
  });
  assert.equal(saved.state, "committed");
  const run = await h.start({
    goal: "Complete synthetic project work and remember that release checks run on Sundays.",
  });
  let db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db?.close());
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TRIGGER native_memory_enqueue_fault BEFORE INSERT ON memory_evidence BEGIN SELECT RAISE(ABORT,'owned-native-enqueue-fault'); END",
  );
  const exited = once(h.core.child, "exit");
  release();
  await exited;
  db.exec("DROP TRIGGER native_memory_enqueue_fault");
  db.close();
  db = null;
  await h.core.start();
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
const command = async (h, method, input) =>
  h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
test("maintenance uses an explicitly configured independent model and retains its settings revision", async (t) => {
  const h = await setup(t);
  const external = await agentServer({
    plan: [],
    reply: () =>
      '{"additions":[{"content":"Independent maintained fact","tier":"profile"}],"removals":[]}',
  });
  t.after(() => external.close());
  const provider = await h.core.request("provider.save", {
    config: {
      ...h.provider.config,
      name: "Independent maintenance",
      base_url: external.origin,
    },
  });
  const initial = await h.core.request("memory.maintenance.get", {
    agent_id: 1,
  });
  assert.equal(initial.enabled, false);
  assert.equal(initial.revision, 0);
  const input = {
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    provider_id: provider.id,
    model: "maintenance-only",
  };
  const saved = await command(h, "memory.maintenance.save", input);
  assert.equal(saved.state, "committed");
  const agent = (await h.core.request("memory.agents", {}))[0];
  await h.core.request("memory.agent.save", {
    id: 1,
    name: agent.name,
    automatic: true,
    dreaming: false,
    expected_revision: agent.revision,
  });
  const id = await h.start({
    goal: "The user prefers short answers and explicit evidence for all project changes.",
  });
  await h.done(id);
  const jobs = await until(async () => {
    const jobs = await h.core.request("memory.jobs", { agent_id: 1 });
    return jobs.some((j) => j.state === "completed") && jobs;
  });
  assert.equal(jobs[0].maintenance_revision, 1);
  assert.equal(jobs[0].model, "maintenance-only");
  assert.equal(external.requests.length, 1);
  assert.equal(external.requests[0].body.model, "maintenance-only");
  assert.ok(
    h.server.requests.every(
      (r) => !JSON.stringify(r.body).includes("TROOP_MEMORY_"),
    ),
  );
  await h.core.stop();
  await h.core.start();
  assert.equal(
    (await h.core.request("memory.maintenance.get", { agent_id: 1 })).revision,
    1,
  );
});
test("unconfigured maintenance waits across restart and never falls back to the task model", async (t) => {
  const h = await setup(t, { reply: () => '{"additions":[],"removals":[]}' });
  await h.core.request("memory.agent.save", {
    id: 1,
    name: "Waiting agent",
    automatic: true,
    dreaming: false,
    expected_revision: 2,
  });
  await h.done(
    await h.start({
      goal: "Remember that the user prefers explicitly scoped and evidence-based project changes.",
    }),
  );
  const job = await until(async () => {
    const jobs = await h.core.request("memory.jobs", { agent_id: 1 });
    return jobs[0]?.state === "waiting_configuration" && jobs[0];
  });
  assert.equal(h.server.requests.length, 1);
  await h.core.stop();
  await h.core.start();
  const settings = await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    provider_id: h.provider.id,
    model: "chosen-maintainer",
  });
  assert.equal(settings.state, "committed");
  await until(
    async () =>
      (await h.core.request("memory.job", { id: job.id })).state ===
      "completed",
  );
  assert.equal(h.server.requests.length, 2);
  assert.equal(h.server.requests[1].body.model, "chosen-maintainer");
});
test("revoking maintenance authorization cancels an active attempt and rejects its late result", async (t) => {
  let started, release;
  const waiting = new Promise((r) => (started = r)),
    gate = new Promise((r) => (release = r));
  const h = await setup(t);
  const external = await agentServer({
    plan: [],
    beforeResponse: async () => {
      started();
      await gate;
    },
    reply: () =>
      '{"additions":[{"content":"Late fact","tier":"profile"}],"removals":[]}',
  });
  t.after(() => {
    release();
    return external.close();
  });
  const provider = await h.core.request("provider.save", {
    config: {
      ...h.provider.config,
      name: "Revocable maintenance",
      base_url: external.origin,
    },
  });
  await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    provider_id: provider.id,
    model: "maintainer",
  });
  await h.core.request("memory.agent.save", {
    id: 1,
    name: "Revocation agent",
    automatic: true,
    dreaming: false,
    expected_revision: 2,
  });
  await h.done(
    await h.start({
      goal: "Remember that the user prefers short answers and independently validated maintenance.",
    }),
  );
  await waiting;
  const receipt = await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 1,
    enabled: false,
    provider_id: provider.id,
    model: "maintainer",
  });
  assert.equal(receipt.state, "committed");
  release();
  await new Promise((r) => setTimeout(r, 150));
  const [job] = await h.core.request("memory.jobs", { agent_id: 1 });
  assert.equal(job.state, "cancelled");
  assert.equal(
    (await h.core.request("memory.list", { agent_id: 1 })).items.length,
    0,
  );
  const detail = await h.core.request("memory.job", { id: job.id });
  assert.equal(detail.attempts[0].state, "cancelled");
});
test("a running synthesis keeps one model revision across extraction and validation", async (t) => {
  let signal, release;
  const started = new Promise((r) => (signal = r)),
    gate = new Promise((r) => (release = r));
  let first = true;
  const h = await setup(t);
  const external = await agentServer({
    plan: [],
    beforeResponse: async () => {
      if (first) {
        first = false;
        signal();
        await gate;
      }
    },
    reply: ({ body }) =>
      JSON.stringify(body).includes("TROOP_MEMORY_VALIDATE")
        ? '{"approved":true}'
        : '{"additions":[{"content":"Frozen model fact","tier":"profile"}],"removals":[]}',
  });
  t.after(() => {
    release();
    return external.close();
  });
  const provider = await h.core.request("provider.save", {
    config: {
      ...h.provider.config,
      name: "Frozen maintenance",
      base_url: external.origin,
    },
  });
  await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    provider_id: provider.id,
    model: "frozen-v1",
  });
  await h.core.request("memory.agent.save", {
    id: 1,
    name: "Synthesis agent",
    automatic: true,
    dreaming: true,
    expected_revision: 2,
  });
  await h.done(
    await h.start({
      goal: "Remember that user expectations require evidence-based and independently validated memory.",
    }),
  );
  await started;
  await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 1,
    enabled: true,
    provider_id: provider.id,
    model: "next-v2",
  });
  release();
  const jobs = await until(async () => {
    const jobs = await h.core.request("memory.jobs", { agent_id: 1 });
    return jobs[0]?.state === "completed" && jobs;
  });
  assert.equal(external.requests.length, 2);
  assert.ok(external.requests.every((r) => r.body.model === "frozen-v1"));
  assert.equal(jobs[0].maintenance_revision, 1);
});
test("manual retry freezes current settings while preserving the failed attempt", async (t) => {
  let fail = true;
  const h = await setup(t);
  const external = await agentServer({
    plan: [],
    reply: () => (fail ? "invalid json" : '{"additions":[],"removals":[]}'),
  });
  t.after(() => external.close());
  const provider = await h.core.request("provider.save", {
    config: {
      ...h.provider.config,
      name: "Retry maintenance",
      base_url: external.origin,
    },
  });
  await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    provider_id: provider.id,
    model: "failed-v1",
  });
  await h.core.request("memory.agent.save", {
    id: 1,
    name: "Retry agent",
    automatic: true,
    dreaming: false,
    expected_revision: 2,
  });
  await h.done(
    await h.start({
      goal: "Remember that the user expects retry attempts to keep their own immutable configuration evidence.",
    }),
  );
  const job = await until(async () => {
    const jobs = await h.core.request("memory.jobs", { agent_id: 1 });
    return jobs[0]?.state === "failed" && jobs[0];
  });
  fail = false;
  await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 1,
    enabled: true,
    provider_id: provider.id,
    model: "retry-v2",
  });
  await h.core.request("memory.job.retry", { id: job.id });
  await until(
    async () =>
      (await h.core.request("memory.job", { id: job.id })).state ===
      "completed",
  );
  const detail = await h.core.request("memory.job", { id: job.id });
  assert.equal(detail.attempt, 2);
  assert.deepEqual(
    detail.attempts.map((a) => a.model),
    ["retry-v2", "failed-v1"],
  );
  assert.equal(detail.attempts[1].state, "failed");
  assert.equal(detail.maintenance_revision, 2);
});
test("a waiting maintenance job can be cancelled before granting a model destination", async (t) => {
  const h = await setup(t);
  await h.core.request("memory.agent.save", {
    id: 1,
    name: "Cancel waiting",
    automatic: true,
    dreaming: false,
    expected_revision: 2,
  });
  await h.done(
    await h.start({
      goal: "Remember that the user requires explicit authorization for future maintenance evidence delivery.",
    }),
  );
  const job = await until(async () => {
    const jobs = await h.core.request("memory.jobs", { agent_id: 1 });
    return jobs[0]?.state === "waiting_configuration" && jobs[0];
  });
  assert.equal(
    (await h.core.request("memory.job.cancel", { id: job.id })).state,
    "cancelled",
  );
  await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    provider_id: h.provider.id,
    model: "never-called",
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.server.requests.length, 1);
});
test("Core crash recovery interrupts both the job and its recorded attempt", async (t) => {
  let signal, release;
  const started = new Promise((r) => (signal = r)),
    gate = new Promise((r) => (release = r));
  const h = await setup(t);
  const external = await agentServer({
    plan: [],
    beforeResponse: async () => {
      signal();
      await gate;
    },
  });
  t.after(() => {
    release();
    return external.close();
  });
  const provider = await h.core.request("provider.save", {
    config: {
      ...h.provider.config,
      name: "Crash maintenance",
      base_url: external.origin,
    },
  });
  await command(h, "memory.maintenance.save", {
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    provider_id: provider.id,
    model: "crash-model",
  });
  await h.core.request("memory.agent.save", {
    id: 1,
    name: "Crash evidence",
    automatic: true,
    dreaming: false,
    expected_revision: 2,
  });
  await h.done(
    await h.start({
      goal: "Remember that every interrupted maintenance attempt must preserve its own execution evidence.",
    }),
  );
  await started;
  const job = (await h.core.request("memory.jobs", { agent_id: 1 }))[0];
  const exited = require("node:events").once(h.core.child, "close");
  h.core.child.kill();
  await exited;
  release();
  await h.core.start();
  const detail = await h.core.request("memory.job", { id: job.id });
  assert.equal(detail.state, "interrupted");
  assert.equal(detail.attempts[0].state, "interrupted");
  assert.equal(external.requests.length, 1);
});
