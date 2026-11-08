const { app, BrowserWindow } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime;
const js = (window, code) => window.webContents.executeJavaScript(code, true);
async function field(window, selector, value, type = "HTMLInputElement") {
  await js(
    window,
    `(()=>{const element=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(element,${JSON.stringify(String(value))});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await sleep(50);
}
async function openGroups(window) {
  await until(() =>
    js(
      window,
      "[...document.querySelectorAll('nav button')].some(button=>button.textContent==='Agent 群聊'&&!button.disabled)",
    ),
  );
  await js(
    window,
    "[...document.querySelectorAll('nav button')].find(button=>button.textContent==='Agent 群聊').click()",
  );
  await until(() =>
    js(window, "Boolean(document.querySelector('.group-chat-page'))"),
  );
}
async function selectGroup(window) {
  await until(() =>
    js(window, "Boolean(document.querySelector('.group-list button'))"),
  );
  await js(window, "document.querySelector('.group-list button').click()");
  await until(() =>
    js(window, "Boolean(document.querySelector('#group-message-body'))"),
  );
}
async function main() {
  runtime = await bootstrap({ userData: profile, show: false });
  const first = runtime.window,
    core = runtime.core;
  first.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  const initial = (await core.request("memory.agents", {}))[0];
  await core.request("memory.agent.save", {
    id: initial.id,
    name: "Alpha",
    automatic: false,
    dreaming: false,
    expected_revision: initial.revision,
  });
  const beta = await core.request("memory.agent.save", {
    name: "Beta",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  await openGroups(first);
  await field(first, "#group-create-name", "发布协作群");
  await field(
    first,
    "#group-create-rules",
    "以可核对来源为准",
    "HTMLTextAreaElement",
  );
  await js(
    first,
    "document.querySelector('#group-create').click();document.querySelector('#group-create').click()",
  );
  await until(() =>
    js(first, "Boolean(document.querySelector('#group-add-agent'))"),
  );
  let group = (await core.request("groups.list", {})).items[0];
  assert.equal((await core.request("groups.list", {})).items.length, 1);
  async function addMember(id) {
    await until(() =>
      js(
        first,
        `[...document.querySelector('#group-add-agent').options].some(option=>option.value==='${id}')`,
      ),
    );
    await field(first, "#group-add-agent", id, "HTMLSelectElement");
    await js(
      first,
      "document.querySelector('#group-add-member').click();document.querySelector('#group-add-member').click()",
    );
    await until(() =>
      js(
        first,
        `Boolean(document.querySelector('.group-member-list [data-agent-id="${id}"]'))`,
      ),
    );
  }
  await addMember(initial.id);
  await addMember(beta.id);
  group = await core.request("groups.get", { id: group.id });
  assert.equal(group.members.length, 2);
  assert.ok(group.members.every((member) => member.listen_mode === "passive"));
  await until(() =>
    js(
      first,
      "document.querySelector('#group-recipient-preview')?.textContent.includes('消息仅保存')",
    ),
  );
  await field(
    first,
    `.group-member-list [data-agent-id="${initial.id}"] select`,
    "active",
    "HTMLSelectElement",
  );
  await until(() =>
    js(
      first,
      "document.querySelector('#group-recipient-preview')?.textContent.includes('Alpha · 可接收')",
    ),
  );
  await field(
    first,
    "#group-message-body",
    "请 Beta 核对发布，正文 @Alpha 只是文本",
    "HTMLTextAreaElement",
  );
  await js(
    first,
    "document.querySelector('input[aria-label=\"点名 Beta\"]').click()",
  );
  await until(() =>
    js(
      first,
      "document.querySelector('#group-recipient-preview')?.textContent.includes('Beta · 可接收')&&!document.querySelector('#group-recipient-preview').textContent.includes('Alpha · 可接收')",
    ),
  );
  first.webContents.reload();
  await openGroups(first);
  await selectGroup(first);
  assert.equal(
    await js(first, "document.querySelector('#group-message-body').value"),
    "请 Beta 核对发布，正文 @Alpha 只是文本",
  );
  assert.equal(
    await js(
      first,
      "document.querySelector('input[aria-label=\"点名 Beta\"]').checked",
    ),
    true,
  );
  await until(() =>
    js(first, "Boolean(document.querySelector('#group-send:not(:disabled)'))"),
  );
  await js(
    first,
    "document.querySelector('#group-send').click();document.querySelector('#group-send').click()",
  );
  await until(
    async () =>
      (await core.request("groups.messages", { group_id: group.id })).items
        .length === 1,
  );
  const firstMessage = (
    await core.request("groups.messages", { group_id: group.id })
  ).items[0];
  assert.deepEqual(firstMessage.recipient_agent_ids, [beta.id]);
  assert.equal(firstMessage.delivery_summary.queued, 1);
  report.checks.push(
    "UI group creation and member setup are idempotent, passive is default, Core previews candidates, and a reloaded explicitly addressed draft sends one durable message",
  );
  const before = BrowserWindow.getAllWindows().map((window) => window.id);
  await js(first, "document.querySelector('#desktop-new-window').click()");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find((window) => !before.includes(window.id)),
  );
  second.webContents.setBackgroundThrottling(false);
  await openGroups(second);
  await selectGroup(second);
  await until(() =>
    js(
      second,
      "document.querySelector('.group-message')?.textContent.includes('请 Beta 核对发布')",
    ),
  );
  await field(
    second,
    "#group-message-body",
    "保留第二窗口独立草稿",
    "HTMLTextAreaElement",
  );
  await field(second, "#group-name", "第二窗口设置草稿");
  await until(() =>
    js(
      first,
      "Boolean(document.querySelector('input[aria-label=\"Beta 接收群消息\"]:not(:disabled)'))",
    ),
  );
  await js(
    first,
    "document.querySelector('input[aria-label=\"Beta 接收群消息\"]').click()",
  );
  await until(() =>
    js(
      second,
      "document.querySelector('.group-delivery')?.textContent.includes('已取消')",
    ),
  );
  assert.equal(
    await js(second, "document.querySelector('#group-message-body').value"),
    "保留第二窗口独立草稿",
  );
  assert.equal(
    await js(second, "document.querySelector('#group-name').value"),
    "第二窗口设置草稿",
  );
  assert.equal(
    await js(second, "document.querySelector('#group-save').disabled"),
    true,
  );
  assert.equal(
    await js(
      second,
      "document.querySelector('#group-name').value==='第二窗口设置草稿'",
    ),
    true,
  );
  await until(() =>
    js(
      first,
      "!document.querySelector('#group-send').closest('fieldset').disabled",
    ),
  );
  await field(
    first,
    "#group-message-body",
    "显式广播后核对接收范围",
    "HTMLTextAreaElement",
  );
  await js(first, "document.querySelector('#group-broadcast').click()");
  await until(() =>
    js(first, "Boolean(document.querySelector('#group-send:not(:disabled)'))"),
  );
  await js(first, "document.querySelector('#group-send').click()");
  await until(
    async () =>
      (await core.request("groups.messages", { group_id: group.id })).items
        .length === 2,
  );
  const broadcast = (
    await core.request("groups.messages", { group_id: group.id })
  ).items[0];
  assert.equal(broadcast.delivery_summary.queued, 1);
  assert.equal(broadcast.delivery_summary.rejected, 1);
  await until(() =>
    js(
      first,
      "document.querySelector('[aria-label=消息投递记录]')?.textContent.includes('关闭接收')",
    ),
  );
  report.checks.push(
    "two registered windows share message and cancellation facts while preserving independent message and stale settings drafts; broadcast cannot bypass a disabled receiver",
  );
  for (const width of [1440, 768, 660]) {
    first.setContentSize(width, 900);
    await sleep(100);
    await js(
      first,
      "document.querySelector('[aria-label=群消息]').scrollIntoView()",
    );
    assert.equal(
      await js(first, "document.documentElement.scrollWidth>innerWidth"),
      false,
    );
    fs.writeFileSync(
      path.join(profile, `group-messages-${width}.png`),
      (await first.webContents.capturePage()).toPNG(),
    );
    await js(
      first,
      "document.querySelector('[aria-label=消息投递记录]').scrollIntoView()",
    );
    fs.writeFileSync(
      path.join(profile, `group-deliveries-${width}.png`),
      (await first.webContents.capturePage()).toPNG(),
    );
  }
  second.close();
  await core.stop();
  await core.start();
  first.webContents.reload();
  await openGroups(first);
  await selectGroup(first);
  await until(() =>
    js(
      first,
      "document.querySelector('[aria-label=消息投递记录]')?.textContent.includes('等待继续')",
    ),
  );
  const pending = (
    await core.request("groups.deliveries", {
      group_id: group.id,
      message_id: broadcast.id,
    })
  ).items.find((delivery) => delivery.agent_id === initial.id);
  assert.equal(pending.state, "waiting_resume");
  await js(
    first,
    `[...document.querySelectorAll('[data-delivery-id="${pending.id}"] button')].find(button=>button.textContent==='继续此投递').click()`,
  );
  await until(async () =>
    (
      await core.request("groups.deliveries", {
        group_id: group.id,
        message_id: broadcast.id,
      })
    ).items.some(
      (delivery) => delivery.id === pending.id && delivery.state === "queued",
    ),
  );
  assert.equal(
    (await core.request("groups.messages", { group_id: group.id })).items
      .length,
    2,
  );
  assert.equal((await core.request("agent.list", {})).items.length, 0);
  report.checks.push(
    "three-width message and delivery pages avoid horizontal overflow; Core restart preserves identities and requires explicit resume without creating Runs",
  );
  report.passed = true;
}
main()
  .catch((error) => {
    report.error = error.stack;
  })
  .finally(async () => {
    await runtime?.core.stop();
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "group-chat-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
