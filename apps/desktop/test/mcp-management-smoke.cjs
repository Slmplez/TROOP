// Isolated acceptance. Core, vault, IPC and renderer are real; OS dialogs/browser launch use owned fixtures.
const { app, dialog, shell } = require("electron"),
  { bootstrap } = require("../src/main.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs"),
  { mcpServer } = require("./fixtures/mcp-agent-server.cjs"),
  { oauthServer } = require("./fixtures/oauth-server.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { once } = require("node:events");
const profile = process.argv[2],
  nodeExecutable = process.argv[3],
  report = {
    checks: [],
    passed: false,
    osBrowser:
      "owned opener fixture; real default-browser and third-party acceptance remain #48",
  };
let runtime,
  model,
  server,
  legacy,
  oauth,
  browserCalls = 0,
  confirmHost = false;
dialog.showMessageBox = async (_win, options) => ({
  response: options.title === "启用 Windows MCP 服务" && !confirmHost ? 0 : 1,
});
shell.openExternal = async (url) => {
  const u = new URL(url);
  assert.equal(u.origin, oauth.base);
  assert.equal(u.pathname, "/authorize");
  browserCalls++;
  await fetch(url);
};
async function until(fn) {
  const end = Date.now() + 18000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(40);
  }
  throw Error("MCP management UI condition timed out");
}
async function run() {
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  model = await agentServer({
    plan: ({ body }) => {
      const messages = body.messages ?? body.input;
      if (
        messages.some(
          (m) =>
            m.role === "tool" ||
            m.type === "function_call_output" ||
            (Array.isArray(m.content) &&
              m.content.some((b) => b.type === "tool_result")),
        )
      )
        return [];
      return (body.tools ?? [])
        .map((t) => t.function ?? t)
        .filter((t) => t.name.startsWith("mcp_"))
        .slice(0, 1)
        .map((t) => ({
          name: t.name,
          arguments: { text: "owned-management-ui" },
        }));
    },
  });
  server = await mcpServer({
    result: {
      content: [
        { type: "text", text: "Owned archived UI result ".repeat(900) },
      ],
    },
  });
  legacy = await mcpServer({ legacy: true });
  oauth = await oauthServer({ mcp: true });
  runtime = await bootstrap({ userData: profile, show: false });
  const { core, window: win } = runtime;
  win.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  report.corePid = core.snapshot().pid;
  await core.request("memory.agent.save", {
    id: 1,
    name: "Owned managed Agent",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const wid = (await core.request("workspace.add", { path: workspace }))
      .items[0].id,
    providers = {};
  for (const protocol of ["chat_completions", "responses", "anthropic"])
    providers[protocol] = (
      await core.request("provider.save", {
        config: {
          name: `Owned ${protocol}`,
          protocol,
          base_url: model.origin,
          model: "owned-ui",
          max_output_tokens: 1024,
          idle_timeout_secs: 5,
        },
      })
    ).id;
  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code, true);
    } catch (e) {
      throw Error(`${e.message}\nOwned UI script: ${code.slice(0, 500)}`);
    }
  };
  const click = async (selector) => {
    await until(() =>
      js(
        `Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
      ),
    );
    return js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const text = () => js("document.body.textContent");
  const field = async (id, value, type = "HTMLInputElement") => {
    await until(() =>
      js(
        `Boolean(document.getElementById(${JSON.stringify(id)})) && !document.getElementById(${JSON.stringify(id)}).disabled`,
      ),
    );
    await js(
      `(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e)throw Error('Missing field '+${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(50);
  };
  const nav = async (label) => {
    await js(
      `[...document.querySelectorAll('nav button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`,
    );
    await sleep(120);
  };
  const tab = async (label) => {
    await until(() =>
      js("Boolean(document.querySelector('.mcp-tabs button:not(:disabled)'))"),
    );
    await js(
      `[...document.querySelectorAll('.mcp-tabs button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`,
    );
    await sleep(80);
  };
  const reload = async () => {
    const loaded = once(win.webContents, "did-finish-load");
    win.webContents.reload();
    await loaded;
    await until(() => js("Boolean(document.querySelector('nav'))"));
  };
  const save = async () => {
    await click("#mcp-save");
    await until(
      async () => !(await js("document.querySelector('#mcp-save')?.disabled")),
    );
    await until(async () => (await text()).includes("已保存。"));
    await until(() => js("!document.querySelector('#mcp-save')?.disabled"));
  };
  const newRemote = async (name, url) => {
    await nav("MCP");
    await until(() => js("Boolean(document.querySelector('#mcp-new'))"));
    await click("#mcp-new");
    await field("mcp-name", name);
    await field("mcp-url", url);
    await click("input[data-agent-id='1']");
    await click("#mcp-enabled");
  };
  const start = async (protocol, goal) => {
    await nav("任务");
    await until(() => js("Boolean(document.querySelector('#agent-new'))"));
    await click("#agent-new");
    await field("agent-provider", providers[protocol], "HTMLSelectElement");
    await field("agent-workspace", wid, "HTMLSelectElement");
    await field("agent-goal", goal, "HTMLTextAreaElement");
    await click("#agent-start");
    await until(() => js("Boolean(document.querySelector('#agent-approve'))"));
    const p = await core.request("agent.list", {});
    const id = p.items[0].id;
    await click("#agent-approve");
    return id;
  };
  const done = async (id, state = "completed") =>
    until(async () => {
      const s = await core.request("agent.get", { id });
      return s.run.state === state && s;
    });
  const selectService = async (name) => {
    await nav("MCP");
    await until(() =>
      js(
        `[...document.querySelectorAll('.mcp-library button')].some(b=>b.textContent.includes(${JSON.stringify(name)}))`,
      ),
    );
    await js(
      `[...document.querySelectorAll('.mcp-library button')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`,
    );
    await until(() => js("Boolean(document.querySelector('#mcp-config'))"));
  };
  const runView = async (id) => {
    await tab("任务连接");
    await field("mcp-run-select", id, "HTMLSelectElement");
    await until(() =>
      js("Boolean(document.querySelector('.mcp-run .mcp-session-list'))"),
    );
  };
  await reload();
  await newRemote("Owned HTTP service", server.url);
  await save();
  const service = (await core.request("mcp.list", {})).items[0];
  assert.equal(service.config.enabled, true);
  assert.deepEqual(service.config.agent_ids, [1]);
  assert.equal(server.calls.length, 0);
  report.checks.push(
    "real service form saves assignment and enabled revision without connecting early",
  );
  let id = await start("chat_completions", "Owned HTTP UI task");
  await done(id);
  assert.equal(server.calls.filter((c) => c.method === "tools/call").length, 1);
  await selectService("Owned HTTP service");
  await runView(id);
  const firstCall = (await core.request("agent.get", { id })).invocations[0].id;
  await field("mcp-call-select", firstCall, "HTMLSelectElement");
  await until(() =>
    js(
      "[...document.querySelectorAll('.mcp-call-detail button')].some(b=>b.textContent.includes('application/json'))",
    ),
  );
  await js(
    "[...document.querySelectorAll('.mcp-call-detail button')].find(b=>b.textContent.includes('application/json')).click()",
  );
  await until(() =>
    js("Boolean(document.querySelector('[aria-label=\"MCP 附件\"]'))"),
  );
  assert.ok(
    await js(
      "document.querySelector('[aria-label=\"MCP 附件\"] pre').textContent.includes('Owned archived UI result')",
    ),
  );
  assert.ok(
    await js(
      "new TextEncoder().encode(document.querySelector('[aria-label=\"MCP 附件\"] pre').textContent).length<=4000",
    ),
  );
  await js(
    "[...document.querySelectorAll('[aria-label=\"MCP 附件\"] button')].find(b=>b.textContent==='下一页附件').click()",
  );
  report.checks.push(
    "owned archived MCP result is viewed through bounded artifact pages in the real UI",
  );
  await js(
    "[...document.querySelectorAll('.mcp-run button')].find(b=>b.textContent==='读取本任务工具目录').click()",
  );
  await sleep(180);
  await tab("配置");
  await js(
    "[...document.querySelectorAll('#mcp-config summary')].find(s=>s.textContent==='工具开关').click()",
  );
  assert.ok((await text()).includes("echo"));
  await field("mcp-disabled-tools", "echo", "HTMLTextAreaElement");
  await save();
  assert.deepEqual(
    (await core.request("mcp.get", { id: service.id })).config.disabled_tools,
    ["echo"],
  );
  await field("mcp-disabled-tools", "", "HTMLTextAreaElement");
  await save();
  report.checks.push(
    "real task discovery, call approval, directory and tool disable controls persist exact revisions",
  );
  await field("mcp-transport", "sse", "HTMLSelectElement");
  await field("mcp-url", legacy.url);
  await field("mcp-name", "Owned legacy service");
  await save();
  id = await start("responses", "Owned legacy SSE UI task");
  await done(id);
  assert.equal(legacy.calls.filter((c) => c.method === "tools/call").length, 1);
  await selectService("Owned legacy service");
  await field("mcp-transport", "stdio", "HTMLSelectElement");
  await field("mcp-name", "Owned local service");
  await field("mcp-command", nodeExecutable);
  await field("mcp-cwd", workspace);
  await field(
    "mcp-args",
    JSON.stringify([
      path.join(__dirname, "fixtures/mcp-stdio.cjs"),
      "stateful",
      workspace,
    ]),
    "HTMLTextAreaElement",
  );
  await click("#mcp-save");
  await until(async () => (await text()).includes("已取消保存"));
  assert.equal(
    (await core.request("mcp.get", { id: service.id })).config.transport,
    "sse",
  );
  confirmHost = true;
  await save();
  id = await start("anthropic", "Owned stdio UI task");
  await done(id);
  report.checks.push(
    "three model protocols and HTTP/legacy SSE/stdio work through real task UI; host enable cancel has no save effect",
  );
  await selectService("Owned local service");
  await tab("配置");
  await click("#mcp-enabled");
  await save();
  await newRemote("Owned OAuth service", oauth.resource);
  await field("mcp-auth-mode", "oauth", "HTMLSelectElement");
  await save();
  const authService = (await core.request("mcp.list", {})).items.find(
    (s) => s.config.name === "Owned OAuth service",
  );
  await tab("认证");
  await field("mcp-client-id", "owned-client");
  await field("mcp-scopes", "files.read");
  await click("#mcp-auth-begin");
  await until(() => js("Boolean(document.querySelector('#mcp-auth-open'))"));
  const old = await core.request("mcp.oauth.status", { id: authService.id });
  await click("#mcp-auth-cancel");
  await until(() => js("!document.querySelector('#mcp-auth-open')"));
  assert.equal(
    (
      await js(
        `window.troop.mcpAuthOpen({id:${JSON.stringify(authService.id)},auth_revision:${old.revision}})`,
      )
    ).ok,
    false,
  );
  assert.equal(browserCalls, 0);
  await click("#mcp-auth-begin");
  await until(() => js("Boolean(document.querySelector('#mcp-auth-open'))"));
  await click("#mcp-auth-open");
  await until(async () => (await text()).includes("已授权"));
  assert.equal(browserCalls, 1);
  id = await start("anthropic", "Owned OAuth tool UI task");
  await done(id);
  await selectService("Owned OAuth service");
  await tab("认证");
  await until(() => js("Boolean(document.querySelector('#mcp-auth-refresh'))"));
  await click("#mcp-auth-refresh");
  await until(
    async () => oauth.calls.filter((c) => c.path === "/token").length === 2,
  );
  await until(
    async () =>
      (await core.request("mcp.oauth.status", { id: authService.id })).state ===
      "connected",
  );
  await until(() =>
    js("document.querySelector('#mcp-auth-status')?.textContent==='已授权'"),
  );
  await click("#mcp-auth-disconnect");
  await until(() =>
    js("document.querySelector('#mcp-auth-status')?.textContent==='已撤销'"),
  );
  report.checks.push(
    "real PKCE callback, canceled link rejection, controlled opener, authenticated tool, refresh and revoke flow through fixed IPC",
  );
  await tab("配置");
  await click("#mcp-enabled");
  await save();
  server.state.hang = true;
  await newRemote("Owned uncertain service", server.url);
  await field("mcp-timeout", 1);
  await save();
  id = await start("chat_completions", "Owned unknown HTTP task");
  const interrupted = await done(id, "interrupted");
  await selectService("Owned uncertain service");
  await runView(id);
  await field(
    "mcp-call-select",
    interrupted.invocations[0].id,
    "HTMLSelectElement",
  );
  await until(() => js("Boolean(document.querySelector('#mcp-review-note'))"));
  await field(
    "mcp-review-note",
    "Owned fixture effects inspected and stopped",
    "HTMLTextAreaElement",
  );
  await click(".mcp-call-detail input[type=checkbox]");
  await click("#mcp-call-review");
  await until(
    async () =>
      (
        await core.request("agent.invocation", {
          id: interrupted.invocations[0].id,
        })
      ).reviewed === true,
  );
  assert.equal(server.calls.filter((c) => c.method === "tools/call").length, 2);
  await js(
    "[...document.querySelectorAll('.mcp-content button')].find(b=>b.textContent==='前往任务审批与继续').click()",
  );
  await until(() =>
    js("Boolean(document.querySelector('#agent-resume:not(:disabled)'))"),
  );
  await click("#agent-resume");
  await done(id);
  assert.equal(server.calls.filter((c) => c.method === "tools/call").length, 2);
  report.checks.push(
    "unknown HTTP invocation is reviewed via UI and manual resume does not replay the request",
  );
  await selectService("Owned uncertain service");
  await click("#mcp-enabled");
  await save();
  await click("#mcp-new");
  await field("mcp-name", "Owned crash service");
  await field("mcp-transport", "stdio", "HTMLSelectElement");
  await field("mcp-command", nodeExecutable);
  await field("mcp-cwd", workspace);
  await field(
    "mcp-args",
    JSON.stringify([
      path.join(__dirname, "fixtures/mcp-stdio.cjs"),
      "tree",
      workspace,
    ]),
    "HTMLTextAreaElement",
  );
  await click("input[data-agent-id='1']");
  await click("#mcp-enabled");
  await save();
  id = await start("anthropic", "Owned crash reconciliation task");
  await until(() => fs.existsSync(path.join(workspace, "heartbeat")));
  await until(async () =>
    (await core.request("agent.get", { id })).invocations.some(
      (i) => i.state === "running",
    ),
  );
  const closed = once(core.child, "close");
  core.child.kill();
  await closed;
  await core.start();
  await reload();
  await selectService("Owned crash service");
  await runView(id);
  const crash = await core.request("agent.get", { id });
  await field("mcp-call-select", crash.invocations[0].id, "HTMLSelectElement");
  await until(() => js("Boolean(document.querySelector('#mcp-review-note'))"));
  await field(
    "mcp-review-note",
    "Owned descendants and effects inspected stopped",
    "HTMLTextAreaElement",
  );
  await click(".mcp-call-detail input[type=checkbox]");
  await click("#mcp-call-review");
  await until(
    async () =>
      (await core.request("agent.invocation", { id: crash.invocations[0].id }))
        .reviewed === true,
  );
  await js(
    "(()=>{const f=document.querySelector('.mcp-session-list form');const e=f.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Owned process tree inspected stopped');e.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await click(".mcp-session-list input[type=checkbox]");
  await click(".mcp-session-review");
  await until(async () =>
    (await core.request("agent.mcp-sessions", { run_id: id })).items.every(
      (s) => s.reviewed,
    ),
  );
  report.checks.push(
    "Core crash produces a distinct stdio session review and invocation review, both operable in the actual UI",
  );
  await tab("配置");
  await click("#mcp-enabled");
  await save();
  await js(
    "[...document.querySelectorAll('.mcp-page header button')].find(b=>b.textContent==='导入配置').click()",
  );
  await field(
    "mcp-import-json",
    JSON.stringify({
      mcpServers: {
        "Owned imported Linux": {
          command: "/usr/bin/node",
          args: ["/tmp/server.js"],
          env: { OWNED_KEY: "owned-fake-secret" },
        },
      },
    }),
    "HTMLTextAreaElement",
  );
  await js(
    "(()=>{const e=[...document.querySelectorAll('.mcp-content select')][0];Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'legacy-linux');e.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await click("#mcp-import-preview");
  await until(() => js("Boolean(document.querySelector('.mcp-preview'))"));
  assert.ok(
    !(await js("document.querySelector('.mcp-preview').textContent")).includes(
      "owned-fake-secret",
    ),
  );
  await click(".mcp-import-apply");
  await until(async () => (await text()).includes("已保存。"));
  const imported = (await core.request("mcp.list", {})).items.find(
    (s) => s.config.name === "Owned imported Linux",
  );
  assert.equal(imported.config.enabled, false);
  assert.deepEqual(imported.config.agent_ids, []);
  report.checks.push(
    "redacted import preview and explicit legacy import preserve disabled state and no Agent assignment",
  );
  const layouts = [];
  win.showInactive();
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(200);
    await js("scrollTo(0,0)");
    layouts.push(
      await js(
        "({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,title:document.querySelector('.mcp-page h1')?.textContent,font:document.fonts.check('14px Plex')})",
      ),
    );
    fs.writeFileSync(
      path.join(profile, `mcp-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  win.hide();
  assert.ok(layouts.every((l) => !l.overflow && l.font));
  report.layouts = layouts;
  report.checks.push(
    "MCP management has loaded brand font and no horizontal overflow at supported 1440/768/660 widths",
  );
  const snapshot = await js(
    `(()=>{const root=document.documentElement.cloneNode(true);const live=[...document.querySelectorAll('input,select,textarea')],copy=[...root.querySelectorAll('input,select,textarea')];live.forEach((el,i)=>{const c=copy[i];if(el.tagName==='SELECT')[...c.options].forEach((o,n)=>o.toggleAttribute('selected',n===el.selectedIndex));else if(el.tagName==='TEXTAREA')c.textContent=el.value;else{c.setAttribute('value',el.type==='password'?'':el.value);c.toggleAttribute('checked',el.checked);}});return root.outerHTML;})()`,
  );
  fs.writeFileSync(
    path.join(profile, "mcp-screen.html"),
    snapshot.replace(/<script[\s\S]*?<\/script>/g, ""),
  );
  fs.copyFileSync(
    path.resolve(__dirname, "../dist/renderer.css"),
    path.join(profile, "renderer.css"),
  );
  fs.cpSync(
    path.resolve(__dirname, "../dist/assets"),
    path.join(profile, "assets"),
    { recursive: true },
  );
  await js(
    "[...document.querySelectorAll('#mcp-config summary')].find(s=>s.textContent==='来源、修订与删除').click()",
  );
  await click("#mcp-remove");
  await until(
    async () =>
      !(await core.request("mcp.list", {})).items.some(
        (s) => s.id === imported.id,
      ),
  );
  const removed = await core.request("mcp.get", { id: imported.id });
  assert.equal(removed.deleted, true);
  assert.deepEqual(removed.secret_keys, []);
  report.checks.push(
    "named deletion confirmation removes the service and saved credential keys while history remains",
  );
  report.passed = true;
}
run()
  .catch(async (e) => {
    report.error = e.stack;
    if (runtime?.window && !runtime.window.isDestroyed())
      report.ownedScreen = await runtime.window.webContents
        .executeJavaScript("document.body.innerText")
        .catch(() => "");
  })
  .finally(async () => {
    try {
      await runtime?.core.stop();
      report.coreStopped = !runtime?.core.child;
      await model?.close();
      await server?.close();
      await legacy?.close();
      await oauth?.close();
    } catch (e) {
      report.cleanup = e.message;
    }
    fs.writeFileSync(
      path.join(profile, "mcp-management-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
