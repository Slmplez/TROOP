const { app, BrowserWindow } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { agentServer } = require("./fixtures/agent-server.cjs");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime, server;
const js = (w, code) => w.webContents.executeJavaScript(code, true);
async function field(w, id, value, type = "HTMLInputElement") {
  await js(
    w,
    `(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await sleep(60);
}
const click = (w, selector) =>
  js(w, `document.querySelector(${JSON.stringify(selector)}).click()`);
async function groups(w) {
  await until(() =>
    js(
      w,
      "[...document.querySelectorAll('nav button')].some(b=>b.textContent==='Agent 群聊'&&!b.disabled)",
    ),
  );
  await js(
    w,
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='Agent 群聊').click()",
  );
  await until(() =>
    js(w, "Boolean(document.querySelector('.group-list button'))"),
  );
  await click(w, ".group-list button");
  await until(() =>
    js(w, "Boolean(document.querySelector('.group-execution'))"),
  );
  await js(w, "document.querySelector('.group-execution').open=true");
  await until(() =>
    js(w, "Boolean(document.querySelector('#group-executor-kind'))"),
  );
}
async function main() {
  runtime = await bootstrap({ userData: profile, show: false });
  const core = runtime.core,
    w = runtime.window;
  w.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  const command = async (method, input) => {
    const r = await core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method,
      input,
    });
    assert.equal(r.state, "committed", JSON.stringify(r.error));
    return r.result;
  };
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const initial = (await core.request("memory.agents", {}))[0];
  await core.request("memory.agent.save", {
    id: initial.id,
    name: "Alpha",
    automatic: false,
    dreaming: false,
    expected_revision: initial.revision,
  });
  server = await agentServer({
    plan: () => [],
    reply: JSON.stringify({
      troop_group_reply: {
        body: "已核对群工作并保留来源",
        mention_agent_ids: [],
        broadcast: false,
      },
    }),
  });
  const provider = await core.request("provider.save", {
    config: {
      name: "G2 本地验收模型",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-group-model",
      max_output_tokens: 4096,
      idle_timeout_secs: 5,
    },
  });
  let g = await command("groups.save", {
    expected_revision: 0,
    group: {
      name: "执行协作群",
      rules: "核对证据后显式回复",
      project_id: null,
      paused: false,
    },
  });
  g = await command("groups.member", {
    id: g.id,
    expected_revision: g.revision,
    agent_id: initial.id,
  });
  const common = {
    agent_id: initial.id,
    workspace_id: wid,
    project_ids: [],
    read_roots: [workspace],
    write_roots: [workspace],
    network: "any",
    expires_at: Math.floor(Date.now() / 1000) + 600,
  };
  const native = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      ...common,
      name: "G2 原生群回复",
      purpose: "tool_call",
      engine_id: "native",
      operations: ["read_file", "group_reply"],
    },
  });
  const cli = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      ...common,
      name: "G2 Pi 协议验收",
      purpose: "cli_start",
      engine_id: "pi",
      operations: ["start"],
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/pi_protocol_probe.exe",
      ),
    },
  });
  w.webContents.reload();
  await groups(w);
  await field(w, "group-executor-kind", "cli", "HTMLSelectElement");
  await field(w, "group-executor-engine", "pi", "HTMLSelectElement");
  await field(w, "group-executor-tools", "disabled", "HTMLSelectElement");
  await field(
    w,
    "group-executor-approval",
    "preauthorized",
    "HTMLSelectElement",
  );
  await field(w, "group-executor-grant", cli.id);
  await click(w, "#group-executor-enabled");
  await click(w, "#group-executor-preview");
  await until(() =>
    js(
      w,
      "Boolean(document.querySelector('#group-executor-save:not(:disabled)'))",
    ),
  );
  await field(w, "group-executor-tools", "native", "HTMLSelectElement");
  assert.equal(
    await js(w, "document.querySelector('#group-executor-save').disabled"),
    true,
  );
  await field(w, "group-executor-tools", "disabled", "HTMLSelectElement");
  await click(w, "#group-executor-preview");
  await until(() =>
    js(
      w,
      "Boolean(document.querySelector('#group-executor-save:not(:disabled)'))",
    ),
  );
  await js(
    w,
    "document.querySelector('#group-executor-save').click();document.querySelector('#group-executor-save').click()",
  );
  await until(
    async () =>
      (
        await core.request("groups.executor.get", {
          group_id: g.id,
          agent_id: initial.id,
        })
      ).enabled,
  );
  assert.equal(
    (
      await core.request("groups.executor.get", {
        group_id: g.id,
        agent_id: initial.id,
      })
    ).revision,
    1,
  );
  report.checks.push(
    "Pi configuration enters grant through strict input validation, previews a real permission plan, invalidates changed plans and saves once under repeated clicks",
  );
  await until(() =>
    js(
      w,
      "document.querySelector('.group-execution').textContent.includes('修订 1')",
    ),
  );
  await field(w, "group-executor-kind", "agent", "HTMLSelectElement");
  await field(w, "group-executor-provider", provider.id, "HTMLSelectElement");
  await field(w, "group-executor-grant", native.id);
  await click(w, "#group-executor-preview");
  await until(() =>
    js(
      w,
      "Boolean(document.querySelector('#group-executor-save:not(:disabled)'))",
    ),
  );
  await click(w, "#group-executor-save");
  await until(
    async () =>
      (
        await core.request("groups.executor.get", {
          group_id: g.id,
          agent_id: initial.id,
        })
      ).execution.kind === "agent",
  );
  const work = await command("work_items.save", {
    expected_revision: 0,
    item: {
      title: "群工作验收",
      goal: "核对来源",
      acceptance: "显式回复并保留来源",
      owner_agent_id: initial.id,
      workspace_id: wid,
    },
  });
  await field(w, "group-message-body", "核对这项群工作", "HTMLTextAreaElement");
  await click(w, 'input[aria-label="点名 Alpha"]');
  await field(w, "group-work-item", work.id);
  await click(w, "#group-execute-work");
  w.webContents.reload();
  await groups(w);
  assert.equal(
    await js(w, "document.querySelector('#group-work-item').value"),
    String(work.id),
  );
  assert.equal(
    await js(w, "document.querySelector('#group-execute-work').checked"),
    true,
  );
  await until(() =>
    js(w, "Boolean(document.querySelector('#group-send:not(:disabled)'))"),
  );
  await js(
    w,
    "document.querySelector('#group-send').click();document.querySelector('#group-send').click()",
  );
  const delivery = await until(async () => {
    const d = (await core.request("groups.deliveries", { group_id: g.id }))
      .items[0];
    return d?.run_state === "completed" && d.adopted && d;
  });
  await until(() =>
    js(
      w,
      "[...document.querySelectorAll('.group-message')].some(e=>e.textContent.includes('已核对群工作并保留来源'))",
    ),
  );
  assert.equal((await core.request("agent.list", {})).items.length, 1);
  assert.equal(
    (await core.request("work_items.get", { id: work.id })).progress.state,
    "awaiting_acceptance",
  );
  assert.equal(
    (await core.request("groups.messages", { group_id: g.id })).items.length,
    2,
  );
  await until(() =>
    js(
      w,
      "[...document.querySelectorAll('.group-delivery')].some(e=>e.textContent.includes('已有采纳证据')&&e.textContent.includes('completed'))",
    ),
  );
  report.checks.push(
    "reloaded work-linked message draft creates one native Run, publishes a trusted explicit reply, displays adoption proof and leaves work pending acceptance",
  );
  await js(
    w,
    "[...document.querySelectorAll('.group-delivery button')].find(b=>b.textContent.includes('查看 Run')).click()",
  );
  await until(() =>
    js(
      w,
      `document.body.textContent.includes('核对这项群工作') && !document.querySelector('.group-chat-page')`,
    ),
  );
  await groups(w);
  const before = BrowserWindow.getAllWindows().map((x) => x.id);
  await click(w, "#desktop-new-window");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find((x) => !before.includes(x.id)),
  );
  second.webContents.setBackgroundThrottling(false);
  await groups(second);
  await until(() =>
    js(
      second,
      "[...document.querySelectorAll('.group-message')].some(e=>e.textContent.includes('已核对群工作并保留来源'))",
    ),
  );
  await js(
    w,
    "[...document.querySelectorAll('.group-delivery button')].find(b=>b.textContent==='查看本次协作').click()",
  );
  await until(() =>
    js(
      w,
      "Boolean(document.querySelector('.group-chain button:not(:disabled)'))",
    ),
  );
  await click(w, ".group-chain button");
  await until(() =>
    js(
      w,
      "document.querySelector('.group-chain').textContent.includes('已停止')",
    ),
  );
  const historical = (
    await core.request("groups.deliveries", { group_id: g.id })
  ).items[0];
  assert.equal(historical.state, "adopted");
  assert.equal(historical.reply_state, "published");
  report.checks.push(
    "Run navigation, second-window shared messages and stopping the collaboration chain preserve completed adoption and published history",
  );
  for (const width of [1440, 768, 660]) {
    w.setSize(width, 900);
    await sleep(120);
    await js(w, "document.querySelector('.group-execution').scrollIntoView()");
    assert.equal(
      await js(w, "document.documentElement.scrollWidth>innerWidth"),
      false,
      `overflow ${width}`,
    );
    fs.writeFileSync(
      path.join(profile, `group-execution-${width}.png`),
      (await w.webContents.capturePage()).toPNG(),
    );
  }
  second.close();
  await core.stop();
  await core.start();
  w.webContents.reload();
  await groups(w);
  assert.equal((await core.request("agent.list", {})).items.length, 1);
  const recovered = (
    await core.request("groups.deliveries", { group_id: g.id })
  ).items[0];
  assert.equal(recovered.id, delivery.id);
  assert.equal(recovered.adopted, true);
  report.checks.push(
    "three-width layout and Core restart retain delivery and Run identities without replay",
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
      path.join(profile, "group-execution-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
