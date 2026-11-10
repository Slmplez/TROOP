const { app, BrowserWindow } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { until, sleep } = require("./fixtures/hooks-fixture.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const profile = process.argv[2];
const report = { passed: false, checks: [] };
let runtime;
const js = (window, source) =>
  window.webContents.executeJavaScript(source, true);
async function button(window, text) {
  await until(() =>
    js(
      window,
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length);if(b){b.click();return true;}return false;})()`,
    ),
  );
  await sleep(60);
}
async function field(window, selector, value, type = "HTMLInputElement") {
  await js(
    window,
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing field');Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await sleep(70);
}
async function open(window, filename) {
  await button(window, "文件办公");
  await field(window, '[aria-label="办公文件路径"]', filename);
  await button(window, "打开或新建");
  await until(() =>
    js(
      window,
      `Boolean(document.querySelector('.office-heading')?.textContent.includes(${JSON.stringify(filename)}))`,
    ),
  );
}
async function edit(window, text) {
  await button(window, "开始编辑");
  await until(() =>
    js(
      window,
      "Boolean(document.querySelector('.office-markdown [contenteditable=true]'))",
    ),
  );
  await js(
    window,
    `(()=>{const el=document.querySelector('.office-markdown [contenteditable=true]');el.focus();document.execCommand('selectAll');document.execCommand('insertText',false,${JSON.stringify(text)});})()`,
  );
  await until(() =>
    js(
      window,
      "document.querySelector('.office-detail [role=status]')?.textContent.includes('草稿已保存到 Core')",
    ),
  );
}
async function main() {
  runtime = await bootstrap({ userData: profile, show: false });
  const core = runtime.core,
    w = runtime.window;
  w.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(workspace, "notes.md"),
    "# 项目纪要\n\n原始段落\n",
  );
  fs.writeFileSync(
    path.join(workspace, "table.csv"),
    "编号,名称\r\n001,原始名称\r\n",
  );
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  w.webContents.reload();
  await open(w, "notes.md");
  await edit(w, "第一窗口的保存内容");
  await button(w, "保存文件");
  await until(() =>
    fs
      .readFileSync(path.join(workspace, "notes.md"), "utf8")
      .includes("第一窗口的保存内容"),
  );
  report.checks.push(
    "rendered Markdown edit, durable draft, versioned save and reopen",
  );
  await open(w, "notes.md");
  const existing = BrowserWindow.getAllWindows().map((x) => x.id);
  await js(w, "document.querySelector('#desktop-new-window').click()");
  const second = await until(() =>
    BrowserWindow.getAllWindows().find((x) => !existing.includes(x.id)),
  );
  second.webContents.setBackgroundThrottling(false);
  second.hide();
  await open(second, "notes.md");
  await edit(w, "第一窗口冲突内容");
  await edit(second, "第二窗口保留内容");
  await button(w, "保存文件");
  await until(() =>
    js(
      w,
      "document.querySelector('.office-page [role=alert]')?.textContent.includes('其他窗口')",
    ),
  );
  assert.ok(
    !fs
      .readFileSync(path.join(workspace, "notes.md"), "utf8")
      .includes("冲突内容"),
  );
  await button(w, "查看其他窗口内容");
  await until(() =>
    js(
      w,
      "document.querySelector('.office-page').textContent.includes('第二窗口保留内容')",
    ),
  );
  await button(w, "确认保留其他草稿并提交本窗口内容");
  await until(() =>
    fs
      .readFileSync(path.join(workspace, "notes.md"), "utf8")
      .includes("第一窗口冲突内容"),
  );
  const doc = (
    await core.request("office.list", { workspace_id: wid })
  ).items.find((x) => x.path === "notes.md");
  const snapshot = await core.request("office.get", { id: doc.id });
  assert.ok(snapshot.drafts.some((x) => x.actor));
  report.checks.push(
    "two real windows block overwrite, expose both contents and retain the other draft after explicit resolution",
  );
  await button(second, "放弃本窗口草稿");
  fs.writeFileSync(path.join(workspace, "notes.md"), "外部修改版本\n");
  await until(() =>
    js(
      w,
      "document.querySelector('.office-page').textContent.includes('检测到外部修改')",
    ),
  );
  await button(w, "登记外部版本并保留草稿");
  await open(w, "notes.md");
  await button(w, "固定所选内容");
  await until(() =>
    js(
      w,
      "document.querySelector('.office-page').textContent.includes('外部修改版本')",
    ),
  );
  await button(w, "交给对话");
  await until(() =>
    js(w, `Boolean(document.querySelector('[aria-label="待交付固定引用"]'))`),
  );
  report.checks.push(
    "external change capture and immutable paragraph reference delivered to the existing chat surface",
  );
  await open(w, "notes.md");
  await js(
    w,
    `(()=>{const instance=${JSON.stringify(core.snapshot().storage_instance)};const actor=sessionStorage.getItem('troop:office-window');localStorage.setItem('troop:office:'+instance+':'+${JSON.stringify(doc.id)}+':'+actor,JSON.stringify({content:'Recovered last local office edit',base_revision:4}));sessionStorage.removeItem('troop:office-window');})()`,
  );
  w.webContents.reload();
  await open(w, "notes.md");
  await until(() =>
    js(
      w,
      "document.querySelector('.office-page').textContent.includes('Recovered last local office edit')",
    ),
  );
  await button(w, "接回本窗口缓存内容");
  await until(() =>
    js(
      w,
      "document.querySelector('.office-markdown')?.textContent.includes('Recovered last local office edit')",
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, "notes.md"), "utf8"),
    "外部修改版本\n",
  );
  await button(w, "放弃本窗口草稿");
  report.checks.push(
    "a new renderer window identity discovers previous-session local edits and recovers them without overwriting the file",
  );
  await open(w, "table.csv");
  await button(w, "开始编辑");
  await field(
    w,
    '[aria-label="单元格 2,2"]',
    "CSV 修改内容",
    "HTMLTextAreaElement",
  );
  await until(() =>
    js(
      w,
      "document.querySelector('.office-detail [role=status]')?.textContent.includes('草稿已保存到 Core')",
    ),
  );
  await button(w, "保存文件");
  await until(() =>
    fs
      .readFileSync(path.join(workspace, "table.csv"), "utf8")
      .includes("CSV 修改内容"),
  );
  assert.ok(
    fs
      .readFileSync(path.join(workspace, "table.csv"), "utf8")
      .includes("001,CSV 修改内容\r\n"),
  );
  report.checks.push(
    "CSV cell edit retains leading zeros and CRLF through real renderer and Core",
  );
  for (const width of [1440, 768, 660]) {
    w.setSize(width, 920);
    await sleep(180);
    assert.ok(
      await js(w, "document.documentElement.scrollWidth<=innerWidth+1"),
      `Overflow ${width}`,
    );
    fs.writeFileSync(
      path.join(profile, `office-${width}.png`),
      (await w.webContents.capturePage()).toPNG(),
    );
  }
  report.checks.push(
    "three desktop widths keep editor tables within their own scroll container",
  );
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.error = error.stack;
    report.page = await js(runtime.window, "document.body.innerText").catch(
      () => "",
    );
  })
  .finally(async () => {
    if (runtime) {
      await runtime.core.stop();
      report.coreStopped = runtime.core.state === "stopped";
    }
    fs.writeFileSync(
      path.join(profile, "office-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
