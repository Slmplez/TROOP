const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { CoreSupervisor } = require("../src/core-client.cjs");
const { modelServer, sleep } = require("./fixtures/model-server.cjs");
const temp = path.resolve(__dirname, "../../../.tmp-troop-chat/tests");
fs.mkdirSync(temp, { recursive: true });
async function until(predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await sleep(25);
  }
  throw Error("Chat condition timed out");
}
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(temp, "case-"));
  const server = await modelServer();
  const core = new CoreSupervisor({
    executable: path.resolve(__dirname, "../bin/troop-core.exe"),
    args: ["--data-dir", directory],
  });
  await core.start();
  t.after(async () => {
    try {
      if (core.state !== "ready" && !core.child) await core.start();
      if (core.state === "ready") {
        const page = await core.request("chat.list");
        for (const c of page.items)
          if (c.active_turn_id)
            await core.request("chat.cancel", { turn_id: c.active_turn_id });
        for (const p of await core.request("provider.list"))
          await core.request("provider.remove", { id: p.id });
      }
    } finally {
      await core.stop();
      await server.close();
    }
  });
  const provider = async (
    mode = "normal",
    protocol = "chat_completions",
    api_key = null,
  ) =>
    core.request("provider.save", {
      config: {
        name: "自有测试服务",
        protocol,
        base_url: server.origin + "/" + mode,
        model: "owned-fixture-model",
        max_output_tokens: 1024,
        idle_timeout_secs: 5,
      },
      api_key,
    });
  const chat = async () =>
    (
      await core.request("chat.create", {
        title: "协议测试",
        workspace_id: null,
      })
    ).id;
  const messages = async (id, before) =>
    core.request("chat.messages", {
      conversation_id: id,
      ...(before ? { before } : {}),
    });
  const send = async (
    id,
    provider,
    text = "测试问题",
    client_turn_id = randomUUID(),
  ) =>
    core.request("chat.send", {
      conversation_id: id,
      provider_id: provider.id,
      text,
      client_turn_id,
    });
  const done = async (id) =>
    until(async () => {
      const page = await messages(id);
      const last = page.items.at(-1);
      return last?.role === "assistant" && last.status !== "streaming"
        ? last
        : false;
    });
  return { core, server, directory, provider, chat, messages, send, done };
}
for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(`real HTTP ${protocol} streams split Unicode, preserves context and records usage`, async (t) => {
    const h = await setup(t),
      p = await h.provider("normal", protocol),
      id = await h.chat();
    const events = [];
    h.core.on("chat-event", (e) => events.push(e));
    await h.send(id, p);
    const first = await h.done(id);
    assert.equal(first.content, "你好，来自真实 HTTP 流。");
    assert.equal(first.status, "completed");
    assert.deepEqual(first.usage, { input_tokens: 9, output_tokens: 7 });
    await h.send(id, p, "第二个问题");
    await h.done(id);
    assert.equal(h.server.requests.length, 2);
    const payload = h.server.requests[1].body;
    const context = protocol === "responses" ? payload.input : payload.messages;
    assert.deepEqual(
      context.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.equal(context[1].content, first.content);
    assert.equal(context[2].content, "第二个问题");
    if (protocol === "responses") assert.equal(payload.store, false);
    assert.ok(events.some((e) => e.status === "streaming"));
    assert.ok(events.some((e) => e.status === "completed"));
    assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq));
  });
test("cancel aborts its stream, keeps visible text and leaves Core control responsive", async (t) => {
  const h = await setup(t),
    p = await h.provider("slow"),
    id = await h.chat();
  const turn = await h.send(id, p);
  await until(
    async () => (await h.messages(id)).items.at(-1)?.content === "你好",
  );
  assert.equal((await h.core.request("system.ping")).ready, true);
  const start = Date.now();
  assert.equal(
    (await h.core.request("chat.cancel", { turn_id: turn.turn_id })).cancelled,
    true,
  );
  assert.ok(Date.now() - start < 1000);
  const end = await h.done(id);
  assert.equal(end.status, "cancelled");
  assert.equal(end.content, "你好");
  await until(() => h.server.requests[0].closed);
  await sleep(100);
  assert.equal((await h.messages(id)).items.at(-1).content, end.content);
  assert.equal(h.server.requests.length, 1);
});
test("duplicate client turn ID returns original receipt without another model request", async (t) => {
  const h = await setup(t),
    p = await h.provider(),
    id = await h.chat(),
    client = randomUUID();
  const receipt = await h.send(id, p, "同一消息", client);
  await h.done(id);
  const repeated = await h.send(id, p, "同一消息", client);
  assert.equal(repeated.turn_id, receipt.turn_id);
  assert.equal(repeated.duplicate, true);
  assert.equal(h.server.requests.length, 1);
  await assert.rejects(h.send(id, p, "改变了内容", client));
  assert.equal((await h.messages(id)).items.length, 2);
});
test("crash recovery retains partial text, marks interrupted and sends nothing automatically", async (t) => {
  const h = await setup(t),
    p = await h.provider("slow"),
    id = await h.chat();
  await h.send(id, p);
  await until(
    async () => (await h.messages(id)).items.at(-1)?.content === "你好",
  );
  const child = h.core.child;
  child.kill();
  await until(() => h.core.child === null);
  await h.core.start();
  const reply = (await h.messages(id)).items.at(-1);
  assert.equal(reply.status, "interrupted");
  assert.equal(reply.content, "你好");
  await sleep(100);
  assert.equal(h.server.requests.length, 1);
});
for (const [mode, kind] of [
  ["drop", "disconnected"],
  ["malformed", "invalid_stream"],
  ["oversize", "invalid_stream"],
  ["redirect", "redirect_rejected"],
  ["auth", "authentication"],
  ["rate", "rate_limited"],
  ["stream-error", "provider_error"],
  ["tool", "unsupported_capability"],
  ["timeout", "timeout"],
])
  test(`gateway ${mode} fails visibly without replay`, async (t) => {
    const h = await setup(t),
      p = await h.provider(mode),
      id = await h.chat();
    await h.send(id, p);
    const reply = await h.done(id);
    assert.equal(reply.status, "failed");
    assert.equal(reply.error_kind, kind);
    assert.equal(h.server.requests.length, 1);
    assert.ok(!reply.error_message.includes("must not be echoed"));
  });
test("credential manager keeps fake test key out of database and renderer projections", async (t) => {
  const h = await setup(t),
    secret = "troop-owned-test-" + randomUUID(),
    p = await h.provider("normal", "chat_completions", secret),
    id = await h.chat();
  assert.equal(p.has_key, true);
  assert.equal("secret_ref" in p, false);
  assert.ok(!JSON.stringify(p).includes(secret));
  await h.send(id, p);
  await h.done(id);
  assert.equal(h.server.requests[0].headers.authorization, "Bearer " + secret);
  const rejected = await h.core.request("provider.save", {
    id: p.id,
    config: { ...p.config, base_url: h.server.origin + "/auth" },
  });
  await h.send(id, rejected, "认证错误不应回显密钥");
  const failure = await h.done(id);
  assert.equal(failure.status, "failed");
  assert.equal(failure.error_message.includes(secret), false);
  for (const file of fs
    .readdirSync(h.directory)
    .filter((name) => name.startsWith("troop.sqlite3"))) {
    if (fs.statSync(path.join(h.directory, file)).isFile())
      assert.equal(
        fs
          .readFileSync(path.join(h.directory, file))
          .includes(Buffer.from(secret)),
        false,
      );
  }
  const without = await h.core.request("provider.save", {
    id: p.id,
    config: p.config,
    clear_key: true,
  });
  assert.equal(without.has_key, false);
  await h.send(id, without, "不带密钥");
  await h.done(id);
  assert.equal(h.server.requests.at(-1).headers.authorization, undefined);
});
test("legacy Chat Completions output parameter is explicitly selectable", async (t) => {
  const h = await setup(t),
    p = await h.provider(),
    id = await h.chat();
  const legacy = await h.core.request("provider.save", {
    id: p.id,
    config: { ...p.config, legacy_max_tokens: true },
  });
  await h.send(id, legacy);
  await h.done(id);
  assert.equal(h.server.requests[0].body.max_tokens, 1024);
  assert.equal(h.server.requests[0].body.max_completion_tokens, undefined);
});
test("a conversation is single-flight while independent conversations have a bounded quota", async (t) => {
  const h = await setup(t),
    p = await h.provider("slow");
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const id = await h.chat();
    ids.push(id);
    await h.send(id, p);
  }
  await assert.rejects(h.send(ids[0], p));
  const fifth = await h.chat();
  await assert.rejects(h.send(fifth, p));
  assert.equal((await h.core.request("system.ping")).ready, true);
});
test("long persisted messages page within frame limits and model length remains incomplete", async (t) => {
  const h = await setup(t),
    p = await h.provider("long"),
    id = await h.chat();
  for (let i = 0; i < 4; i++) {
    await h.send(id, p, "问题" + i);
    assert.equal((await h.done(id)).status, "completed");
  }
  let before;
  const items = [];
  do {
    const page = await h.messages(id, before);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 65536);
    items.push(...page.items);
    before = page.next_before;
  } while (before);
  assert.equal(items.length, 8);
  assert.equal(new Set(items.map((m) => m.id)).size, 8);
  const limited = await h.provider("length");
  await h.send(id, limited);
  assert.equal((await h.done(id)).status, "incomplete");
});
