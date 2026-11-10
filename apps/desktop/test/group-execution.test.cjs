const { test } = require("node:test");
const { cliTest } = require("./fixtures/sandbox-support.cjs");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"),
  path = require("node:path");
const { setup, until, results } = require("./fixtures/hooks-fixture.cjs");
const { sleep, user } = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");
const op = (h, method, input, id = crypto.randomUUID()) =>
  h.core.request("operations.execute", {
    operation_id: id,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
async function command(h, method, input, id) {
  const receipt = await op(h, method, input, id);
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return contract.validate(method, receipt.result, true);
}
const read = async (h, method, input) =>
  contract.validate(method, await h.core.request(method, input), true);
async function deliveryFor(h, g, sent) {
  return (
    await read(h, "groups.deliveries", { group_id: g.id, message_id: sent.id })
  ).items[0];
}
async function group(h, agent = 1) {
  let value = await command(h, "groups.save", {
    expected_revision: 0,
    group: {
      name: "执行讨论",
      rules: "明确回复，保留来源",
      project_id: null,
      paused: false,
    },
  });
  return command(h, "groups.member", {
    id: value.id,
    expected_revision: value.revision,
    agent_id: agent,
  });
}
async function grant(h, agent = 1, extra = {}) {
  return command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Group scoped tools",
      purpose: "tool_call",
      agent_id: agent,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["read_file", "group_reply"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      ...extra,
    },
  });
}
const message = (h, g, extra = {}) =>
  command(h, "groups.send", {
    group_id: g.id,
    expected_revision: g.revision,
    client_message_id: crypto.randomUUID(),
    body: "核对收到的群任务",
    mention_agent_ids: [1],
    broadcast: false,
    ...extra,
  });
test("authorized group delivery creates one Run and an explicit native reply with trusted provenance", async (t) => {
  const h = await setup(t, {
    plan: (request) =>
      results(request.body).length
        ? []
        : [
            {
              name: "group_reply",
              arguments: {
                body: "群任务已核对",
                targets_json: "[]",
                broadcast: "false",
              },
            },
          ],
  });
  const g = await group(h),
    permission = await grant(h);
  const saved = await command(h, "groups.executor.save", {
    group_id: g.id,
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    workspace_id: h.wid,
    execution: {
      kind: "agent",
      provider_id: h.provider.id,
      authorization_id: permission.id,
    },
  });
  assert.equal(saved.enabled, true);
  const sent = await message(h, g);
  const delivery = await until(async () => {
    const page = await read(h, "groups.deliveries", {
      group_id: g.id,
      message_id: sent.id,
    });
    return (
      page.items[0]?.adopted &&
      page.items[0].run_state === "completed" &&
      page.items[0]
    );
  });
  assert.equal(delivery.state, "adopted");
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  const messages = await read(h, "groups.messages", { group_id: g.id });
  assert.equal(messages.items.length, 2);
  const reply = messages.items.find((item) => item.sender_agent_id === 1);
  assert.equal(reply.body, "群任务已核对");
  assert.equal(reply.source_run_id, delivery.run_id);
  assert.equal(reply.chain_id, delivery.chain_id);
  assert.deepEqual(reply.recipient_agent_ids, []);
  assert.equal(
    (await h.get(delivery.run_id)).run.group_delivery_id,
    delivery.id,
  );
});
async function configure(h, g, agent = 1, extra = {}) {
  const permission = await grant(h, agent);
  return command(h, "groups.executor.save", {
    group_id: g.id,
    agent_id: agent,
    expected_revision: 0,
    enabled: true,
    workspace_id: h.wid,
    execution: {
      kind: "agent",
      provider_id: h.provider.id,
      authorization_id: permission.id,
      ...extra,
    },
  });
}
test("plain output stays in the Run and a work-associated delivery uses the existing acceptance gate", async (t) => {
  const h = await setup(t),
    g = await group(h);
  await configure(h, g);
  const work = await command(h, "work_items.save", {
    expected_revision: 0,
    item: {
      title: "群工作",
      goal: "核对群内交办目标",
      acceptance: "给出可核对结果",
      owner_agent_id: 1,
      workspace_id: h.wid,
    },
  });
  const sent = await message(h, g, {
    work_item_id: work.id,
    execute_work_item: true,
  });
  const delivery = await until(async () => {
    const page = await read(h, "groups.deliveries", {
      group_id: g.id,
      message_id: sent.id,
    });
    return (
      page.items[0]?.run_state === "completed" &&
      page.items[0].adopted &&
      page.items[0]
    );
  });
  assert.equal(
    (await read(h, "groups.messages", { group_id: g.id })).items.length,
    1,
  );
  const current = await read(h, "work_items.get", { id: work.id });
  assert.equal(current.current_run_id, delivery.run_id);
  assert.equal(current.progress.state, "awaiting_acceptance");
  const result = (await read(h, "work_items.runs", { id: work.id })).items[0];
  await command(h, "work_items.accept", {
    id: work.id,
    expected_revision: current.revision,
    run_id: result.run.id,
    expected_run_revision: result.run.revision,
    evidence_sha256: result.evidence_sha256,
    note: "固定目标符合验收",
  });
  assert.equal(
    (await read(h, "work_items.get", { id: work.id })).progress.state,
    "completed",
  );
});
test("busy deliveries remain ordered and isolated from another group's discussion", async (t) => {
  const h = await setup(t, { delay: 100 }),
    g = await group(h),
    other = await group(h);
  await configure(h, g);
  await configure(h, other);
  const first = await message(h, g, { body: "FIRST_STREAM_ONLY" });
  await until(
    async () =>
      (
        await read(h, "groups.deliveries", {
          group_id: g.id,
          message_id: first.id,
        })
      ).items[0]?.run_id,
  );
  const second = await message(h, g, { body: "SECOND_STREAM_ONLY" });
  const parallel = await message(h, other, { body: "OTHER_GROUP_SECRET" });
  await until(async () => {
    const page = await read(h, "groups.deliveries", {
      group_id: g.id,
      message_id: second.id,
    });
    return page.items[0]?.run_state === "completed";
  });
  await until(async () => {
    const page = await read(h, "groups.deliveries", {
      group_id: other.id,
      message_id: parallel.id,
    });
    return page.items[0]?.run_state === "completed";
  });
  const firstDelivery = (
      await read(h, "groups.deliveries", {
        group_id: g.id,
        message_id: first.id,
      })
    ).items[0],
    secondDelivery = (
      await read(h, "groups.deliveries", {
        group_id: g.id,
        message_id: second.id,
      })
    ).items[0];
  assert.ok(secondDelivery.run_id > firstDelivery.run_id);
  const goals = h.server.requests.map((request) =>
    JSON.stringify(request.body),
  );
  assert.ok(
    goals
      .filter((body) => body.includes("SECOND_STREAM_ONLY"))
      .every((body) => !body.includes("OTHER_GROUP_SECRET")),
  );
});
for (const stream of ["group", "topic"]) {
  for (const engine of ["codex", "claude", "pi", "opencode"]) {
    cliTest(engine, `${engine} ${stream}: real Worker requires native adoption proof and reviewed structured output before a group reply`, async (t) => {
      const h = await setup(t);
      let g = await group(h);
      const program = {
        codex: "cli_protocol_probe",
        claude: "claude_protocol_probe",
        pi: "pi_protocol_probe",
        opencode: "opencode_protocol_probe",
      }[engine];
      let model_settings;
      if (engine === "claude" || engine === "opencode") {
        const file = path.join(h.directory, `${engine}-group-settings.json`);
        fs.writeFileSync(
          file,
          JSON.stringify(
            engine === "claude"
              ? {
                  env: {
                    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
                    ANTHROPIC_MODEL: "owned-claude-model",
                    ANTHROPIC_AUTH_TOKEN: "TROOP_CLAUDE_TEST_CREDENTIAL",
                  },
                }
              : {
                  model: "owned/fixture",
                  provider: {
                    owned: {
                      npm: "@ai-sdk/openai-compatible",
                      options: {
                        baseURL: "http://127.0.0.1:9/v1",
                        apiKey: "TROOP_OPENCODE_TEST_CREDENTIAL",
                      },
                      models: {
                        fixture: { limit: { context: 32768, output: 4096 } },
                      },
                    },
                  },
                },
          ),
        );
        model_settings = { file };
      }
      const permission = await command(h, "authorizations.save", {
        expected_revision: 0,
        grant: {
          name: `Group ${engine} fixture`,
          purpose: "cli_start",
          agent_id: 1,
          engine_id: engine,
          workspace_id: h.wid,
          project_ids: [],
          read_roots: [h.workspace],
          write_roots: [h.workspace],
          operations: ["start"],
          network: "any",
          expires_at: Math.floor(Date.now() / 1000) + 300,
          program: path.resolve(
            __dirname,
            `../../../target/debug/examples/${program}.exe`,
          ),
          ...(model_settings ? { model_settings } : {}),
        },
      });
      const input = {
        group_id: g.id,
        agent_id: 1,
        expected_revision: 0,
        enabled: true,
        workspace_id: h.wid,
        execution: {
          kind: "cli",
          engine_id: engine,
          authorization_id: permission.id,
          tool_mode: engine === "codex" ? "native" : "disabled",
          approval_mode: "preauthorized",
        },
      };
      const preview = await read(h, "groups.executor.preview", input);
      input.execution.expected_plan_sha256 = preview.plan_sha256;
      await command(h, "groups.executor.save", input);
      if (stream === "topic") {
        const source = await message(h, g, { mention_agent_ids: [] });
        g = await command(h, "topics.create", {
          source_group_id: g.id,
          source_message_id: source.id,
          expected_group_revision: g.revision,
          name: "CLI topic",
        });
      }
      const sent = await message(h, g);
      const delivery = await until(async () => {
        const page = await read(h, "groups.deliveries", {
          group_id: g.id,
          message_id: sent.id,
        });
        return page.items[0]?.adopted && page.items[0].run_id && page.items[0];
      });
      await until(async () =>
        (await h.get(delivery.run_id)).run.waiting.includes("review"),
      );
      assert.equal(
        (await read(h, "groups.messages", { group_id: g.id })).items.length,
        1,
      );
      const snapshot = await h.get(delivery.run_id),
        task = await h.core.request("agent.task", { id: snapshot.tasks[0].id });
      assert.equal(task.evidence.coverage_complete, true);
      await command(h, "cli.review", {
        id: task.id,
        epoch: task.epoch,
        expected_task_revision: task.revision,
        evidence_sha256: task.evidence.sha256,
        accepted: true,
        note: "核对固定群回复 JSON",
      });
      const reply = await until(async () =>
        (await read(h, "groups.messages", { group_id: g.id })).items.find(
          (item) => item.sender_agent_id === 1,
        ),
      );
      assert.match(reply.body, /Owned .* group reply/);
      assert.equal(reply.source_run_id, delivery.run_id);
      assert.equal(reply.chain_id, delivery.chain_id);
      assert.equal((await h.core.request("agent.list", {})).items.length, 1);
      const stopped = await command(h, "groups.stop_chain", {
        id: delivery.chain_id,
        expected_revision: (
          await read(h, "groups.chain", { id: delivery.chain_id })
        ).revision,
      });
      assert.equal(stopped.stopped, true);
      const declaration = (await read(h, "engines.list", {})).find(
        (item) => item.id === engine,
      ).group_delivery;
      assert.equal(declaration.contract_version, 1);
      assert.equal(
        declaration.reply,
        "reviewed_complete_evidence_structured_result",
      );
      for (const control of ["stop", "revoke"]) {
        let targetGroup = g;
        if (stream === "topic") {
          const parent = await read(h, "groups.get", { id: input.group_id });
          const source = await message(h, parent, { mention_agent_ids: [] });
          targetGroup = await command(h, "topics.create", {
            source_group_id: parent.id,
            source_message_id: source.id,
            expected_group_revision: parent.revision,
            name: `${control} topic`,
          });
        } else if (control === "revoke") {
          targetGroup = await group(h);
        }
        if (control === "revoke" && stream === "group") {
          await command(h, "groups.executor.save", {
            ...input,
            group_id: targetGroup.id,
          });
        }
        const marker = path.join(h.workspace, "group-started.txt");
        if (fs.existsSync(marker)) fs.unlinkSync(marker);
        const waiting = await message(h, targetGroup, {
          body: "G2_WAIT_BEFORE_REPLY",
        });
        const active = await until(async () => {
          const value = await deliveryFor(h, targetGroup, waiting);
          if (!value.run_id) return false;
          const owned = (await h.get(value.run_id)).tasks[0];
          const received =
            fs.existsSync(marker) ||
            (owned &&
              fs.existsSync(
                path.join(
                  h.data,
                  "worker-receipts",
                  `cli-${owned.id}-${owned.epoch}`,
                  "group-started.txt",
                ),
              ));
          return received && value;
        });
        if (control === "stop") {
          const chain = await read(h, "groups.chain", { id: waiting.chain_id });
          await command(h, "groups.stop_chain", {
            id: chain.id,
            expected_revision: chain.revision,
          });
        } else {
          await command(h, "authorizations.revoke", {
            id: permission.id,
            expected_revision: permission.revision,
          });
        }
        const finished = await h.done(active.run_id);
        assert.ok(
          ["cancelled", "failed", "interrupted"].includes(finished.run.state),
        );
        const owned = await h.core.request("agent.task", {
          id: finished.tasks[0].id,
        });
        assert.equal(owned.stopped, true);
        assert.equal(
          (await deliveryFor(h, targetGroup, waiting)).adopted,
          false,
        );
        assert.equal(
          (await read(h, "groups.messages", { group_id: g.id })).items.filter(
            (item) => item.sender_agent_id === 1,
          ).length,
          1,
        );
      }
      assert.equal(h.server.requests.length, 0);
    });
  }
}
test("a busy recipient with 64 queued messages does not starve an idle group", async (t) => {
  const h = await setup(t, { delay: 300 }),
    busy = await group(h),
    idle = await group(h);
  await configure(h, busy);
  await configure(h, idle);
  await message(h, busy, { body: "HOLD_BUSY_RECIPIENT" });
  await until(() => h.server.requests.length === 1);
  for (let index = 0; index < 64; index++)
    await message(h, busy, { body: `queued ${index}` });
  await message(h, idle, { body: "FREE_RECIPIENT_MARKER" });
  await until(
    () =>
      h.server.requests.some((request) =>
        JSON.stringify(request.body).includes("FREE_RECIPIENT_MARKER"),
      ),
    700,
  );
});
test("128 unchanged interrupted histories do not starve new adoption and structured replies", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const h = await setup(t, {
      reply: JSON.stringify({
        troop_group_reply: {
          body: "new reply",
          mention_agent_ids: [],
          broadcast: false,
        },
      }),
    }),
    g = await group(h);
  const executor = await configure(h, g);
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  const now = Math.floor(Date.now() / 1000);
  db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < 128; index++) {
    const old = { ...g, name: `old ${index}` };
    delete old.allowed_actions;
    const groupId = Number(
      db
        .prepare("INSERT INTO group_chats(document) VALUES(?)")
        .run(JSON.stringify(old)).lastInsertRowid,
    );
    old.id = groupId;
    db.prepare("UPDATE group_chats SET document=? WHERE id=?").run(
      JSON.stringify(old),
      groupId,
    );
    const chainId = crypto.randomUUID(),
      messageId = Number(
        db
          .prepare(
            "INSERT INTO group_messages(group_id,client_id,request,document) VALUES(?,?,?,?)",
          )
          .run(groupId, crypto.randomUUID(), "{}", "{}").lastInsertRowid,
      );
    db.prepare("UPDATE group_messages SET document=? WHERE id=?").run(
      JSON.stringify({
        id: messageId,
        group_id: groupId,
        sender_agent_id: null,
        body: "historical",
        mention_agent_ids: [1],
        broadcast: false,
        reply_to: null,
        group_revision: g.revision,
        recipient_agent_ids: [1],
        created_at: now,
        rules: "",
        chain_id: chainId,
      }),
      messageId,
    );
    const runId = Number(
      db
        .prepare(
          "INSERT INTO agent_runs(client_id,request,state,document) VALUES(?,?,?,?)",
        )
        .run(crypto.randomUUID(), "{}", "interrupted", "{}").lastInsertRowid,
    );
    const deliveryId = Number(
      db
        .prepare(
          "INSERT INTO group_deliveries(group_id,message_id,agent_id,document) VALUES(?,?,1,?)",
        )
        .run(groupId, messageId, "{}").lastInsertRowid,
    );
    const run = {
      id: runId,
      state: "interrupted",
      intent: null,
      epoch: 1,
      revision: 1,
      step: 1,
      agent_id: 1,
      workspace_id: h.wid,
      kind: "agent",
      goal: "historical",
      waiting: [],
      group_id: groupId,
      group_delivery_id: deliveryId,
      group_chain_id: chainId,
      group_project_id: null,
      group_chain_generation: 0,
      authorization_id: executor.execution.authorization_id,
      authorization_revision: executor.grant_revision,
    };
    db.prepare("UPDATE agent_runs SET document=? WHERE id=?").run(
      JSON.stringify(run),
      runId,
    );
    db.prepare("UPDATE group_deliveries SET document=? WHERE id=?").run(
      JSON.stringify({
        id: deliveryId,
        revision: 1,
        group_id: groupId,
        message_id: messageId,
        agent_id: 1,
        group_revision: g.revision,
        member_revision: g.members[0].revision,
        state: "awaiting_reconciliation",
        reason: "historical",
        run_id: runId,
        chain_id: chainId,
        adopted: true,
        reply_state: "waiting_reconciliation",
        observed_run_revision: 1,
        observed_group_revision: g.revision,
        observed_chain_revision: 1,
        created_at: now,
        updated_at: now,
      }),
      deliveryId,
    );
    db.prepare("INSERT INTO group_chains VALUES(?,?,?)").run(
      chainId,
      groupId,
      JSON.stringify({
        id: chainId,
        group_id: groupId,
        root_message_id: messageId,
        revision: 1,
        generation: 0,
        stopped: false,
        wake_count: 1,
        wake_limit: 16,
        parallel_limit: 2,
        expires_at: now + 300,
      }),
    );
  }
  db.exec("COMMIT");
  db.close();
  const sent = await message(h, g);
  await until(
    async () =>
      (
        await read(h, "groups.deliveries", {
          group_id: g.id,
          message_id: sent.id,
        })
      ).items[0]?.adopted,
    900,
  );
  await until(
    async () =>
      (await read(h, "groups.messages", { group_id: g.id })).items.some(
        (item) => item.body === "new reply",
      ),
    900,
  );
});

test("automatic handoffs share the 16-start chain ceiling and preserve trusted source identities", async (t) => {
  const h = await setup(t, {
    plan: (request) =>
      results(request.body).length
        ? []
        : [
            {
              name: "group_reply",
              arguments: {
                body: "继续核对",
                targets_json: user(request.body).includes(
                  '"recipient_agent_id":1',
                )
                  ? "[2]"
                  : "[1]",
                broadcast: "false",
              },
            },
          ],
  });
  const beta = await h.core.request("memory.agent.save", {
    name: "Beta",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  assert.equal(beta.id, 2);
  let g = await group(h);
  g = await command(h, "groups.member", {
    id: g.id,
    expected_revision: g.revision,
    agent_id: 2,
  });
  await configure(h, g, 1);
  await configure(h, g, 2);
  const sent = await message(h, g);
  const chain = await until(async () => {
    const value = await read(h, "groups.chain", { id: sent.chain_id });
    const page = await read(h, "groups.deliveries", { group_id: g.id });
    return (
      value.wake_count === 16 &&
      page.items.some(
        (item) => item.state === "rejected" && item.reason.includes("唤醒"),
      ) &&
      value
    );
  });
  assert.equal(chain.wake_count, 16);
  const runs = (await h.core.request("agent.list", {})).items;
  assert.equal(runs.length, 16);
  assert.ok(runs.every((run) => run.group_chain_id === sent.chain_id));
  const messages = await read(h, "groups.messages", { group_id: g.id });
  assert.equal(new Set(messages.items.map((item) => item.chain_id)).size, 1);
  assert.ok(
    messages.items
      .filter((item) => item.sender_agent_id)
      .every((item) => item.source_run_id > 0),
  );
  await sleep(200);
  assert.equal((await h.core.request("agent.list", {})).items.length, 16);
});

test("an automatic handoff cannot widen or change the source capability scope", async (t) => {
  const h = await setup(t, {
    reply: JSON.stringify({
      troop_group_reply: {
        body: "交接",
        mention_agent_ids: [2],
        broadcast: false,
      },
    }),
  });
  await h.core.request("memory.agent.save", {
    name: "Beta",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  let g = await group(h);
  g = await command(h, "groups.member", {
    id: g.id,
    expected_revision: g.revision,
    agent_id: 2,
  });
  await configure(h, g, 1);
  const other = await grant(h, 2, {
    operations: ["read_file", "write_file", "group_reply"],
  });
  await command(h, "groups.executor.save", {
    group_id: g.id,
    agent_id: 2,
    expected_revision: 0,
    enabled: true,
    workspace_id: h.wid,
    execution: {
      kind: "agent",
      provider_id: h.provider.id,
      authorization_id: other.id,
    },
  });
  await message(h, g);
  const rejected = await until(async () =>
    (await read(h, "groups.deliveries", { group_id: g.id })).items.find(
      (item) => item.agent_id === 2 && item.state === "rejected",
    ),
  );
  assert.match(rejected.reason, /协作上限/);
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
});

for (const mutation of ["stop_chain", "revoke", "remove_member", "restart"]) {
  test(`${mutation}: in-flight delivery fences late replies and retains a single Run`, async (t) => {
    const h = await setup(t, {
      delay: 150,
      reply: JSON.stringify({
        troop_group_reply: {
          body: "迟到回复",
          mention_agent_ids: [],
          broadcast: false,
        },
      }),
    });
    const g = await group(h),
      executor = await configure(h, g);
    const sent = await message(h, g);
    const original = await until(async () => {
      const d = await deliveryFor(h, g, sent);
      return d.run_id && d;
    });
    await until(() => h.server.requests.length > 0);
    if (mutation === "stop_chain") {
      const chain = await read(h, "groups.chain", { id: sent.chain_id });
      const input = { id: chain.id, expected_revision: chain.revision };
      const operation = crypto.randomUUID();
      const stopped = await command(h, "groups.stop_chain", input, operation);
      assert.equal(stopped.stopped, true);
      assert.equal(
        (await command(h, "groups.stop_chain", input, operation)).revision,
        stopped.revision,
      );
    } else if (mutation === "revoke") {
      await command(h, "authorizations.revoke", {
        id: executor.execution.authorization_id,
        expected_revision: executor.grant_revision,
      });
    } else if (mutation === "remove_member") {
      await command(h, "groups.member", {
        id: g.id,
        expected_revision: g.revision,
        agent_id: 1,
        remove: true,
      });
    } else {
      await h.core.stop();
      await h.core.start();
    }
    await until(async () => {
      const run = (await h.get(original.run_id)).run;
      return ["cancelled", "failed", "interrupted"].includes(run.state);
    });
    await sleep(300);
    assert.equal(
      (await read(h, "groups.messages", { group_id: g.id })).items.length,
      1,
    );
    assert.equal((await h.core.request("agent.list", {})).items.length, 1);
    const current = await deliveryFor(h, g, sent);
    assert.equal(current.run_id, original.run_id);
    if (mutation === "restart") {
      assert.equal(current.state, "awaiting_reconciliation");
      assert.equal(current.allowed_actions.resume.allowed, false);
      assert.equal(current.adopted, false);
    }
  });
}

test("member executor and chain Client Models poll shared backend revisions", async () => {
  const { ClientModels } = await import("../renderer/client/models.mjs");
  const models = new ClientModels(
    { request: async () => ({}), onChatEvent: () => () => {} },
    { pollInterval: 350 },
  );
  for (const [method, input] of [
    ["groups.executor.get", { group_id: 1, agent_id: 1 }],
    ["groups.chain", { id: "chain" }],
  ]) {
    const model = models.resource(method, input);
    assert.equal(model.interval, 350);
    assert.equal(models.resource(method, { ...input }), model);
  }
  models.dispose();
});

test("completed adoption and published reply survive stopping and project revocation", async (t) => {
  const h = await setup(t, {
    reply: JSON.stringify({
      troop_group_reply: {
        body: "已完成",
        mention_agent_ids: [],
        broadcast: false,
      },
    }),
  });
  await command(h, "memory.membership", {
    agent_id: 1,
    project: "g2-history",
    action: "create",
  });
  let g = await group(h);
  g = await command(h, "groups.save", {
    id: g.id,
    expected_revision: g.revision,
    group: {
      name: g.name,
      rules: g.rules,
      paused: false,
      project_id: "g2-history",
    },
  });
  const permission = await grant(h, 1, { project_ids: ["g2-history"] });
  await command(h, "groups.executor.save", {
    group_id: g.id,
    agent_id: 1,
    expected_revision: 0,
    enabled: true,
    workspace_id: h.wid,
    execution: {
      kind: "agent",
      provider_id: h.provider.id,
      authorization_id: permission.id,
    },
  });
  const sent = await message(h, g);
  const before = await until(async () => {
    const value = await deliveryFor(h, g, sent);
    return value.adopted && value.reply_state === "published" && value;
  });
  const chain = await read(h, "groups.chain", { id: sent.chain_id });
  await command(h, "groups.stop_chain", {
    id: chain.id,
    expected_revision: chain.revision,
  });
  await command(h, "memory.membership", {
    agent_id: 1,
    project: "g2-history",
    action: "leave",
  });
  await sleep(100);
  const after = await deliveryFor(h, g, sent);
  assert.equal(after.state, "adopted");
  assert.equal(after.adopted, true);
  assert.equal(after.reply_state, "published");
  assert.equal(after.run_id, before.run_id);
  assert.equal(
    (await read(h, "groups.messages", { group_id: g.id })).items.length,
    2,
  );
});

test("a model configuration change requires executor reconfirmation before a new delivery", async (t) => {
  const h = await setup(t),
    g = await group(h);
  await configure(h, g);
  const provider = (await h.core.request("provider.list", {})).find(
    (item) => item.id === h.provider.id,
  );
  await h.core.request("provider.save", {
    id: provider.id,
    config: { ...provider.config, model: "changed-model" },
  });
  const executor = await read(h, "groups.executor.get", {
    group_id: g.id,
    agent_id: 1,
  });
  assert.match(executor.current_blocker, /重新确认/);
  const sent = await message(h, g);
  const blocked = await until(async () => {
    const value = await deliveryFor(h, g, sent);
    return value.state === "blocked" && value;
  });
  assert.equal(blocked.run_id, null);
  assert.equal(h.server.requests.length, 0);
});

test("automatic Run handoffs share the native 128-tool ceiling", async (t) => {
  const h = await setup(t, {
    plan: (request) => {
      const used = results(request.body).length;
      if (used >= 16) return [];
      const calls = Array.from({ length: used ? 7 : 8 }, () => ({
        name: "read_file",
        arguments: { path: "input.txt" },
      }));
      if (used)
        calls.push({
          name: "group_reply",
          arguments: {
            body: "核对后交接",
            targets_json: user(request.body).includes('"recipient_agent_id":1')
              ? "[2]"
              : "[1]",
            broadcast: "false",
          },
        });
      return calls;
    },
  });
  await h.core.request("memory.agent.save", {
    name: "Beta",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  let g = await group(h);
  g = await command(h, "groups.member", {
    id: g.id,
    expected_revision: g.revision,
    agent_id: 2,
  });
  await configure(h, g, 1);
  await configure(h, g, 2);
  const sent = await message(h, g);
  const failed = await until(async () =>
    (await h.core.request("agent.list", {})).items.find(
      (item) => item.state === "failed",
    ),
  );
  assert.match((await h.get(failed.id)).run.error, /预算/);
  const chain = await read(h, "groups.chain", { id: sent.chain_id });
  assert.equal(chain.wake_count, 8);
  let count = 0;
  for (const run of (await h.core.request("agent.list", {})).items)
    count += (await h.get(run.id)).invocations.length;
  assert.equal(count, 128);
  assert.ok(count <= 128);
  await sleep(150);
  assert.equal((await h.core.request("agent.list", {})).items.length, 8);
});

test("a group reply transaction failure preserves model pairing and leaves no partial message", async (t) => {
  const h = await setup(t, {
    plan: (request) =>
      results(request.body).length
        ? []
        : [
            {
              name: "group_reply",
              arguments: {
                body: "应回滚的回复",
                targets_json: "[]",
                broadcast: "false",
              },
            },
          ],
  });
  const g = await group(h);
  await configure(h, g);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER reply_fault BEFORE UPDATE ON group_messages WHEN json_extract(NEW.document,'$.sender_agent_id')=1 BEGIN SELECT RAISE(ABORT,'owned reply rollback'); END",
  );
  const sent = await message(h, g);
  const delivery = await until(async () => {
    const value = await deliveryFor(h, g, sent);
    return value.run_state === "completed" && value;
  });
  assert.equal(
    (await read(h, "groups.messages", { group_id: g.id })).items.length,
    1,
  );
  const snapshot = await h.get(delivery.run_id);
  const invocation = await h.core.request("agent.invocation", {
    id: snapshot.invocations[0].id,
  });
  assert.equal(invocation.state, "failed");
  assert.equal(invocation.result.ok, false);
  assert.equal(invocation.permission_plan.operation, "group_reply");
  assert.ok(
    h.server.requests.some((request) =>
      results(request.body).some((value) => value.ok === false),
    ),
  );
});

test("schema 26 group history migrates without replay and resumes the original delivery into one Run", async (t) => {
  const h = await setup(t),
    g = await group(h);
  const sent = await message(h, g),
    before = await deliveryFor(h, g, sent);
  await h.core.stop();
  const { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  require("./fixtures/remove-policy-schema.cjs")(db);
  db.exec(`DROP TABLE followup_appointments; DROP TABLE followup_chains; DROP TABLE followup_states; DROP TABLE reminder_notifications; DROP TABLE reminder_slots; DROP TABLE reminder_states; DROP TABLE reminder_preferences; DROP TABLE group_executors; DROP TABLE group_chains; DROP INDEX group_delivery_run; DROP INDEX group_topic_source; DROP INDEX group_topic_parent; DROP TRIGGER group_project_revoked;
 CREATE TRIGGER group_project_revoked AFTER DELETE ON memory_members BEGIN
 UPDATE group_deliveries SET document=json_set(document,'$.state','cancelled') WHERE agent_id=OLD.agent_id AND json_extract(document,'$.state') IN ('queued','waiting_resume'); END;
 UPDATE group_messages SET document=json_remove(document,'$.chain_id','$.chain_generation','$.source_run_id','$.work_item_id','$.execute_work_item','$.scope_ceiling');
 UPDATE group_deliveries SET document=json_remove(document,'$.chain_id','$.run_id','$.adopted');
 PRAGMA user_version=26;`);
  db.close();
  await h.core.start();
  const migrated = new DatabaseSync(path.join(h.data, "troop.sqlite3"), {
    readOnly: true,
  });
  assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 35);
  migrated.close();
  await configure(h, g);
  let current = await deliveryFor(h, g, sent);
  assert.equal(current.id, before.id);
  assert.equal(current.state, "waiting_resume");
  assert.equal(h.server.requests.length, 0);
  await command(h, "groups.resolve_delivery", {
    id: current.id,
    expected_revision: current.revision,
    action: "resume",
  });
  current = await until(async () => {
    const value = await deliveryFor(h, g, sent);
    return value.adopted && value.run_state === "completed" && value;
  });
  assert.equal(current.id, before.id);
  assert.ok(current.chain_id);
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  assert.equal(
    (await read(h, "groups.messages", { group_id: g.id })).items.length,
    1,
  );
});

test("legacy deliveries without chain fields still share the two-Run concurrency ceiling", async (t) => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const h = await setup(t, { beforeResponse: () => barrier });
  for (const name of ["Beta", "Gamma"])
    await h.core.request("memory.agent.save", {
      name,
      automatic: false,
      dreaming: false,
      expected_revision: 0,
    });
  let g = await group(h);
  for (const agent of [2, 3])
    g = await command(h, "groups.member", {
      id: g.id,
      expected_revision: g.revision,
      agent_id: agent,
    });
  const sent = await message(h, g, { mention_agent_ids: [], broadcast: true });
  const { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "UPDATE group_messages SET document=json_remove(document,'$.chain_id','$.chain_generation'); UPDATE group_deliveries SET document=json_remove(document,'$.chain_id')",
  );
  db.close();
  for (const agent of [1, 2, 3]) await configure(h, g, agent);
  await until(() => h.server.requests.length >= 2);
  await sleep(150);
  try {
    assert.equal(h.server.requests.length, 2);
  } finally {
    release();
  }
  await until(async () =>
    (
      await read(h, "groups.deliveries", {
        group_id: g.id,
        message_id: sent.id,
      })
    ).items.every((item) => item.run_state === "completed"),
  );
  const deliveries = (
    await read(h, "groups.deliveries", { group_id: g.id, message_id: sent.id })
  ).items;
  assert.equal(new Set(deliveries.map((item) => item.chain_id)).size, 1);
  assert.equal(
    (await read(h, "groups.chain", { id: deliveries[0].chain_id })).wake_count,
    3,
  );
});

test("legacy chain capacity is filtered before the 64-candidate window", async (t) => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const h = await setup(t, { beforeResponse: () => barrier });
  const provider = (await h.core.request("provider.list", {})).find(
    (item) => item.id === h.provider.id,
  );
  await h.core.request("provider.save", {
    id: provider.id,
    config: { ...provider.config, idle_timeout_secs: 30 },
  });
  for (let id = 2; id <= 24; id++)
    await h.core.request("memory.agent.save", {
      name: `Member ${id}`,
      automatic: false,
      dreaming: false,
      expected_revision: 0,
    });
  const { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  for (let index = 0; index < 3; index++) {
    let g = await group(h);
    for (let id = 2; id <= 24; id++)
      g = await command(h, "groups.member", {
        id: g.id,
        expected_revision: g.revision,
        agent_id: id,
      });
    await message(h, g, { mention_agent_ids: [], broadcast: true });
    db.prepare(
      "UPDATE group_messages SET document=json_remove(document,'$.chain_id','$.chain_generation') WHERE group_id=?",
    ).run(g.id);
    db.prepare(
      "UPDATE group_deliveries SET document=json_remove(document,'$.chain_id') WHERE group_id=?",
    ).run(g.id);
    for (let id = 1; id <= 24; id++) await configure(h, g, id);
    await until(
      async () =>
        (await h.core.request("agent.list", {})).items.length >=
        (index + 1) * 2,
    );
  }
  const idle = await group(h);
  await configure(h, idle);
  const sent = await message(h, idle, { body: "IDLE_AFTER_LEGACY_CAPACITY" });
  try {
    await until(async () => (await deliveryFor(h, idle, sent)).run_id, 2000);
  } finally {
    release();
  }
});
