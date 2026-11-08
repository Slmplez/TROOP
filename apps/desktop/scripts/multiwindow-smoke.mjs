import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const directory = path.resolve(".tmp-troop-multiwindow");
fs.mkdirSync(directory, { recursive: true });
const profile = fs.mkdtempSync(path.join(directory, "ui-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require("electron"),
  [path.resolve("apps/desktop/test/multiwindow-smoke.cjs"), profile],
  { env, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
);
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(Error("Multiwindow acceptance timed out"));
  }, 60000);
  child.once("error", reject);
  child.once("exit", (value) => {
    clearTimeout(timer);
    resolve(value);
  });
});
const report = JSON.parse(
  fs.readFileSync(path.join(profile, "multiwindow-smoke.json"), "utf8"),
);
assert.equal(code, 0, report.error);
assert.ok(report.passed && report.coreStopped);
console.log(`Multiwindow desktop acceptance passed: ${profile}`);
