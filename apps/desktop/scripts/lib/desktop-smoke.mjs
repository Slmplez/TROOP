import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import crypto from "node:crypto";

export async function runDesktopSmoke(name) {
  const app = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const root = path.resolve(app, "../..");
  const temporary = path.join(root, ".tmp-troop-hooks/tests");
  const evidence = path.join(root, "verification/desktop-ci");
  fs.mkdirSync(temporary, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const profile = fs.mkdtempSync(path.join(temporary, `ui-${name}-`));
  const output = path.join(evidence, `${name}-smoke.json`);
  let report = {
    profile,
    passed: false,
    status: "running",
    run_identity: crypto.randomUUID(),
    started_at: new Date().toISOString(),
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let stderr = "";
  try {
    const child = spawn(
      createRequire(import.meta.url)("electron"),
      [path.join(app, `test/${name}-smoke.cjs`), profile],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
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
    const result = path.join(profile, `${name}-smoke.json`);
    assert.ok(fs.existsSync(result), stderr);
    report = { ...report, ...JSON.parse(fs.readFileSync(result, "utf8")) };
    assert.equal(code, 0, report.error ?? stderr);
    assert.ok(report.passed && report.coreStopped);
    report.status = "passed";
  } catch (error) {
    report.passed = false;
    report.status = "failed";
    report.error = error.stack;
    throw error;
  } finally {
    try {
      if (report.coreStopped)
        report.credentialCleanup = createRequire(import.meta.url)(
          "../../test/fixtures/events-credentials.cjs",
        ).cleanupEventCredentials([path.join(profile, "core")]);
    } catch (error) {
      report.passed = false;
      report.status = "failed";
      report.error = [report.error, error.stack].filter(Boolean).join("\n");
      throw error;
    } finally {
      report.completed_at = new Date().toISOString();
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
    }
  }
  console.log(`${name} desktop acceptance passed: ${profile}`);
}
