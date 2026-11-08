const { app, BrowserWindow } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime;
let modelServer;
const js = (window, code) => window.webContents.executeJavaScript(code, true);
async function field(window, id, value, type = "HTMLInputElement") {
  await js(
    window,
    `(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await sleep(55);
}
async function openBoard(window) {
  await until(() =>
    js(
      window,
      "[...document.querySelectorAll('nav button')].some(b=>b.textContent==='工作看板'&&!b.disabled)",
    ),
  );
  await js(
    window,
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='工作看板').click()",
  );
  await until(() =>
    js(window, "Boolean(document.querySelector('#work-item-title'))"),
  );
}
async function selectItem(window, title) {
  await until(() =>
    js(
      window,
      `[...document.querySelectorAll('[aria-label=工作项列表] button')].some(b=>b.textContent.includes(${JSON.stringify(title)}))`,
    ),
  );
  await js(
    window,
    `[...document.querySelectorAll('[aria-label=工作项列表] button')].find(b=>b.textContent.includes(${JSON.stringify(title)})).click()`,
  );
  await until(() =>
    js(
      window,
      "Boolean(document.querySelector('#work-item-refresh:not(:disabled)'))",
    ),
  );
}
async function main() {
  runtime = await bootstrap({ userData: profile, show: false });
  const first = runtime.window,
    core = runtime.core;
  first.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const workspaceId = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
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
  const agent = await command("memory.agent.save", {
    name: "发布检查 Agent",
    automatic: false,
    dreaming: false,
    expected_revision: 0,
  });
  let provider;
  if (process.argv.includes("--execution")) {
    modelServer = await require("./fixtures/agent-server.cjs").agentServer({
      plan: () => [],
      reply: "固定发布检查结果已完成",
    });
    provider = await core.request("provider.save", {
      config: {
        name: "W2 local acceptance",
        protocol: "anthropic",
        base_url: modelServer.origin,
        model: "owned-work-model",
        max_output_tokens: 1024,
        idle_timeout_secs: 5,
      },
    });
  }
  await command("memory.membership", {
    agent_id: agent.id,
    project: "release-project",
    action: "create",
  });
  first.webContents.reload();
  await openBoard(first);
  await until(() =>
    js(
      first,
      `[...document.querySelector('#work-item-workspace').options].some(option=>option.value==='${workspaceId}')`,
    ),
  );
  await field(first, "work-item-workspace", workspaceId, "HTMLSelectElement");
  await field(first, "work-item-title", "发布检查");
  await field(
    first,
    "work-item-goal",
    "核对项目发布步骤",
    "HTMLTextAreaElement",
  );
  await field(
    first,
    "work-item-acceptance",
    "提交检查报告和来源",
    "HTMLTextAreaElement",
  );
  await field(first, "work-item-owner", agent.id, "HTMLSelectElement");
  await until(() =>
    js(
      first,
      "[...document.querySelector('#work-item-project').options].some(o=>o.value==='release-project')",
    ),
  );
  await field(
    first,
    "work-item-project",
    "release-project",
    "HTMLSelectElement",
  );
  first.webContents.reload();
  await openBoard(first);
  assert.equal(
    await js(first, "document.querySelector('#work-item-title').value"),
    "发布检查",
  );
  assert.equal(
    await js(first, "document.querySelector('#work-item-save').disabled"),
    false,
  );
  assert.equal(
    await js(
      first,
      "document.querySelector('[aria-label=工作项详情] form').checkValidity()",
    ),
    true,
  );
  await js(
    first,
    "document.querySelector('#work-item-save').click();document.querySelector('#work-item-save').click()",
  );
  await until(
    async () => (await core.request("work_items.list", {})).items.length === 1,
  );
  let item = (await core.request("work_items.list", {})).items[0];
  assert.equal(item.owner_agent_id, agent.id);
  assert.equal(item.project_id, "release-project");
  await until(() =>
    js(
      first,
      "Boolean(document.querySelector('#work-item-archive:not(:disabled)'))",
    ),
  );
  report.checks.push(
    "typed work item form preserves its draft across reload, assigns the selected project Agent and duplicate saves create one record",
  );
  await js(first, "document.querySelector('#desktop-new-window').click()");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find((window) => window !== first),
  );
  second.webContents.setBackgroundThrottling(false);
  await openBoard(second);
  await selectItem(second, "发布检查");
  await field(
    second,
    "work-item-goal",
    "保留第二窗口草稿",
    "HTMLTextAreaElement",
  );
  await field(first, "work-item-title", "发布检查已更新");
  await js(first, "document.querySelector('#work-item-save').click()");
  await until(() =>
    js(
      second,
      "document.querySelector('[aria-label=工作项列表]')?.textContent.includes('发布检查已更新')",
    ),
  );
  assert.equal(
    await js(second, "document.querySelector('#work-item-goal').value"),
    "保留第二窗口草稿",
  );
  await until(() =>
    js(second, "document.querySelector('#work-item-save').disabled"),
  );
  assert.equal(
    (await core.request("work_items.get", { id: item.id })).goal,
    "核对项目发布步骤",
  );
  await js(second, "document.querySelector('#work-item-refresh').click()");
  await until(() =>
    js(
      second,
      "document.querySelector('#work-item-goal').value==='核对项目发布步骤'",
    ),
  );
  report.checks.push(
    "two registered windows observe the same work item revision while preserving and fencing a stale local draft",
  );
  await until(() =>
    js(
      first,
      "Boolean(document.querySelector('#work-item-archive:not(:disabled)'))",
    ),
  );
  await js(first, "document.querySelector('#work-item-archive').click()");
  await until(
    async () => (await core.request("work_items.list", {})).items.length === 0,
  );
  await until(() =>
    js(
      second,
      "document.querySelector('#work-item-archive')?.textContent==='恢复工作项'",
    ),
  );
  await js(second, "document.querySelector('#work-item-refresh').click()");
  await until(() =>
    js(
      second,
      "Boolean(document.querySelector('#work-item-archive:not(:disabled)'))",
    ),
  );
  await js(second, "document.querySelector('#work-item-archive').click()");
  await until(
    async () => (await core.request("work_items.list", {})).items.length === 1,
  );
  await field(first, "work-filter-owner", agent.id, "HTMLSelectElement");
  await field(
    first,
    "work-filter-project",
    "release-project",
    "HTMLSelectElement",
  );
  await until(() =>
    js(
      first,
      "document.querySelector('[aria-label=工作项列表]')?.textContent.includes('发布检查已更新')",
    ),
  );
  item = await core.request("work_items.get", { id: item.id });
  assert.equal(
    await js(
      first,
      "document.querySelector('#work-item-workspace-path').textContent",
    ),
    (await core.request("workspace.list", {})).items.find(
      (entry) => entry.id === item.workspace_id,
    ).path,
  );
  assert.equal(item.revision, 4);
  assert.equal(item.archived, false);
  report.checks.push(
    "archive and restore preserve one identity and project/Agent filters query the same persisted record",
  );
  for (const width of [1440, 768, 660]) {
    first.setContentSize(width, 900);
    await sleep(100);
    assert.equal(
      await js(first, "document.documentElement.scrollWidth>innerWidth"),
      false,
    );
    assert.equal(
      await js(
        first,
        `(() => {
        const list = document.querySelector('.work-item-list').getBoundingClientRect();
        const button = document.querySelector('.work-item-list button').getBoundingClientRect();
        return button.bottom <= list.bottom && button.height > 80;
      })()`,
      ),
      true,
    );
    fs.writeFileSync(
      path.join(profile, `work-items-${width}.png`),
      (await first.webContents.capturePage()).toPNG(),
    );
  }
  first.webContents.reload();
  await openBoard(first);
  await selectItem(first, "发布检查已更新");
  assert.equal(
    await js(first, "document.querySelector('#work-item-acceptance').value"),
    "提交检查报告和来源",
  );
  if (provider) {
    await until(() =>
      js(
        first,
        "Boolean(document.querySelector('#work-item-start:not(:disabled)'))",
      ),
    );
    await field(
      first,
      "work-execution-provider",
      provider.id,
      "HTMLSelectElement",
    );
    await js(
      first,
      "document.querySelector('#work-item-start').click();document.querySelector('#work-item-start').click()",
    );
    await until(
      async () =>
        (await core.request("work_items.get", { id: item.id })).progress
          .state === "awaiting_acceptance",
    );
    assert.equal((await core.request("agent.list", {})).items.length, 1);
    await until(() =>
      js(
        first,
        "document.querySelector('#work-item-progress').textContent==='待验收'",
      ),
    );
    await until(() =>
      js(
        second,
        "document.querySelector('#work-item-progress').textContent==='待验收'",
      ),
    );
    await field(
      first,
      "work-acceptance-note",
      "已核对固定发布检查结果",
      "HTMLTextAreaElement",
    );
    await until(() =>
      js(
        first,
        "Boolean(document.querySelector('.work-result-accept:not(:disabled)'))",
      ),
    );
    await js(
      first,
      "document.querySelector('.work-result-accept').click();document.querySelector('.work-result-accept').click()",
    );
    await until(() =>
      js(
        first,
        "document.querySelector('#work-item-progress').textContent==='已完成'",
      ),
    );
    await until(() =>
      js(
        second,
        "document.querySelector('#work-item-progress').textContent==='已完成'",
      ),
    );
    assert.equal(
      (await core.request("work_items.runs", { id: item.id })).items.length,
      1,
    );
    await js(first, "document.querySelector('#work-item-open-run').click()");
    await until(() =>
      js(first, "Boolean(document.querySelector('.agent-status'))"),
    );
    await openBoard(first);
    await selectItem(first, "发布检查已更新");
    for (const width of [1440, 768, 660]) {
      first.setContentSize(width, 900);
      await sleep(100);
      await js(
        first,
        "document.querySelector('.work-execution').scrollIntoView()",
      );
      assert.equal(
        await js(first, "document.documentElement.scrollWidth>innerWidth"),
        false,
      );
      fs.writeFileSync(
        path.join(profile, `work-execution-${width}.png`),
        (await first.webContents.capturePage()).toPNG(),
      );
    }
    first.webContents.reload();
    await openBoard(first);
    await selectItem(first, "发布检查已更新");
    await until(() =>
      js(
        first,
        "document.querySelector('#work-item-progress').textContent==='已完成'",
      ),
    );
    report.checks.push(
      "real Core model boundary, duplicate Run start and acceptance, two-window progress, Run navigation, reload and three-width execution history",
    );
  }
  report.passed = true;
}
main()
  .catch((error) => {
    report.error = error.stack;
  })
  .finally(async () => {
    await runtime?.core.stop();
    await modelServer?.close();
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "work-items-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
