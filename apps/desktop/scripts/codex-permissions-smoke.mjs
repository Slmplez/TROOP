import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const evidence = path.join(root, "verification/cli-core-2026-11-07");
const allowToolNetwork = process.argv.includes("--allow-tool-network");
const source = JSON.parse(
  fs.readFileSync(path.join(evidence, "codex-real.json"), "utf8"),
);
assert.ok(source.passed);
assert.ok(
  path
    .resolve(source.directory)
    .startsWith(path.join(root, ".tmp-troop-cli") + path.sep),
);
const require = createRequire(import.meta.url);
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const core = new CoreSupervisor({
  executable: path.join(root, "apps/desktop/bin", coreBinary),
  args: ["--data-dir", path.join(source.directory, "data")],
});
const report = {
  scope: "native_sandbox_enforcement_of_core_permission_plan",
  effective_tool_network: allowToolNetwork ? "any" : "none",
  model_requests: 0,
  passed: false,
  checks: [],
};
let child,
  requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  res.end("reachable");
});
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
try {
  await core.start();
  const task = await core.request("agent.task", { id: source.task_id });
  const plan = task.evidence.permission_plan;
  assert.equal(plan.read_all, true);
  assert.equal(plan.network, "none");
  const workspace = path.join(source.directory, "workspace");
  const outside = path.join(source.directory, "denied-by-native-sandbox.txt");
  const inside = path.join(workspace, "native-permissions.txt");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/probe`;
  const profile = "troop_native_acceptance";
  const filesystem = { ":root": "read" };
  for (const p of plan.read_roots) filesystem[p] = "read";
  for (const p of plan.write_roots) filesystem[p] = "write";
  const entries = Object.entries(filesystem)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(",");
  const script = [
    "$ErrorActionPreference='Stop'",
    `Set-Content -LiteralPath ${quote(inside)} -Value 'authorized' -NoNewline`,
    "$blocked=$false",
    `try {Set-Content -LiteralPath ${quote(outside)} -Value 'must be denied' -NoNewline} catch {if ($_.CategoryInfo.Category -ne 'PermissionDenied') {throw}; $blocked=$true}`,
    "if (!$blocked) {exit 41}",
    `$networkBlocked=$false; try {Invoke-WebRequest -UseBasicParsing -Uri ${quote(url)} -TimeoutSec 3 | Out-Null} catch {$networkBlocked=$true}`,
    allowToolNetwork
      ? "if ($networkBlocked) {exit 43}"
      : "if (!$networkBlocked) {exit 42}",
    "Write-Output 'TROOP_NATIVE_PERMISSIONS_OK'",
  ].join("; ");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("CODEX_") ||
        ["CODEX_HOME", "CODEX_API_KEY"].includes(key),
    ),
  );
  child = spawn(
    plan.program,
    [
      "sandbox",
      "--include-managed-config",
      "-C",
      workspace,
      "-P",
      profile,
      "-c",
      'windows.sandbox="elevated"',
      "-c",
      "features.prefer_mxc=false",
      "-c",
      `default_permissions=${JSON.stringify(profile)}`,
      "-c",
      `permissions.${profile}.filesystem={${entries}}`,
      "-c",
      `permissions.${profile}.network.enabled=${allowToolNetwork}`,
      "--",
      path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    error = "";
  child.stdout.on("data", (bytes) => (output = (output + bytes).slice(-4000)));
  child.stderr.on("data", (bytes) => (error = (error + bytes).slice(-4000)));
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const stopped = spawnSync(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 3000, stdio: "ignore" },
      );
      reject(
        Error(
          stopped.status === 0
            ? "Native sandbox acceptance timed out"
            : "Native sandbox stop is unconfirmed",
        ),
      );
    }, 60000);
    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  report.exit_code = status;
  report.network_requests = requests;
  assert.equal(status, 0, error);
  assert.ok(output.includes("TROOP_NATIVE_PERMISSIONS_OK"));
  assert.equal(fs.readFileSync(inside, "utf8"), "authorized");
  assert.equal(fs.existsSync(outside), false);
  assert.equal(requests, allowToolNetwork ? 1 : 0);
  report.checks.push(
    "the native sandbox permits an authorized workspace write and rejects a sibling temporary-directory write",
  );
  report.checks.push(
    allowToolNetwork
      ? "the explicitly network-enabled native sandbox reaches only the controlled local HTTP fixture during this probe"
      : "the native sandbox rejects an actual request to a live local HTTP service",
  );
  report.core_plan_sha256 = plan.program_sha256;
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await core.stop();
  await new Promise((resolve) => server.close(resolve));
  fs.writeFileSync(
    path.join(
      evidence,
      allowToolNetwork
        ? "codex-permissions-network-authorized.json"
        : "codex-permissions.json",
    ),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
