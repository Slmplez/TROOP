import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const app = path.join(root, "apps/desktop");
const require = createRequire(path.join(app, "package.json"));
const electron = require("electron");
const temp = path.join(root, ".tmp-troop-bootstrap");
fs.mkdirSync(temp, { recursive: true });
const profile = fs.mkdtempSync(path.join(temp, "smoke-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(app, "test/smoke-app.cjs"), profile], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: false,
});
let stderr = "";
child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-16000)));
child.stdout.on("data", (b) => process.stdout.write(b));
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(Error("Electron smoke exceeded 90 seconds"));
  }, 90000);
  child.once("error", reject);
  child.once("exit", (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});
const file = path.join(profile, "smoke.json");
if (!fs.existsSync(file)) throw Error(`No smoke result (${code}): ${stderr}`);
const report = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(code, 0, report.error ?? stderr);
assert.equal(report.passed, true, report.error);
let exited = false;
for (let i = 0; i < 50; i++) {
  try {
    process.kill(report.corePid, 0);
  } catch (e) {
    if (e.code === "ESRCH") {
      exited = true;
      break;
    }
    throw e;
  }
  await new Promise((r) => setTimeout(r, 40));
}
assert.ok(exited, "Core survived explicit Electron quit");
report.checks.push("explicit application quit leaves no Core process");
if (report.activeConversation) {
  const { CoreSupervisor } = require("./src/core-client.cjs");
  const reader = new CoreSupervisor({
    executable: path.join(app, "bin", "troop-core.exe"),
    args: ["--data-dir", path.join(profile, "core")],
  });
  try {
    await reader.start();
    const page = await reader.request("chat.messages", {
      conversation_id: report.activeConversation,
    });
    assert.equal(
      page.items.find(
        (m) => m.turn_id === report.activeTurn && m.role === "assistant",
      ).status,
      "cancelled",
    );
  } finally {
    await reader.stop();
  }
  report.checks.push(
    "renderer Quit stops and persists a live generation before Core exit",
  );
}
// Exercise the package's actual main entry, independently of the imported test bootstrap.
const productionProfile = fs.mkdtempSync(path.join(temp, "entry-"));
const production = spawn(
  electron,
  [app, "--user-data-dir=" + productionProfile],
  {
    env,
    windowsHide: false,
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let entryError = "";
production.stderr.on("data", (chunk) => {
  entryError = (entryError + chunk).slice(-4096);
});
const productionExit = new Promise((resolve, reject) => {
  production.once("error", reject);
  production.once("close", resolve);
});
const core = path.join(
  app,
  "bin",
  process.platform === "win32" ? "troop-core.exe" : "troop-core",
);
const coreData = path.join(productionProfile, "core");
const probe = () =>
  spawnSync(core, ["--data-dir", coreData], {
    input: "",
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
  });
try {
  const deadline = Date.now() + 10000;
  while (
    !fs.existsSync(path.join(coreData, "troop.sqlite3")) &&
    Date.now() < deadline &&
    production.exitCode === null
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    fs.existsSync(path.join(coreData, "troop.sqlite3")),
    "Production entry did not initialize Core: " + entryError,
  );
  const locked = probe();
  assert.equal(
    locked.status,
    1,
    "Production entry did not retain the Core writer",
  );
  assert.match(locked.stderr, /Another Core/);
} finally {
  production.kill();
  await productionExit;
}
let released = false;
for (let i = 0; i < 30; i++) {
  if (probe().status === 0) {
    released = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(
  released,
  "Production Core did not release its writer after parent death",
);
report.checks.push(
  "production entry boots Core and parent death releases its writer",
);
report.stderr = stderr;
fs.writeFileSync(file, JSON.stringify(report, null, 2));
fs.writeFileSync(
  path.join(temp, "latest-smoke.json"),
  JSON.stringify({ profile, file }, null, 2),
);
console.log(JSON.stringify(report, null, 2));
