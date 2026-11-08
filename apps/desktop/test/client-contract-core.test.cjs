const { test } = require("node:test");
const assert = require("node:assert/strict");
const contract = require("../contracts/execution.cjs");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");

test("public contract accepts actual Core records; resume availability and command admission share rules", async (t) => {
  const h = await setup(t, {
    plan: () => [
      {
        name: "write_file",
        arguments: {
          path: "blocked.txt",
          content: "needs approval",
          expected_hash: "missing",
        },
      },
    ],
  });
  const request = async (method, input) => {
    contract.validate(method, input);
    return contract.validate(method, await h.core.request(method, input), true);
  };
  const id = await h.start();
  const data = await until(async () => {
    const d = await request("agent.get", { id });
    return d.invocations.length && d;
  });
  assert.equal(data.allowed_actions.resume.allowed, false);
  await request("agent.invocation", { id: data.invocations[0].id });
  await request("agent.list", {});
  await request("agent.content", { id, field: "goal" });
  await request("agent.tasks", { id });
  await request("agent.checkpoints", { id });
  await request("memory.agents", {});
  const events = await request("agent.events", { id });
  await request("agent.event", { id: events.items[0].id });
  const session = await request("chat.create", {
    title: "Contract",
    workspace_id: null,
  });
  await request("chat.list", {});
  await request("chat.messages", { conversation_id: session.id });

  await h.core.stop();
  await h.core.start();
  const recovered = await request("agent.get", { id });
  assert.equal(recovered.run.state, "interrupted");
  assert.deepEqual(recovered.allowed_actions.resume, {
    allowed: true,
    reason: null,
  });
  // Another view cancels after this snapshot: old availability never grants authority.
  await request("agent.cancel", { id });
  const cancelled = await request("agent.get", { id });
  assert.equal(cancelled.allowed_actions.resume.allowed, false);
  assert.ok(cancelled.allowed_actions.resume.reason);
  await assert.rejects(request("agent.resume", { id }));
});
