const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, until, user } = require("./fixtures/hooks-fixture.cjs");
const crypto = require("node:crypto");
async function command(h, method, input) {
  const result = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
  assert.equal(result.state, "committed", JSON.stringify(result.error));
  return result.result;
}
const forgotten = "I prefer writing code in Rust";
const paraphrase = "Rust is my preferred programming language";
async function forget(h, scope = "agent") {
  await h.core.request("memory.write", {
    agent_id: 1,
    scope,
    tier: "profile",
    content: forgotten,
  });
  const original = (
    await h.core.request("memory.list", { agent_id: 1 })
  ).items.find((m) => m.content === forgotten);
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: original.id,
    expected_revision: original.revision,
    content: null,
  });
}
async function enable(h, scope = "agent") {
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
    model: "separate-forgetting-validator",
    target_scope: scope,
    target_project: "",
  });
}
for (const scope of ["agent", "user"])
  test(`${scope} maintenance withholds an unrecognized paraphrase after an independent forgetting check`, async (t) => {
    let checked = false;
    const h = await setup(t, {
      reply: (request) => {
        const text = user(request.body);
        if (text.startsWith("<<TROOP_MEMORY_VALIDATE>>")) {
          checked = text.toLowerCase().includes(forgotten.toLowerCase());
          return '{"approved":false}';
        }
        if (text.startsWith("<<TROOP_MEMORY_"))
          return JSON.stringify({
            additions: [{ content: paraphrase, tier: "profile" }],
            removals: [],
          });
        return "Completed owned task";
      },
    });
    await forget(h, scope);
    await enable(h, scope);
    await h.done(
      await h.start({
        goal: "Complete this fixed task and preserve only facts suitable for future work.",
      }),
    );
    const job = await until(async () =>
      (await h.core.request("memory.jobs", { agent_id: 1 })).find((j) =>
        ["completed", "waiting_review", "failed"].includes(j.state),
      ),
    );
    assert.equal(job.state, "waiting_review", job.error);
    assert.equal(checked, true);
    assert.equal(
      (await h.core.request("memory.list", { agent_id: 1 })).items.length,
      0,
    );
    await h.core.stop();
    await h.core.start();
    assert.equal(
      (await h.core.request("memory.job", { id: job.id })).state,
      "waiting_review",
    );
    await h.core.request("memory.job.cancel", { id: job.id });
    assert.equal(
      (await h.core.request("memory.job", { id: job.id })).state,
      "cancelled",
    );
  });

test("an unrelated fact can pass the separate forgetting check automatically", async (t) => {
  let validations = 0;
  const h = await setup(t, {
    reply: (request) => {
      const text = user(request.body);
      if (text.startsWith("<<TROOP_MEMORY_VALIDATE>>")) {
        validations++;
        assert.ok(text.toLowerCase().includes(forgotten.toLowerCase()));
        return '{"approved":true}';
      }
      if (text.startsWith("<<TROOP_MEMORY_"))
        return '{"additions":[{"content":"Project release checks run on Sundays","tier":"profile"}],"removals":[]}';
      return "Completed owned task";
    },
  });
  await forget(h);
  await enable(h);
  await h.done(
    await h.start({
      goal: "Complete this fixed task about the project's weekly release checks.",
    }),
  );
  const job = await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find((j) =>
      ["completed", "waiting_review", "failed"].includes(j.state),
    ),
  );
  assert.equal(job.state, "completed", job.error);
  assert.equal(validations, 1);
  assert.equal(
    (await h.core.request("memory.list", { agent_id: 1 })).items[0].content,
    "Project release checks run on Sundays",
  );
});

test("an Agent's direct paraphrase is queued for forgetting review without entering memory", async (t) => {
  const h = await setup(t, {
    plan: [
      {
        name: "update_state",
        arguments: {
          target: "memory",
          action: "write",
          content: paraphrase,
          scope: "agent",
        },
      },
    ],
  });
  await forget(h);
  const run = await h.start();
  await h.done(run);
  const call = await h.call(run);
  assert.equal(call.result.ok, true);
  assert.equal(call.result.pending_validation, true);
  assert.equal(
    (await h.core.request("memory.list", { agent_id: 1 })).items.length,
    0,
  );
  const jobs = await h.core.request("memory.jobs", { agent_id: 1 });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "guard");
  assert.equal(jobs[0].state, "waiting_configuration");
});

test("a separately validated direct write preserves its explicit protection and invocation provenance", async (t) => {
  const content = "Release checks are scheduled for Sundays";
  const h = await setup(t, {
    plan: (request) =>
      user(request.body).startsWith("<<TROOP_MEMORY_")
        ? []
        : require("./fixtures/hooks-fixture.cjs").results(request.body).length
          ? []
          : [
              {
                name: "update_state",
                arguments: {
                  target: "memory",
                  action: "write",
                  content,
                  scope: "agent",
                },
              },
            ],
    reply: (request) =>
      user(request.body).startsWith("<<TROOP_MEMORY_VALIDATE>>")
        ? '{"approved":true}'
        : user(request.body).startsWith("<<TROOP_MEMORY_")
          ? '{"additions":[],"removals":[]}'
          : "Completed owned task",
  });
  await forget(h);
  await enable(h);
  const run = await h.start({
    goal: "Remember that release checks are scheduled for Sundays.",
  });
  await h.done(run);
  const job = await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find(
      (j) => j.kind === "guard" && ["completed", "failed"].includes(j.state),
    ),
  );
  assert.equal(job.state, "completed", job.error);
  const record = (
    await h.core.request("memory.list", { agent_id: 1 })
  ).items.find((entry) => entry.content === content);
  assert.equal(record.protected, true);
  assert.equal(record.source.kind, "invocation");
  assert.equal(record.source.validation_job_id, job.id);
  assert.equal(record.source.run_id, run);
});

test("an incomplete forgetting snapshot holds the proposal without trusting a partial model check", async (t) => {
  let validations = 0;
  const h = await setup(t, {
    reply: (request) => {
      const text = user(request.body);
      if (text.startsWith("<<TROOP_MEMORY_VALIDATE>>")) {
        validations++;
        return '{"approved":true}';
      }
      return text.startsWith("<<TROOP_MEMORY_")
        ? '{"additions":[{"content":"A separate release fact","tier":"profile"}],"removals":[]}'
        : "Completed owned task";
    },
  });
  for (let index = 0; index < 65; index++) {
    await h.core.request("memory.write", {
      agent_id: 1,
      scope: "agent",
      tier: "profile",
      content: `Retired convention ${index}`,
    });
    const entry = (await h.core.request("memory.list", { agent_id: 1 }))
      .items[0];
    await h.core.request("memory.edit", {
      agent_id: 1,
      id: entry.id,
      expected_revision: entry.revision,
      content: null,
    });
  }
  await enable(h);
  await h.done(
    await h.start({
      goal: "Complete the fixed task about a separate release fact.",
    }),
  );
  const job = await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find((j) =>
      ["waiting_review", "failed", "completed"].includes(j.state),
    ),
  );
  assert.equal(job.state, "waiting_review", job.error);
  assert.equal(job.forgetting_check.count, 65);
  assert.equal(job.forgetting_check.truncated, true);
  assert.equal(validations, 0);
  assert.equal(
    (await h.core.request("memory.list", { agent_id: 1 })).items.length,
    0,
  );
});

test("forgetting during an in-flight semantic check invalidates the frozen proposal", async (t) => {
  let release, entered;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  t.after(() => release());
  const h = await setup(t, {
    beforeResponse: async (request) => {
      if (user(request.body).startsWith("<<TROOP_MEMORY_VALIDATE>>")) {
        entered();
        await blocked;
      }
    },
    reply: (request) =>
      user(request.body).startsWith("<<TROOP_MEMORY_VALIDATE>>")
        ? '{"approved":true}'
        : user(request.body).startsWith("<<TROOP_MEMORY_")
          ? '{"additions":[{"content":"Current release convention","tier":"profile"}],"removals":[]}'
          : "Completed owned task",
  });
  await forget(h);
  await enable(h);
  await h.done(
    await h.start({ goal: "Complete the fixed release convention task." }),
  );
  await Promise.race([
    started,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(Error("Validation did not start")),
        10000,
      ).unref(),
    ),
  ]);
  await h.core.request("memory.write", {
    agent_id: 1,
    scope: "agent",
    tier: "profile",
    content: "Current release convention",
  });
  const entry = (await h.core.request("memory.list", { agent_id: 1 })).items[0];
  await h.core.request("memory.edit", {
    agent_id: 1,
    id: entry.id,
    expected_revision: entry.revision,
    content: null,
  });
  release();
  const job = await until(async () =>
    (await h.core.request("memory.jobs", { agent_id: 1 })).find((j) =>
      ["failed", "completed"].includes(j.state),
    ),
  );
  assert.equal(job.state, "failed");
  assert.match(job.error, /snapshot changed|资料|变化/);
  assert.equal(
    (await h.core.request("memory.list", { agent_id: 1 })).items.length,
    0,
  );
});
