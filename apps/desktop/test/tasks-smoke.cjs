// Isolated developer acceptance; uses the real preload, IPC, Core, SQLite and Worker.
const { app } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { once } = require("node:events");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime, server;
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(35);
  }
  throw Error("Owned task UI condition timed out");
}
async function run() {
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  server = await agentServer({
    plan: ({ body }) => {
      const m = body.messages;
      if (
        m.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === "tool_result"),
        )
      )
        return [];
      if (m[0].content.startsWith("UI child"))
        return [
          {
            name: "start_background",
            arguments: {
              command:
                "Write-Output 'owned-live-ui'; Set-Content -LiteralPath 'owned.txt' -Value 'owned'; Start-Sleep -Seconds 3",
              timeout_seconds: "20",
            },
          },
        ];
      if (m[0].content === "UI stop")
        return [
          {
            name: "start_background",
            arguments: {
              command:
                "while ($true) { Add-Content -LiteralPath 'heartbeat.txt' -Value 'beat'; Start-Sleep -Milliseconds 100 }",
              timeout_seconds: "60",
            },
          },
        ];
      return [
        {
          name: "spawn_agent",
          arguments: { goal: "UI child", access: "inherit" },
        },
      ];
    },
  });
  runtime = await bootstrap({ userData: profile, show: false });
  const { window: win, core } = runtime;
  win.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  report.corePid = core.snapshot().pid;
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const p = await core.request("provider.save", {
    config: {
      name: "Owned tasks UI fixture",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-tasks-ui",
      max_output_tokens: 1024,
      idle_timeout_secs: 5,
    },
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const loaded = once(win.webContents, "did-finish-load");
  win.webContents.reload();
  await loaded;
  await until(() => js("Boolean(document.querySelector('nav'))"));
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='任务').click()",
  );
  const field = async (id, value, type) => {
    await js(
      `(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(70);
  };
  await until(() =>
    js("document.querySelectorAll('#agent-provider option').length===2"),
  );
  await field("agent-provider", p.id, "HTMLSelectElement");
  await field("agent-workspace", String(wid), "HTMLSelectElement");
  await field("agent-goal", "UI root", "HTMLTextAreaElement");
  await js("document.querySelector('#agent-start').click()");
  await until(() =>
    js("Boolean(document.querySelector('.owned-task-list li button'))"),
  );
  await until(() =>
    js(
      "Boolean([...document.querySelectorAll('.owned-task-actions button')].find(b=>b.textContent.includes('查看子代理')))",
    ),
  );
  await js(
    "[...document.querySelectorAll('.owned-task-actions button')].find(b=>b.textContent.includes('查看子代理')).click()",
  );
  await until(() => js("Boolean(document.querySelector('#agent-approve'))"));
  assert.equal(fs.existsSync(path.join(workspace, "owned.txt")), false);
  report.checks.push(
    "task tree opens the distinct child run; background command waits for exact approval",
  );
  await js("document.querySelector('#agent-approve').click()");
  await until(() =>
    js("Boolean(document.querySelector('.owned-task-list li button'))"),
  );
  await until(() =>
    js("document.querySelectorAll('.owned-task-list li').length===2"),
  );
  await js(
    "document.querySelector('.owned-task-list li:last-child button').click()",
  );
  await until(() =>
    js(
      "document.querySelector('[aria-label=作业输出]')?.textContent.includes('owned-live-ui')",
    ),
  );
  report.checks.push(
    "owned background output flows through fixed IPC into its detail view",
  );
  await js(
    "[...document.querySelectorAll('.agent-row')].find(b=>b.textContent.trim().startsWith('#1 ')).click()",
  );
  await until(() =>
    js(
      "document.querySelector('.agent-status strong')?.textContent.includes('已完成')",
    ),
  );
  assert.ok(
    (await core.request("agent.tasks", { id: 1 })).items.every(
      (t) => t.consumed,
    ),
  );
  report.checks.push(
    "parent completion waits for descendant job and durable result consumption",
  );
  const layouts = [];
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(120);
    layouts.push(
      await js(
        "({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth})",
      ),
    );
    fs.writeFileSync(
      path.join(profile, `tasks-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  assert.ok(layouts.every((l) => !l.overflow));
  report.layouts = layouts;
  report.checks.push("task tree fits 1440/768/660 without horizontal overflow");
  await js("document.querySelector('#agent-new').click()");
  await field("agent-provider", p.id, "HTMLSelectElement");
  await field("agent-workspace", String(wid), "HTMLSelectElement");
  await field("agent-goal", "UI stop", "HTMLTextAreaElement");
  await js("document.querySelector('#agent-start').click()");
  await until(() => js("Boolean(document.querySelector('#agent-approve'))"));
  await js("document.querySelector('#agent-approve').click()");
  await until(() => fs.existsSync(path.join(workspace, "heartbeat.txt")));
  await until(() =>
    js(
      "Boolean([...document.querySelectorAll('.owned-task-actions button')].find(b=>b.textContent.includes('停止此作业')))",
    ),
  );
  await js(
    "[...document.querySelectorAll('.owned-task-actions button')].find(b=>b.textContent.includes('停止此作业')).click()",
  );
  await until(() =>
    js(
      "document.querySelector('.agent-status strong')?.textContent.includes('已中断')",
    ),
  );
  const size = fs.statSync(path.join(workspace, "heartbeat.txt")).size;
  await sleep(250);
  assert.equal(fs.statSync(path.join(workspace, "heartbeat.txt")).size, size);
  await js("document.querySelector('.owned-task-list li button').click()");
  await until(() =>
    js("Boolean(document.querySelector('.owned-task-detail textarea'))"),
  );
  await js("document.querySelector('.owned-task-detail textarea').value");
  await js(
    "(()=>{const el=document.querySelector('.owned-task-detail textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Owned UI heartbeat stopped; effects reviewed; do not replay');el.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await sleep(80);
  await js(
    "document.querySelector('.owned-task-detail input[type=checkbox]').click()",
  );
  await until(() =>
    js(
      "![...document.querySelectorAll('.owned-task-detail button')].find(b=>b.textContent==='记录作业核对结论').disabled",
    ),
  );
  await js(
    "[...document.querySelectorAll('.owned-task-detail button')].find(b=>b.textContent==='记录作业核对结论').click()",
  );
  await until(() =>
    js("!document.querySelector('.owned-task-detail textarea')"),
  );
  report.checks.push(
    "owned Stop button ends real heartbeat; manual reconciliation is saved from the UI",
  );
  await js("document.querySelector('#agent-end').click()");
  await until(() =>
    js(
      "document.querySelector('.agent-status strong')?.textContent.includes('已停止')",
    ),
  );
  report.checks.push(
    "acknowledged interrupted owner can end without replaying its job",
  );
  report.passed = true;
}
run()
  .catch((error) => {
    report.error = error.message;
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
      path.join(profile, "tasks-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
