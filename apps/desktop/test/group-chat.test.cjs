const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const contract = require("../contracts/execution.cjs");
const { setup } = require("./fixtures/hooks-fixture.cjs");
const write = (h, method, input, operation = crypto.randomUUID()) =>
  h.core.request("operations.execute", {
    operation_id: operation,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
async function command(h, method, input, operation) {
  const receipt = await write(h, method, input, operation);
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return contract.validate(method, receipt.result, true);
}
const read = async (h, method, input) =>
  contract.validate(method, await h.core.request(method, input), true);
const create = (h) =>
  command(h, "groups.save", {
    expected_revision: 0,
    group: {
      name: "发布协作",
      rules: "核对来源后回复",
      project_id: null,
      paused: false,
    },
  });
const member = (h, group, agent_id, extra = {}) =>
  command(h, "groups.member", {
    id: group.id,
    expected_revision: group.revision,
    agent_id,
    listen_mode: "passive",
    receiving: true,
    remove: false,
    ...extra,
  });
const send = (h, group, extra = {}, operation) =>
  command(
    h,
    "groups.send",
    {
      group_id: group.id,
      expected_revision: group.revision,
      client_message_id: crypto.randomUUID(),
      body: "请检查发布",
      mention_agent_ids: [],
      broadcast: false,
      ...extra,
    },
    operation,
  );
test("a group saves members and commits one explicitly addressed message with durable delivery", async (t) => {
  const h = await setup(t);
  let group = await create(h);
  group = await member(h, group, 1);
  assert.equal(group.members[0].listen_mode, "passive");
  const input = {
    group_id: group.id,
    expected_revision: group.revision,
    client_message_id: crypto.randomUUID(),
    body: "请检查发布",
    mention_agent_ids: [1],
    broadcast: false,
  };
  const operation = crypto.randomUUID();
  const [first, duplicate] = await Promise.all([
    command(h, "groups.send", input, operation),
    command(h, "groups.send", input, operation),
  ]);
  assert.deepEqual(first, duplicate);
  const messages = await read(h, "groups.messages", { group_id: group.id });
  assert.equal(messages.items.length, 1);
  assert.deepEqual(messages.items[0].recipient_agent_ids, [1]);
  let deliveries = await read(h, "groups.deliveries", {
    group_id: group.id,
    message_id: first.id,
  });
  assert.equal(deliveries.items.length, 1);
  assert.equal(deliveries.items[0].state, "queued");
  await h.core.stop();
  await h.core.start();
  deliveries = await read(h, "groups.deliveries", {
    group_id: group.id,
    message_id: first.id,
  });
  assert.equal(deliveries.items[0].state, "waiting_resume");
  assert.equal(
    (await read(h, "groups.messages", { group_id: group.id })).items[0].id,
    first.id,
  );
  assert.equal((await h.core.request("agent.list", {})).items.length, 0);
  assert.equal(h.server.requests.length, 0);
});
async function agent(h, name) {
  return h.core.request("memory.agent.save", {
    name,
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
}
test("explicit IDs suppress active listeners, broadcasts include passive members and quoted names stay plain text", async (t) => {
  const h = await setup(t),
    beta = await agent(h, "Beta"),
    gamma = await agent(h, "Gamma");
  let group = await create(h);
  group = await member(h, group, 1, { listen_mode: "active" });
  group = await member(h, group, beta.id);
  group = await member(h, group, gamma.id, { listen_mode: "active" });
  const ordinary = await send(h, group, {
    body: "代码里的 @Beta 与 @所有 Agent 都只是文本",
  });
  assert.deepEqual(ordinary.recipient_agent_ids, [1, gamma.id]);
  const direct = await send(h, group, {
    mention_agent_ids: [beta.id, beta.id],
  });
  assert.deepEqual(direct.recipient_agent_ids, [beta.id]);
  const reply = await send(h, group, {
    reply_to: direct.id,
    mention_agent_ids: [gamma.id],
  });
  assert.deepEqual(reply.recipient_agent_ids, [gamma.id]);
  const broadcast = await send(h, group, { broadcast: true });
  assert.deepEqual(broadcast.recipient_agent_ids, [1, beta.id, gamma.id]);
  group = await member(h, group, beta.id, { receiving: false });
  assert.equal(
    (
      await read(h, "groups.deliveries", {
        group_id: group.id,
        message_id: direct.id,
      })
    ).items[0].state,
    "cancelled",
  );
  const disabled = await send(h, group, { mention_agent_ids: [beta.id] });
  const rejected = (
    await read(h, "groups.deliveries", {
      group_id: group.id,
      message_id: disabled.id,
    })
  ).items[0];
  assert.equal(rejected.state, "rejected");
  assert.match(rejected.reason, /关闭接收/);
  group = await member(h, group, 1, { remove: true });
  assert.equal(
    (
      await read(h, "groups.deliveries", {
        group_id: group.id,
        message_id: ordinary.id,
      })
    ).items.find((delivery) => delivery.agent_id === 1).state,
    "cancelled",
  );
  group = await member(h, group, 1);
  assert.equal(
    (
      await read(h, "groups.deliveries", {
        group_id: group.id,
        message_id: ordinary.id,
      })
    ).items.find((delivery) => delivery.agent_id === 1).state,
    "cancelled",
  );
  assert.equal(h.server.requests.length, 0);
});
test("current project membership gates delivery and revocation cancels old messages while group administration remains usable", async (t) => {
  const h = await setup(t);
  await command(h, "memory.membership", {
    agent_id: 1,
    project: "release-scope",
    action: "create",
  });
  let group = await command(h, "groups.save", {
    expected_revision: 0,
    group: {
      name: "项目群",
      rules: "",
      project_id: "release-scope",
      paused: false,
    },
  });
  group = await member(h, group, 1);
  const message = await send(h, group, { mention_agent_ids: [1] });
  await command(h, "memory.membership", {
    agent_id: 1,
    project: "release-scope",
    action: "leave",
  });
  assert.equal(
    (
      await read(h, "groups.deliveries", {
        group_id: group.id,
        message_id: message.id,
      })
    ).items[0].state,
    "cancelled",
  );
  const paused = await write(h, "groups.save", {
    id: group.id,
    expected_revision: group.revision,
    group: {
      name: group.name,
      rules: group.rules,
      project_id: group.project_id,
      paused: true,
    },
  });
  assert.equal(paused.state, "committed", JSON.stringify(paused.error));
  const disabled = await write(h, "groups.member", {
    id: group.id,
    expected_revision: paused.result.revision,
    agent_id: 1,
    receiving: false,
  });
  assert.equal(disabled.state, "committed", JSON.stringify(disabled.error));
});
test("legacy membership entry also cancels delivery atomically and rejoining cannot revive it", async (t) => {
  const h = await setup(t);
  await h.core.request("memory.membership", {
    agent_id: 1,
    project: "legacy-scope",
    action: "create",
  });
  let group = await command(h, "groups.save", {
    expected_revision: 0,
    group: {
      name: "Legacy scoped group",
      rules: "",
      project_id: "legacy-scope",
      paused: false,
    },
  });
  group = await member(h, group, 1);
  const message = await send(h, group, { mention_agent_ids: [1] });
  await h.core.request("memory.membership", {
    agent_id: 1,
    project: "legacy-scope",
    action: "leave",
  });
  assert.equal(
    (
      await read(h, "groups.deliveries", {
        group_id: group.id,
        message_id: message.id,
      })
    ).items[0].state,
    "cancelled",
  );
  await h.core.request("memory.membership", {
    agent_id: 1,
    project: "legacy-scope",
    action: "join",
  });
  assert.equal(
    (
      await read(h, "groups.deliveries", {
        group_id: group.id,
        message_id: message.id,
      })
    ).items[0].state,
    "cancelled",
  );
});
test("switching to passive cancels ordinary pending delivery while retaining explicit addressing", async (t) => {
  const h = await setup(t);
  let group = await create(h);
  group = await member(h, group, 1, { listen_mode: "active" });
  const ordinary = await send(h, group),
    direct = await send(h, group, { mention_agent_ids: [1] });
  group = await member(h, group, 1, { listen_mode: "passive" });
  assert.equal(
    (
      await read(h, "groups.deliveries", {
        group_id: group.id,
        message_id: ordinary.id,
      })
    ).items[0].state,
    "cancelled",
  );
  assert.equal(
    (
      await read(h, "groups.deliveries", {
        group_id: group.id,
        message_id: direct.id,
      })
    ).items[0].state,
    "queued",
  );
});
test("stale settings, paused groups, archives and restart decisions preserve the original delivery identity", async (t) => {
  const h = await setup(t);
  let group = await create(h);
  const old = group;
  group = await member(h, group, 1);
  const stale = await write(h, "groups.member", {
    id: group.id,
    expected_revision: old.revision,
    agent_id: 1,
    remove: true,
  });
  assert.equal(stale.error.kind, "revision_conflict");
  const message = await send(h, group, { mention_agent_ids: [1] });
  await h.core.stop();
  await h.core.start();
  let delivery = (
    await read(h, "groups.deliveries", {
      group_id: group.id,
      message_id: message.id,
    })
  ).items[0];
  const resumed = await command(h, "groups.resolve_delivery", {
    id: delivery.id,
    expected_revision: delivery.revision,
    action: "resume",
  });
  assert.equal(resumed.id, delivery.id);
  assert.equal(resumed.state, "queued");
  assert.equal(
    (
      await write(h, "groups.resolve_delivery", {
        id: delivery.id,
        expected_revision: delivery.revision,
        action: "cancel",
      })
    ).error.kind,
    "revision_conflict",
  );
  group = await command(h, "groups.save", {
    id: group.id,
    expected_revision: group.revision,
    group: { name: group.name, rules: "", project_id: null, paused: true },
  });
  delivery = (
    await read(h, "groups.deliveries", {
      group_id: group.id,
      message_id: message.id,
    })
  ).items[0];
  assert.equal(delivery.state, "cancelled");
  const duringPause = await send(h, group, { mention_agent_ids: [1] });
  assert.equal(duringPause.delivery_summary.rejected, 1);
  group = await command(h, "groups.archive", {
    id: group.id,
    expected_revision: group.revision,
    archived: true,
  });
  assert.equal((await read(h, "groups.list", {})).items.length, 0);
  assert.equal(
    (await read(h, "groups.list", { archived: true })).items[0].id,
    group.id,
  );
  assert.equal(
    (
      await write(h, "groups.send", {
        group_id: group.id,
        expected_revision: group.revision,
        client_message_id: crypto.randomUUID(),
        body: "new",
        mention_agent_ids: [1],
      })
    ).state,
    "rejected",
  );
  group = await command(h, "groups.archive", {
    id: group.id,
    expected_revision: group.revision,
    archived: false,
  });
  assert.equal(group.archived, false);
  assert.equal(
    (
      await read(h, "groups.deliveries", {
        group_id: group.id,
        message_id: message.id,
      })
    ).items[0].state,
    "cancelled",
  );
});
test("a failed delivery or receipt commit rolls back the message, and clients cannot spoof senders or reply across groups", async (t) => {
  const { DatabaseSync } = require("node:sqlite"),
    path = require("node:path");
  const h = await setup(t);
  let group = await create(h);
  group = await member(h, group, 1);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER delivery_fault BEFORE INSERT ON group_deliveries BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  const input = {
    group_id: group.id,
    expected_revision: group.revision,
    client_message_id: crypto.randomUUID(),
    body: "atomic",
    mention_agent_ids: [1],
  };
  assert.equal((await write(h, "groups.send", input)).state, "rejected");
  assert.equal(
    (await read(h, "groups.messages", { group_id: group.id })).items.length,
    0,
  );
  db.exec(
    "DROP TRIGGER delivery_fault; CREATE TRIGGER group_receipt_fault BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await assert.rejects(write(h, "groups.send", input));
  assert.equal(
    (await read(h, "groups.messages", { group_id: group.id })).items.length,
    0,
  );
  db.exec("DROP TRIGGER group_receipt_fault");
  const message = await command(h, "groups.send", input);
  assert.equal((await command(h, "groups.send", input)).id, message.id);
  assert.equal(
    (await write(h, "groups.send", { ...input, body: "different" })).state,
    "rejected",
  );
  assert.equal(
    (
      await write(h, "groups.send", {
        ...input,
        client_message_id: crypto.randomUUID(),
        sender_agent_id: 1,
      })
    ).state,
    "rejected",
  );
  const other = await create(h);
  assert.equal(
    (
      await write(h, "groups.send", {
        ...input,
        group_id: other.id,
        expected_revision: other.revision,
        client_message_id: crypto.randomUUID(),
        reply_to: message.id,
      })
    ).state,
    "rejected",
  );
  await assert.rejects(
    read(h, "groups.deliveries", {
      group_id: other.id,
      message_id: message.id,
    }),
  );
});
test("recovering a message after a settings revision returns its original fact and never produces new delivery", async (t) => {
  const h = await setup(t);
  let group = await create(h);
  group = await member(h, group, 1);
  const input = {
    group_id: group.id,
    expected_revision: group.revision,
    client_message_id: crypto.randomUUID(),
    body: "recover",
    mention_agent_ids: [1],
    broadcast: false,
  };
  const first = await command(h, "groups.send", input);
  group = await member(h, group, 1, { receiving: false });
  const recovered = await command(h, "groups.send", {
    ...input,
    expected_revision: group.revision,
  });
  assert.equal(recovered.id, first.id);
  assert.equal(
    (await read(h, "groups.messages", { group_id: group.id })).items.length,
    1,
  );
  assert.equal(recovered.delivery_summary.cancelled, 1);
});
test("Core previews exact candidates and explains when a message is only saved", async (t) => {
  const h = await setup(t);
  let group = await create(h);
  group = await member(h, group, 1);
  const address = {
    group_id: group.id,
    expected_revision: group.revision,
    mention_agent_ids: [],
    broadcast: false,
  };
  assert.equal((await read(h, "groups.preview", address)).ready_count, 0);
  let preview = await read(h, "groups.preview", {
    ...address,
    mention_agent_ids: [1],
  });
  assert.equal(preview.ready_count, 1);
  assert.equal(preview.recipients[0].agent_id, 1);
  group = await member(h, group, 1, { receiving: false });
  preview = await read(h, "groups.preview", {
    ...address,
    expected_revision: group.revision,
    broadcast: true,
  });
  assert.equal(preview.ready_count, 0);
  assert.match(preview.reason, /仅保存/);
  assert.match(preview.recipients[0].availability.reason, /关闭接收/);
});
test("queue capacity rejects excess delivery without losing the message and pagination retains escaped Unicode content", async (t) => {
  const h = await setup(t);
  let group = await create(h);
  group = await member(h, group, 1);
  for (let index = 0; index < 128; index++)
    await send(h, group, { body: `排队 ${index}`, mention_agent_ids: [1] });
  const full = await send(h, group, { mention_agent_ids: [1] });
  assert.equal(full.delivery_summary.rejected, 1);
  const delivery = (
    await read(h, "groups.deliveries", {
      group_id: group.id,
      message_id: full.id,
    })
  ).items[0];
  assert.match(delivery.reason, /128/);
  let before;
  const ids = [];
  do {
    const page = await read(h, "groups.messages", {
      group_id: group.id,
      ...(before ? { before } : {}),
    });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 65536);
    ids.push(...page.items.map((message) => message.id));
    before = page.next_before;
  } while (before);
  assert.equal(ids.length, 129);
  assert.equal(new Set(ids).size, 129);
  const large = await command(h, "groups.save", {
    expected_revision: 0,
    group: {
      name: "长消息群",
      rules: "\\".repeat(4000),
      project_id: null,
      paused: false,
    },
  });
  for (let index = 0; index < 5; index++)
    await send(h, large, {
      body: "😀".repeat(1000) + "\\".repeat(1900) + index,
    });
  const page = await read(h, "groups.messages", { group_id: large.id });
  assert.ok(page.items.length < 5);
  assert.ok(page.next_before);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32000);
  assert.match(page.items[0].body, /😀/);
});
test("schema 25 upgrade preserves work items and enables empty group storage", async (t) => {
  const { DatabaseSync } = require("node:sqlite"),
    path = require("node:path");
  const h = await setup(t);
  const work = await command(h, "work_items.save", {
    expected_revision: 0,
    item: {
      title: "保留工作",
      goal: "验证旧资料",
      acceptance: "保留历史",
      owner_agent_id: 1,
      workspace_id: h.wid,
    },
  });
  await h.core.stop();
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "DROP TABLE followup_appointments; DROP TABLE followup_chains; DROP TABLE followup_states; DROP TABLE reminder_notifications; DROP TABLE reminder_slots; DROP TABLE reminder_states; DROP TABLE reminder_preferences; DROP TABLE group_executors; DROP TABLE group_chains; DROP TRIGGER group_project_revoked; DROP TABLE group_deliveries; DROP TABLE group_messages; DROP TABLE group_chats; PRAGMA user_version=25;",
  );
  db.close();
  await h.core.start();
  assert.equal(
    (await h.core.request("work_items.get", { id: work.id })).title,
    "保留工作",
  );
  assert.equal((await read(h, "groups.list", {})).items.length, 0);
  const group = await create(h);
  assert.equal(group.name, "发布协作");
});
