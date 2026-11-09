import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = createRequire(import.meta.url)("electron");
const temp = path.resolve(app, "../../.tmp-troop-conversation-automations");
fs.mkdirSync(temp, { recursive: true });
const profile = fs.mkdtempSync(path.join(temp, "ui-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [path.join(app, "test/conversation-automations-smoke.cjs"), profile],
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
    reject(Error("Conversation automation smoke timeout"));
  }, 90000);
  child.once("error", reject);
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
const reportPath = path.join(profile, "conversation-automations-smoke.json");
assert.ok(fs.existsSync(reportPath), `Electron exited ${code}: ${stderr}`);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
assert.equal(code, 0, report.error ?? stderr);
assert.ok(report.passed && report.coreStopped);
fs.writeFileSync(
  path.join(temp, "latest-conversation-automations-smoke.json"),
  JSON.stringify({ profile, ...report }, null, 2),
);
console.log(`Conversation automation desktop acceptance passed: ${profile}`);

const evidence = path.resolve(app, "../../verification/desktop-ci");
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(
  path.join(evidence, "conversation-automation-smoke.json"),
  JSON.stringify(report, null, 2),
);
