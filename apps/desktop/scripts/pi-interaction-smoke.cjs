const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setup, until } = require("../test/fixtures/hooks-fixture.cjs");
const { spawnSync } = require("node:child_process");
async function main() {
  const omp = process.argv.includes("--omp"),
    engine = omp ? "oh-my-pi" : "pi";
  const cleanup = [],
    report = {
      passed: false,
      engine,
      version: omp ? "18.14.0" : "1.5.0",
      checks: [],
    };
  const h = await setup({ after: (fn) => cleanup.push(fn) });
  async function command(method, input) {
    const receipt = await h.core.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: h.core.snapshot().storage_instance,
      method,
      input,
    });
    assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
    return receipt.result;
  }
  try {
    const piDirectory = omp
      ? path.join(process.env.USERPROFILE, "AppData/Local/omp")
      : path.resolve(".tmp-troop-cli/pi-v1.5.0/native");
    const agentDirectory =
      process.env.PI_CODING_AGENT_DIR ??
      path.join(process.env.USERPROFILE, ".pi/agent");
    const shell = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-Command pwsh.exe -ErrorAction Stop).Source",
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout.trim();
    const grant = await command("authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "Pi native interaction acceptance",
        purpose: "cli_start",
        agent_id: 1,
        engine_id: engine,
        program: path.join(piDirectory, omp ? "omp.exe" : "pi.exe"),
        workspace_id: h.wid,
        project_ids: [],
        read_roots: [
          h.workspace,
          piDirectory,
          agentDirectory,
          path.dirname(shell),
        ],
        write_roots: [h.workspace],
        operations: ["start"],
        network: "any",
        credential_env_keys: ["DEEPSEEK_API_KEY"],
        expires_at: Math.floor(Date.now() / 1000) + 600,
      },
    });
    for (const mode of ["question", "permission", "stop", "revoke"]) {
      const started = await command("cli.start", {
        client_run_id: crypto.randomUUID(),
        workspace_id: h.wid,
        engine_id: engine,
        tool_mode: "native",
        authorization_id: grant.id,
        approval_mode: "manual",
        goal:
          mode === "question"
            ? "Use ask_user to ask one question with Alpha and Beta choices. Wait for my answer then reply TROOP_PI_INTERACTION_DONE. Do not use other tools or read any files."
            : `Use write to create ${mode}.txt with exactly TROOP_PI_INTERACTION_ARTIFACT. Do not read other files or use shell. Then reply TROOP_PI_INTERACTION_DONE.`,
        timeout_seconds: 120,
      });
      const request = await until(async () => {
        const item = (
          await h.core.request("cli.interactions", { task_id: started.task_id })
        ).items.find((item) => item.state === "pending");
        const run = await h.get(started.run.id);
        if (["failed", "interrupted"].includes(run.run.state))
          throw Error(
            JSON.stringify(
              await h.core.request("agent.task", { id: started.task_id }),
            ),
          );
        return item;
      }, 150000);
      assert.equal(fs.existsSync(path.join(h.workspace, `${mode}.txt`)), false);
      if (mode === "stop" || mode === "revoke") {
        await command(
          mode === "stop" ? "agent.stop-task" : "authorizations.revoke",
          mode === "stop"
            ? { id: started.task_id }
            : { id: grant.id, expected_revision: grant.revision },
        );
        await h.done(started.run.id);
        const receipt = await h.core.request("operations.execute", {
          operation_id: crypto.randomUUID(),
          instance_id: h.core.snapshot().storage_instance,
          method: "cli.respond",
          input: {
            interaction_id: request.interaction_id,
            expected_revision: request.revision,
            task_epoch: request.task_epoch,
            request_sha256: request.request_sha256,
            answer: { kind: "permission", option_id: "once" },
          },
        });
        assert.equal(receipt.state, "rejected");
        assert.equal(
          fs.existsSync(path.join(h.workspace, `${mode}.txt`)),
          false,
        );
      } else {
        const answer =
          request.kind === "question"
            ? { kind: "question", answers: { choice: ["Alpha"] } }
            : { kind: "permission", option_id: "once" };
        await command("cli.respond", {
          interaction_id: request.interaction_id,
          expected_revision: request.revision,
          task_epoch: request.task_epoch,
          request_sha256: request.request_sha256,
          answer,
        });
        await until(
          async () =>
            (await h.get(started.run.id)).run.waiting.includes("review"),
          150000,
        );
        if (mode === "permission")
          assert.equal(
            fs.readFileSync(path.join(h.workspace, "permission.txt"), "utf8"),
            "TROOP_PI_INTERACTION_ARTIFACT",
          );
      }
      report.checks.push({
        mode,
        interaction: await h.core.request("cli.interaction", {
          interaction_id: request.interaction_id,
        }),
        task_id: started.task_id,
      });
    }
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    fs.writeFileSync(
      path.resolve(
        `verification/cli-interactions-2026-11-08/${omp ? "omp" : "pi"}-real.json`,
      ),
      JSON.stringify(report, null, 2),
    );
  }
  assert.equal(report.passed, true, report.error);
  console.log("Pi real interaction acceptance passed.");
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
