const { app } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { sleep } = require("./fixtures/agent-server.cjs");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime, api;
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(30);
  }
  throw Error("Events UI timeout");
}
async function run() {
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  api = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: 77,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      }),
    );
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  runtime = await bootstrap({ userData: profile, show: false });
  const { core, window: win } = runtime;
  win.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  await core.request("memory.agent.save", {
    id: 1,
    name: "Events fixture",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const command = (method, input) =>
    core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method,
      input,
    });
  const grant = (
    await command("authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "Event output",
        purpose: "tool_call",
        agent_id: 1,
        engine_id: "native",
        workspace_id: wid,
        project_ids: [],
        read_roots: [workspace],
        write_roots: [workspace],
        operations: ["write_file"],
        network: "none",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        rule_id: null,
      },
    })
  ).result;
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const field = async (id, value, type = "HTMLInputElement") => {
    await js(
      `(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(40);
  };
  const nav = async (name) =>
    js(
      `[...document.querySelectorAll('nav button')].find(b=>b.textContent===${JSON.stringify(name)}).click()`,
    );
  win.webContents.reload();
  await until(() => js("document.querySelector('nav')"));
  await nav("事件来源");
  await until(() => js("document.querySelector('#event-source-definition')"));
  const sourceId = await js(
    "document.querySelector('#event-source-id').textContent",
  );
  const secret = crypto.randomBytes(32).toString("hex"),
    token = crypto.randomBytes(32).toString("hex");
  await field(
    "event-source-definition",
    JSON.stringify({
      name: "UI mock GitHub",
      kind: "github",
      project: "owner/repo",
      workspace_id: wid,
      project_ids: [],
      enabled: true,
      mode: "local",
      api_base_url: `http://127.0.0.1:${api.address().port}`,
      consumer_id: core.snapshot().storage_instance,
    }),
    "HTMLTextAreaElement",
  );
  await field("event-webhook-secret", secret);
  await field("event-consumer-token", token);
  const request = core.request.bind(core);
  let lost = false;
  core.request = async (method, input, ...args) => {
    const value = await request(method, input, ...args);
    if (
      method === "operations.execute" &&
      input.method === "events.source.save" &&
      !lost
    ) {
      lost = true;
      throw Error("Fixture lost source acceptance");
    }
    return value;
  };
  await js(
    "document.querySelector('#event-source-save').click();document.querySelector('#event-source-save').click()",
  );
  await until(() => lost);
  assert.equal((await core.request("events.sources", {})).items.length, 1);
  const journal = await js("JSON.stringify(localStorage)");
  assert.ok(!journal.includes(secret) && !journal.includes(token));
  win.webContents.reload();
  await until(() =>
    js(
      "document.querySelector('[aria-label=待确认操作]')?.textContent.includes('命令已接纳')",
    ),
  );
  await js(
    "[...document.querySelectorAll('[aria-label=待确认操作] button')].find(b=>b.textContent==='查看资源当前状态').click()",
  );
  await until(() =>
    js("document.querySelector('[aria-label=事件来源列表] button')"),
  );
  await js(
    "document.querySelector('[aria-label=事件来源列表] button').click()",
  );
  report.checks.push(
    "typed source form preserves one source across duplicate clicks and lost-response reload; journal keeps credentials out of storage",
  );
  await nav("规则");
  await until(() => js("document.querySelector('#rule-definition')"));
  await field(
    "rule-definition",
    JSON.stringify({
      name: "UI failed workflow",
      enabled: true,
      event: "github.workflow.completed",
      source_id: sourceId,
      event_state: "failure",
      source_run_id: null,
      workspace_id: wid,
      expires_at: grant.expires_at,
      start: {
        client_run_id: crypto.randomUUID(),
        workspace_id: wid,
        agent_id: 1,
        authorization_id: grant.id,
        goal: "Webhook file action",
        action: {
          name: "write_file",
          arguments: {
            path: "webhook-result.txt",
            content: "verified event",
            expected_hash: "missing",
          },
        },
      },
    }),
    "HTMLTextAreaElement",
  );
  await js("document.querySelector('#rule-save').click()");
  await until(
    async () => (await core.request("rules.list", {})).items.length === 1,
  );
  const health = await core.request("events.health", {});
  const body = JSON.stringify({
    action: "completed",
    repository: { full_name: "owner/repo" },
    workflow_run: {
      id: 77,
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
    },
  });
  const headers = {
    "x-github-event": "workflow_run",
    "x-github-delivery": "ui-event",
    "x-hub-signature-256":
      "sha256=" +
      crypto.createHmac("sha256", secret).update(body).digest("hex"),
  };
  assert.equal(
    (
      await fetch(health.address + "/webhooks/" + sourceId, {
        method: "POST",
        headers,
        body,
      })
    ).status,
    202,
  );
  await nav("事件来源");
  await until(() =>
    js("document.querySelector('[aria-label=事件来源列表] button')"),
  );
  await js(
    "document.querySelector('[aria-label=事件来源列表] button').click()",
  );
  await until(() =>
    js(
      "[...document.querySelectorAll('.event-record button')].some(b=>b.textContent.includes('查看 Run'))",
    ),
  );
  await js(
    "[...document.querySelectorAll('.event-record button')].find(b=>b.textContent.includes('查看 Run')).click()",
  );
  await until(() =>
    js(
      "document.querySelector('.agent-status strong')?.textContent.includes('已完成')",
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, "webhook-result.txt"), "utf8"),
    "verified event",
  );
  assert.equal((await core.request("agent.list", {})).items[0].step, 0);
  report.checks.push(
    "real HTTP delivery -> mock current-state API -> authorized zero-model Run -> visible source disposition and Run detail",
  );
  await nav("事件来源");
  await until(() =>
    js("document.querySelector('[aria-label=事件来源列表] button')"),
  );
  await js(
    "document.querySelector('[aria-label=事件来源列表] button').click()",
  );
  await js("document.querySelector('#event-source-toggle').click()");
  await until(
    async () =>
      (await core.request("events.sources", {})).items[0].enabled === false,
  );
  assert.equal(
    (
      await fetch(health.address + "/webhooks/" + sourceId, {
        method: "POST",
        headers,
        body,
      })
    ).status,
    403,
  );
  report.layouts = [];
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await win.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    await sleep(100);
    const layout = await js(
      "({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth})",
    );
    report.layouts.push(layout);
    fs.writeFileSync(
      path.join(profile, `events-${width}.png`),
      (
        await win.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      ).toPNG(),
    );
  }
  assert.ok(report.layouts.every((l) => !l.overflow));
  report.passed = true;
}
run()
  .catch((error) => {
    report.error = error.stack;
  })
  .finally(async () => {
    await runtime?.core.stop();
    if (api) await new Promise((r) => api.close(r));
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "events-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
