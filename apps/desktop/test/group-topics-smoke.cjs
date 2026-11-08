const { app, BrowserWindow } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { agentServer } = require("./fixtures/agent-server.cjs");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime, server;
const js = (w, code) => w.webContents.executeJavaScript(code, true);
async function field(w, id, value, type = "HTMLInputElement") {
  await js(
    w,
    `(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await sleep(60);
}
const click = (w, selector) =>
  js(w, `document.querySelector(${JSON.stringify(selector)}).click()`);
async function groups(w) {
  await until(() =>
    js(
      w,
      "[...document.querySelectorAll('nav button')].some(b=>b.textContent==='Agent 群聊'&&!b.disabled)",
    ),
  );
  await js(
    w,
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='Agent 群聊').click()",
  );
  await until(() =>
    js(w, "Boolean(document.querySelector('.group-list button'))"),
  );
  await click(w, ".group-list button");
  await until(() =>
    js(w, "Boolean(document.querySelector('.group-execution'))"),
  );
  await js(w, "document.querySelector('.group-execution').open=true");
  await until(() =>
    js(w, "Boolean(document.querySelector('#group-executor-kind'))"),
  );
}
async function main() {
  runtime = await bootstrap({ userData: profile, show: false });
  const core = runtime.core,
    w = runtime.window;
  w.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  const command = async (method, input) => {
    const r = await core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method,
      input,
    });
    assert.equal(r.state, "committed", JSON.stringify(r.error));
    return r.result;
  };
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const alpha = (await core.request("memory.agents", {}))[0];
  await core.request("memory.agent.save", {
    id: alpha.id,
    name: "Alpha",
    automatic: false,
    dreaming: false,
    expected_revision: alpha.revision,
  });
  server = await agentServer({
    plan: () => [],
    reply: JSON.stringify({
      troop_group_reply: {
        body: "话题结论已核对",
        mention_agent_ids: [],
        broadcast: false,
        destination: "parent",
      },
    }),
  });
  const provider = await core.request("provider.save", {
    config: {
      name: "本地话题验收",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-topic",
      max_output_tokens: 2048,
      idle_timeout_secs: 5,
    },
  });
  let g = await command("groups.save", {
    expected_revision: 0,
    group: {
      name: "话题协作群",
      rules: "核对来源后回复",
      project_id: null,
      paused: false,
    },
  });
  g = await command("groups.member", {
    id: g.id,
    expected_revision: g.revision,
    agent_id: alpha.id,
  });
  const grant = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "话题范围授权",
      purpose: "tool_call",
      agent_id: alpha.id,
      engine_id: "native",
      workspace_id: wid,
      project_ids: [],
      read_roots: [workspace],
      write_roots: [workspace],
      operations: ["read_file", "group_reply"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  await command("groups.executor.save", {
    group_id: g.id,
    agent_id: alpha.id,
    expected_revision: 0,
    enabled: true,
    workspace_id: wid,
    execution: {
      kind: "agent",
      provider_id: provider.id,
      authorization_id: grant.id,
    },
  });
  const send = async (group, body) =>
    command("groups.send", {
      group_id: group.id,
      expected_revision: group.revision,
      client_message_id: crypto.randomUUID(),
      body,
      mention_agent_ids: [],
      broadcast: false,
    });
  const sourceA = await send(g, "来源 A：核对发布步骤"),
    sourceB = await send(g, "🙂".repeat(61));
  w.webContents.reload();
  await groups(w);
  await field(w, "group-message-body", "主群独立草稿", "HTMLTextAreaElement");
  async function openFrom(source) {
    await click(w, "#group-main-tab");
    await until(() =>
      js(
        w,
        `Boolean(document.querySelector('#main-group-pane [data-message-id="${source.id}"] .group-open-topic'))`,
      ),
    );
    await js(
      w,
      `(()=>{const b=document.querySelector('#main-group-pane [data-message-id="${source.id}"] .group-open-topic');b.click();b.click();})()`,
    );
    await until(() =>
      js(w, "Boolean(document.querySelector('#topic-group-message-body'))"),
    );
  }
  await openFrom(sourceA);
  const a = (await core.request("topics.list", { group_id: g.id })).items.find(
    (x) => x.source_message_id === sourceA.id,
  );
  assert.equal(
    (await core.request("topics.list", { group_id: g.id })).items.length,
    1,
  );
  await js(
    w,
    "document.querySelector('#topic-pane .topic-settings').open=true",
  );
  await field(w, "topic-name", "A 设置草稿");
  await click(w, "#topic-rules-inherit");
  await field(w, "topic-rules", "A 独立规则", "HTMLTextAreaElement");
  await field(
    w,
    "topic-group-message-body",
    "A 消息草稿",
    "HTMLTextAreaElement",
  );
  await openFrom(sourceB);
  const b = (await core.request("topics.list", { group_id: g.id })).items.find(
    (x) => x.source_message_id === sourceB.id,
  );
  await until(() =>
    js(
      w,
      `document.querySelector('#topic-name')?.value===${JSON.stringify(b.name)}`,
    ),
  );
  assert.notEqual(
    await js(w, "document.querySelector('#topic-name').value"),
    "A 设置草稿",
  );
  await js(
    w,
    "document.querySelector('#topic-pane .topic-settings').open=true",
  );
  await field(w, "topic-name", "B 已保存名称");
  await click(w, "#topic-save");
  await until(
    async () =>
      (await core.request("topics.get", { id: b.id })).name === "B 已保存名称",
  );
  assert.equal((await core.request("topics.get", { id: a.id })).name, a.name);
  await field(w, "group-topic-select", a.id, "HTMLSelectElement");
  await until(() =>
    js(w, "document.querySelector('#topic-name')?.value==='A 设置草稿'"),
  );
  assert.equal(
    await js(w, "document.querySelector('#topic-group-message-body').value"),
    "A 消息草稿",
  );
  assert.equal(
    await js(w, "document.querySelector('#group-message-body').value"),
    "主群独立草稿",
  );
  w.webContents.reload();
  await groups(w);
  await until(() =>
    js(w, "document.querySelector('#topic-name')?.value==='A 设置草稿'"),
  );
  assert.equal(
    await js(w, "document.querySelector('#topic-group-message-body').value"),
    "A 消息草稿",
  );
  report.checks.push(
    "duplicate source creation is idempotent; A/B settings and message drafts stay isolated through direct selection and reload; saving B does not modify A",
  );
  const before = BrowserWindow.getAllWindows().map((x) => x.id);
  await click(w, "#desktop-new-window");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find((x) => !before.includes(x.id)),
  );
  second.webContents.setBackgroundThrottling(false);
  await groups(second);
  await field(second, "group-topic-select", a.id, "HTMLSelectElement");
  await until(() =>
    js(second, "Boolean(document.querySelector('#topic-name'))"),
  );
  await js(
    second,
    "document.querySelector('#topic-pane .topic-settings').open=true",
  );
  await field(second, "topic-name", "第二窗口过期草稿");
  await js(
    w,
    "document.querySelector('#topic-pane .topic-settings').open=true",
  );
  await click(w, "#topic-save");
  await until(
    async () =>
      (await core.request("topics.get", { id: a.id })).name === "A 设置草稿",
  );
  await until(() =>
    js(
      second,
      "document.querySelector('.topic-settings')?.textContent.includes('已有新修订')&&document.querySelector('#topic-save').disabled",
    ),
  );
  await click(w, "#group-topic-tab");
  await click(w, '#topic-pane input[aria-label="点名 Alpha"]');
  await until(() =>
    js(
      w,
      "Boolean(document.querySelector('#topic-group-send:not(:disabled)'))",
    ),
  );
  await js(
    w,
    "document.querySelector('#topic-group-send').click();document.querySelector('#topic-group-send').click()",
  );
  const delivered = await until(async () => {
    const d = (await core.request("groups.deliveries", { group_id: a.id }))
      .items[0];
    return d?.adopted && d.run_state === "completed" && d;
  });
  const conclusion = await until(async () =>
    (await core.request("groups.messages", { group_id: g.id })).items.find(
      (x) => x.body === "话题结论已核对",
    ),
  );
  assert.equal(conclusion.source_topic_id, a.id);
  assert.equal(conclusion.source_run_id, delivered.run_id);
  assert.equal(conclusion.chain_id, sourceA.chain_id);
  await until(() =>
    js(
      second,
      "document.querySelector('#topic-pane')?.textContent.includes('已有采纳证据')",
    ),
  );
  assert.equal((await core.request("agent.list", {})).items.length, 1);
  assert.equal(
    await js(w, "document.querySelector('#group-message-body').value"),
    "主群独立草稿",
  );
  await click(w, "#topic-source");
  await until(() =>
    js(
      w,
      "document.querySelector('.group-topic-workspace').dataset.activePane==='main'",
    ),
  );
  assert.ok(
    await js(
      w,
      `Boolean(document.querySelector('#main-group-pane [data-message-id="${sourceA.id}"]'))`,
    ),
  );
  report.checks.push(
    "two windows share adoption and parent conclusion with trusted provenance; stale settings cannot overwrite a newer revision; topic Run uses the existing executor and source chain",
  );
  let current = await core.request("topics.get", { id: a.id });
  for (let n = 0; n < 14; n++)
    await send(current, `话题历史 ${n} · 独立滚动内容`);
  for (let n = 0; n < 14; n++) await send(g, `主群历史 ${n} · 保留来源`);
  await click(w, "#group-topic-tab");
  await field(
    w,
    "topic-group-message-body",
    "重启后继续讨论",
    "HTMLTextAreaElement",
  );
  await until(() =>
    js(
      w,
      "document.querySelector('#topic-pane .group-stream-pane').scrollHeight>900",
    ),
  );
  await js(
    w,
    "(()=>{for(const [id,top]of [['main-group-pane',170],['topic-pane',290]]){const el=document.querySelector('#'+id+' .group-stream-pane');el.scrollTop=top;el.dispatchEvent(new Event('scroll'));}})()",
  );
  await sleep(80);
  const savedScroll = await js(
    w,
    "document.querySelector('#topic-pane .group-stream-pane').scrollTop",
  );
  await field(w, "group-topic-select", b.id, "HTMLSelectElement");
  await until(() =>
    js(w, "document.querySelector('#topic-name')?.value==='B 已保存名称'"),
  );
  await field(w, "group-topic-select", a.id, "HTMLSelectElement");
  await until(() =>
    js(
      w,
      "document.querySelector('#topic-group-message-body')?.value==='重启后继续讨论'",
    ),
  );
  await until(() =>
    js(
      w,
      `Math.abs(document.querySelector('#topic-pane .group-stream-pane').scrollTop-${savedScroll})<2`,
    ),
  );
  for (const width of [1440, 768, 660]) {
    w.setSize(width, 900);
    await sleep(200);
    await click(w, "#group-topic-tab");
    assert.equal(
      await js(w, "document.documentElement.scrollWidth>innerWidth"),
      false,
      `overflow ${width}`,
    );
    if (width < 1250)
      assert.equal(
        await js(
          w,
          "getComputedStyle(document.querySelector('#main-group-pane')).display",
        ),
        "none",
      );
    else
      assert.notEqual(
        await js(
          w,
          "getComputedStyle(document.querySelector('#main-group-pane')).display",
        ),
        "none",
      );
    await js(
      w,
      "document.querySelector('.topic-toolbar').scrollIntoView({block:'start'})",
    );
    await sleep(100);
    fs.writeFileSync(
      path.join(profile, `group-topics-${width}.png`),
      (await w.webContents.capturePage()).toPNG(),
    );
  }
  second.close();
  const count = (await core.request("agent.list", {})).items.length;
  await core.stop();
  await core.start();
  w.webContents.reload();
  await groups(w);
  await until(() =>
    js(
      w,
      "document.querySelector('#topic-group-message-body')?.value==='重启后继续讨论'",
    ),
  );
  assert.equal((await core.request("agent.list", {})).items.length, count);
  assert.equal(
    (await core.request("topics.list", { group_id: g.id })).items.length,
    2,
  );
  assert.equal((await core.request("groups.list", {})).items.length, 1);
  report.checks.push(
    "topic switch restores independent scroll and draft; 1440 shows both streams while 768/660 switch one stream; Core restart preserves source/topic identities without replay",
  );
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.error = error.stack;
    if (runtime?.window) {
      report.page = await js(runtime.window, "document.body.innerText").catch(
        () => "",
      );
      fs.writeFileSync(
        path.join(profile, "failure.png"),
        (await runtime.window.webContents.capturePage()).toPNG(),
      );
    }
  })
  .finally(async () => {
    await runtime?.core.stop();
    await server?.close();
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "group-topics-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
