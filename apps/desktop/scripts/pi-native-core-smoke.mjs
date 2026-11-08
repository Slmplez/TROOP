import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const omp = process.argv.includes("--omp");
const engine = omp ? "oh-my-pi" : "pi";
const label = omp ? "OMP" : "Pi";
const evidence = path.join(root, `verification/${omp ? "omp" : "pi"}-native-2026-11-08`);
fs.mkdirSync(evidence, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, ".tmp-troop-cli/pi-native-"));
const workspace = path.join(directory, "workspace");
const readonly = path.join(directory, "readonly");
fs.mkdirSync(workspace);
fs.mkdirSync(readonly);
const marker = "TROOP_PI_NATIVE_ARTIFACT";
fs.writeFileSync(path.join(workspace, "input.txt"), marker);
fs.writeFileSync(path.join(readonly, "input.txt"), "TROOP_PI_READONLY");
const outside = path.join(directory, "outside.txt");
fs.writeFileSync(outside, "TROOP_PI_OUTSIDE");
const piDirectory = omp ? path.join(process.env.USERPROFILE, "AppData/Local/omp") : path.join(root, ".tmp-troop-cli/pi-v1.5.0/native");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.USERPROFILE, ".pi/agent");
const shell = spawnSync("powershell.exe", ["-NoProfile", "-Command", "(Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const gitBash = omp ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "(Get-Command bash.exe -ErrorAction Stop).Source"], { encoding: "utf8", windowsHide: true }).stdout.trim() : "";
const readRoots = [workspace, readonly, piDirectory, ...(!omp ? [agentDirectory] : []), ...(shell ? [path.dirname(shell)] : []), ...(gitBash ? [path.dirname(path.dirname(gitBash))] : [])];
const core = new CoreSupervisor({ executable: path.join(root, "apps/desktop/bin", coreBinary), args: ["--data-dir", path.join(directory, "data")], timeout: 10000 });
let networkRequests = 0;
const server = http.createServer((req, res) => { networkRequests++; res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("TROOP_PI_NETWORK_OK"); });
const report = { passed: false, scope: `real_${engine}_contained_native_tools`, directory, read_roots: readRoots, write_roots: [workspace], network: "any", checks: [] };
async function command(method, input) {
  const receipt = await core.request("operations.execute", { operation_id: crypto.randomUUID(), instance_id: core.snapshot().storage_instance, method, input });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return receipt.result;
}
async function until(read) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("Native Pi acceptance timed out");
}
try {
  await core.start();
  await core.request("memory.agent.save", { id: 1, name: "Pi native acceptance", automatic: false, dreaming: false, expected_revision: 1 });
  const wid = (await core.request("workspace.add", { path: workspace })).items[0].id;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const permission = await command("authorizations.save", { expected_revision: 0, grant: {
    name: `${label} native explicit test scope`, purpose: "cli_start", agent_id: 1, engine_id: engine, program: path.join(piDirectory, omp ? "omp.exe" : "pi.exe"),
    workspace_id: wid, project_ids: [], read_roots: readRoots, write_roots: [workspace], operations: ["start"], network: "any", credential_env_keys: ["DEEPSEEK_API_KEY"], expires_at: Math.floor(Date.now() / 1000) + 900,
  } });
  const start = (goal) => command("cli.start", { client_run_id: crypto.randomUUID(), workspace_id: wid, engine_id: engine, tool_mode: "native", authorization_id: permission.id, goal, timeout_seconds: 160 });
  const ready = async (run) => until(async () => {
    const value = await core.request("agent.get", { id: run });
    if (["failed", "interrupted"].includes(value.run.state)) throw Error(JSON.stringify(value.run.error));
    return value.run.waiting.includes("review") && value;
  });
  const shellInstruction = omp ? "Use bash to run Windows PowerShell with -NoProfile -NonInteractive for the command steps." : "Use the powershell tool for the command steps.";
  const first = await start(`This is an authorized native tool acceptance. ${shellInstruction} Use read to read input.txt and write its exact bytes to result.txt. Attempt writing ASCII BAD to these two absolute paths, catching denial separately and saving boundary.json with exactly this schema {"readonly_write":false,"outside_write":false}, where true means write succeeded and false means denied. They must both be denied. Readonly path ${JSON.stringify(path.join(readonly, "input.txt"))}. Outside path ${JSON.stringify(outside)}. Also use PowerShell Invoke-WebRequest -UseBasicParsing to GET http://127.0.0.1:${server.address().port}/native and put its response in network.txt. Do not read any other files. Finish with TROOP_PI_NATIVE_DONE.`);
  await ready(first.run.id);
  let task = await core.request("agent.task", { id: first.task_id });
  assert.equal(task.stopped, true);
  assert.equal(task.evidence.result.tools_disabled, false);
  assert.equal(task.evidence.result.session_settled, true);
  assert.ok(task.evidence.result.tool_calls.some((call) => call.name === (omp ? "bash" : "powershell")));
  report.tool_calls = task.evidence.result.tool_calls;
  assert.equal(fs.readFileSync(path.join(workspace, "result.txt"), "utf8"), marker);
  assert.equal(fs.readFileSync(path.join(readonly, "input.txt"), "utf8"), "TROOP_PI_READONLY");
  assert.equal(fs.readFileSync(outside, "utf8"), "TROOP_PI_OUTSIDE");
  const pending = [workspace];
  while (pending.length) for (const entry of fs.readdirSync(pending.pop(), { withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isDirectory()) pending.push(file);
    else if (entry.isFile()) assert.equal(fs.readFileSync(file).includes(Buffer.from(process.env.DEEPSEEK_API_KEY)), false, "Credential persisted in temporary workspace");
  }
  assert.match(fs.readFileSync(path.join(workspace, "network.txt"), "utf8"), /TROOP_PI_NETWORK_OK/);
  assert.ok(networkRequests > 0);
  report.boundary = JSON.parse(fs.readFileSync(path.join(workspace, "boundary.json"), "utf8").replace(/^\uFEFF/, ""));
  assert.deepEqual(report.boundary, { readonly_write: false, outside_write: false });
  report.model = task.evidence.result.model;
  report.provider = task.evidence.result.provider;
  report.first_run = first.run.id;
  report.first_task = task.id;
  report.permission_plan = task.evidence.permission_plan;
  report.checks.push(`real ${label} uses the existing model credential reference, native file and command tools inside BaseContainer; readonly/outside writes are denied and authorized loopback networking succeeds`);
  await command("cli.review", { id: task.id, epoch: task.epoch, expected_task_revision: task.revision, evidence_sha256: task.evidence.sha256, accepted: true, note: "Inspected native artifact and denied write boundaries" });
  assert.equal((await core.request("agent.get", { id: first.run.id })).run.state, "completed");
  const second = await start(`${shellInstruction} Use PowerShell to write started.txt with ASCII STARTED, then Start-Sleep -Seconds 120, then write late.txt. This is a cancellation acceptance, do not perform anything else.`);
  await until(() => fs.existsSync(path.join(workspace, "started.txt")));
  await command("authorizations.revoke", { id: permission.id, expected_revision: permission.revision });
  await until(async () => ["cancelled", "failed", "interrupted"].includes((await core.request("agent.get", { id: second.run.id })).run.state));
  task = await core.request("agent.task", { id: second.task_id });
  assert.equal(task.stopped, true);
  await core.stop();
  await core.start();
  const restored = await core.request("agent.get", { id: second.run.id });
  assert.equal(restored.allowed_actions.resume.allowed, false);
  assert.equal(restored.tasks.length, 1);
  assert.equal(fs.existsSync(path.join(workspace, "late.txt")), false);
  report.revoked_run = second.run.id;
  report.checks.push("exact artifact review completes the original Run; revoking a real sleeping native PowerShell stops its process tree and restart retains the failure fence without replay");
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  await core.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  report.core_stopped = !core.child;
  fs.writeFileSync(path.join(evidence, "real-core.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
