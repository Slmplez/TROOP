const { app, BrowserWindow } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const { fillSchemaForm } = require("./fixtures/schema-form-fill.cjs");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const profile = process.argv[2],
  report = { passed: false, checks: [] };
let runtime;
async function main() {
  fs.mkdirSync(path.join(profile, "workspace"), { recursive: true });
  runtime = await bootstrap({ userData: profile, show: false });
  const { core, window } = runtime;
  window.webContents.setBackgroundThrottling(false);
  const js = (code) => window.webContents.executeJavaScript(code, true);
  await until(() => core.state === "ready");
  const workspace = (
    await core.request("workspace.add", {
      path: path.join(profile, "workspace"),
    })
  ).items[0];
  const operation = crypto.randomUUID();
  await core.request("operations.execute", {
    operation_id: operation,
    instance_id: core.snapshot().storage_instance,
    method: "workspace.rename",
    input: { id: workspace.id, name: "Archived UI workspace" },
  });
  async function navigate(execute = js) {
    await until(() =>
      execute(
        "[...document.querySelectorAll('nav button')].some(button=>button.textContent.trim()==='规则')",
      ),
    );
    await execute(
      "[...document.querySelectorAll('nav button')].find(button=>button.textContent.trim()==='规则').click()",
    );
    await until(() =>
      execute("Boolean(document.getElementById('rules-policies-tab'))"),
    );
    await execute("document.getElementById('rules-policies-tab').click()");
    await until(() =>
      execute(
        "document.getElementById('causal-limits.max_depth')?.disabled===false",
      ),
    );
  }
  await navigate();
  const existing = BrowserWindow.getAllWindows().map((window) => window.id);
  await js("document.getElementById('desktop-new-window').click()");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find(
      (window) => !existing.includes(window.id),
    ),
  );
  second.hide();
  second.webContents.setBackgroundThrottling(false);
  const secondJs = (code) => second.webContents.executeJavaScript(code, true);
  await navigate(secondJs);
  await fillSchemaForm(secondJs, "causal-limits", {
    max_depth: 7,
    max_writes_per_hour: 9,
    cooldown_seconds: 0,
  });
  await fillSchemaForm(js, "causal-limits", {
    max_depth: 7,
    max_writes_per_hour: 2,
    cooldown_seconds: 0,
  });
  await js(
    "document.getElementById('causal-limits-save').click();document.getElementById('causal-limits-save').click()",
  );
  await until(
    async () =>
      (await core.request("rules.limits.get", { scope: { kind: "global" } }))
        .revision === 2,
  );
  assert.equal(
    (await core.request("rules.limits.history", { scope: { kind: "global" } }))
      .items.length,
    2,
  );
  report.checks.push(
    "Schema-generated policy controls save one version after a double click and retain immutable configuration history",
  );
  await secondJs("document.getElementById('causal-limits-save').click()");
  await until(() =>
    secondJs(
      "document.querySelector('[role=alert]')?.textContent.includes('修订已变化')",
    ),
  );
  assert.equal(
    await secondJs(
      "document.getElementById('causal-limits.max_writes_per_hour').value",
    ),
    "9",
  );
  assert.equal(
    (await core.request("rules.limits.get", { scope: { kind: "global" } }))
      .revision,
    2,
  );
  report.checks.push(
    "Two actual windows reject a stale policy revision while preserving the losing window's draft",
  );
  second.destroy();
  await fillSchemaForm(js, "archive-settings", {
    enabled: true,
    retention_seconds: 60,
  });
  await js("document.getElementById('archive-settings-save').click()");
  await until(() =>
    js("document.getElementById('archive-run')?.disabled===false"),
  );
  const db = new DatabaseSync(path.join(profile, "core/troop.sqlite3"));
  db.prepare(
    "UPDATE operation_receipt_times SET updated_at=0 WHERE subject='desktop' AND operation_id=?",
  ).run(operation);
  db.close();
  await js("document.getElementById('archive-run').click()");
  await until(
    async () =>
      (
        await core.request("operations.get", {
          instance_id: core.snapshot().storage_instance,
          operation_id: operation,
        })
      ).state === "archived",
  );
  await fillSchemaForm(js, "archive-operation-id", operation);
  await js("document.getElementById('archive-query').click()");
  await until(() =>
    js(
      "document.getElementById('archive-result')?.textContent.includes('Archived UI workspace')",
    ),
  );
  report.checks.push(
    "Actual desktop archives an old terminal receipt and resolves the fixed archive reference to its original result",
  );
  window.webContents.reload();
  await navigate();
  assert.equal(
    await js(
      "document.getElementById('causal-limits.max_writes_per_hour').value",
    ),
    "2",
  );
  assert.equal(
    await js("document.getElementById('archive-settings.enabled').checked"),
    true,
  );
  report.checks.push(
    "Renderer reload keeps saved scope limits and archive configuration",
  );
  report.layouts = [];
  for (const width of [1440, 768, 660]) {
    window.setSize(width, 980);
    await sleep(120);
    const layout = await js(
      "({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,offenders:[...document.querySelectorAll('body *')].filter(node=>node.getBoundingClientRect().right>innerWidth+1).slice(0,6).map(node=>({tag:node.tagName,id:node.id,className:node.className}))})",
    );
    report.layouts.push(layout);
    fs.writeFileSync(
      path.join(profile, `core-policies-${width}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert.equal(layout.overflow, false);
  }
  report.checks.push(
    "Core settings fit 1440, 768 and the supported 660 pixel desktop width",
  );
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.error = error.stack;
    report.page = await runtime?.window.webContents
      .executeJavaScript("document.body.innerText")
      .catch(() => "");
  })
  .finally(async () => {
    await runtime?.core.stop();
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "core-policies-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
