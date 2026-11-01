// Developer-only Electron acceptance. No fake preload or production test hooks.
const { app } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const profile = process.argv[2];
const report = { checks: [], passed: false };
let runtime, server;
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(35);
  }
  throw Error("Agent UI condition timed out");
}
async function run() {
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  server = await agentServer({
    plan: (request) => {
      const messages = request.body.messages;
      if (
        messages.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === "tool_result"),
        )
      )
        return [];
      if (messages[0].content.includes("停止演练"))
        return [
          {
            name: "run_command",
            arguments: {
              command:
                "Set-Content -LiteralPath 'running.txt' -Value 'owned'; Start-Sleep -Seconds 30",
            },
          },
        ];
      return [
        {
          name: "write_file",
          arguments: {
            path: "ui-proof.txt",
            content: "真实 UI 工具写入",
            expected_hash: "missing",
          },
        },
        {
          name: "run_command",
          arguments: { command: "Write-Output 'owned-ui-command'" },
        },
      ];
    },
  });
  runtime = await bootstrap({ userData: profile, show: false });
  assert.ok(runtime);
  const { window: win, core } = runtime;
  win.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  report.corePid = core.snapshot().pid;
  const workspaceId = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const provider = await core.request("provider.save", {
    config: {
      name: "自有工具测试",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-agent-ui",
      max_output_tokens: 1024,
      idle_timeout_secs: 5,
    },
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // Reconstruct the app after seeding its own fixture through the real Core.
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
  await field("agent-provider", provider.id, "HTMLSelectElement");
  await field("agent-workspace", String(workspaceId), "HTMLSelectElement");
  await field("agent-goal", "UI 工具验收", "HTMLTextAreaElement");
  await js("document.querySelector('#agent-start').click()");
  await until(() => js("Boolean(document.querySelector('#agent-approve'))"));
  assert.equal(fs.existsSync(path.join(workspace, "ui-proof.txt")), false);
  assert.ok(
    await js(
      "document.querySelector('[aria-label=工具参数]').textContent.includes('ui-proof.txt')",
    ),
  );
  report.checks.push(
    "start button -> fixed IPC -> real Core -> frozen write approval; no pre-approval effect",
  );
  const approvalImage = await win.webContents.capturePage();
  fs.writeFileSync(path.join(profile, "approval.png"), approvalImage.toPNG());
  await js("document.querySelector('#agent-approve').click()");
  await until(() => fs.existsSync(path.join(workspace, "ui-proof.txt")));
  await until(async () =>
    (await core.request("agent.get", { id: 1 })).invocations.some(
      (i) => i.name === "run_command" && i.state === "prepared",
    ),
  );
  const command = (await core.request("agent.get", { id: 1 })).invocations.find(
    (i) => i.name === "run_command",
  );
  await field("agent-invocation", String(command.id), "HTMLSelectElement");
  await until(() =>
    js(
      "document.querySelector('[aria-label=工具参数]')?.textContent.includes('owned-ui-command') && Boolean(document.querySelector('#agent-approve'))",
    ),
  );
  await js("document.querySelector('#agent-approve').click()");
  await until(() =>
    js(
      "document.querySelector('.agent-status strong')?.textContent.includes('已完成')",
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, "ui-proof.txt"), "utf8"),
    "真实 UI 工具写入",
  );
  report.checks.push(
    "both approval buttons -> actual file and PowerShell -> model final result",
  );
  const reloaded = once(win.webContents, "did-finish-load");
  win.webContents.reload();
  await reloaded;
  await until(() => js("Boolean(document.querySelector('nav'))"));
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='任务').click()",
  );
  await until(() => js("Boolean(document.querySelector('.agent-row'))"));
  await js("document.querySelector('.agent-row').click()");
  await until(() =>
    js(
      "document.querySelector('.agent-status strong')?.textContent.includes('已完成')",
    ),
  );
  assert.equal(server.requests.length, 2);
  report.checks.push(
    "renderer reload restores completed task and tools without replay",
  );
  await js("document.querySelector('.agent-ledger summary').click()");
  await until(() =>
    js(
      "[...document.querySelectorAll('.agent-ledger li button')].some(b=>b.textContent.includes('模型回复'))",
    ),
  );
  await js(
    "[...document.querySelectorAll('.agent-ledger li button')].find(b=>b.textContent.includes('模型回复')).click()",
  );
  await until(() =>
    js(
      "document.querySelector('[aria-label=执行事件详情]')?.textContent.includes('model_finished')",
    ),
  );
  report.checks.push(
    "durable execution ledger exposes prior model and approval events",
  );
  await js("document.querySelector('.agent-ledger summary').click()");
  const layouts = [];
  for (const [width, height] of [
    [1440, 900],
    [768, 900],
    [660, 780],
  ]) {
    win.setContentSize(width, height);
    await sleep(120);
    layouts.push(
      await js(
        "({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('.agent-page button')].filter(b=>b.offsetWidth>0).every(b=>b.getBoundingClientRect().width>0)})",
      ),
    );
    fs.writeFileSync(
      path.join(profile, `task-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  assert.ok(layouts.every((l) => !l.overflow && l.buttons));
  report.layouts = layouts;
  report.checks.push(
    "task view has no horizontal overflow at 1440/768/660 widths",
  );
  await js("document.querySelector('#agent-new').click()");
  await field("agent-provider", provider.id, "HTMLSelectElement");
  await field("agent-workspace", String(workspaceId), "HTMLSelectElement");
  await field("agent-goal", "停止演练", "HTMLTextAreaElement");
  await js("document.querySelector('#agent-start').click()");
  await until(() => js("Boolean(document.querySelector('#agent-approve'))"));
  await js("document.querySelector('#agent-approve').click()");
  await until(() => fs.existsSync(path.join(workspace, "running.txt")));
  await js("document.querySelector('#agent-stop').click()");
  await until(() =>
    js(
      "document.querySelector('.agent-status strong')?.textContent.includes('已停止')",
    ),
  );
  report.checks.push(
    "Stop button stops a running command and retains produced file",
  );
  assert.equal(win.isVisible(), false);
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
      path.join(profile, "agent-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
