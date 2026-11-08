const { test } = require("node:test");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const {
  setup,
  until,
  results,
  sleep,
  user,
} = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");
const write = (h, method, input, operation_id = crypto.randomUUID()) =>
  h.core.request("operations.execute", {
    operation_id,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
async function command(h, method, input, id) {
  const value = await write(h, method, input, id);
  assert.equal(value.state, "committed", JSON.stringify(value.error));
  return contract.methods[method]
    ? contract.validate(method, value.result, true)
    : value.result;
}
const read = (h, method, input) => h.core.request(method, input);
async function group(h) {
  let g = await command(h, "groups.save", {
    expected_revision: 0,
    group: {
      name: "Topic source",
      rules: "SOURCE_RULE",
      project_id: null,
      paused: false,
    },
  });
  return command(h, "groups.member", {
    id: g.id,
    expected_revision: g.revision,
    agent_id: 1,
  });
}
const send = (h, g, extra = {}) =>
  command(h, "groups.send", {
    group_id: g.id,
    expected_revision: g.revision,
    client_message_id: crypto.randomUUID(),
    body: "SOURCE_MESSAGE",
    mention_agent_ids: [],
    broadcast: false,
    ...extra,
  });
const create = (h, g, m) =>
  command(h, "topics.create", {
    source_group_id: g.id,
    source_message_id: m.id,
    expected_group_revision: g.revision,
    name: "Release discussion",
  });
test("a source message creates one persistent topic across retries, revision changes and restart", async (t) => {
  const h = await setup(t);
  let g = await group(h);
  const m = await send(h, g);
  const topic = await create(h, g, m);
  assert.notEqual(topic.id, g.id);
  assert.equal(topic.source_group_id, g.id);
  assert.equal(topic.source_message_id, m.id);
  assert.equal(topic.rules, "SOURCE_RULE");
  g = await command(h, "groups.save", {
    id: g.id,
    expected_revision: g.revision,
    group: {
      name: g.name,
      rules: "UPDATED_RULE",
      project_id: null,
      paused: false,
    },
  });
  assert.equal((await create(h, g, m)).id, topic.id);
  assert.equal((await read(h, "groups.list", {})).items.length, 1);
  assert.equal(
    (await read(h, "topics.list", { group_id: g.id })).items.length,
    1,
  );
  await h.core.stop();
  await h.core.start();
  const restored = await read(h, "topics.get", { id: topic.id });
  assert.equal(restored.source_message_id, m.id);
  assert.equal(restored.rules, "UPDATED_RULE");
  assert.equal((await read(h, "agent.list", {})).items.length, 0);
});

test("topic rules and listening override the current parent without extending membership", async (t) => {
  const h = await setup(t),
    g = await group(h),
    source = await send(h, g),
    topic = await create(h, g, source);
  let own = await command(h, "topics.save", {
    id: topic.id,
    expected_revision: topic.revision,
    name: topic.name,
    rules_override: "",
    paused: false,
  });
  assert.equal(own.rules, "");
  assert.equal(
    (await read(h, "groups.get", { id: g.id })).rules,
    "SOURCE_RULE",
  );
  own = await command(h, "topics.member", {
    id: own.id,
    expected_revision: own.revision,
    agent_id: 1,
    listen_mode: "active",
  });
  const sent = await send(h, own, { body: "TOPIC_ONLY" });
  assert.deepEqual(sent.recipient_agent_ids, [1]);
  assert.equal(
    (await read(h, "groups.messages", { group_id: g.id })).items.length,
    1,
  );
  assert.equal(
    (await read(h, "groups.messages", { group_id: own.id })).items.length,
    1,
  );
  assert.equal(
    (
      await write(h, "topics.create", {
        source_group_id: own.id,
        source_message_id: sent.id,
        expected_group_revision: own.revision,
        name: "nested",
      })
    ).state,
    "rejected",
  );
  assert.equal(
    (
      await write(h, "groups.member", {
        id: own.id,
        expected_revision: own.revision,
        agent_id: 1,
        remove: true,
      })
    ).state,
    "rejected",
  );
  const parent = await command(h, "groups.member", {
    id: g.id,
    expected_revision: g.revision,
    agent_id: 1,
    receiving: false,
  });
  own = await read(h, "topics.get", { id: own.id });
  assert.equal(own.members[0].receiving, false);
  const rejected = await send(h, own, { mention_agent_ids: [1] });
  assert.equal(rejected.delivery_summary.rejected, 1);
  own = await command(h, "topics.save", {
    id: own.id,
    expected_revision: own.revision,
    name: own.name,
    rules_override: null,
    paused: false,
  });
  assert.equal(own.rules, "SOURCE_RULE");
  assert.ok(own.revision > topic.revision);
  const deliveries = await read(h, "groups.deliveries", {
    group_id: own.id,
    message_id: sent.id,
  });
  assert.equal(deliveries.items[0].state, "cancelled");
  const stale = await write(h, "topics.save", {
    id: own.id,
    expected_revision: topic.revision,
    name: "stale",
    rules_override: "bad",
    paused: false,
  });
  assert.equal(stale.error.kind, "revision_conflict");
});

async function configure(h, g) {
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Topic tools",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["read_file", "group_reply"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    },
  });
  return command(h, "groups.executor.save", {
    group_id: g.id,
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    workspace_id: h.wid,
    execution: {
      kind: "agent",
      provider_id: h.provider.id,
      authorization_id: grant.id,
    },
  });
}
test("topic execution inherits the parent executor, isolates context and explicitly publishes a conclusion to the parent", async (t) => {
  const h = await setup(t, {
    plan: (request) =>
      results(request.body).length
        ? []
        : [
            {
              name: "group_reply",
              arguments: {
                body: "TOPIC_CONCLUSION",
                targets_json: "[]",
                broadcast: "false",
                destination: "parent",
              },
            },
          ],
  });
  const g = await group(h);
  await configure(h, g);
  const source = await send(h, g);
  const topic = await create(h, g, source);
  await send(h, g, { body: "UNRELATED_PARENT_HISTORY" });
  const sent = await send(h, topic, {
    body: "TOPIC_TASK",
    mention_agent_ids: [1],
  });
  assert.equal(sent.chain_id, source.chain_id);
  const delivery = await until(async () => {
    const d = (
      await read(h, "groups.deliveries", {
        group_id: topic.id,
        message_id: sent.id,
      })
    ).items[0];
    return d?.run_state === "completed" && d.adopted && d;
  });
  const parentMessages = (await read(h, "groups.messages", { group_id: g.id }))
    .items;
  const conclusion = parentMessages.find((m) => m.body === "TOPIC_CONCLUSION");
  assert.ok(conclusion);
  assert.equal(conclusion.source_topic_id, topic.id);
  assert.equal(conclusion.source_run_id, delivery.run_id);
  assert.equal(conclusion.chain_id, source.chain_id);
  assert.equal(conclusion.reply_to, source.id);
  assert.equal(
    (await read(h, "groups.messages", { group_id: topic.id })).items.length,
    1,
  );
  assert.ok(
    h.server.requests.every(
      (request) => !user(request.body).includes("UNRELATED_PARENT_HISTORY"),
    ),
  );
  assert.ok(
    h.server.requests.some(
      (request) =>
        user(request.body).includes("SOURCE_MESSAGE") &&
        user(request.body).includes("TOPIC_TASK"),
    ),
  );
  const chain = await read(h, "groups.chain", { id: source.chain_id });
  assert.equal(chain.wake_count, 1);
  await command(h, "groups.stop_chain", {
    id: chain.id,
    expected_revision: chain.revision,
  });
  const blocked = await send(h, topic, {
    body: "LATE_TOPIC",
    mention_agent_ids: [1],
  });
  assert.equal(blocked.delivery_summary.rejected, 1);
});

test("topic discussion history uses the parent membership boundary and rejoining does not restore old history", async (t) => {
  const h = await setup(t),
    g = await group(h),
    source = await send(h, g),
    topic = await create(h, g, source);
  await configure(h, g);
  await send(h, topic, { body: "TOPIC_FIRST_CONTEXT" });
  const second = await send(h, topic, {
    body: "TOPIC_SECOND",
    mention_agent_ids: [1],
  });
  await until(() => h.server.requests.length > 0);
  assert.ok(user(h.server.requests[0].body).includes("TOPIC_FIRST_CONTEXT"));
  await until(
    async () =>
      (
        await read(h, "groups.deliveries", {
          group_id: topic.id,
          message_id: second.id,
        })
      ).items[0]?.run_state === "completed",
  );
  let parent = await command(h, "groups.member", {
    id: g.id,
    expected_revision: g.revision,
    agent_id: 1,
    remove: true,
  });
  parent = await command(h, "groups.member", {
    id: g.id,
    expected_revision: parent.revision,
    agent_id: 1,
  });
  const current = await read(h, "topics.get", { id: topic.id });
  const third = await send(h, current, {
    body: "AFTER_REJOIN",
    mention_agent_ids: [1],
  });
  await until(() => h.server.requests.length >= 2);
  assert.ok(!user(h.server.requests[1].body).includes("TOPIC_FIRST_CONTEXT"));
  assert.ok(!user(h.server.requests[1].body).includes("TOPIC_SECOND"));
  assert.equal(
    (await read(h, "topics.get", { id: topic.id })).members[0].listen_override,
    null,
  );
});

test("parent scope changes invalidate topics and cannot be undone by restoring or editing the topic", async (t) => {
  const h = await setup(t);
  let g = await group(h);
  const source = await send(h, g),
    topic = await create(h, g, source);
  await command(h, "memory.membership", {
    agent_id: 1,
    project: "new-scope",
    action: "create",
  });
  g = await command(h, "groups.save", {
    id: g.id,
    expected_revision: g.revision,
    group: {
      name: g.name,
      rules: g.rules,
      project_id: "new-scope",
      paused: false,
    },
  });
  const current = await read(h, "topics.get", { id: topic.id });
  assert.equal(current.archived, true);
  assert.equal(current.scope_invalidated, true);
  assert.equal(current.allowed_actions.restore.allowed, false);
  assert.equal(
    (
      await write(h, "topics.archive", {
        id: topic.id,
        expected_revision: current.revision,
        archived: false,
      })
    ).state,
    "rejected",
  );
  assert.equal(
    (
      await write(h, "groups.save", {
        id: topic.id,
        expected_revision: current.revision,
        group: { name: "escape", rules: "", project_id: null, paused: false },
      })
    ).state,
    "rejected",
  );
  assert.equal(
    (
      await write(h, "groups.send", {
        group_id: topic.id,
        expected_revision: current.revision,
        client_message_id: crypto.randomUUID(),
        body: "escape",
      })
    ).state,
    "rejected",
  );
  assert.equal(
    (
      await write(h, "topics.create", {
        source_group_id: g.id,
        source_message_id: source.id,
        expected_group_revision: g.revision,
        name: "existing",
      })
    ).result.id,
    topic.id,
  );
  const newer = await send(h, g, { body: "NEW_SCOPE" });
  const fresh = await create(h, g, newer);
  assert.notEqual(fresh.id, topic.id);
  assert.equal(fresh.project_id, "new-scope");
});

for (const action of ["pause", "remove", "revoke_project"])
  test(`${action}: a parent change stops an active topic Run and fences late replies`, async (t) => {
    const h = await setup(t, {
      delay: 120,
      reply: JSON.stringify({
        troop_group_reply: {
          body: "LATE_TOPIC",
          mention_agent_ids: [],
          broadcast: false,
          destination: "parent",
        },
      }),
    });
    let g = await group(h);
    if (action === "revoke_project") {
      await command(h, "memory.membership", {
        agent_id: 1,
        project: "topic-scope",
        action: "create",
      });
      g = await command(h, "groups.save", {
        id: g.id,
        expected_revision: g.revision,
        group: {
          name: g.name,
          rules: g.rules,
          project_id: "topic-scope",
          paused: false,
        },
      });
    }
    const source = await send(h, g),
      topic = await create(h, g, source);
    const grant = await command(h, "authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "Scoped topic",
        purpose: "tool_call",
        agent_id: 1,
        engine_id: "native",
        workspace_id: h.wid,
        project_ids: g.project_id ? [g.project_id] : [],
        read_roots: [h.workspace],
        write_roots: [h.workspace],
        operations: ["read_file", "group_reply"],
        network: "none",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await command(h, "groups.executor.save", {
      group_id: g.id,
      agent_id: 1,
      expected_revision: 0,
      enabled: true,
      workspace_id: h.wid,
      execution: {
        kind: "agent",
        provider_id: h.provider.id,
        authorization_id: grant.id,
      },
    });
    const sent = await send(h, topic, { mention_agent_ids: [1] });
    await until(() => h.server.requests.length > 0);
    if (action === "pause")
      await command(h, "groups.save", {
        id: g.id,
        expected_revision: g.revision,
        group: {
          name: g.name,
          rules: g.rules,
          project_id: g.project_id,
          paused: true,
        },
      });
    else if (action === "remove")
      await command(h, "groups.member", {
        id: g.id,
        expected_revision: g.revision,
        agent_id: 1,
        remove: true,
      });
    else
      await command(h, "memory.membership", {
        agent_id: 1,
        project: g.project_id,
        action: "leave",
      });
    await until(
      async () =>
        (
          await read(h, "groups.deliveries", {
            group_id: topic.id,
            message_id: sent.id,
          })
        ).items[0].state === "cancelled",
    );
    await sleep(200);
    assert.equal(
      (await read(h, "groups.messages", { group_id: g.id })).items.length,
      1,
    );
    assert.equal(
      (await read(h, "groups.messages", { group_id: topic.id })).items.length,
      1,
    );
  });
