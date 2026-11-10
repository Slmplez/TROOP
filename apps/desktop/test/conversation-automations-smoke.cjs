const { app, BrowserWindow } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { agentServer } = require("./fixtures/agent-server.cjs");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const { writeTestClock } = require("./fixtures/test-clock.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const profile = process.argv[2],
  report = { passed: false, checks: [] };
let runtime, server, clock;
let current = Date.parse("2026-11-09T00:00:00Z"),
  mode = "reminder";
const js = (window, code) => window.webContents.executeJavaScript(code, true);
async function field(window, selector, value, type = "HTMLInputElement") {
  await js(
    window,
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await sleep(70);
}
async function button(window, label, scope = "document") {
  const clicked = await js(
    window,
    `(()=>{const root=${scope};const button=[...root.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(label)}&&!el.disabled);button?.click();return !!button;})()`,
  );
  assert.ok(clicked, `Missing enabled button ${label}`);
}
const card = "document.querySelector('[aria-label=\"对话自动化确认\"]')";
async function openChat(window) {
  await until(() =>
    js(window, "Boolean(document.querySelector('#chat-provider'))"),
  );
  await until(() =>
    js(
      window,
      "document.querySelectorAll('.conversation-list .conversation').length>0",
    ),
  );
  await js(
    window,
    "document.querySelector('.conversation-list .conversation').click()",
  );
  await until(() =>
    js(
      window,
      "Boolean(document.querySelector('[aria-label=\"对话自动化确认\"]'))",
    ),
  );
}
async function main() {
  fs.mkdirSync(profile, { recursive: true });
  clock = path.join(profile, "clock");
  fs.writeFileSync(clock, String(current));
  runtime = await bootstrap({
    userData: profile,
    show: false,
    testClockFile: clock,
  });
  const core = runtime.core,
    w = runtime.window;
  w.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  const command = async (method, input) => {
    const receipt = await core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method,
      input,
    });
    assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
    return receipt.result;
  };
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace);
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const agent = (await core.request("memory.agents", {}))[0];
  await core.request("memory.agent.save", {
    id: 1,
    name: "对话验收 Agent",
    automatic: false,
    dreaming: false,
    expected_revision: agent.revision,
  });
  server = await agentServer({
    plan: () => [],
    reply: (request) =>
      request.body.tools?.length
        ? "预约执行完成，交付资料已核对。"
        : JSON.stringify({
            troop_automation: {
              kind: mode,
              name: mode === "reminder" ? "对话提醒验收" : "对话定时验收",
              ...(mode === "reminder"
                ? { body: "核对交付" }
                : { goal: "核对交付资料" }),
              schedule: {
                kind: "once",
                timezone: "Asia/Shanghai",
                date: "2026-11-09",
                time: mode === "reminder" ? "08:00:02" : "08:00:04",
                weekdays: [],
              },
            },
          }),
  });
  const provider = await core.request("provider.save", {
    config: {
      name: "对话验收模型",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-conversation-automation",
      max_output_tokens: 2048,
      idle_timeout_secs: 5,
    },
  });
  const grant = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "对话定时授权",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: wid,
      project_ids: [],
      read_roots: [workspace],
      write_roots: [],
      operations: ["read_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  w.webContents.reload();
  await until(() =>
    js(w, "document.querySelectorAll('#chat-provider option').length===2"),
  );
  await field(w, "#chat-provider", provider.id, "HTMLSelectElement");
  await field(w, 'select[aria-label="关联工作区"]', wid, "HTMLSelectElement");
  await js(
    w,
    "document.querySelector('.composer-options input[type=checkbox]').click()",
  );
  await field(w, "#chat-input", "八点提醒我核对交付。", "HTMLTextAreaElement");
  await js(w, "document.querySelector('form.composer').requestSubmit()");
  await until(() => js(w, `Boolean(${card})`));
  assert.equal((await core.request("rules.list", {})).items.length, 0);
  await button(w, "预览时间与范围", card);
  await until(() =>
    js(w, "document.body.innerText.includes('2026-11-09 08:00:02')"),
  );
  const windows = BrowserWindow.getAllWindows().map((window) => window.id);
  await js(w, "document.querySelector('#desktop-new-window').click()");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find(
      (window) => !windows.includes(window.id),
    ),
  );
  second.webContents.setBackgroundThrottling(false);
  await openChat(second);
  second.hide();
  await button(second, "预览时间与范围", card);
  await until(() =>
    js(
      second,
      `[...${card}.querySelectorAll('button')].some(button=>button.textContent==='确认登记自动化')`,
    ),
  );
  await Promise.all([
    button(w, "确认登记自动化", card),
    button(second, "确认登记自动化", card),
  ]);
  await until(
    async () => (await core.request("rules.list", {})).items.length === 1,
  );
  await until(() => js(w, `${card}.innerText.includes('已登记')`));
  const reminder = (await core.request("rules.list", {})).items[0];
  assert.equal(reminder.agent_id, 1);
  assert.equal(
    reminder.origin.conversation_id,
    (await core.request("chat.list", {})).items[0].id,
  );
  current += 2000;
  await writeTestClock(clock, current);
  await until(
    async () =>
      (await core.request("reminders.history", { id: reminder.id })).items
        .length === 1,
  );
  assert.equal((await core.request("agent.list", {})).items.length, 0);
  report.checks.push(
    "actual chat preview, fixed scope, two-window confirmation, one reminder and zero model calls at reminder delivery",
  );
  w.webContents.reload();
  await openChat(w);
  await button(w, "预览时间与范围", card);
  await until(() => js(w, `${card}.innerText.includes('已登记')`));
  await button(w, "修改、暂停或取消", card);
  await until(() =>
    js(w, "document.querySelector('#reminder-name')?.value==='对话提醒验收'"),
  );
  report.checks.push(
    "renderer reload retains the source and opens the existing rule management form",
  );
  await button(w, "对话", "document.querySelector('nav')");
  await button(w, "新建对话");
  mode = "scheduled";
  await field(w, "#chat-provider", provider.id, "HTMLSelectElement");
  await field(w, 'select[aria-label="关联工作区"]', wid, "HTMLSelectElement");
  await js(
    w,
    "if(!document.querySelector('.composer-options input[type=checkbox]').checked)document.querySelector('.composer-options input[type=checkbox]').click()",
  );
  await field(w, "#chat-input", "定时核对交付。", "HTMLTextAreaElement");
  await js(w, "document.querySelector('form.composer').requestSubmit()");
  await until(() => js(w, `Boolean(${card})`));
  await field(w, '[aria-label="定时执行授权"]', grant.id, "HTMLSelectElement");
  await button(w, "预览时间与范围", card);
  await until(() =>
    js(w, "document.body.innerText.includes('2026-11-09 08:00:04')"),
  );
  await button(w, "确认登记自动化", card);
  await until(
    async () => (await core.request("rules.list", {})).items.length === 2,
  );
  current += 2000;
  await writeTestClock(clock, current);
  const run = await until(
    async () => (await core.request("agent.list", {})).items[0],
  );
  await until(
    async () =>
      (await core.request("agent.get", { id: run.id })).run.state ===
      "completed",
  );
  await until(() =>
    js(
      w,
      `[...${card}.querySelectorAll('button')].some(button=>button.textContent==='引用结果继续对话'&&!button.disabled)`,
    ),
  );
  await button(w, "引用结果继续对话", card);
  await until(() =>
    js(
      w,
      "document.querySelector('#chat-input').value.includes('预约执行完成')",
    ),
  );
  report.checks.push(
    "explicit native authorization, time-triggered Run, correlated result and continuation in the original chat",
  );
  for (const width of [1440, 768, 660]) {
    w.setSize(width, 920);
    await sleep(180);
    const fits = await js(
      w,
      "document.documentElement.scrollWidth<=innerWidth+1",
    );
    assert.ok(fits, `Horizontal overflow at ${width}`);
    fs.writeFileSync(
      path.join(profile, `conversation-${width}.png`),
      (await w.webContents.capturePage()).toPNG(),
    );
  }
  report.checks.push("three desktop widths remain within the viewport");
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.error = error.stack;
    if (runtime?.window)
      report.page = await js(runtime.window, "document.body.innerText").catch(
        () => "",
      );
  })
  .finally(async () => {
    await runtime?.core.stop();
    await server?.close();
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "conversation-automations-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
