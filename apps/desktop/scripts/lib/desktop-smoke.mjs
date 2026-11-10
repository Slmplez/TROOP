import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

export async function runDesktopSmoke(name) {
  const app = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const root = path.resolve(app, "../..");
  const temp = path.join(root, ".tmp-troop-hooks/tests");
  fs.mkdirSync(temp, { recursive: true });
  const profile = fs.mkdtempSync(path.join(temp, `ui-${name}-`));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    createRequire(import.meta.url)("electron"),
    [path.join(app, `test/${name}-smoke.cjs`), profile],
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
      reject(Error(`${name} desktop smoke timeout`));
    }, 120000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const file = path.join(profile, `${name}-smoke.json`);
  assert.ok(fs.existsSync(file), stderr);
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(code, 0, report.error ?? stderr);
  assert.ok(report.passed && report.coreStopped);
  report.credentialCleanup = createRequire(import.meta.url)(
    "../../test/fixtures/events-credentials.cjs",
  ).cleanupEventCredentials([path.join(profile, "core")]);
  const evidence = path.join(root, "verification/desktop-ci");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(
    path.join(evidence, `${name}-smoke.json`),
    JSON.stringify({ profile, ...report }, null, 2),
  );
  console.log(`${name} desktop acceptance passed: ${profile}`);
}
