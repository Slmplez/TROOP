import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url),
  electron = require("electron");
const temp = path.resolve(app, "../../.tmp-troop-tasks");
fs.mkdirSync(temp, { recursive: true });
const profile = fs.mkdtempSync(path.join(temp, "ui-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [path.join(app, "test/tasks-smoke.cjs"), profile],
  { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", (bytes) => process.stdout.write(bytes));
let stderr = "";
child.stderr.on("data", (bytes) => {
  stderr = (stderr + bytes).slice(-4000);
});
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(Error("Owned task smoke timeout"));
  }, 90000);
  child.once("error", reject);
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
const report = JSON.parse(
  fs.readFileSync(path.join(profile, "tasks-smoke.json"), "utf8"),
);
assert.equal(code, 0, report.error ?? stderr);
assert.ok(report.passed && report.coreStopped);
fs.writeFileSync(
  path.join(temp, "latest-tasks-smoke.json"),
  JSON.stringify({ profile, ...report }, null, 2),
);
console.log(`Owned task desktop acceptance passed: ${profile}`);
