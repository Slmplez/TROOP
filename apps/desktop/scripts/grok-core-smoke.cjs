const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setup, until } = require("../test/fixtures/hooks-fixture.cjs");
async function main() {
  const real = process.argv.includes("--real");
  const manual = process.argv.includes("--manual");
  const native = real || process.argv.includes("--native");
  const integrations = process.argv.includes("--integrations");
  const lifecycle = process.argv.includes("--lifecycle");
  assert.ok(!real || process.env.DEEPSEEK_API_KEY);
  assert.ok(!real || (!lifecycle && !integrations));
  const credential = real ? "DEEPSEEK_API_KEY" : "TROOP_GROK_TEST_API_KEY";
  const cleanup = [];
  const report = {
    version: "1.0.70",
    modelService: real
      ? "existing_deepseek_environment"
      : "owned_loopback_mock",
    native,
    passed: false,
    integrations,
  };
  const shell = (script) =>
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  let boundaryCommand;
  const h = await setup(
    { after: (fn) => cleanup.push(fn) },
    {
      protocol: "chat_completions",
      plan: ({ body }) => {
        if (
          !native ||
          !body.tools?.some((tool) => tool.function.name === "write_file") ||
          body.messages.some((message) => message.role === "tool")
        )
          return [];
        const mode = ["stop", "crash", "revoke", "expire"].find((value) =>
          JSON.stringify(body.messages).includes(
            `TROOP_GROK_LIFECYCLE_${value}`,
          ),
        );
        if (mode)
          return [
            {
              name: "shell",
              arguments: {
                command: shell(
                  `[IO.File]::WriteAllText(${quote(path.join(h.workspace, `started-${mode}.txt`))},$PID.ToString()); Start-Sleep -Seconds 30; [IO.File]::WriteAllText(${quote(path.join(h.workspace, `late-${mode}.txt`))},'bad')`,
                ),
                description: "Wait for owned lifecycle verification",
                timeout: 60000,
                block_until_ms: 60000,
                is_background: false,
              },
            },
          ];
        return [
          {
            name: "read_file",
            arguments: { target_file: path.join(h.workspace, "input.txt") },
          },
          {
            name: "write_file",
            arguments: {
              file_path: path.join(h.workspace, "result.txt"),
              content: "TROOP_GROK_ARTIFACT",
            },
          },
          {
            name: "shell",
            arguments: {
              command: shell(boundaryCommand),
              description: "Inspect owned filesystem boundaries",
              timeout: 60000,
              block_until_ms: 60000,
              is_background: false,
            },
          },
        ];
      },
      reply: "TROOP_GROK_COMPLETE",
      metadata: () => ({
        object: "list",
        data: [{ id: "owned-grok-model", object: "model", owned_by: "owned" }],
        models: [
          {
            id: "troop",
            model: "owned-grok-model",
            base_url: h.server.origin + "/v1",
            context_window: 32768,
          },
        ],
      }),
    },
  );
  try {
    fs.writeFileSync(
      path.join(h.workspace, "input.txt"),
      "TROOP_GROK_ARTIFACT",
    );
    const readonly = path.join(h.directory, "readonly");
    fs.mkdirSync(readonly);
    const readonlyFile = path.join(readonly, "input.txt");
    const outside = path.join(h.directory, "outside.txt");
    fs.writeFileSync(readonlyFile, "original readonly");
    fs.writeFileSync(outside, "original outside");
    boundaryCommand = `
[IO.File]::WriteAllText(${quote(path.join(h.workspace, "shell.txt"))},'owned shell')
$scope = [ordered]@{outside_read=$false;outside_write=$false;readonly_write=$false}
try {[void][IO.File]::ReadAllText(${quote(outside)});$scope.outside_read=$true} catch {}
try {[IO.File]::WriteAllText(${quote(outside)},'bad');$scope.outside_write=$true} catch {}
try {[IO.File]::WriteAllText(${quote(readonlyFile)},'bad');$scope.readonly_write=$true} catch {}
[IO.File]::WriteAllText(${quote(path.join(h.workspace, "scope.json"))},($scope|ConvertTo-Json -Compress))`;
    if (integrations) {
      const directory = path.join(h.workspace, ".grok");
      fs.mkdirSync(directory);
      const script = `[IO.File]::WriteAllText('${path.join(h.workspace, "unselected-mcp.txt").replaceAll("'", "''")}', 'unselected startup')`;
      fs.writeFileSync(
        path.join(directory, "config.toml"),
        `[mcp_servers.unselected]\ncommand = "powershell.exe"\nargs = ["-NoProfile", "-NonInteractive", "-EncodedCommand", "${Buffer.from(script, "utf16le").toString("base64")}"]\n`,
      );
    }
    await h.core.stop();
    process.env.GROK_MODELS_BASE_URL = real
      ? "https://api.deepseek.com"
      : h.server.origin + "/v1";
    process.env.GROK_DEFAULT_MODEL = real
      ? "deepseek-flash"
      : "owned-grok-model";
    if (!real) process.env[credential] = "TROOP_GROK_FAKE_KEY";
    await h.core.start();
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
      name: "Owned Grok model",
      purpose: "cli_start",
      engine_id: "grok",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace, readonly],
      write_roots: [h.workspace],
      operations: ["start"],
      credential_env_keys: [credential],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    };
    const grant = await command("authorizations.save", {
      expected_revision: 0,
      grant: grantDefinition,
    });
    const started = await command("cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "grok",
      tool_mode: native ? "native" : "disabled",
      authorization_id: grant.id,
      ...(manual ? { approval_mode: "manual" } : {}),
      timeout_seconds: 90,
      goal: real
        ? "In this temporary workspace use read_file and write_file to read input.txt and write result.txt with exactly the same text and no trailing newline. Then reply TROOP_GROK_COMPLETE. Do not access other files."
        : "Reply TROOP_GROK_COMPLETE without using tools.",
    });
    const run = await until(async () => {
      if (manual) {
        for (const request of (
          await h.core.request("cli.interactions", { task_id: started.task_id })
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
      const value = await h.get(started.run.id);
      return value.run.waiting.includes("review") ||
        ["failed", "interrupted"].includes(value.run.state)
        ? value
        : false;
    }, 110000);
    const task = await h.core.request("agent.task", { id: started.task_id });
    report.run = run;
    report.task = task;
    report.requests = h.server.requests.map(({ body, method, url }) => ({
      method: method ?? "POST",
      url,
      model: body.model,
      stream: body.stream,
      tools: body.tools?.map((tool) => tool.function.name),
    }));
    report.toolResults = h.server.requests
      .flatMap(({ body }) =>
        (body.messages ?? []).filter((message) => message.role === "tool"),
      )
      .slice(-16)
      .map((message) => ({
        tool_call_id: message.tool_call_id,
        content: JSON.stringify(message.content).slice(0, 3000),
      }));
    assert.ok(run.run.waiting.includes("review"), JSON.stringify(task.result));
    assert.ok(task.evidence.result.text.includes("TROOP_GROK_COMPLETE"));
    if (!real) assert.ok(report.requests.length > 0);
    if (native) {
      assert.equal(
        fs.readFileSync(path.join(h.workspace, "result.txt"), "utf8"),
        "TROOP_GROK_ARTIFACT",
      );
    }
    if (native && !real) {
      assert.equal(
        fs.readFileSync(path.join(h.workspace, "shell.txt"), "utf8"),
        "owned shell",
      );
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
      assert.ok(
        report.requests
          .filter(
            (request) =>
              request.model === "owned-grok-model" &&
              request.tools?.length &&
              !request.tools.includes("session_title"),
          )
          .every(
            (request) =>
              request.tools.length === 4 &&
              request.tools.every((tool) =>
                ["read_file", "write_file", "edit_file", "shell"].includes(
                  tool,
                ),
              ),
          ),
      );
    } else if (!native)
      assert.ok(
        report.requests
          .filter((request) => request.model === "owned-grok-model")
          .every(
            (request) =>
              !request.tools?.length ||
              (request.tools.length === 1 &&
                request.tools[0] === "session_title"),
          ),
      );
    if (!real)
      assert.ok(
        report.requests
          .filter((request) => request.model)
          .every((request) => request.model === "owned-grok-model"),
      );
    if (!real)
      assert.ok(
        report.requests.some((request) => request.model === "owned-grok-model"),
      );

    if (integrations)
      assert.equal(
        fs.existsSync(path.join(h.workspace, "unselected-mcp.txt")),
        false,
      );
    await command("cli.review", {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: task.evidence.sha256,
      accepted: true,
      note: "Inspected owned fixed text and disabled tool inventory",
    });
    if (lifecycle) {
      assert.ok(native);
      report.lifecycle = [];
      for (const mode of ["stop", "crash", "revoke", "expire"]) {
        const authority = await command("authorizations.save", {
          expected_revision: 0,
          grant: {
            ...grantDefinition,
            name: `Owned Grok ${mode}`,
            expires_at:
              Math.floor(Date.now() / 1000) + (mode === "expire" ? 20 : 300),
          },
        });
        const held = await command("cli.start", {
          client_run_id: crypto.randomUUID(),
          workspace_id: h.wid,
          engine_id: "grok",
          tool_mode: "native",
          authorization_id: authority.id,
          goal: `TROOP_GROK_LIFECYCLE_${mode}`,
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
          if (mode !== "expire")
            await command(
              mode === "stop" ? "agent.stop-task" : "authorizations.revoke",
              mode === "stop"
                ? { id: held.task_id }
                : { id: authority.id, expected_revision: authority.revision },
            );
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
            note: "Verified the owned PowerShell PID has exited and inspected its marker",
          });
        else assert.equal(task.stopped, true);
        await h.core.stop();
        await h.core.start();
        const current = await h.get(held.run.id);
        assert.equal(current.allowed_actions.resume.allowed, false);
        assert.equal(current.tasks.length, 1);
        assert.equal(
          fs.existsSync(path.join(h.workspace, `late-${mode}.txt`)),
          false,
        );
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
    const directory = path.resolve("verification/grok-core-2026-11-08");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(
        directory,
        real
          ? manual
            ? "real-manual.json"
            : "real-native.json"
          : lifecycle
            ? "mock-lifecycle.json"
            : integrations
              ? "mock-integrations.json"
              : `mock-${native ? "native" : "text"}.json`,
      ),
      JSON.stringify(report, null, 2),
    );
  }
  console.log("Grok managed acceptance passed.");
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
