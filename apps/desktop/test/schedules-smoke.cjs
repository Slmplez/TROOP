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
  report = { checks: [], passed: false };
let runtime,
  server,
  clock,
  current = Date.parse("2026-11-08T00:00:00Z"),
  slow = false;
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
async function schedules(w) {
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
    js(w, "Boolean(document.querySelector('#rules-schedules-tab'))"),
  );
  await click(w, "#rules-schedules-tab");
  await until(() =>
    js(w, "Boolean(document.querySelector('#schedule-preview'))"),
  );
}
async function advance(time) {
  current = time;
  await writeTestClock(clock, time);
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
    id: agent.id,
    name: "定时验收 Agent",
    automatic: false,
    dreaming: false,
    expected_revision: agent.revision,
  });
  server = await agentServer({
    plan: () => [],
    reply: "定时核对结论",
    beforeResponse: async () => {
      if (slow) await sleep(1200);
    },
  });
  const provider = await core.request("provider.save", {
    config: {
      name: "S2 本地验收模型",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-schedule",
      max_output_tokens: 2048,
      idle_timeout_secs: 5,
    },
  });
  const grantInput = {
    name: "S2 范围",
    purpose: "tool_call",
    agent_id: 1,
    engine_id: "native",
    workspace_id: wid,
    project_ids: [],
    read_roots: [workspace],
    write_roots: [workspace],
    operations: ["read_file"],
    network: "none",
    expires_at: Math.floor(Date.now() / 1000) + 600,
  };
  const grant = await command("authorizations.save", {
    expected_revision: 0,
    grant: grantInput,
  });
  const work = await command("work_items.save", {
    expected_revision: 0,
    item: {
      title: "定时工作验收",
      goal: "核对固定资料",
      acceptance: "提供核对结论",
      owner_agent_id: 1,
      workspace_id: wid,
    },
  });
  w.webContents.reload();
  await schedules(w);
  await field(w, "schedule-name", "S2 定时核对");
  await field(w, "schedule-authorization", grant.id);
  await field(w, "schedule-goal", "核对固定验收资料", "HTMLTextAreaElement");
  await field(w, "schedule-work", work.id);
  await field(w, "schedule-zone", "UTC");
  await field(w, "schedule-date", "2026-11-08");
  await field(w, "schedule-time", "00:00:02");
  await click(w, "#schedule-preview");
  await until(() =>
    js(w, "Boolean(document.querySelector('#schedule-preview-result'))"),
  );
  assert.equal(
    await js(w, "document.querySelector('#schedule-save').disabled"),
    false,
  );
  await js(
    w,
    "document.querySelector('#schedule-save').click();document.querySelector('#schedule-save').click()",
  );
  const rule = await until(async () => {
    const p = await core.request("rules.list", {});
    return p.items[0];
  });
  assert.equal((await core.request("rules.list", {})).items.length, 1);
  assert.equal(server.requests.length, 0);
  await advance(current + 2000);
  const first = await until(async () => {
    const p = await core.request("schedules.history", { id: rule.id });
    return p.items[0]?.run?.state === "completed" && p.items[0];
  });
  await until(() =>
    js(
      w,
      "document.querySelector('#work-item-progress')?.innerText.includes('待验收')",
    ),
  );
  await field(
    w,
    "work-acceptance-note",
    "固定结论符合验收要求",
    "HTMLTextAreaElement",
  );
  await until(() =>
    js(
      w,
      "Boolean(document.querySelector('.work-result-accept:not(:disabled)'))",
    ),
  );
  await click(w, ".work-result-accept");
  await until(
    async () =>
      (await core.request("work_items.get", { id: work.id })).progress.state ===
      "completed",
  );
  assert.equal((await core.request("agent.list", {})).items.length, 1);
  report.checks.push(
    "UI time and permission preview plus duplicate save create one native scheduled Run, freeze the grant and work definition, and accept its fixed result through the existing work interface",
  );
  w.webContents.reload();
  await schedules(w);
  await until(() =>
    js(w, "document.querySelector('#schedule-name')?.value==='S2 定时核对'"),
  );
  const before = BrowserWindow.getAllWindows().map((w) => w.id);
  await click(w, "#desktop-new-window");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find((w) => !before.includes(w.id)),
  );
  second.webContents.setBackgroundThrottling(false);
  await schedules(second);
  second.hide();
  await until(() =>
    js(
      second,
      "Boolean(document.querySelector('.scheduled-page .provider-choice'))",
    ),
  );
  await click(second, ".scheduled-page .provider-choice");
  await until(() =>
    js(second, "!document.querySelector('#schedule-preview').disabled"),
  );
  await field(
    w,
    "schedule-goal",
    "保留第一窗口的旧草稿",
    "HTMLTextAreaElement",
  );
  await field(second, "schedule-work", "");
  await field(second, "schedule-name", "新定时修订");
  await field(second, "schedule-time", "00:01:02");
  await click(second, "#schedule-preview");
  await until(() =>
    js(second, "!document.querySelector('#schedule-save').disabled"),
  );
  await click(second, "#schedule-save");
  await until(() =>
    js(
      w,
      "document.querySelector('.scheduled-page')?.innerText.includes('规则已变化')",
    ),
  );
  assert.equal(
    await js(w, "document.querySelector('#schedule-goal').value"),
    "保留第一窗口的旧草稿",
  );
  assert.equal(
    await js(w, "document.querySelector('#schedule-save').disabled"),
    true,
  );
  second.close();
  await js(
    w,
    "[...document.querySelectorAll('.scheduled-page button')].find(b=>b.textContent==='载入当前定时修订').click()",
  );
  await until(() =>
    js(w, "!document.querySelector('#schedule-toggle').disabled"),
  );
  await click(w, "#schedule-toggle");
  await until(() =>
    js(
      w,
      "document.querySelector('#schedule-phase')?.innerText.includes('已暂停')",
    ),
  );
  slow = true;
  await click(w, "#schedule-run");
  const manual = await until(async () => {
    const p = await core.request("schedules.history", { id: rule.id });
    return p.items[0]?.manual && p.items[0].run && p.items[0];
  });
  await until(() =>
    js(w, "!document.querySelector('#schedule-stop-run').disabled"),
  );
  await click(w, "#schedule-stop-run");
  await until(
    async () =>
      (await core.request("agent.get", { id: manual.run.id })).run.state ===
      "cancelled",
  );
  slow = false;
  await click(w, "#schedule-toggle");
  await until(() =>
    js(
      w,
      "document.querySelector('#schedule-phase')?.innerText.includes('已启用')",
    ),
  );
  report.checks.push(
    "reload retains the selected draft, two windows fence a stale edit, and pausing a rule remains separate from explicitly stopping its manual Run",
  );
  for (const width of [1440, 768, 660]) {
    w.setSize(width, 900);
    await sleep(180);
    assert.equal(
      await js(w, "document.documentElement.scrollWidth<=window.innerWidth"),
      true,
    );
    await js(
      w,
      "document.querySelector('.scheduled-page').scrollIntoView({block:'start'})",
    );
    fs.writeFileSync(
      path.join(profile, `schedules-${width}.png`),
      (await w.webContents.capturePage()).toPNG(),
    );
  }
  await core.stop();
  await advance(current + 86400000);
  await core.start();
  w.webContents.reload();
  await schedules(w);
  const restored = await core.request("schedules.history", { id: rule.id });
  assert.equal(restored.items.length, 3);
  assert.equal(restored.items[0].state, "skipped");
  assert.equal((await core.request("agent.list", {})).items.length, 2);
  report.checks.push(
    "three desktop widths avoid horizontal overflow; restart preserves identities and skips the offline slot without starting another Run",
  );
  const pi = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      ...grantInput,
      name: "Pi 定时验收范围",
      purpose: "cli_start",
      engine_id: "pi",
      operations: ["start"],
      network: "any",
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/pi_protocol_probe.exe",
      ),
    },
  });
  await click(w, "#schedule-new");
  await field(w, "schedule-name", "Pi 定时验收");
  await field(w, "schedule-execution", "cli", "HTMLSelectElement");
  assert.deepEqual(
    await js(
      w,
      "[...document.querySelector('#schedule-engine').options].map(o=>o.value).sort()",
    ),
    ["claude", "codex", "opencode", "pi"],
  );
  await field(w, "schedule-engine", "pi", "HTMLSelectElement");
  await field(w, "schedule-tools", "disabled", "HTMLSelectElement");
  await field(w, "schedule-authorization", pi.id);
  await field(
    w,
    "schedule-goal",
    "Owned scheduled fixture task",
    "HTMLTextAreaElement",
  );
  await field(w, "schedule-zone", "UTC");
  await field(w, "schedule-date", "2026-11-09");
  await field(w, "schedule-time", "00:00:04");
  await click(w, "#schedule-preview");
  await until(() =>
    js(w, "!document.querySelector('#schedule-save').disabled"),
  );
  await field(
    w,
    "schedule-goal",
    "Owned scheduled fixture task revised",
    "HTMLTextAreaElement",
  );
  assert.equal(
    await js(w, "document.querySelector('#schedule-save').disabled"),
    true,
  );
  await click(w, "#schedule-preview");
  await until(() =>
    js(w, "!document.querySelector('#schedule-save').disabled"),
  );
  await click(w, "#schedule-save");
  const cliRule = await until(async () => {
    const p = await core.request("rules.list", {});
    return p.items.find((rule) => rule.name === "Pi 定时验收");
  });
  await advance(current + 2000);
  const cli = await until(async () => {
    const p = await core.request("schedules.history", { id: cliRule.id });
    return p.items[0]?.run && p.items[0];
  });
  await until(async () =>
    (await core.request("agent.get", { id: cli.run.id })).run.waiting.includes(
      "review",
    ),
  );
  await until(() =>
    js(w, "Boolean(document.querySelector('#schedule-open-run'))"),
  );
  await click(w, "#schedule-open-run");
  await until(() =>
    js(w, "Boolean(document.querySelector('.owned-task-list button'))"),
  );
  await click(w, ".owned-task-list button");
  await until(() =>
    js(w, "Boolean(document.querySelector('#cli-review-note'))"),
  );
  await field(
    w,
    "cli-review-note",
    "确认定时 CLI 固定证据",
    "HTMLTextAreaElement",
  );
  await click(w, "#cli-review-confirm");
  await until(() =>
    js(w, "!document.querySelector('#cli-review-accept').disabled"),
  );
  await click(w, "#cli-review-accept");
  await until(
    async () =>
      (await core.request("agent.get", { id: cli.run.id })).run.state ===
      "completed",
  );
  report.checks.push(
    "the CLI form exposes the four selected engines, changed input invalidates preview, and a scheduled Pi protocol peer uses the real Worker and existing fixed-evidence review UI",
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
      path.join(profile, "schedules-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
