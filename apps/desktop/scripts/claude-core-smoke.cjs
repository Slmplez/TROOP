const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setup, until } = require("../test/fixtures/hooks-fixture.cjs");
const destination = path.resolve("verification/claude-core-2026-11-08");
fs.mkdirSync(destination, { recursive: true });
async function main() {
  const cleanup = [];
  const real = process.argv.includes("--real");
  const native = !process.argv.includes("--text");
  const manual = process.argv.includes("--manual");
  const question = process.argv.includes("--question");
  const shellTest = process.argv.includes("--shell");
  const lifecycle = process.argv.includes("--lifecycle");
  assert.ok(
    !lifecycle || !real || question,
    "Lifecycle mutation uses only an owned fake settings file",
  );
  const report = { version: "2.1.319", realModel: real, native, checks: [] };
  let shellCommand;
  const h = await setup(
    { after: (fn) => cleanup.push(fn) },
    {
      plan: ({ body }) => {
        if (
          body.messages.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "tool_result"),
          )
        )
          return [];
        const mode = ["stop", "crash", "revoke", "settings"].find((value) =>
          JSON.stringify(body.messages).includes(
            `TROOP_CLAUDE_LIFECYCLE_${value}`,
          ),
        );
        if (mode)
          return [
            {
              name: "PowerShell",
              arguments: {
                command: `
[System.IO.File]::WriteAllText('${path.join(h.workspace, `started-${mode}.txt`).replaceAll("'", "''")}',$PID.ToString())
Start-Sleep -Seconds 20
[System.IO.File]::WriteAllText('${path.join(h.workspace, `late-${mode}.txt`).replaceAll("'", "''")}', 'bad')
`,
                description: "Wait for owned lifecycle verification",
              },
            },
          ];
        if (question)
          return [
            {
              name: "AskUserQuestion",
              arguments: {
                questions: [
                  {
                    question: "Choose an owned synthetic target",
                    header: "Target",
                    options: [
                      { label: "Alpha", description: "First synthetic target" },
                      { label: "Beta", description: "Second synthetic target" },
                    ],
                    multiSelect: false,
                  },
                ],
              },
            },
          ];
        return native
          ? [
              {
                name: "Read",
                arguments: { file_path: path.join(h.workspace, "input.txt") },
              },
              {
                name: "Write",
                arguments: {
                  file_path: path.join(h.workspace, "result.txt"),
                  content: "TROOP_CLAUDE_ARTIFACT",
                },
              },
              ...(shellTest
                ? [
                    {
                      name: "PowerShell",
                      arguments: {
                        command: shellCommand,
                        description: "Inspect owned filesystem boundaries",
                      },
                    },
                  ]
                : []),
            ]
          : [];
      },
      reply: () => "TROOP_CLAUDE_COMPLETE",
    },
  );
  try {
    fs.writeFileSync(
      path.join(h.workspace, "input.txt"),
      "TROOP_CLAUDE_ARTIFACT",
    );
    const readonly = path.join(h.directory, "readonly");
    fs.mkdirSync(readonly);
    const outside = path.join(h.directory, "outside.txt");
    fs.writeFileSync(outside, "original outside");
    fs.writeFileSync(path.join(readonly, "input.txt"), "original readonly");
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    shellCommand = `
$scope = [ordered]@{outside_read=$false;outside_write=$false;readonly_write=$false}
try {[void][System.IO.File]::ReadAllText(${quote(outside)});$scope.outside_read=$true} catch {}
try {[System.IO.File]::WriteAllText(${quote(outside)},'bad');$scope.outside_write=$true} catch {}
try {[System.IO.File]::WriteAllText(${quote(path.join(readonly, "input.txt"))},'bad');$scope.readonly_write=$true} catch {}
[System.IO.File]::WriteAllText(${quote(path.join(h.workspace, "scope.json"))},($scope|ConvertTo-Json -Compress))
`;
    const shell = require("node:child_process").spawnSync(
      "where.exe",
      ["pwsh.exe"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(shell.status, 0);
    const shellRoot = path.dirname(shell.stdout.trim().split(/\r?\n/)[0]);
    const file = real
      ? path.join(process.env.USERPROFILE, ".claude/settings.json")
      : path.join(h.directory, "model-settings.json");
    if (!real)
      fs.writeFileSync(
        file,
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: h.server.origin,
            ANTHROPIC_AUTH_TOKEN: "TROOP_CLAUDE_FAKE_KEY",
            ANTHROPIC_MODEL: "owned-claude-model",
          },
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "must not execute" }] },
            ],
          },
        }),
      );
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
      name: "Existing Claude settings acceptance",
      purpose: "cli_start",
      engine_id: "claude",
      agent_id: 1,
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace, readonly, ...(native ? [shellRoot] : [])],
      write_roots: [h.workspace],
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      model_settings: { file },
    };
    const grant = await command("authorizations.save", {
      expected_revision: 0,
      grant: grantDefinition,
    });
    const started = await command("cli.start", {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "claude",
      tool_mode: native ? "native" : "disabled",
      authorization_id: grant.id,
      ...(manual ? { approval_mode: "manual" } : {}),
      timeout_seconds: 120,
      goal: question
        ? "Use AskUserQuestion to ask one question with Alpha and Beta options. Wait for my answer and then reply TROOP_CLAUDE_COMPLETE. Do not read files or use any other tools."
        : native
          ? "In this temporary workspace, read input.txt and write result.txt with exactly the same text and no trailing newline. Use only file tools. Then reply TROOP_CLAUDE_COMPLETE. Do not access other files. The fixed synthetic text is TROOP_CLAUDE_ARTIFACT."
          : "Reply TROOP_CLAUDE_COMPLETE. Do not use tools or read files.",
    });
    const run = await until(async () => {
      if (manual) {
        for (const request of (
          await h.core.request("cli.interactions", { task_id: started.task_id })
        ).items.filter((item) => item.state === "pending")) {
          const answer =
            request.kind === "question"
              ? {
                  kind: "question",
                  answers: Object.fromEntries(
                    request.body.questions.map((item) => [
                      item.id,
                      [item.options[0].label],
                    ]),
                  ),
                }
              : {
                  kind: "permission",
                  option_id: request.allowed_actions.approve.allowed
                    ? "once"
                    : "reject",
                };
          report.interactions ??= [];
          report.interactions.push(request);
          await command("cli.respond", {
            interaction_id: request.interaction_id,
            expected_revision: request.revision,
            task_epoch: request.task_epoch,
            request_sha256: request.request_sha256,
            answer,
          });
        }
      }
      const value = await h.get(started.run.id);
      return value.run.waiting.includes("review") ||
        ["failed", "interrupted"].includes(value.run.state)
        ? value
        : false;
    }, 150000);
    const task = await h.core.request("agent.task", { id: started.task_id });
    report.run = run;
    report.task = task;
    report.mockRequests = h.server.requests.map(({ body, url }) => ({
      url,
      stream: body.stream,
      model: body.model,
      tools: body.tools?.map((tool) => tool.name),
    }));
    assert.ok(run.run.waiting.includes("review"), JSON.stringify(task.result));
    assert.ok(task.evidence.result.text.includes("TROOP_CLAUDE_COMPLETE"));
    if (native && !question)
      assert.equal(
        fs.readFileSync(path.join(h.workspace, "result.txt"), "utf8"),
        "TROOP_CLAUDE_ARTIFACT",
      );
    if (shellTest) {
      report.boundary = JSON.parse(
        fs.readFileSync(path.join(h.workspace, "scope.json"), "utf8"),
      );
      assert.deepEqual(report.boundary, {
        outside_read: false,
        outside_write: false,
        readonly_write: false,
      });
      assert.equal(fs.readFileSync(outside, "utf8"), "original outside");
      assert.equal(
        fs.readFileSync(path.join(readonly, "input.txt"), "utf8"),
        "original readonly",
      );
    }
    assert.equal(task.evidence.result.tool_inventory_readback, true);
    await command("cli.review", {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: task.evidence.sha256,
      accepted: true,
      note: "Inspected the fixed configured Claude task",
    });
    report.checks.push(
      "real Claude native program uses an explicitly bound settings identity, confirms tools and permissions, completes its prompt and seals reviewable evidence",
    );
    if (question && lifecycle) {
      report.questionLifecycle = [];
      for (const mode of ["stop", "revoke"]) {
        const held = await command("cli.start", {
          client_run_id: crypto.randomUUID(),
          workspace_id: h.wid,
          engine_id: "claude",
          tool_mode: "native",
          authorization_id: grant.id,
          approval_mode: "manual",
          goal: "Use AskUserQuestion to ask one question with Alpha and Beta options. Wait for my answer, then reply TROOP_CLAUDE_COMPLETE. Do not read files or use any other tools.",
          timeout_seconds: 120,
        });
        const pending = await until(
          async () =>
            (
              await h.core.request("cli.interactions", {
                task_id: held.task_id,
              })
            ).items.find((item) => item.state === "pending"),
          150000,
        );
        await command(
          mode === "stop" ? "agent.stop-task" : "authorizations.revoke",
          mode === "stop"
            ? { id: held.task_id }
            : { id: grant.id, expected_revision: grant.revision },
        );
        await h.done(held.run.id);
        const late = await h.core.request("operations.execute", {
          operation_id: crypto.randomUUID(),
          instance_id: h.core.snapshot().storage_instance,
          method: "cli.respond",
          input: {
            interaction_id: pending.interaction_id,
            expected_revision: pending.revision,
            task_epoch: pending.task_epoch,
            request_sha256: pending.request_sha256,
            answer: {
              kind: "question",
              answers: Object.fromEntries(
                pending.body.questions.map((item) => [
                  item.id,
                  [item.options[0].label],
                ]),
              ),
            },
          },
        });
        assert.equal(late.state, "rejected");
        const task = await h.core.request("agent.task", { id: held.task_id });
        assert.equal(task.stopped, true);
        report.questionLifecycle.push({ mode, task_id: held.task_id, late });
      }
    }
    if (lifecycle && !question) {
      report.lifecycle = [];
      for (const mode of ["stop", "crash", "revoke", "settings"]) {
        const authority = await command("authorizations.save", {
          expected_revision: 0,
          grant: { ...grantDefinition, name: `Owned Claude ${mode}` },
        });
        const held = await command("cli.start", {
          client_run_id: crypto.randomUUID(),
          workspace_id: h.wid,
          engine_id: "claude",
          tool_mode: "native",
          authorization_id: authority.id,
          goal: `TROOP_CLAUDE_LIFECYCLE_${mode}`,
          timeout_seconds: 120,
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
            changed.env.ANTHROPIC_AUTH_TOKEN += "_changed";
            fs.writeFileSync(file, JSON.stringify(changed));
          } else
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
          taskState: (await h.core.request("agent.task", { id: task.id }))
            .state,
        });
      }
      report.checks.push(
        "real native PowerShell stops on user stop, Core crash, grant revoke and model-settings identity change; restart keeps one task and refuses replay",
      );
    }
    report.passed = true;
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    report.coreStopped = !h.core.child;
    fs.writeFileSync(
      path.join(
        destination,
        question && lifecycle
          ? `${real ? "real" : "mock"}-question-lifecycle.json`
          : lifecycle
            ? "mock-lifecycle.json"
            : `${real ? "real" : "mock"}-${question ? "question" : manual ? "manual" : native ? "native" : "text"}.json`,
      ),
      JSON.stringify(report, null, 2),
    );
  }
  console.log("Claude managed acceptance passed.");
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
