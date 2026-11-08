// Developer acceptance through the production window, preload, supervisor and Core.
const { app } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const { mcpServer } = require("./fixtures/mcp-agent-server.cjs");
const { once } = require("node:events");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const profile = process.argv[2];
const report = { checks: [], passed: false };
let runtime, model, server;
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(35);
  }
  throw Error("MCP approval UI condition timed out");
}
async function run() {
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  model = await agentServer({
    plan: ({ body }) => {
      if (
        body.messages.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === "tool_result"),
        )
      )
        return [];
      return body.tools
        .filter((t) => t.name.startsWith("mcp_"))
        .map((t) => ({
          name: t.name,
          arguments: { text: "owned-ui-mcp", count: 2 },
        }));
    },
  });
  server = await mcpServer();
  runtime = await bootstrap({ userData: profile, show: false });
  const { window: win, core } = runtime;
  win.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  report.corePid = core.snapshot().pid;
  await core.request("memory.agent.save", {
    id: 1,
    name: "Owned MCP Agent",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const provider = await core.request("provider.save", {
    config: {
      name: "Owned MCP model",
      protocol: "anthropic",
      base_url: model.origin,
      model: "owned-ui",
      max_output_tokens: 1024,
      idle_timeout_secs: 5,
    },
  });
  await core.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "Owned approval service",
      transport: "http",
      location: "remote",
      url: server.url,
      enabled: true,
      agent_ids: [1],
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
  await field("agent-provider", provider.id, "HTMLSelectElement");
  await field("agent-workspace", String(wid), "HTMLSelectElement");
  await field(
    "agent-goal",
    "Owned MCP approval acceptance",
    "HTMLTextAreaElement",
  );
  await js("document.querySelector('#agent-start').click()");
  await until(() => js("Boolean(document.querySelector('#agent-approve'))"));
  const shown = await js(
    "document.querySelector('[aria-label=工具参数]').textContent",
  );
  for (const expected of [
    "Owned approval service",
    "echo",
    "owned-ui-mcp",
    "remote",
    "http",
  ])
    assert.ok(shown.includes(expected), expected);
  assert.equal(server.calls.filter((c) => c.method === "tools/call").length, 0);
  report.checks.push(
    "real task start and MCP approval display exact server, transport, tool and final arguments without an early call",
  );
  await js(
    "document.querySelector('#agent-approve').scrollIntoView({block:'center'})",
  );
  win.showInactive();
  await sleep(200);
  fs.writeFileSync(
    path.join(profile, "mcp-approval.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  win.hide();
  await js("document.querySelector('#agent-approve').click()");
  await until(() =>
    js(
      "document.querySelector('.agent-status strong')?.textContent.includes('已完成')",
    ),
  );
  assert.equal(server.calls.filter((c) => c.method === "tools/call").length, 1);
  report.checks.push(
    "real approval button dispatches one MCP call and completes model history",
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
  assert.equal(server.calls.filter((c) => c.method === "tools/call").length, 1);
  assert.ok(
    (await core.request("agent.mcp-sessions", { run_id: 1 })).items.every(
      (s) => s.stopped,
    ),
  );
  report.checks.push(
    "reload restores ledger without replay; terminal Run closes its MCP connection",
  );
  await core.stop();
  report.coreStopped = core.child === null;
  report.passed = true;
}
app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    report.error = error.stack;
  } finally {
    if (runtime?.core.child) await runtime.core.stop().catch(() => {});
    await server?.close();
    await model?.close();
    fs.writeFileSync(
      path.join(profile, "mcp-agent-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    app.exit(report.passed ? 0 : 1);
  }
});
