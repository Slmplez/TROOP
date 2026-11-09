const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  net = require("node:net"),
  assert = require("node:assert/strict"),
  { spawn, execFileSync } = require("node:child_process");
const deployment = require("../src/event-deployment.cjs"),
  { coreBinary } = require("../src/core-path.cjs"),
  { until, sleep } = require("../test/fixtures/hooks-fixture.cjs");
const root = path.resolve(__dirname, "../../.."),
  evidence = path.join(root, "verification/cli-followups-2026-11-09");
const duration = Number(process.env.TROOP_SOAK_MS ?? 300000);
assert.ok(
  Number.isInteger(duration) && duration >= 300000 && duration <= 86400000,
);
fs.mkdirSync(path.join(root, ".tmp-troop-followups"), { recursive: true });
const folder = fs.mkdtempSync(path.join(root, ".tmp-troop-followups/host-"));
const healthFile = path.join(folder, "health.json"),
  configFile = path.join(folder, "host.json"),
  executable = path.join(folder, coreBinary);
fs.copyFileSync(path.join(root, "apps/desktop/bin", coreBinary), executable);
let supervisor;
const hosts = new Set(),
  report = { passed: false, duration_target_ms: duration, checks: [] };
function health() {
  try {
    const value = JSON.parse(fs.readFileSync(healthFile, "utf8"));
    if (hosts.has(value.host_pid) && value.ready) {
      return value;
    }
  } catch {}
  return false;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function main() {
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const config = {
    version: 1,
    mode: "receiver",
    executable,
    core_sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(executable))
      .digest("hex"),
    data_directory: path.join(folder, "data"),
    listen: `127.0.0.1:${port}`,
    health_file: healthFile,
    health_interval_ms: 1000,
  };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const started = Date.now();
  let buffer = "";
  supervisor = spawn(
    "pwsh.exe",
    [
      "-NoProfile",
      "-File",
      path.join(__dirname, "host-events.ps1"),
      "-Config",
      configFile,
      "-Node",
      process.execPath,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  supervisor.stdout.on("data", (bytes) => {
    buffer += bytes;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line);
        if (value.event === "host_start") hosts.add(value.pid);
      } catch {}
    }
  });
  supervisor.stderr.on("data", () => {});
  const first = await until(health, 30000),
    instance = first.instance_id;
  process.kill(first.core_pid);
  const recovered = await until(() => {
    const value = health();
    return value && value.host_pid !== first.host_pid && value;
  }, 65000);
  assert.equal(recovered.instance_id, instance);
  report.checks.push(
    "A killed Core causes health failure, supervised replacement and stable storage identity",
  );
  process.kill(recovered.host_pid);
  const second = await until(() => {
    const value = health();
    return value && value.host_pid !== recovered.host_pid && value;
  }, 35000);
  assert.equal(second.instance_id, instance);
  report.checks.push(
    "A killed deployment host is restarted and retains storage identity",
  );
  const backup = await deployment.createBackup(
    config,
    path.join(folder, "backup"),
  );
  const restored = deployment.restoreBackup(
    path.join(folder, "backup"),
    path.join(folder, "restored"),
  );
  assert.equal(backup.instance_id, instance);
  assert.equal(restored.instance_id, instance);
  report.checks.push(
    "Online backup and restore retain the receiver identity during a healthy supervised run",
  );
  let samples = 0;
  while (Date.now() - started < report.duration_target_ms) {
    assert.ok(alive(supervisor.pid));
    const value = await until(() => {
      const value = health();
      return value && Date.now() - Date.parse(value.checked_at) < 5000 && value;
    }, 5000);
    assert.equal(value.instance_id, instance);
    samples++;
    await sleep(1000);
  }
  report.elapsed_ms = Date.now() - started;
  report.health_samples = samples;
  report.host_starts = hosts.size;
  assert.equal(hosts.size, 3);
  report.passed = true;
}
main()
  .catch((error) => {
    report.error = error.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    report.processes_stopped = true;
    if (supervisor) {
      const cleanupScript = `
$owned = @(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine.Contains($env:TROOP_SOAK_FOLDER)
})
foreach ($p in $owned) {
  try { [Diagnostics.Process]::GetProcessById($p.ProcessId).Kill($true) } catch {}
}
Start-Sleep -Milliseconds 500
@(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine.Contains($env:TROOP_SOAK_FOLDER)
}).Count
`;
      const remaining = execFileSync(
        "pwsh.exe",
        ["-NoProfile", "-Command", cleanupScript],
        {
          windowsHide: true,
          encoding: "utf8",
          env: {
            ...process.env,
            TROOP_SOAK_FOLDER: folder,
          },
        },
      );
      report.processes_stopped = remaining.trim() === "0";
    }
    await sleep(1500);
    if (!report.processes_stopped) {
      report.passed = false;
      process.exitCode = 1;
    }
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(
      path.join(evidence, "windows-host-soak.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  });
