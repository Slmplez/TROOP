import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = createRequire(import.meta.url)("electron");
const temp = path.resolve(app, "../../.tmp-troop-followups");
fs.mkdirSync(temp, { recursive: true });
const profile = fs.mkdtempSync(path.join(temp, "ui-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [path.join(app, "test/followups-smoke.cjs"), profile],
  { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
child.stdout.on("data", (bytes) => process.stdout.write(bytes));
child.stderr.on("data", (bytes) => {
  stderr = (stderr + bytes).slice(-4000);
});
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(Error("Follow-up smoke timeout"));
  }, 90000);
  child.once("error", reject);
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
const reportPath = path.join(profile, "followups-smoke.json");
assert.ok(fs.existsSync(reportPath), `Electron exited ${code}: ${stderr}`);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
assert.equal(code, 0, report.error ?? stderr);
assert.ok(report.passed && report.coreStopped);
fs.writeFileSync(
  path.join(temp, "latest-followups-smoke.json"),
  JSON.stringify({ profile, ...report }, null, 2),
);
console.log(`Follow-up desktop acceptance passed: ${profile}`);
