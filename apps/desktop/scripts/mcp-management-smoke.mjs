import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  electron = createRequire(import.meta.url)("electron"),
  temp = path.resolve(app, "../../.tmp-troop-mcp");
fs.mkdirSync(temp, { recursive: true });
const profile = fs.mkdtempSync(path.join(temp, "management-")),
  env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [path.join(app, "test/mcp-management-smoke.cjs"), profile, process.execPath],
  { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
child.stdout.on("data", (b) => process.stdout.write(b));
child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-6000)));
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(Error("MCP management smoke exceeded 120 seconds"));
  }, 120000);
  child.once("error", reject);
  child.once("close", (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});
const file = path.join(profile, "mcp-management-smoke.json");
if (!fs.existsSync(file)) throw Error(`No management report: ${stderr}`);
const report = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(code, 0, report.error ?? stderr);
assert.ok(report.passed && report.coreStopped);
fs.writeFileSync(
  path.join(temp, "latest-mcp-management-smoke.json"),
  JSON.stringify({ profile, ...report }, null, 2),
);
console.log(`MCP management acceptance passed: ${profile}`);
