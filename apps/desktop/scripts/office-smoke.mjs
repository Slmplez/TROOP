import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(app, "../..");
const temp = path.join(root, ".tmp-troop-office");
fs.mkdirSync(temp, { recursive: true });
const profile = fs.mkdtempSync(path.join(temp, "ui-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  createRequire(import.meta.url)("electron"),
  [path.join(app, "test/office-smoke.cjs"), profile],
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
    reject(Error("Office desktop smoke timeout"));
  }, 120000);
  child.once("error", reject);
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
const file = path.join(profile, "office-smoke.json");
assert.ok(fs.existsSync(file), stderr);
const report = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(code, 0, report.error ?? stderr);
assert.ok(report.passed && report.coreStopped);
const evidence = path.join(root, "verification/desktop-ci");
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(
  path.join(evidence, "office-smoke.json"),
  JSON.stringify({ profile, ...report }, null, 2),
);
console.log(`Office desktop acceptance passed: ${profile}`);
