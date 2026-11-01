// Runs only when explicitly passed to Electron; production main has no test commands.
const { app, BrowserWindow, dialog } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const profile = process.argv[2];
const reportPath = path.join(profile, "smoke.json");
fs.mkdirSync(profile, { recursive: true });
let runtime;
let secondary;
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(40);
  }
  throw Error("Smoke condition timed out");
}
const timeout = setTimeout(() => {
  secondary?.kill();
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ passed: false, error: "Smoke timeout", checks }),
  );
  app.exit(1);
}, 45000);
async function run() {
  runtime = await bootstrap({ userData: profile, show: false });
  if (!runtime) {
    clearTimeout(timeout);
    return;
  }
  const { window: win, core } = runtime;
  win.webContents.setBackgroundThrottling(false);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await until(() => core.state === "ready");
  await until(() =>
    js(
      "document.querySelector('h1')?.textContent==='工作区' && document.body.textContent.includes('已连接')",
    ),
  );
  checks.push("real Rust Core connected and renderer mounted");
  const bridge = await js(
    "({node:typeof process,require:typeof require,methods:Object.keys(window.troop),font:document.fonts.check('14px Plex')})",
  );
  assert.equal(bridge.node, "undefined");
  assert.equal(bridge.require, "undefined");
  assert.ok(!bridge.methods.includes("invoke"));
  checks.push("context-isolated narrow bridge");
  await js("document.fonts.ready");
  assert.equal(await js("document.fonts.check('14px Plex')"), true);
  runtime.restore();
  await until(() => win.isVisible());
  win.setContentSize(1440, 900);
  await js(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  await sleep(120);
  fs.writeFileSync(
    path.join(profile, "empty.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  const work = path.join(profile, "用户项目");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "keep.txt"), "preserved");
  // Native picker is stubbed to the owned fixture; actual IPC, Rust and SQLite remain real.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [work] });
  await js(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='添加工作区').click()",
  );
  await until(() =>
    js(
      "document.querySelector('.workspace-info h2')?.textContent==='用户项目'",
    ),
  );
  checks.push("renderer button -> IPC -> Rust -> SQLite -> list");
  await js(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='重命名').click()",
  );
  await js(
    "(()=>{const input=document.querySelector('.workspace-info input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'TROOP 本机项目');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await sleep(40);
  await js("document.querySelector('.workspace-info form').requestSubmit()");
  await until(() =>
    js(
      "!document.querySelector('.workspace-info form') && document.querySelector('.workspace-info h2')?.textContent==='TROOP 本机项目'",
    ),
  );
  checks.push("rename form persists Unicode name");
  await js(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  fs.writeFileSync(
    path.join(profile, "workspaces.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  const page = await core.request("workspace.list");
  const id = page.items[0].id;
  const attacker = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, "../src/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await attacker.loadFile(path.resolve(__dirname, "../dist/index.html"));
  await assert.rejects(
    attacker.webContents.executeJavaScript(
      `window.troop.renameWorkspace(${id},'MUST NOT CHANGE')`,
    ),
  );
  attacker.destroy();
  assert.equal(
    (await core.request("workspace.list")).items[0].name,
    "TROOP 本机项目",
  );
  checks.push("foreign renderer IPC rejected");
  const previous = core.generation;
  core.child.kill();
  await until(() => core.child === null && core.state === "faulted");
  await until(() => js("Boolean(document.querySelector('[role=alert]'))"));
  fs.writeFileSync(
    path.join(profile, "fault.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js("document.querySelector('[role=alert] button').click()");
  await until(() => core.state === "ready" && core.generation !== previous);
  await until(() =>
    js(
      "document.querySelector('.workspace-info h2')?.textContent==='TROOP 本机项目'",
    ),
  );
  checks.push("crash state and explicit restart retain SQLite data");
  assert.ok(runtime.tray && !runtime.tray.isDestroyed());
  win.close();
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isVisible(), false);
  assert.equal((await core.request("system.ping")).ready, true);
  checks.push("close hides to live tray without stopping Core");
  runtime.restore();
  await until(() => win.isVisible());
  win.hide();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  secondary = spawn(
    process.execPath,
    [path.resolve(__dirname, ".."), "--user-data-dir=" + profile],
    { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  const secondaryTimeout = setTimeout(() => secondary.kill(), 8000);
  const [code] = await once(secondary, "exit");
  clearTimeout(secondaryTimeout);
  assert.equal(code, 0);
  assert.equal((await core.request("system.ping")).ready, true);
  checks.push(
    "production entry secondary instance exits while primary Core remains",
  );
  await js("document.querySelectorAll('nav button')[1].click()");
  await until(() => js("document.querySelector('h1')?.textContent==='连接'"));
  win.setContentSize(768, 900);
  await sleep(80);
  fs.writeFileSync(
    path.join(profile, "connection-768.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  win.setMinimumSize(320, 400);
  win.setContentSize(390, 844);
  await sleep(80);
  fs.writeFileSync(
    path.join(profile, "connection-390.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  win.setContentSize(1120, 740);
  const transport = await js("window.troop.status()");
  assert.equal(transport.value.state, "ready");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        passed: true,
        checks,
        corePid: core.child.pid,
        coreGeneration: core.generation,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        fontLoaded: true,
        picker: "owned test fixture; native dialog itself not automated",
        profile,
      },
      null,
      2,
    ),
  );
  clearTimeout(timeout);
  app.quit();
}
run().catch(async (error) => {
  secondary?.kill();
  clearTimeout(timeout);
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ passed: false, checks, error: error.stack }, null, 2),
  );
  try {
    await runtime?.core.stop();
  } finally {
    app.exit(1);
  }
});
