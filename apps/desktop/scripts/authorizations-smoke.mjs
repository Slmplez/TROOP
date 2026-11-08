import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url),
  electron = require("electron");
const engine = process.argv[2] ?? "codex";
const nativeTools =
  ["pi", "oh-my-pi", "copilot", "claude", "opencode", "grok"].includes(
    engine,
  ) && process.argv.includes("--native");
assert.ok(
  ["codex", "oh-my-pi", "pi", "copilot", "claude", "opencode", "grok"].includes(
    engine,
  ),
);
const built = spawnSync(
  "cargo",
  ["build", "--offline", "--locked", "-p", "troop-core", "--examples"],
  { cwd: path.resolve(app, "../.."), encoding: "utf8", windowsHide: true },
);
assert.equal(built.status, 0, built.stderr);
const temp = path.resolve(app, "../../.tmp-troop-authorizations");
fs.mkdirSync(temp, { recursive: true });
const profile = fs.mkdtempSync(path.join(temp, "ui-"));
const env = { ...process.env };
if (engine === "copilot") {
  env.COPILOT_PROVIDER_BASE_URL = "http://127.0.0.1:9";
  env.COPILOT_MODEL = "owned-protocol-model";
}
delete env.ELECTRON_RUN_AS_NODE;
if (engine === "grok") {
  env.GROK_MODELS_BASE_URL = "http://127.0.0.1:9/v1";
  env.GROK_DEFAULT_MODEL = "owned-grok-model";
  env.XAI_API_KEY = "TROOP_GROK_TEST_CREDENTIAL";
}
const child = spawn(
  electron,
  [
    path.join(app, "test/authorizations-smoke.cjs"),
    profile,
    engine,
    ...(nativeTools ? ["--native"] : []),
  ],
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
    reject(Error("Authorization smoke timeout"));
  }, 90000);
  child.once("error", reject);
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
const report = JSON.parse(
  fs.readFileSync(path.join(profile, "authorizations-smoke.json"), "utf8"),
);
assert.equal(code, 0, report.error ?? stderr);
assert.ok(report.passed && report.coreStopped);
fs.writeFileSync(
  path.join(
    temp,
    engine === "oh-my-pi"
      ? "latest-omp-smoke.json"
      : engine === "pi"
        ? "latest-pi-smoke.json"
        : engine === "copilot"
          ? "latest-copilot-smoke.json"
          : ["claude", "opencode", "grok"].includes(engine)
            ? `latest-${engine}-smoke.json`
            : "latest-authorizations-smoke.json",
  ),
  JSON.stringify({ profile, ...report }, null, 2),
);
console.log(`Authorization desktop acceptance passed: ${profile}`);
