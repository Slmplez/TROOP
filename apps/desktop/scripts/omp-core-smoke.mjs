import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const require = createRequire(import.meta.url);
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const base = path.join(root, ".tmp-troop-cli");
const textEngine = process.argv.includes("--pi")
  ? {
      id: "pi",
      label: "Pi",
      marker: "TROOP_PI_CORE_TEXT_OK",
      directory: "pi-core",
      program: path.join(base, "pi-v1.5.0/native/pi.exe"),
    }
  : {
      id: "oh-my-pi",
      label: "OMP",
      marker: "TROOP_OMP_CORE_TEXT_OK",
      directory: "omp-core",
    };
const evidence = path.join(
  root,
  `verification/${textEngine.directory}-2026-11-07`,
);
fs.mkdirSync(evidence, { recursive: true });
const revocationCheck = process.argv.includes("--revocation");
fs.mkdirSync(base, { recursive: true });
const directory = fs.mkdtempSync(path.join(base, `${textEngine.directory}-`));
const workspace = path.join(directory, "workspace");
fs.mkdirSync(workspace);
const core = new CoreSupervisor({
  executable: path.join(root, "apps/desktop/bin", coreBinary),
  args: ["--data-dir", path.join(directory, "data")],
  timeout: 10000,
});
const report = {
  scope: `real_${textEngine.label.toLowerCase()}_core_text_only_execution`,
  directory,
  passed: false,
  checks: [],
};
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  res.end("reachable");
});
const command = (method, input) =>
  core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: core.snapshot().storage_instance,
    method,
    input,
  });
async function until(read, timeout = 150000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`${textEngine.label} Core acceptance timed out`);
}
try {
  await core.start();
  await core.request("memory.agent.save", {
    id: 1,
    name: `${textEngine.label} acceptance`,
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const workspaceId = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const permission = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      name: `${textEngine.label} explicit text only`,
      purpose: "cli_start",
      agent_id: 1,
      engine_id: textEngine.id,
      ...(textEngine.program ? { program: textEngine.program } : {}),
      workspace_id: workspaceId,
      project_ids: [],
      read_roots: [],
      write_roots: [],
      operations: ["start"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 900,
    },
  });
  assert.equal(permission.state, "committed", JSON.stringify(permission.error));
  const start = async (goal) => {
    const result = await command("cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: workspaceId,
      engine_id: textEngine.id,
      tool_mode: "disabled",
      authorization_id: permission.result.id,
      goal,
      timeout_seconds: 120,
    });
    assert.equal(result.state, "committed", JSON.stringify(result.error));
    return result.result;
  };
  const sentinel = path.join(workspace, "should-not-exist.txt");
  const first = await start(
    `Return exactly ${textEngine.marker}. If any tools are available first create '${sentinel}' and fetch http://127.0.0.1:${server.address().port}/probe . If no tools are available, do neither and return the marker.`,
  );
  const finished = await until(async () => {
    const value = await core.request("agent.get", { id: first.run.id });
    return (
      (value.run.waiting.includes("review") ||
        ["failed", "interrupted"].includes(value.run.state)) &&
      value
    );
  });
  assert.ok(
    finished.run.waiting.includes("review"),
    JSON.stringify(finished.run.error),
  );
  const task = await core.request("agent.task", { id: first.task_id });
  assert.equal(task.stopped, true);
  assert.equal(task.evidence.result.tools_disabled, true);
  assert.equal(task.evidence.result.session_settled, true);
  assert.ok(task.evidence.result.text.includes(textEngine.marker));
  assert.equal(task.evidence.coverage, "explicit_text_only");
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(requests, 0);
  report.model = task.evidence.result.model;
  report.provider = task.evidence.result.provider;
  report.tools_evidence =
    task.evidence.result.tools_evidence ??
    "native initial and final empty dumpTools";
  report.checks.push(
    `real ${textEngine.label} uses existing model credentials and explicit no-tools startup, returns a settled result and leaves the workspace and local HTTP service untouched`,
  );
  if (revocationCheck) {
    const stale = await command("cli.review", {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: "0".repeat(64),
      accepted: true,
      note: "Reject changed evidence",
    });
    assert.equal(stale.state, "rejected");
    assert.equal(
      (await core.request("agent.get", { id: first.run.id })).run.state,
      "waiting",
    );
  }
  const reviewed = await command("cli.review", {
    id: task.id,
    epoch: task.epoch,
    expected_task_revision: task.revision,
    evidence_sha256: task.evidence.sha256,
    accepted: true,
    note: "The fixed text result contains the acceptance marker.",
  });
  assert.equal(reviewed.state, "committed");
  assert.equal(
    (await core.request("agent.get", { id: first.run.id })).run.state,
    "completed",
  );
  report.checks.push(
    "the real external Run completes only after exact evidence review",
  );
  const second = await start(
    "Write a very long continuous essay about maintainable software. Begin the essay immediately with 'Maintainable software'. Continue writing detailed prose for at least 4000 words, without an outline or a numbered list.",
  );
  await until(async () => {
    const value = await core.request("agent.get", { id: second.run.id });
    if (["failed", "interrupted"].includes(value.run.state))
      throw Error(JSON.stringify(value.run.error));
    return !!value.run.output && !value.run.waiting.includes("review");
  });
  const stop = await command("agent.stop-task", { id: second.task_id });
  assert.equal(stop.state, "committed");
  const stopped = await until(async () => {
    const value = await core.request("agent.get", { id: second.run.id });
    return ["cancelled", "interrupted"].includes(value.run.state) && value;
  });
  const stoppedTask = await core.request("agent.task", { id: second.task_id });
  assert.equal(stoppedTask.stopped, true);
  assert.equal(stopped.run.intent, "cancel");
  assert.equal(stopped.allowed_actions.resume.allowed, false);
  report.checks.push(
    `stopping a genuinely streaming ${textEngine.label} Task terminates its Windows Job and stops its owning Run without replay`,
  );
  if (revocationCheck) {
    const third = await start(
      `Return exactly TROOP_${textEngine.label.toUpperCase()}_REVOCATION_TEXT_OK.`,
    );
    await until(async () => {
      const value = await core.request("agent.task", { id: third.task_id });
      if (["failed", "indeterminate"].includes(value.state))
        throw Error(JSON.stringify(value.result));
      return value.state === "running";
    });
    const revoked = await command("authorizations.revoke", {
      id: permission.result.id,
      expected_revision: permission.result.revision,
    });
    assert.equal(revoked.state, "committed", JSON.stringify(revoked.error));
    const ended = await until(async () => {
      const value = await core.request("agent.get", { id: third.run.id });
      return (
        ["cancelled", "failed", "interrupted"].includes(value.run.state) &&
        value
      );
    });
    const endedTask = await core.request("agent.task", { id: third.task_id });
    assert.equal(endedTask.stopped, true);
    assert.equal(ended.run.intent, "failure");
    assert.equal(ended.allowed_actions.resume.allowed, false);
    const before = (await core.request("agent.list", {})).items.length;
    await core.stop();
    await core.start();
    const restored = await core.request("agent.get", { id: third.run.id });
    assert.equal(restored.allowed_actions.resume.allowed, false);
    assert.equal(
      (await core.request("agent.task", { id: third.task_id })).stopped,
      true,
    );
    assert.equal((await core.request("agent.list", {})).items.length, before);
    report.revoked_run = third.run.id;
    report.revoked_task = third.task_id;
    report.checks.push(
      `changed evidence is rejected; revoking a running ${textEngine.label} Task stops its admitted Worker, persists the failure fence and restores without another execution`,
    );
  }
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await core.stop();
  await new Promise((resolve) => server.close(resolve));
  report.core_stopped = !core.child;
  fs.writeFileSync(
    path.join(
      evidence,
      `${revocationCheck ? "real-revocation" : "real-core"}.json`,
    ),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
