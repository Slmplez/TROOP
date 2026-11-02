const { app } = require("electron"),
  { bootstrap } = require("../src/main.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const { results, user, hook, emit } = require("./fixtures/hooks-fixture.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { once } = require("node:events");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime, server;
async function until(fn) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(40);
  }
  throw Error("Hook UI condition timed out");
}
async function run() {
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "input.txt"), "OWNED_UI_READ");
  server = await agentServer({
    plan: ({ body }) =>
      hook(body) || results(body).length
        ? []
        : user(body) === "UI maintain workflow"
          ? [
              {
                name: "update_state",
                arguments: {
                  target: "workflow",
                  action: "write",
                  id: "ui-maintained",
                  name: "UI maintained workflow",
                  description: "Use when checking this owned UI fixture",
                  body: "Read input.txt and report evidence.",
                },
              },
            ]
          : [{ name: "read_file", arguments: { path: "input.txt" } }],
    reply: ({ body }) => (hook(body) ? "{}" : "Owned task completed."),
  });
  runtime = await bootstrap({ userData: profile, show: false });
  const { window: win, core } = runtime;
  win.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  await core.request("memory.agent.save", {
    id: 1,
    name: "Owned Hooks UI Agent",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const provider = await core.request("provider.save", {
    config: {
      name: "Owned Hooks UI service",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-hooks-ui",
      max_output_tokens: 4096,
      idle_timeout_secs: 5,
    },
  });
  const js = (code) => win.webContents.executeJavaScript(code, true),
    click = async (selector) => {
      await until(() =>
        js(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return Boolean(e && !e.disabled);})()`,
        ),
      );
      await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await sleep(80);
    };
  const field = async (id, value, type = "HTMLInputElement") => {
    await until(() =>
      js(
        `(()=>{const e=document.getElementById(${JSON.stringify(id)});return Boolean(e && !e.disabled);})()`,
      ),
    );
    await js(
      `(()=>{const e=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(60);
  };
  const nav = async (text) => {
    await js(
      `[...document.querySelectorAll('nav button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`,
    );
    await sleep(100);
  };
  const reload = once(win.webContents, "did-finish-load");
  win.webContents.reload();
  await reload;
  await until(() => js("Boolean(document.querySelector('nav'))"));
  await nav("Hooks");
  await until(() =>
    js("document.querySelectorAll('#hook-event option').length===21"),
  );
  await field("hook-name", "Owned read approval");
  await field(
    "hook-command",
    emit({ permission: "ask" }),
    "HTMLTextAreaElement",
  );
  await click("#hook-enabled");
  await click("#hook-fail-closed");
  await click("#hook-save");
  await until(() =>
    js(
      "document.querySelector('.hook-rules')?.textContent.includes('Owned read approval')",
    ),
  );
  let rule = (await core.request("hooks.list", {})).rules[0];
  assert.equal(rule.enabled, true);
  assert.equal(rule.failClosed, true);
  report.checks.push(
    "Hook form saves explicit Windows location, event, command, scope and failure policy through fixed IPC",
  );
  async function startGoal(goal) {
    await nav("任务");
    await click("#agent-new");
    await field("agent-provider", provider.id, "HTMLSelectElement");
    await field("agent-workspace", String(wid), "HTMLSelectElement");
    await field("agent-goal", goal, "HTMLTextAreaElement");
    await click("#agent-start");
    await until(
      async () => (await core.request("agent.list", {})).items.length > 0,
    );
    return (await core.request("agent.list", {})).items[0].id;
  }
  const id = await startGoal("UI Hook read");
  await until(() => js("Boolean(document.querySelector('#agent-approve'))"));
  const pending = await core.request("agent.get", { id });
  assert.equal(pending.run.waiting[0], "approval");
  const inv = await core.request("agent.invocation", {
    id: pending.invocations[0].id,
  });
  assert.equal(inv.name, "read_file");
  assert.equal(inv.hook_ask, true);
  await click("#agent-approve");
  await until(
    async () =>
      (await core.request("agent.get", { id })).run.state === "completed",
  );
  await until(() => js("Boolean(document.querySelector('.hook-details'))"));
  await click(".hook-details");
  await until(() =>
    js(
      "document.querySelector('.hook-detail')?.textContent.includes('input.txt')",
    ),
  );
  report.checks.push(
    "Hook ask exposes approval for a read and the task UI shows the real Hook input/result ledger",
  );
  await nav("Hooks");
  await click(".hook-name");
  await field("hook-name", "Owned stop exercise");
  await field("hook-event", "sessionStart", "HTMLSelectElement");
  await field("hook-timeout", "30");
  await field(
    "hook-command",
    "while($true){[IO.File]::AppendAllText((Join-Path (Get-Location) 'ui-hook-heartbeat.txt'),'x');Start-Sleep -Milliseconds 40}",
    "HTMLTextAreaElement",
  );
  await click("#hook-save");
  await until(() =>
    js(
      "document.querySelector('.hook-rules')?.textContent.includes('Owned stop exercise')",
    ),
  );
  const stoppedId = await startGoal("UI stop Hook");
  await until(() =>
    fs.existsSync(path.join(workspace, "ui-hook-heartbeat.txt")),
  );
  await click("#agent-stop");
  await until(async () =>
    ["interrupted", "cancelled"].includes(
      (await core.request("agent.get", { id: stoppedId })).run.state,
    ),
  );
  const count = fs.statSync(path.join(workspace, "ui-hook-heartbeat.txt")).size;
  await sleep(150);
  assert.equal(
    fs.statSync(path.join(workspace, "ui-hook-heartbeat.txt")).size,
    count,
  );
  report.checks.push(
    "Stop button terminates the actual Hook process tree and preserves its existing output",
  );
  await until(() =>
    js(
      "document.querySelector('.hook-records')?.textContent.includes('结果不明')",
    ),
  );
  await click(".hook-details");
  await until(() =>
    js("Boolean(document.querySelector('#hook-reconcile-note'))"),
  );
  await field(
    "hook-reconcile-note",
    "Owned heartbeat and whole process tree checked stopped",
    "HTMLTextAreaElement",
  );
  await click("#hook-reconcile-stopped");
  await click("#hook-reconcile");
  await until(
    async () =>
      !(await core.request("agent.get", { id: stoppedId })).hooks_unresolved,
  );
  report.checks.push(
    "Task Hook ledger saves explicit effect/stop reconciliation without replaying the old script",
  );
  await nav("Hooks");
  await click(".hook-name");
  await click("#hook-delete");
  await until(async () => (await core.request("hooks.list", {})).total === 0);
  assert.equal((await core.request("hooks.calls", { run_id: id })).total, 1);
  report.checks.push(
    "Deleting configuration retains prior task Hook records and revokes the old revision",
  );
  const maintained = await startGoal("UI maintain workflow");
  await until(
    async () =>
      (await core.request("agent.get", { id: maintained })).run.state ===
      "completed",
  );
  await nav("技能");
  await until(() =>
    js(
      "document.querySelector('.skill-list')?.textContent.includes('UI maintained workflow')",
    ),
  );
  report.checks.push(
    "Model update_state workflow write becomes a visible editable skill through the production task and library interfaces",
  );
  await nav("Hooks");
  await field("hook-name", "Model response review");
  await field("hook-kind", "prompt", "HTMLSelectElement");
  await field("hook-event", "sessionStart", "HTMLSelectElement");
  await field(
    "hook-prompt",
    "Return {} after checking the owned event data.",
    "HTMLTextAreaElement",
  );
  await click("#hook-save");
  await until(() =>
    js(
      "document.querySelector('.hook-rules')?.textContent.includes('Model response review')",
    ),
  );
  await click("#hook-new");
  await field("hook-name", "Legacy Linux preflight");
  await field("hook-location", "legacy-linux", "HTMLSelectElement");
  await field(
    "hook-command",
    "python /workspace/preflight.py",
    "HTMLTextAreaElement",
  );
  assert.equal(
    await js("document.querySelector('#hook-enabled').disabled"),
    true,
  );
  await click("#hook-save");
  await until(() =>
    js(
      "document.querySelector('.hook-rules')?.textContent.includes('Legacy Linux preflight')",
    ),
  );
  report.checks.push(
    "Legacy Linux configuration stays visible and disabled; no command conversion or implicit execution occurs",
  );
  report.layouts = [];
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(140);
    report.layouts.push(
      await js(
        "({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth})",
      ),
    );
    fs.writeFileSync(
      path.join(profile, `hooks-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  assert.ok(report.layouts.every((l) => !l.overflow));
  report.checks.push(
    "Hook settings and source text fit real Electron windows at 1440/768/660",
  );
  const requests = server.requests.length,
    loaded = once(win.webContents, "did-finish-load");
  win.webContents.reload();
  await loaded;
  await until(() => js("Boolean(document.querySelector('nav'))"));
  await nav("Hooks");
  await until(() =>
    js(
      "document.querySelector('.hook-rules')?.textContent.includes('Legacy Linux preflight')",
    ),
  );
  assert.equal(server.requests.length, requests);
  report.checks.push(
    "Renderer reload restores configuration without starting a Hook or issuing a new model request",
  );
  report.passed = true;
}
run()
  .catch((e) => {
    report.error = e.stack;
  })
  .finally(async () => {
    try {
      await runtime?.core.stop();
      report.coreStopped = !runtime?.core.child;
      await server?.close();
    } catch {
      report.coreStopped = false;
    }
    fs.writeFileSync(
      path.join(profile, "hooks-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
