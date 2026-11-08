const { app, BrowserWindow, dialog } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const profile = process.argv[2];
const report = { checks: [], passed: false };
let runtime;
const js = (window, source) =>
  window.webContents.executeJavaScript(source, true);
async function field(window, value) {
  await js(
    window,
    `(()=>{const input=document.querySelector('#memory-content');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  );
  await sleep(60);
}
async function main() {
  runtime = await bootstrap({ userData: profile, show: false });
  const first = runtime.window;
  const core = runtime.core;
  await until(() => core.state === "ready");
  await until(() =>
    js(first, "Boolean(document.querySelector('#desktop-new-window'))"),
  );
  await js(first, "document.querySelector('#desktop-new-window').click()");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find((window) => window !== first),
  );
  for (const window of [first, second]) {
    window.webContents.setBackgroundThrottling(false);
    await until(() => js(window, "Boolean(document.querySelector('nav'))"));
    await js(
      window,
      "[...document.querySelectorAll('nav button')].find(button=>button.textContent==='记忆').click()",
    );
    await until(() =>
      js(window, "Boolean(document.querySelector('#memory-content'))"),
    );
  }
  await field(first, "Owned multiwindow fact");
  await js(first, "document.querySelector('#memory-save').click()");
  await until(() =>
    js(
      second,
      "document.querySelector('.memory-records')?.textContent.includes('Owned multiwindow fact')",
    ),
  );
  await js(second, "document.querySelector('.memory-records button').click()");
  await field(second, "Stale second-window draft");
  await js(first, "document.querySelector('.memory-records button').click()");
  await field(first, "Updated first-window fact");
  await js(first, "document.querySelector('#memory-save').click()");
  await until(() =>
    js(
      second,
      "document.querySelector('.memory-records')?.textContent.includes('Updated first-window fact')",
    ),
  );
  await js(second, "document.querySelector('#memory-save').click()");
  await until(() =>
    js(second, "Boolean(document.querySelector('.memory-page [role=alert]'))"),
  );
  assert.equal(
    (await core.request("memory.list", { agent_id: 1 })).items[0].content,
    "Updated first-window fact",
  );
  report.checks.push(
    "registered windows share one Core, observe resource changes and reject stale drafts without overwriting current memory",
  );
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(workspace, "input.txt"),
    "Owned maintenance input",
  );
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const agent = (await core.request("memory.agents", {}))[0];
  await core.request("memory.agent.save", {
    id: agent.id,
    name: agent.name,
    automatic: true,
    dreaming: false,
    expected_revision: agent.revision,
  });
  const command = (method, input) =>
    core.request("operations.execute", {
      operation_id: require("node:crypto").randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method,
      input,
    });
  const permission = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Owned maintenance read",
      purpose: "tool_call",
      agent_id: agent.id,
      engine_id: "native",
      workspace_id: wid,
      project_ids: [],
      read_roots: [workspace],
      write_roots: [],
      operations: ["read_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    },
  });
  assert.equal(permission.state, "committed");
  const started = await command("agent.start", {
    client_run_id: require("node:crypto").randomUUID(),
    agent_id: agent.id,
    workspace_id: wid,
    authorization_id: permission.result.id,
    goal: "Read the owned release configuration and remember that release checks run on Sundays.",
    action: { name: "read_file", arguments: { path: "input.txt" } },
  });
  assert.equal(started.state, "committed");
  const job = await until(async () =>
    (await core.request("memory.jobs", { agent_id: agent.id })).find(
      (row) => row.state === "waiting_configuration",
    ),
  );
  for (const window of [first, second]) {
    await until(() =>
      js(window, "Boolean(document.querySelector('.memory-jobs button'))"),
    );
    await js(
      window,
      "[...document.querySelectorAll('.memory-jobs button')].find(button=>button.textContent==='查看提案').click()",
    );
    await until(() =>
      js(
        window,
        "document.querySelector('.memory-job-detail')?.textContent.includes('waiting_configuration')",
      ),
    );
  }
  await js(
    second,
    "[...document.querySelectorAll('.memory-jobs button')].find(button=>button.textContent==='停止维护').click()",
  );
  await until(() =>
    js(
      first,
      "document.querySelector('.memory-job-detail')?.textContent.includes('cancelled')",
    ),
  );
  assert.equal(
    (await core.request("memory.job", { id: job.id })).state,
    "cancelled",
  );
  report.checks.push(
    "a maintenance detail opened in both windows observes cancellation in the other window without reload",
  );
  let dialogParent;
  const original = dialog.showOpenDialog;
  dialog.showOpenDialog = async (parent) => {
    dialogParent = parent;
    return { canceled: true };
  };
  try {
    await js(second, "window.troop.resourceselectWorkspacePath({})");
  } finally {
    dialog.showOpenDialog = original;
  }
  assert.equal(dialogParent, second);
  const intruder = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, "../src/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await intruder.loadURL(first.webContents.getURL());
  await assert.rejects(
    js(intruder, "window.troop.status()"),
    /Untrusted IPC sender/,
  );
  intruder.destroy();
  report.checks.push(
    "dialogs belong to their calling window; an unregistered same-page renderer cannot invoke privileged IPC",
  );
  const generation = core.snapshot().generation;
  await core.stop();
  await core.start();
  assert.notEqual(core.snapshot().generation, generation);
  for (const window of [first, second])
    await until(() =>
      js(
        window,
        "document.querySelector('.connection-label')?.textContent.includes('已连接') || [...document.querySelectorAll('span')].some(span=>span.textContent==='已连接')",
      ),
    );
  const reloaded = require("node:events").once(
    second.webContents,
    "did-finish-load",
  );
  second.webContents.reload();
  await reloaded;
  await until(() => js(second, "Boolean(document.querySelector('nav'))"));
  await js(
    second,
    "[...document.querySelectorAll('nav button')].find(button=>button.textContent==='记忆').click()",
  );
  await until(() =>
    js(
      second,
      "document.querySelector('.memory-records')?.textContent.includes('Updated first-window fact')",
    ),
  );
  second.destroy();
  assert.equal(core.state, "ready");
  report.checks.push(
    "Core restart updates both windows; renderer reload retains current data and closing the secondary window preserves active Core ownership",
  );
  report.passed = true;
}
main()
  .catch((error) => {
    report.error = error.stack;
  })
  .finally(async () => {
    await runtime?.core.stop();
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "multiwindow-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
