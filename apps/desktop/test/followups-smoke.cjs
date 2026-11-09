const { app, BrowserWindow } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { agentServer } = require("./fixtures/agent-server.cjs");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const { writeTestClock } = require("./fixtures/test-clock.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime,
  server,
  clock,
  current = Date.now(),
  slow = false;
const js = (window, code) => window.webContents.executeJavaScript(code, true);
const click = (window, selector) =>
  js(window, `document.querySelector(${JSON.stringify(selector)}).click()`);
async function field(window, id, value, type = "HTMLInputElement") {
  await js(
    window,
    `(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await sleep(50);
}
async function open(window) {
  await until(() =>
    js(
      window,
      "[...document.querySelectorAll('nav button')].some(b=>b.textContent.trim()==='规则')",
    ),
  );
  await js(
    window,
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()==='规则').click()",
  );
  await until(() =>
    js(window, "Boolean(document.querySelector('#rules-followups-tab'))"),
  );
  await click(window, "#rules-followups-tab");
  await until(() =>
    js(window, "Boolean(document.querySelector('#followup-preview'))"),
  );
}
async function preview(window) {
  await click(window, "#followup-preview");
  await until(() =>
    js(window, "Boolean(document.querySelector('#followup-confirm'))"),
  );
  await click(window, "#followup-confirm");
  await until(() =>
    js(window, "!document.querySelector('#followup-save').disabled"),
  );
}
async function advance(value) {
  current = value;
  await writeTestClock(clock, value);
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
    name: "跟进验收 Agent",
    automatic: false,
    dreaming: false,
    expected_revision: agent.revision,
  });
  server = await agentServer({
    plan: () => [],
    reply: "固定检查结论",
    beforeResponse: async () => {
      if (slow) await sleep(1800);
    },
  });
  const provider = await core.request("provider.save", {
    config: {
      name: "F2 本机验收模型",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-followup",
      max_output_tokens: 2048,
      idle_timeout_secs: 5,
    },
  });
  const grant = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "跟进验收范围",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: wid,
      project_ids: [],
      read_roots: [workspace],
      write_roots: [workspace],
      operations: ["read_file", "propose_followup", "request_handoff"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  const work = await command("work_items.save", {
    expected_revision: 0,
    item: {
      title: "跟进桌面验收",
      goal: "核对预约检查",
      acceptance: "用户确认固定结论",
      owner_agent_id: 1,
      workspace_id: wid,
    },
  });
  w.webContents.reload();
  await open(w);
  await field(w, "followup-name", "预约复查验收");
  await field(w, "followup-work", work.id);
  await click(w, "#followup-scope");
  await until(() =>
    js(
      w,
      `document.querySelector('.followups-page').innerText.includes('工作区 ${wid}')`,
    ),
  );
  await field(w, "followup-provider", provider.id, "HTMLSelectElement");
  await field(w, "followup-authorization", grant.id);
  await preview(w);
  await field(
    w,
    "followup-goal",
    "检查固定资料并保留结果",
    "HTMLTextAreaElement",
  );
  assert.equal(
    await js(w, "document.querySelector('#followup-save').disabled"),
    true,
  );
  await preview(w);
  await js(
    w,
    "document.querySelector('#followup-save').click();document.querySelector('#followup-save').click()",
  );
  const policy = await until(
    async () => (await core.request("followups.list", {})).items[0],
  );
  assert.equal((await core.request("followups.list", {})).items.length, 1);
  await until(() => js(w, "Boolean(document.querySelector('#followup-run'))"));
  await field(w, "followup-reason", "立即核对第一份资料");
  await field(w, "followup-change", "得到固定检查结论");
  await click(w, "#followup-run");
  await advance(Date.now() + 100);
  const first = await until(async () =>
    (await core.request("followups.history", { id: policy.id })).items.find(
      (row) => row.run?.state === "completed",
    ),
  );
  assert.equal(
    (await core.request("work_items.get", { id: work.id })).progress.state,
    "awaiting_acceptance",
  );
  report.checks.push(
    "work scope and explicit permission preview save one policy despite double click; changing the draft clears confirmation; a manual check creates one unaccepted work Run",
  );
  await field(
    w,
    "followup-goal",
    "重载后保留的个人草稿",
    "HTMLTextAreaElement",
  );
  w.webContents.reload();
  await open(w);
  await until(() =>
    js(
      w,
      "document.querySelector('#followup-goal').value==='重载后保留的个人草稿'",
    ),
  );
  const before = BrowserWindow.getAllWindows().map((window) => window.id);
  await click(w, "#desktop-new-window");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find((window) => !before.includes(window.id)),
  );
  second.webContents.setBackgroundThrottling(false);
  await open(second);
  second.hide();
  await until(() =>
    js(
      second,
      "Boolean(document.querySelector('.followups-page .provider-choice'))",
    ),
  );
  await click(second, ".followups-page .provider-choice");
  await until(() =>
    js(second, "!document.querySelector('#followup-preview').disabled"),
  );
  await field(second, "followup-name", "另一窗口的新修订");
  await preview(second);
  await click(second, "#followup-save");
  await until(() =>
    js(
      w,
      "document.querySelector('.followups-page').innerText.includes('策略已有新修订')",
    ),
  );
  assert.equal(
    await js(w, "document.querySelector('#followup-goal').value"),
    "重载后保留的个人草稿",
  );
  assert.equal(
    await js(w, "document.querySelector('#followup-save').disabled"),
    true,
  );
  await click(w, "#followup-load-current");
  second.close();
  await until(() =>
    js(w, "!document.querySelector('#followup-toggle').disabled"),
  );
  await click(w, "#followup-toggle");
  await until(() =>
    js(
      w,
      "document.querySelector('#followup-phase').innerText.includes('已暂停')",
    ),
  );
  assert.equal(
    (await core.request("agent.get", { id: first.run_id })).run.state,
    "completed",
  );
  await click(w, "#followup-toggle");
  await until(() =>
    js(
      w,
      "document.querySelector('#followup-phase').innerText.includes('已启用')",
    ),
  );
  report.checks.push(
    "reload restores the draft; a second window fences stale edits without losing text; policy pause and resume preserve the completed Run",
  );
  for (const width of [1440, 768, 660]) {
    w.setSize(width, 900);
    await sleep(180);
    assert.equal(
      await js(w, "document.documentElement.scrollWidth<=window.innerWidth"),
      true,
      `horizontal overflow at ${width}`,
    );
    await js(
      w,
      "document.querySelector('.followups-page').scrollIntoView({block:'start'})",
    );
    fs.writeFileSync(
      path.join(profile, `followups-${width}.png`),
      (await w.webContents.capturePage()).toPNG(),
    );
    if (process.env.TROOP_TASTE_SKILL) {
      const skill = process.env.TROOP_TASTE_SKILL;
      const probes = await import(
        pathToFileURL(path.join(skill, "scripts/lib/probe.mjs")).href
      );
      const rules = await import(
        pathToFileURL(path.join(skill, "scripts/lib/rules.mjs")).href
      );
      const metrics = await js(w, `(${probes.probe.toString()})()`),
        appMetrics = await js(w, `(${probes.app.toString()})()`);
      // The desktop keeps inactive route panels mounted. Audit its visible h1.
      appMetrics.title = await js(
        w,
        "(()=>{const el=[...document.querySelectorAll('h1')].find(el=>el.getBoundingClientRect().width>0);if(!el)return null;const rect=el.getBoundingClientRect();return {text:el.innerText.trim(),size:Math.round(parseFloat(getComputedStyle(el).fontSize)),top:Math.round(rect.top+scrollY)};})()",
      );
      fs.writeFileSync(
        path.join(profile, `design-${width}.json`),
        JSON.stringify(
          {
            metrics,
            app: appMetrics,
            probe_adjustment:
              "The title lookup selects the first visible h1 because inactive desktop panels remain mounted.",
            findings: rules.judgeApp(appMetrics, metrics, { width, allow: [] }),
          },
          null,
          2,
        ),
      );
    }
  }
  await advance(current + 62_000);
  slow = true;
  await field(w, "followup-reason", "验证链路停止");
  await field(w, "followup-change", "运行或停止事实");
  await click(w, "#followup-run");
  const active = await until(async () =>
    (await core.request("followups.history", { id: policy.id })).items.find(
      (row) => row.run_id && row.run_id !== first.run_id,
    ),
  );
  await until(() =>
    js(w, "!document.querySelector('#followup-stop-chain').disabled"),
  );
  await click(w, "#followup-stop-chain");
  await until(
    async () =>
      (await core.request("agent.get", { id: active.run_id })).run.state ===
      "cancelled",
  );
  await until(() =>
    js(
      w,
      "document.querySelector('#followup-chain').innerText.includes('已停止')",
    ),
  );
  await js(
    w,
    "document.querySelector('#followup-chain').scrollIntoView({block:'start'})",
  );
  fs.writeFileSync(
    path.join(profile, "followups-stopped.png"),
    (await w.webContents.capturePage()).toPNG(),
  );
  await core.stop();
  await core.start();
  w.webContents.reload();
  await open(w);
  assert.equal(
    (await core.request("followups.get", { id: policy.id })).chain.stopped,
    true,
  );
  assert.equal((await core.request("agent.list", {})).items.length, 2);
  report.checks.push(
    "1440/768/660 desktop widths avoid horizontal overflow; stopping the chain cancels its active Run, survives restart and creates no replacement execution",
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
      path.join(profile, "followups-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
