const { app } = require("electron"),
  { bootstrap } = require("../src/main.cjs"),
  { agentServer } = require("./fixtures/agent-server.cjs"),
  { until, sleep } = require("./fixtures/hooks-fixture.cjs"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const profile = process.argv[2],
  report = { passed: false, checks: [] };
let runtime, server;
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
  const dir = path.join(profile, "workspace");
  fs.mkdirSync(dir);
  const wid = (await core.request("workspace.add", { path: dir })).items[0].id;
  server = await agentServer({ plan: () => [], reply: "核对工作结论" });
  const provider = await core.request("provider.save", {
    config: {
      name: "F1 mock",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned",
      max_output_tokens: 2048,
      idle_timeout_secs: 5,
    },
  });
  const a = (await core.request("memory.agents", {}))[0];
  await core.request("memory.agent.save", {
    id: 1,
    name: "F1 Agent",
    automatic: false,
    dreaming: false,
    expected_revision: a.revision,
  });
  const create = (deps) =>
      command("work_items.save", {
        expected_revision: 0,
        item: {
          title: "F1 工作",
          goal: "核对资料",
          acceptance: "提供结论",
          owner_agent_id: 1,
          workspace_id: wid,
          dependency_ids: deps,
        },
      }),
    source = await create([]),
    target = await create([source.id]),
    grant = await command("authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "F1 grant",
        purpose: "tool_call",
        agent_id: 1,
        engine_id: "native",
        workspace_id: wid,
        project_ids: [],
        read_roots: [dir],
        write_roots: [dir],
        operations: ["read_file"],
        network: "none",
        expires_at: Math.floor(Date.now() / 1000) + 600,
      },
    });
  w.webContents.reload();
  const js = (code) => w.webContents.executeJavaScript(code, true);
  await until(() =>
    js(
      "[...document.querySelectorAll('nav button')].some(b=>b.textContent.trim()==='规则')",
    ),
  );
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()==='规则').click()",
  );
  await until(() => js("Boolean(document.querySelector('#rule-definition'))"));
  const rule = {
    name: "接纳后推进",
    enabled: true,
    event: "work.accepted",
    workspace_id: wid,
    source_run_id: null,
    source_work_item_id: source.id,
    work_item_id: target.id,
    expires_at: grant.expires_at,
    start: {
      client_run_id: crypto.randomUUID(),
      agent_id: 1,
      workspace_id: wid,
      project_ids: [],
      provider_id: provider.id,
      authorization_id: grant.id,
      goal: "推进后续工作",
    },
  };
  await js(
    `(()=>{const e=document.querySelector('#rule-definition');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(JSON.stringify(rule))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await sleep(60);
  await js(
    "document.querySelector('#rule-save').click();document.querySelector('#rule-save').click()",
  );
  await until(
    async () => (await core.request("rules.list", {})).items.length === 1,
  );
  const run = await command("work_items.start", {
    id: source.id,
    expected_revision: source.revision,
    execution: { kind: "agent", provider_id: provider.id },
  });
  await until(
    async () =>
      (await core.request("agent.get", { id: run.current_run_id })).run
        .state === "completed",
  );
  assert.equal((await core.request("agent.list", {})).items.length, 1);
  const item = await core.request("work_items.get", { id: source.id }),
    result = (await core.request("work_items.runs", { id: source.id }))
      .items[0];
  await command("work_items.accept", {
    id: source.id,
    expected_revision: item.revision,
    run_id: result.run.id,
    expected_run_revision: result.run.revision,
    evidence_sha256: result.evidence_sha256,
    note: "固定结论接纳",
  });
  await until(() =>
    js(
      "document.querySelector('#work-item-progress')?.innerText.includes('待验收')",
    ),
  );
  await js(
    "(()=>{const e=document.querySelector('#work-acceptance-note');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'后续工作结论已核对');e.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await until(() =>
    js("Boolean(document.querySelector('.work-result-accept:not(:disabled)'))"),
  );
  await js("document.querySelector('.work-result-accept').click()");
  await until(
    async () =>
      (await core.request("work_items.get", { id: target.id })).progress
        .state === "completed",
  );
  for (const width of [1440, 768, 660]) {
    w.setSize(width, 900);
    await sleep(120);
    assert.equal(
      await js("document.documentElement.scrollWidth<=window.innerWidth"),
      true,
    );
    fs.writeFileSync(
      path.join(profile, `work-events-${width}.png`),
      (await w.webContents.capturePage()).toPNG(),
    );
  }
  report.checks.push(
    "UI duplicate rule save, acceptance-gated dispatch, linked work fixed-result acceptance, and three widths passed",
  );
  report.passed = true;
}
main()
  .catch((e) => {
    report.error = e.stack;
  })
  .finally(async () => {
    await runtime?.core.stop();
    await server?.close();
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "work-events-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
