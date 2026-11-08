const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setup, until } = require("../test/fixtures/hooks-fixture.cjs");
const destination = path.resolve("verification/opencode-core-2026-11-08");
fs.mkdirSync(destination, { recursive: true });
async function main() {
  const native = !process.argv.includes("--text");
  const real = process.argv.includes("--real");
  const manual = process.argv.includes("--manual");
  const lifecycle = process.argv.includes("--lifecycle");
  assert.ok(!real || process.env.DEEPSEEK_API_KEY);
  assert.ok(!real || !lifecycle);
  const model = real ? "deepseek-flash" : "fixture";
  const cleanup = [];
  const report = {
    version: "1.19.5",
    modelService: real
      ? "existing_deepseek_environment"
      : "owned_loopback_mock",
    native,
    passed: false,
  };
  let boundaryCommand;
  const h = await setup(
    { after: (fn) => cleanup.push(fn) },
    {
      protocol: "chat_completions",
      plan: ({ body }) => {
        if (
          body.messages.some((message) => message.role === "tool") ||
          !native ||
          !body.tools?.length
        )
          return [];
        const mode = ["stop", "crash", "revoke", "settings"].find((value) =>
          JSON.stringify(body.messages).includes(
            `TROOP_OPENCODE_LIFECYCLE_${value}`,
          ),
        );
        if (mode)
          return [
            {
              name: "bash",
              arguments: {
                command: `[IO.File]::WriteAllText('${path.join(h.workspace, `started-${mode}.txt`).replaceAll("'", "''")}', $PID.ToString()); Start-Sleep -Seconds 20; [IO.File]::WriteAllText('${path.join(h.workspace, `late-${mode}.txt`).replaceAll("'", "''")}', 'bad')`,
                description: "Owned lifecycle wait",
              },
            },
          ];
        return [
          {
            name: "read",
            arguments: { filePath: path.join(h.workspace, "input.txt") },
          },
          {
            name: "write",
            arguments: {
              filePath: path.join(h.workspace, "result.txt"),
              content: "TROOP_OPENCODE_ARTIFACT",
            },
          },
          {
            name: "bash",
            arguments: {
              command: boundaryCommand,
              description: "Inspect owned filesystem boundaries",
            },
          },
        ];
      },
      reply: () => "TROOP_OPENCODE_COMPLETE",
    },
  );
  try {
    fs.writeFileSync(
      path.join(h.workspace, "input.txt"),
      "TROOP_OPENCODE_ARTIFACT",
    );
    const file = path.join(h.directory, "model-settings.json");
    const readonly = path.join(h.directory, "readonly");
    fs.mkdirSync(readonly);
    const readonlyFile = path.join(readonly, "input.txt");
    const outside = path.join(h.directory, "outside.txt");
    fs.writeFileSync(readonlyFile, "original readonly");
    fs.writeFileSync(outside, "original outside");
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    boundaryCommand = `
$scope = [ordered]@{outside_read=$false;outside_write=$false;readonly_write=$false}
try {[void][IO.File]::ReadAllText(${quote(outside)});$scope.outside_read=$true} catch {}
try {[IO.File]::WriteAllText(${quote(outside)},'bad');$scope.outside_write=$true} catch {}
try {[IO.File]::WriteAllText(${quote(readonlyFile)},'bad');$scope.readonly_write=$true} catch {}
[IO.File]::WriteAllText(${quote(path.join(h.workspace, "scope.json"))},($scope|ConvertTo-Json -Compress))`;
    fs.writeFileSync(
      file,
      JSON.stringify({
        model: `owned/${model}`,
        provider: {
          owned: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: real
                ? "https://api.deepseek.com"
                : h.server.origin + "/v1",
              apiKey: real
                ? "{env:DEEPSEEK_API_KEY}"
                : "TROOP_OPENCODE_FAKE_KEY",
            },
            models: {
              [model]: {
                name: "Owned model",
                limit: { context: 32768, output: 4096 },
              },
            },
          },
        },
      }),
    );
    const shell = require("node:child_process").spawnSync(
      "where.exe",
      ["pwsh.exe"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(shell.status, 0);
    const shellRoot = path.dirname(shell.stdout.trim().split(/\r?\n/)[0]);
    const command = async (method, input) => {
      const receipt = await h.core.request("operations.execute", {
        operation_id: crypto.randomUUID(),
        instance_id: h.core.snapshot().storage_instance,
        method,
        input,
      });
      assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
      return receipt.result;
    };
    const grantDefinition = {
      name: "Owned OpenCode model",
      purpose: "cli_start",
      engine_id: "opencode",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace, readonly, ...(native ? [shellRoot] : [])],
      write_roots: [h.workspace],
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      model_settings: { file },
      ...(real ? { credential_env_keys: ["DEEPSEEK_API_KEY"] } : {}),
    };
    const grant = await command("authorizations.save", {
      expected_revision: 0,
      grant: grantDefinition,
    });
    const run = await command("cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "opencode",
      tool_mode: native ? "native" : "disabled",
      authorization_id: grant.id,
      ...(manual ? { approval_mode: "manual" } : {}),
      goal: native
        ? "In this temporary workspace use the read and write file tools to read input.txt and write result.txt with exactly the same text and no trailing newline. Then reply TROOP_OPENCODE_COMPLETE. Do not access other files."
        : "Reply TROOP_OPENCODE_COMPLETE without using tools.",
      timeout_seconds: 90,
    });
    const value = await until(async () => {
      if (manual) {
        for (const request of (
          await h.core.request("cli.interactions", { task_id: run.task_id })
        ).items.filter((item) => item.state === "pending")) {
          const option = request.body.options.find(
            (item) =>
              item.kind ===
              (request.allowed_actions.approve.allowed
                ? "allow_once"
                : "reject_once"),
          );
          assert.ok(option, "Missing supported one-time choice");
          (report.manualDecisions ??= []).push(request);
          await command("cli.respond", {
            interaction_id: request.interaction_id,
            expected_revision: request.revision,
            task_epoch: request.task_epoch,
            request_sha256: request.request_sha256,
            answer: { kind: "permission", option_id: option.optionId },
          });
        }
      }
      const current = await h.get(run.run.id);
      return current.run.waiting.includes("review") ||
        ["failed", "interrupted"].includes(current.run.state)
        ? current
        : false;
    }, 110000);
    report.run = value;
    const task = await h.core.request("agent.task", { id: run.task_id });
    report.task = task;
    report.requests = h.server.requests.map(({ body }) => ({
      model: body.model,
      stream: body.stream,
      tools: body.tools?.map((tool) => tool.function.name),
    }));
    assert.ok(
      value.run.waiting.includes("review"),
      JSON.stringify(task.result),
    );
    assert.ok(task.evidence.result.text.includes("TROOP_OPENCODE_COMPLETE"));
    if (native)
      assert.equal(
        fs.readFileSync(path.join(h.workspace, "result.txt"), "utf8"),
        "TROOP_OPENCODE_ARTIFACT",
      );
    if (native && !real) {
      report.boundary = JSON.parse(
        fs.readFileSync(path.join(h.workspace, "scope.json"), "utf8"),
      );
      assert.deepEqual(report.boundary, {
        outside_read: false,
        outside_write: false,
        readonly_write: false,
      });
      assert.equal(fs.readFileSync(outside, "utf8"), "original outside");
      assert.equal(fs.readFileSync(readonlyFile, "utf8"), "original readonly");
    }
    assert.equal(
      JSON.stringify(task).includes("TROOP_OPENCODE_FAKE_KEY"),
      false,
    );

    await command("cli.review", {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: task.evidence.sha256,
      accepted: true,
      note: "Inspected owned synthetic artifact",
    });
    if (lifecycle) {
      assert.ok(native);
      report.lifecycle = [];
      for (const mode of ["stop", "crash", "revoke", "settings"]) {
        const authority = await command("authorizations.save", {
          expected_revision: 0,
          grant: { ...grantDefinition, name: `Owned OpenCode ${mode}` },
        });
        const held = await command("cli.start", {
          client_run_id: crypto.randomUUID(),
          workspace_id: h.wid,
          engine_id: "opencode",
          tool_mode: "native",
          authorization_id: authority.id,
          goal: `TROOP_OPENCODE_LIFECYCLE_${mode}`,
          timeout_seconds: 90,
        });
        await until(async () => {
          if (fs.existsSync(path.join(h.workspace, `started-${mode}.txt`)))
            return true;
          const current = await h.get(held.run.id);
          if (
            current.run.waiting.includes("review") ||
            ["failed", "interrupted"].includes(current.run.state)
          )
            throw Error(
              JSON.stringify(
                await h.core.request("agent.task", { id: held.task_id }),
              ),
            );
          return false;
        }, 60000);
        const pid = Number(
          fs.readFileSync(
            path.join(h.workspace, `started-${mode}.txt`),
            "utf8",
          ),
        );
        assert.ok(Number.isInteger(pid) && pid > 0);
        if (mode === "crash") {
          const exited = require("node:events").once(h.core.child, "exit");
          h.core.child.kill();
          await exited;
          await new Promise((resolve) => setTimeout(resolve, 500));
          await h.core.start();
        } else {
          if (mode === "settings") {
            const changed = JSON.parse(fs.readFileSync(file, "utf8"));
            changed.provider.owned.options.apiKey += "_changed";
            fs.writeFileSync(file, JSON.stringify(changed));
          } else {
            await command(
              mode === "stop" ? "agent.stop-task" : "authorizations.revoke",
              mode === "stop"
                ? { id: held.task_id }
                : { id: authority.id, expected_revision: authority.revision },
            );
          }
          await h.done(held.run.id);
        }
        await until(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            return true;
          }
        });
        const task = await h.core.request("agent.task", { id: held.task_id });
        if (mode === "crash")
          await command("agent.reconcile-task", {
            id: task.id,
            epoch: task.epoch,
            source: "reviewed",
            note: "Verified the owned PowerShell PID has exited and inspected the marker",
          });
        else assert.equal(task.stopped, true);
        await h.core.stop();
        await h.core.start();
        const current = await h.get(held.run.id);
        assert.equal(current.allowed_actions.resume.allowed, false);
        assert.equal(
          fs.existsSync(path.join(h.workspace, `late-${mode}.txt`)),
          false,
        );
        assert.equal(current.tasks.length, 1);
        report.lifecycle.push({
          mode,
          pid,
          processExited: true,
          state: current.run.state,
        });
      }
    }
    await h.core.stop();
    if (real)
      report.credentialScan =
        require("../test/fixtures/cli-credential-scan.cjs")(
          h.directory,
          process.env.DEEPSEEK_API_KEY,
        );
    if (manual)
      assert.ok(
        report.manualDecisions?.length > 0,
        "Native engine did not emit manual permission requests",
      );
    report.passed = true;
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    report.coreStopped = !h.core.child;
    fs.writeFileSync(
      path.join(
        destination,
        lifecycle
          ? "mock-lifecycle.json"
          : `${real ? "real" : "mock"}-${manual ? "manual" : native ? "native" : "text"}.json`,
      ),
      JSON.stringify(report, null, 2),
    );
  }
  console.log("OpenCode managed acceptance passed.");
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
