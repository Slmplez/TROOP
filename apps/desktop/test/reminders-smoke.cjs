const { app, BrowserWindow, Notification } = require("electron");
const { EventEmitter } = require("node:events");
const { bootstrap } = require("../src/main.cjs");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const { writeTestClock } = require("./fixtures/test-clock.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const profile = process.argv[2],
  report = { checks: [], passed: false },
  nativeCalls = [];
let runtime,
  clock,
  current = Date.parse("2026-11-08T00:00:00Z"),
  failNative = false,
  realNative = false;
const js = (w, code) => w.webContents.executeJavaScript(code, true);
const click = (w, selector) =>
  js(w, `document.querySelector(${JSON.stringify(selector)}).click()`);
async function field(w, id, value, type = "HTMLInputElement") {
  await js(
    w,
    `(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await sleep(60);
}
async function reminders(w) {
  await until(() =>
    js(
      w,
      "[...document.querySelectorAll('nav button')].some(b=>b.textContent.trim()==='规则')",
    ),
  );
  await js(
    w,
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()==='规则').click()",
  );
  await until(() =>
    js(w, "Boolean(document.querySelector('#rules-reminders-tab'))"),
  );
  await click(w, "#rules-reminders-tab");
  await until(() => js(w, "Boolean(document.querySelector('#reminder-save'))"));
}
async function advance(ms) {
  current = ms;
  await writeTestClock(clock, ms);
  await sleep(200);
}
async function main() {
  fs.mkdirSync(profile, { recursive: true });
  clock = path.join(profile, "clock");
  fs.writeFileSync(clock, String(current));
  runtime = await bootstrap({
    userData: profile,
    show: false,
    testClockFile: clock,
    testNotification(options) {
      if (realNative) return new Notification(options);
      const n = new EventEmitter();
      n.close = () => n.emit("close");
      n.show = () => {
        nativeCalls.push(options);
        n.emit(
          failNative ? "failed" : "show",
          {},
          "owned synthetic OS failure",
        );
      };
      return n;
    },
  });
  const core = runtime.core,
    w = runtime.window;
  w.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  await reminders(w);
  await field(w, "reminder-name", "S1 发布检查");
  await field(w, "reminder-body", "固定合成提醒资料", "HTMLTextAreaElement");
  await field(w, "reminder-zone", "UTC");
  await field(w, "reminder-date", "2026-11-08");
  await field(w, "reminder-time", "00:00:02");
  await click(w, "#reminder-preview");
  await until(() =>
    js(
      w,
      "document.querySelector('#reminder-preview-list')?.innerText.includes('00:00:02')",
    ),
  );
  await js(
    w,
    "document.querySelector('#reminder-save').click();document.querySelector('#reminder-save').click()",
  );
  const rule = await until(async () => {
    const p = await core.request("rules.list", {});
    return p.items[0];
  });
  assert.equal((await core.request("rules.list", {})).items.length, 1);
  assert.equal((await core.request("workspace.list", {})).items.length, 0);
  await advance(current + 2000);
  let notification = await until(async () => {
    const p = await core.request("notifications.list", {});
    return p.items[0]?.state === "shown" && p.items[0];
  });
  assert.equal(nativeCalls.length, 1);
  assert.equal(notification.read_at_ms, null);
  await until(() =>
    js(
      w,
      "document.querySelector('#reminder-notifications')?.innerText.includes('系统显示已回执')",
    ),
  );
  await js(
    w,
    "[...document.querySelectorAll('#reminder-notifications button')].find(b=>b.textContent==='标为已读').click()",
  );
  await until(
    async () =>
      (await core.request("notifications.list", {})).items[0].read_at_ms !=
      null,
  );
  assert.equal((await core.request("agent.list", {})).items.length, 0);
  assert.equal((await core.request("provider.list", {})).length, 0);
  report.checks.push(
    "UI preview and duplicate save create one reminder without workspace or provider; main process records one synthetic native show callback and an independent read receipt with zero Runs",
  );
  w.webContents.reload();
  await reminders(w);
  await until(() =>
    js(w, "document.querySelector('#reminder-name')?.value==='S1 发布检查'"),
  );
  const before = BrowserWindow.getAllWindows().map((w) => w.id);
  await click(w, "#desktop-new-window");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find((w) => !before.includes(w.id)),
  );
  second.webContents.setBackgroundThrottling(false);
  await reminders(second);
  second.hide();
  await until(() =>
    js(
      second,
      "Boolean(document.querySelector('.reminder-page .provider-choice'))",
    ),
  );
  await click(second, ".reminder-page .provider-choice");
  await until(() =>
    js(second, "!document.querySelector('#reminder-save').disabled"),
  );
  await field(w, "reminder-body", "保留我的旧草稿", "HTMLTextAreaElement");
  await field(second, "reminder-name", "另一个窗口的新修订");
  await field(second, "reminder-time", "00:01:02");
  await click(second, "#reminder-save");
  await until(() =>
    js(
      w,
      "document.querySelector('.reminder-page')?.innerText.includes('规则已变化')",
    ),
  );
  assert.equal(
    await js(w, "document.querySelector('#reminder-body').value"),
    "保留我的旧草稿",
  );
  assert.equal(
    await js(w, "document.querySelector('#reminder-save').disabled"),
    true,
  );
  const internal = await js(
    w,
    `window.troop.executeOperation({operation_id:${JSON.stringify(crypto.randomUUID())},instance_id:${JSON.stringify(core.snapshot().storage_instance)},method:'notifications.claim',input:{consumer_id:${JSON.stringify(crypto.randomUUID())},focused:false}})`,
  );
  assert.equal(internal.ok, false);
  report.checks.push(
    "reload retains the reminder draft; two windows observe revisions and preserve stale edits; renderer cannot claim native notification delivery",
  );
  second.close();
  await js(
    w,
    "[...document.querySelectorAll('.reminder-page button')].find(b=>b.textContent==='载入当前修订').click()",
  );
  await advance(current + 6000);
  failNative = true;
  await click(w, "#reminder-run");
  notification = await until(async () => {
    const p = await core.request("notifications.list", {});
    return p.items[0]?.state === "failed" && p.items[0];
  });
  assert.ok(notification.reason.includes("owned synthetic"));
  assert.equal(nativeCalls.length, 2);
  for (const width of [1440, 768, 660]) {
    w.setSize(width, 900);
    await sleep(200);
    assert.equal(
      await js(w, "document.documentElement.scrollWidth<=window.innerWidth"),
      true,
    );
    await js(
      w,
      "document.querySelector('.reminder-page').scrollIntoView({block:'start'})",
    );
    fs.writeFileSync(
      path.join(profile, `reminders-${width}.png`),
      (await w.webContents.capturePage()).toPNG(),
    );
  }
  await core.stop();
  await advance(current + 86400000);
  await core.start();
  w.webContents.reload();
  await reminders(w);
  assert.equal(
    (await core.request("reminders.history", { id: rule.id })).items.length,
    3,
  );
  assert.equal((await core.request("notifications.list", {})).items.length, 2);
  assert.equal(nativeCalls.length, 2);
  assert.equal((await core.request("agent.list", {})).items.length, 0);
  report.checks.push(
    "synthetic native failure remains queryable, three desktop widths avoid horizontal overflow, and Core restart retains trigger and delivery identities without re-showing",
  );
  report.nativeOS = {
    supported: Notification.isSupported(),
    outcome: "unsupported",
  };
  if (Notification.isSupported()) {
    realNative = true;
    const latest = await core.request("reminders.get", { id: rule.id });
    const receipt = await core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method: "reminders.run",
      input: {
        id: rule.id,
        expected_revision: latest.revision,
        client_trigger_id: crypto.randomUUID(),
      },
    });
    assert.equal(receipt.state, "committed");
    const delivered = await until(async () => {
      const n = (await core.request("notifications.list", {})).items.find(
        (n) => n.id === receipt.result.id,
      );
      return n && ["shown", "failed", "indeterminate"].includes(n.state) && n;
    });
    report.nativeOS = {
      supported: true,
      outcome: delivered.state,
      notification_id: delivered.id,
      slot_id: delivered.slot_id,
      reason: delivered.reason,
    };
    assert.equal(delivered.state, "shown");
    assert.equal(delivered.read_at_ms, null);
    report.checks.push(
      "a durable manual reminder uses the actual Windows Notification through the main dispatcher and persists the real native show callback separately from reading",
    );
  }
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
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "reminders-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
