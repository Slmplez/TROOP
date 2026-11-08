import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  { CoreSupervisor } = require("../src/core-client.cjs"),
  { coreBinary } = require("../src/core-path.cjs");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const temporary = path.join(root, ".tmp-troop-cli");
fs.mkdirSync(temporary, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporary, "core-")),
  workspace = path.join(directory, "workspace");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, "input.txt"), "TROOP_CODEX_ARTIFACT");
const core = new CoreSupervisor({
  executable: path.join(root, "apps/desktop/bin", coreBinary),
  args: ["--data-dir", path.join(directory, "data")],
  timeout: 10000,
});
const report = {
  scope: "production_core_codex",
  directory,
  checks: [],
  passed: false,
};
const networkCheck = process.argv.includes("--network-boundary");
const allowToolNetwork = process.argv.includes("--allow-tool-network");
const lifecycleCheck = process.argv.includes("--lifecycle");
const writeBoundaryCheck = process.argv.includes("--write-boundary");
assert.ok(
  !(lifecycleCheck || writeBoundaryCheck) || allowToolNetwork,
  "Lifecycle acceptance requires the explicitly authorized tool-network scope.",
);
assert.ok(
  !(networkCheck && allowToolNetwork),
  "Network denial and network permission need separate acceptance runs.",
);
report.tool_network_authorized = allowToolNetwork;
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
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(read, timeout = 150000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(50);
  }
  throw Error("Codex lifecycle acceptance timed out");
}
try {
  if (networkCheck)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await core.start();
  await core.request("memory.agent.save", {
    id: 1,
    name: "CLI acceptance",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const workspaceId = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const permission = await command("authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Codex real workspace acceptance",
      purpose: "cli_start",
      agent_id: 1,
      engine_id: "codex",
      workspace_id: workspaceId,
      project_ids: [],
      read_roots: [workspace],
      read_all: true,
      write_roots: [workspace],
      operations: ["start"],
      network: allowToolNetwork ? "any" : "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  assert.equal(permission.state, "committed", JSON.stringify(permission.error));
  let goal =
    "Read input.txt and create result.txt containing exactly the same text. Use your native local tools. All task data is in this working directory. Access only this directory.";
  if (networkCheck) {
    goal = `Use your native shell tool to run this exact PowerShell acceptance probe. try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${server.address().port}/probe' -TimeoutSec 3 | Out-Null; [IO.File]::WriteAllText('network-result.txt','reachable') } catch { [IO.File]::WriteAllText('network-result.txt','blocked') }. This checks that tool networking is denied. Do not change permissions, request escalation, use MCP or browser tools, or retry.`;
  }
  const outside = path.join(directory, "outside-write-must-be-denied.txt");
  if (writeBoundaryCheck) {
    const literal = "'" + outside.replaceAll("'", "''") + "'";
    goal += ` After copying, use your native command tool to run this exact PowerShell write-boundary probe. The sibling path below is an owned temporary acceptance target outside the authorized write roots. Its write must be denied. Do not expand permissions or retry the sibling write.\n\`\`\`powershell\n$ErrorActionPreference='Stop'; $result='unexpectedly-allowed'; try { Set-Content -LiteralPath ${literal} -Value 'TROOP_CODEX_ARTIFACT' -NoNewline } catch { if ($_.CategoryInfo.Category -ne 'PermissionDenied') { throw }; $result='denied' }; Set-Content -LiteralPath 'boundary-result.txt' -Value $result -NoNewline\n\`\`\``;
  }
  const started = await command("cli.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: workspaceId,
    engine_id: "codex",
    authorization_id: permission.result.id,
    goal,
    timeout_seconds: 120,
  });
  if (
    started.state === "rejected" &&
    started.error?.message?.includes("网络")
  ) {
    report.scope = "production_core_codex_network_off_start_block";
    report.start_blocked = true;
    report.block_reason = started.error.message;
    assert.equal((await core.request("agent.list", {})).items.length, 0);
    assert.equal(fs.existsSync(path.join(workspace, "result.txt")), false);
    report.checks.push(
      "the real Core refuses a network-off CLI grant before creating a Run or starting native tools",
    );
    report.passed = true;
  } else {
    assert.equal(started.state, "committed", JSON.stringify(started.error));
    const runId = started.result.run.id;
    report.run_id = runId;
    let snapshot;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      snapshot = await core.request("agent.get", { id: runId });
      if (
        snapshot.run.waiting.includes("review") ||
        ["failed", "interrupted", "cancelled"].includes(snapshot.run.state)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    report.run_state = snapshot.run.state;
    report.state_before_review = snapshot.run.state;
    report.error = snapshot.run.error;
    assert.ok(
      snapshot.run.waiting.includes("review"),
      JSON.stringify(snapshot.run.error),
    );
    const task = await core.request("agent.task", { id: snapshot.tasks[0].id });
    report.task_id = task.id;
    report.model = task.evidence.result.model;
    report.effective_scope = {
      read_all: task.evidence.permission_plan.read_all,
      read_roots: task.evidence.permission_plan.read_roots,
      write_roots: task.evidence.permission_plan.write_roots,
      network: task.evidence.permission_plan.network,
      program_sha256: task.evidence.permission_plan.program_sha256,
    };
    report.permission_profile = task.evidence.result.permission_profile;
    assert.equal(task.stopped, true);
    assert.equal(task.state, "awaiting_review");
    if (networkCheck) {
      report.scope = "production_core_codex_network_boundary";
      report.network_requests = requests;
      report.commands = task.evidence.result.commands;
      assert.ok(
        report.commands.some((row) =>
          row.command.includes("Invoke-WebRequest"),
        ),
      );
      assert.equal(
        requests,
        0,
        "The managed native tool reached the local HTTP service.",
      );
      assert.equal(
        fs.readFileSync(path.join(workspace, "network-result.txt"), "utf8"),
        "blocked",
      );
      report.checks.push(
        "a real native shell command attempts the local HTTP request and its network access is denied",
      );
      report.passed = true;
    } else {
      const artifact = task.evidence.artifacts.find(
        (item) => item.path === "result.txt",
      );
      assert.equal(artifact?.text, "TROOP_CODEX_ARTIFACT");
      assert.equal(
        fs.readFileSync(path.join(workspace, "result.txt"), "utf8"),
        "TROOP_CODEX_ARTIFACT",
      );
      report.checks.push(
        "real Codex uses its existing model configuration through a managed Core Task and native named permission profile",
      );
      report.checks.push(
        "Windows Job is confirmed empty before the changed artifact is sealed for review",
      );
      if (writeBoundaryCheck) {
        assert.equal(fs.existsSync(outside), false);
        assert.equal(
          fs.readFileSync(path.join(workspace, "boundary-result.txt"), "utf8"),
          "denied",
        );
        assert.equal(
          task.evidence.artifacts.find(
            (item) => item.path === "boundary-result.txt",
          )?.text,
          "denied",
        );
        assert.ok(
          task.evidence.result.commands.some(
            (row) => row.command.includes("Set-Content") && row.exit_code === 0,
          ),
        );
        report.commands = task.evidence.result.commands;
        report.checks.push(
          "a real Core-managed model native command writes the authorized workspace but receives PermissionDenied for the owned sibling directory, with the exact result sealed for review",
        );
      }
      if (lifecycleCheck) {
        const stale = await command("cli.review", {
          id: task.id,
          epoch: task.epoch,
          expected_task_revision: task.revision,
          evidence_sha256: "0".repeat(64),
          accepted: true,
          note: "Reject mismatched evidence",
        });
        assert.equal(stale.state, "rejected");
        assert.ok(
          (await core.request("agent.get", { id: runId })).run.waiting.includes(
            "review",
          ),
        );
      }
      const reviewed = await command("cli.review", {
        id: task.id,
        epoch: task.epoch,
        expected_task_revision: task.revision,
        evidence_sha256: task.evidence.sha256,
        accepted: true,
        note: "The immutable artifact matches the acceptance input.",
      });
      assert.equal(reviewed.state, "committed", JSON.stringify(reviewed.error));
      const reviewedRun = await core.request("agent.get", { id: runId });
      assert.equal(reviewedRun.run.state, "completed");
      report.run_state = reviewedRun.run.state;
      report.checks.push(
        "only the exact evidence review completes the external Run",
      );
      if (lifecycleCheck) {
        report.lifecycle = [];
        for (const scenario of ["stop", "crash", "revoke"]) {
          const heartbeat = path.join(workspace, `${scenario}-heartbeat.txt`);
          const literal = "'" + heartbeat.replaceAll("'", "''") + "'";
          const script = `for ($i=0; $i -lt 1200; $i++) { Add-Content -LiteralPath ${literal} -Value 'x' -NoNewline; Start-Sleep -Milliseconds 100 }`;
          const input = {
            client_run_id: crypto.randomUUID(),
            workspace_id: workspaceId,
            engine_id: "codex",
            authorization_id: permission.result.id,
            goal: `Run this exact PowerShell command once using your native local command tool and wait synchronously for it to finish. ${script} . This is an owned process-stop acceptance probe. Access only this working directory. Do not use the network or background execution.`,
            timeout_seconds: 120,
          };
          const receipt = await command("cli.start", input);
          assert.equal(
            receipt.state,
            "committed",
            JSON.stringify(receipt.error),
          );
          const owned = receipt.result;
          await until(async () => {
            const value = await core.request("agent.get", { id: owned.run.id });
            if (
              ["failed", "interrupted", "cancelled"].includes(
                value.run.state,
              ) ||
              value.run.waiting.includes("review")
            ) {
              throw Error(
                `${scenario}: native heartbeat was not started: ${JSON.stringify(value.run.error)}`,
              );
            }
            return fs.existsSync(heartbeat) && fs.statSync(heartbeat).size > 0;
          });
          if (scenario === "crash") {
            const closed = once(core.child, "close");
            core.child.kill();
            await closed;
            await sleep(300);
            await core.start();
          } else {
            const mutation =
              scenario === "revoke"
                ? await command("authorizations.revoke", {
                    id: permission.result.id,
                    expected_revision: permission.result.revision,
                  })
                : await command("agent.stop-task", { id: owned.task_id });
            assert.equal(
              mutation.state,
              "committed",
              JSON.stringify(mutation.error),
            );
          }
          const ended = await until(async () => {
            const value = await core.request("agent.get", { id: owned.run.id });
            return (
              ["interrupted", "cancelled", "failed"].includes(
                value.run.state,
              ) && value
            );
          });
          const stamp = fs.statSync(heartbeat).size;
          await sleep(350);
          assert.equal(
            fs.statSync(heartbeat).size,
            stamp,
            `${scenario}: native command survived its Core-owned process stop`,
          );
          const stoppedTask = await core.request("agent.task", {
            id: owned.task_id,
          });
          if (scenario !== "crash") assert.equal(stoppedTask.stopped, true);
          assert.equal(ended.allowed_actions.resume.allowed, false);
          const reviewed = await command("agent.reconcile-task", {
            id: stoppedTask.id,
            epoch: stoppedTask.epoch,
            source: "reviewed",
            note: "Owned heartbeat inspected unchanged after process-tree termination; preserve the effects without replay",
          });
          assert.equal(
            reviewed.state,
            "committed",
            JSON.stringify(reviewed.error),
          );
          const count = (await core.request("agent.list", {})).items.length;
          await core.stop();
          await core.start();
          const restored = await core.request("agent.get", {
            id: owned.run.id,
          });
          assert.equal(restored.allowed_actions.resume.allowed, false);
          assert.equal(
            (await core.request("agent.task", { id: owned.task_id })).stopped,
            true,
          );
          assert.equal(
            (await core.request("agent.list", {})).items.length,
            count,
          );
          await sleep(200);
          assert.equal(fs.statSync(heartbeat).size, stamp);
          if (scenario === "revoke") {
            assert.equal(
              (
                await command("cli.start", {
                  ...input,
                  client_run_id: crypto.randomUUID(),
                })
              ).state,
              "rejected",
            );
            assert.equal(
              (await core.request("agent.list", {})).items.length,
              count,
            );
          }
          report.lifecycle.push({
            scenario,
            run_id: owned.run.id,
            task_id: owned.task_id,
            state: restored.run.state,
            stopped: true,
            heartbeat_bytes: stamp,
            reviewed: true,
            replayed: false,
          });
        }
        report.checks.push(
          "real native commands stop after Task cancellation, Core crash and grant revocation; manual effect reconciliation and restart preserve the original identities without replay",
        );
        report.checks.push(
          "a revoked real CLI grant rejects another start before creating a Run; mismatched result evidence is rejected",
        );
      }
      report.passed = true;
    }
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await core.stop();
  await new Promise((resolve) => server.close(resolve));
  report.core_stopped = !core.child;
  fs.writeFileSync(
    path.join(
      root,
      `verification/cli-core-2026-11-07/${report.start_blocked ? "codex-start-policy" : networkCheck ? "codex-network-core" : writeBoundaryCheck ? "codex-real-write-boundary" : lifecycleCheck ? "codex-real-lifecycle" : allowToolNetwork ? "codex-network-authorized" : "codex-real"}.json`,
    ),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
