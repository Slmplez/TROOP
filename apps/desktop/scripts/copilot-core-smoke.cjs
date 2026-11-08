const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  setup,
  until,
  quote,
  user,
} = require("../test/fixtures/hooks-fixture.cjs");
const destination = path.resolve("verification/copilot-core-2026-11-08");
fs.mkdirSync(destination, { recursive: true });

async function main() {
  const cleanup = [];
  const native = !process.argv.includes("--text");
  const real = process.argv.includes("--real");
  const eventMode = process.argv.includes("--event");
  const manual = process.argv.includes("--manual");
  const question = process.argv.includes("--question");
  assert.ok(!manual || native);
  const report = {
    engine: "copilot",
    version: "1.0.107",
    modelService: real
      ? "existing_deepseek_environment"
      : "owned_loopback_mock",
    native,
    manual,
    checks: [],
  };
  let boundary, outside, readonly;
  const h = await setup(
    { after: (fn) => cleanup.push(fn) },
    {
      protocol: "chat_completions",
      plan: ({ body }) => {
        if (
          user(body).startsWith("<<TROOP_MEMORY_") ||
          body.messages.some((message) => message.role === "tool")
        )
          return [];
        const mode = ["stop", "crash", "revoke"].find((value) =>
          JSON.stringify(body.messages).includes(`TROOP_LIFECYCLE_${value}`),
        );
        if (mode)
          return [
            {
              name: "powershell",
              arguments: {
                command: `
[System.IO.File]::WriteAllText(${quote(path.join(h.workspace, `started-${mode}.txt`))}, $PID.ToString())
Start-Sleep -Seconds 20
[System.IO.File]::WriteAllText(${quote(path.join(h.workspace, `late-${mode}.txt`))}, 'bad')
`,
                description: "Wait for owned lifecycle acceptance",
                mode: "sync",
              },
            },
          ];
        if (JSON.stringify(body.messages).includes("TROOP_CORE_DENIES_OUTSIDE"))
          return [{ name: "view", arguments: { path: outside } }];
        if (question)
          return [
            {
              name: "ask_user",
              arguments: {
                question: "Choose an owned synthetic target",
                choices: ["Alpha", "Beta"],
                allowFreeform: false,
              },
            },
          ];
        return native
          ? [
              {
                name: "create",
                arguments: {
                  path: path.join(h.workspace, "result.txt"),
                  file_text: "TROOP_COPILOT_ARTIFACT",
                },
              },
              {
                name: "powershell",
                arguments: {
                  command: boundary,
                  description: "Check owned filesystem boundaries",
                  mode: "sync",
                },
              },
            ]
          : [];
      },
      reply: ({ body }) =>
        user(body).startsWith("<<TROOP_MEMORY_")
          ? '{"additions":[{"content":"Synthetic acceptance artifacts use TROOP_COPILOT_ARTIFACT","tier":"profile"}],"removals":[]}'
          : "TROOP_COPILOT_COMPLETE",
      coreArgs: ["--event-listen", "127.0.0.1:0"],
    },
  );
  try {
    outside = path.join(h.directory, "outside.txt");
    readonly = path.join(h.directory, "readonly");
    fs.mkdirSync(readonly);
    fs.writeFileSync(outside, "TROOP_OUTSIDE_COPILOT_SECRET");
    fs.writeFileSync(
      path.join(h.workspace, "input.txt"),
      "TROOP_COPILOT_ARTIFACT",
    );
    fs.writeFileSync(path.join(readonly, "input.txt"), "original readonly");
    const scopeTargets = path.join(h.workspace, "scope-targets.json");
    fs.writeFileSync(
      scopeTargets,
      JSON.stringify({ outside, readonly: path.join(readonly, "input.txt") }),
    );
    boundary = `
$scopeTargets=Get-Content -LiteralPath ${quote(scopeTargets)} -Raw | ConvertFrom-Json
$result = [ordered]@{ outside_read = $false; outside_write = $false; readonly_write = $false }
try { [void][System.IO.File]::ReadAllText(($scopeTargets.outside)); $result.outside_read = $true } catch {}
try { [System.IO.File]::WriteAllText(($scopeTargets.outside), 'bad'); $result.outside_write = $true } catch {}
try { [System.IO.File]::WriteAllText(($scopeTargets.readonly), 'bad'); $result.readonly_write = $true } catch {}
[System.IO.File]::WriteAllText(${quote(path.join(h.workspace, "scope.json"))}, ($result | ConvertTo-Json -Compress))
`;
    await h.core.stop();
    process.env.COPILOT_PROVIDER_BASE_URL = real
      ? "https://api.deepseek.com"
      : h.server.origin;
    process.env.COPILOT_MODEL = real ? "deepseek-flash" : "owned-copilot-model";
    if (real) {
      assert.ok(
        process.env.DEEPSEEK_API_KEY,
        "Existing DeepSeek environment credential is unavailable",
      );
      process.env.COPILOT_PROVIDER_API_KEY = process.env.DEEPSEEK_API_KEY;
    }
    process.env.COPILOT_PROVIDER_TYPE = "openai";
    process.env.COPILOT_PROVIDER_WIRE_API = "completions";
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
    const hookDirectory = path.join(h.workspace, ".github", "hooks");
    fs.mkdirSync(hookDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(hookDirectory, "canary.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            {
              type: "command",
              powershell: "Set-Content hook-ran.txt unauthorized",
              timeoutSec: 5,
            },
          ],
        },
      }),
    );
    const repoConfig = path.join(h.workspace, ".github", "copilot");
    fs.mkdirSync(repoConfig, { recursive: true });
    fs.writeFileSync(
      path.join(repoConfig, "settings.json"),
      JSON.stringify({ disableAllHooks: false }),
    );
    const ruleId = eventMode ? crypto.randomUUID() : null;
    const grant = await command("authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "Copilot owned local protocol acceptance",
        purpose: "cli_start",
        agent_id: 1,
        engine_id: "copilot",
        workspace_id: h.wid,
        project_ids: [],
        read_roots: [h.workspace, readonly],
        write_roots: [h.workspace],
        operations: ["start"],
        network: "any",
        expires_at: Math.floor(Date.now() / 1000) + 300,
        rule_id: ruleId,
        credential_env_keys: real ? ["COPILOT_PROVIDER_API_KEY"] : [],
      },
    });
    const start = {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      engine_id: "copilot",
      tool_mode: native ? "native" : "disabled",
      ...(manual ? { approval_mode: "manual" } : {}),
      ...(question ? { native_transport: "sdk_questions" } : {}),
      authorization_id: grant.id,
      rule_id: ruleId,
      goal: question
        ? "Call ask_user to ask one question with Alpha and Beta choices. Wait for my answer, then reply TROOP_COPILOT_COMPLETE. Do not use other tools or read files."
        : real
          ? native
            ? "In the current workspace, read input.txt and create result.txt with exactly the same text, without a trailing newline. Use only native file tools. Then reply TROOP_COPILOT_COMPLETE. Do not read other files. The fixed synthetic content is TROOP_COPILOT_ARTIFACT."
            : "Reply TROOP_COPILOT_COMPLETE. Do not use tools or read any files."
          : "Synthetic acceptance artifacts use TROOP_COPILOT_ARTIFACT. Write the fixed artifact when tools are enabled, then return TROOP_COPILOT_COMPLETE.",
      timeout_seconds: real ? 120 : 60,
    };
    let started;
    if (eventMode) {
      const api = require("node:http").createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: Number(request.url.split("/").at(-1)),
            run_attempt: 1,
            status: "completed",
            conclusion: "failure",
          }),
        );
      });
      await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
      cleanup.push(() => new Promise((resolve) => api.close(resolve)));
      const sourceId = crypto.randomUUID();
      const secret = crypto.randomBytes(32).toString("hex");
      await command("events.source.save", {
        id: sourceId,
        expected_revision: 0,
        definition: {
          name: "Mock GitHub native CLI acceptance",
          kind: "github",
          project: "owner/repo",
          workspace_id: h.wid,
          enabled: true,
          mode: "local",
          api_base_url: `http://127.0.0.1:${api.address().port}`,
          consumer_id: h.core.snapshot().storage_instance,
        },
        secrets: {
          webhook_secret: secret,
          consumer_token: crypto.randomBytes(32).toString("hex"),
        },
      });
      await command("rules.save", {
        id: ruleId,
        expected_revision: 0,
        rule: {
          name: "Mock workflow to native CLI",
          enabled: true,
          event: "github.workflow.completed",
          event_state: "failure",
          source_id: sourceId,
          source_run_id: null,
          workspace_id: h.wid,
          expires_at: grant.expires_at,
          start,
        },
      });
      const agent = (await h.core.request("memory.agents", {}))[0];
      await h.core.request("memory.agent.save", {
        id: 1,
        name: agent.name,
        automatic: true,
        dreaming: false,
        expected_revision: agent.revision,
      });
      await command("memory.maintenance.save", {
        agent_id: 1,
        expected_revision: 0,
        enabled: true,
        provider_id: h.provider.id,
        model: "independent-synthetic-maintainer",
        target_scope: "agent",
        target_project: "",
      });
      const body = JSON.stringify({
        action: "completed",
        repository: { full_name: "owner/repo" },
        workflow_run: {
          id: 42,
          run_attempt: 1,
          status: "completed",
          conclusion: "failure",
        },
      });
      const receiver = (await h.core.request("events.health", {})).address;
      const headers = {
        "x-github-event": "workflow_run",
        "x-github-delivery": "owned-cli-joint",
        "x-hub-signature-256":
          "sha256=" +
          crypto.createHmac("sha256", secret).update(body).digest("hex"),
      };
      assert.equal(
        (
          await fetch(`${receiver}/webhooks/${sourceId}`, {
            method: "POST",
            headers,
            body,
          })
        ).status,
        202,
      );
      const delivery = await until(async () =>
        (await h.core.request("rules.history", { id: ruleId })).deliveries.find(
          (entry) => entry.state === "dispatched",
        ),
      );
      started = {
        run: { id: delivery.run_id },
        task_id: (await h.get(delivery.run_id)).tasks[0].id,
      };
      report.event = { sourceId, ruleId, delivery };
      assert.equal(
        (
          await fetch(`${receiver}/webhooks/${sourceId}`, {
            method: "POST",
            headers,
            body,
          })
        ).status,
        202,
      );
    } else {
      started = await command("cli.start", start);
    }
    const run = await until(
      async () => {
        const value = await h.get(started.run.id);
        if (manual || process.argv.includes("--inspect-interactions")) {
          report.interactions = (
            await h.core.request("cli.interactions", {
              task_id: started.task_id,
            })
          ).items;
          const pending = report.interactions.find(
            (item) => item.state === "pending",
          );
          if (pending && manual) {
            const kind = pending.allowed_actions.approve?.allowed
              ? "allow_once"
              : "reject_once";
            const option = pending.body.options?.find(
              (option) => option.kind === kind,
            );
            assert.ok(
              pending.kind === "question" || option,
              "Native request has no supported one-time option",
            );
            await command("cli.respond", {
              interaction_id: pending.interaction_id,
              expected_revision: pending.revision,
              task_epoch: pending.task_epoch,
              request_sha256: pending.request_sha256,
              answer:
                pending.kind === "question"
                  ? {
                      kind: "question",
                      answers: {
                        choice: [pending.body.questions[0].options[0].label],
                      },
                    }
                  : { kind: "permission", option_id: option.optionId },
            });
            (report.manualDecisions ??= []).push({
              interaction_id: pending.interaction_id,
              option_id: option?.optionId,
            });
          }
          if (pending && !manual)
            throw Error(
              "Native permission requires inspection: " +
                JSON.stringify(pending),
            );
        }
        return value.run.waiting.includes("review") ||
          ["failed", "interrupted"].includes(value.run.state)
          ? value
          : false;
      },
      real ? 150000 : 90000,
    );
    const task = await h.core.request("agent.task", { id: started.task_id });
    report.run = run;
    report.task = task;
    report.requests = h.server.requests.map(({ body }) => ({
      model: body.model,
      tools: body.tools,
      messages: body.messages,
    }));
    assert.ok(run.run.waiting.includes("review"), JSON.stringify(task.result));
    assert.equal(fs.existsSync(path.join(h.workspace, "hook-ran.txt")), false);
    report.checks.push(
      question
        ? "real native CLI completes its SDK question callback with the admitted tool set and suppresses repository command Hooks"
        : "real native CLI with a fresh profile completes ACP and suppresses repository command Hooks",
    );
    if (native && !question) {
      assert.equal(
        fs.readFileSync(path.join(h.workspace, "result.txt"), "utf8"),
        "TROOP_COPILOT_ARTIFACT",
      );
      if (!real) {
        report.boundary = JSON.parse(
          fs.readFileSync(path.join(h.workspace, "scope.json"), "utf8"),
        );
        assert.deepEqual(report.boundary, {
          outside_read: false,
          outside_write: false,
          readonly_write: false,
        });
        assert.equal(
          fs.readFileSync(outside, "utf8"),
          "TROOP_OUTSIDE_COPILOT_SECRET",
        );
        assert.equal(
          fs.readFileSync(path.join(readonly, "input.txt"), "utf8"),
          "original readonly",
        );
        assert.equal(
          JSON.stringify(report.requests).includes(
            "TROOP_OUTSIDE_COPILOT_SECRET",
          ),
          false,
        );
        report.checks.push(
          "native PowerShell and file tools preserve outside and readonly files and withhold outside contents from the model",
        );
      }
    } else if (question) assert.ok(task.evidence.result.questions_answered > 0);
    else assert.equal(task.evidence.result.tool_call_count, 0);
    await command("cli.review", {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: task.evidence.sha256,
      accepted: true,
      note: "Inspected local protocol artifact",
    });
    report.checks.push(
      "fixed evidence is reviewable through the production command ledger",
    );
    if (real) {
      assert.ok(task.evidence.result.text.includes("TROOP_COPILOT_COMPLETE"));
      assert.equal(task.evidence.result.model, "deepseek-flash");
      assert.equal(task.evidence.result.provider, "https://api.deepseek.com");
      report.checks.push(
        "real DeepSeek model through the existing in-memory environment credential completes the scoped native task",
      );
    }
    if (native && !real && !manual) {
      const denied = await command("cli.start", {
        ...start,
        client_run_id: crypto.randomUUID(),
        goal: "TROOP_CORE_DENIES_OUTSIDE",
      });
      await h.done(denied.run.id);
      const deniedTask = await h.core.request("agent.task", {
        id: denied.task_id,
      });
      const decision = (
        await h.core.request("cli.interactions", { task_id: denied.task_id })
      ).items[0];
      assert.equal(decision.decision.answer.option_id, "reject_once");
      assert.equal(decision.decision.actor, "authorization");
      assert.equal(deniedTask.stopped, true);
      assert.equal(
        fs.readFileSync(outside, "utf8"),
        "TROOP_OUTSIDE_COPILOT_SECRET",
      );
      await command("agent.reconcile-task", {
        id: deniedTask.id,
        epoch: deniedTask.epoch,
        source: "reviewed",
        note: "Inspected the owned denied read, unchanged fixture file and stopped native process",
      });
      report.deniedPermission = decision;
      report.checks.push(
        "Core durably rejects the explicit outside-path permission; the native tool remains denied and its stopped outcome is reconciled separately",
      );
    }
    if (eventMode) {
      report.maintenance = await until(async () =>
        (await h.core.request("memory.jobs", { agent_id: 1 })).find(
          (entry) =>
            entry.source_run_id === started.run.id &&
            entry.state === "completed",
        ),
      );
      assert.equal(
        (await h.core.request("memory.list", { agent_id: 1 })).items[0].content,
        "Synthetic acceptance artifacts use TROOP_COPILOT_ARTIFACT",
      );
      assert.equal(
        (await h.core.request("rules.history", { id: ruleId })).deliveries
          .length,
        1,
      );
      report.checks.push(
        "authenticated mock GitHub event, current-state review, rule-scoped native CLI, sealed artifact review and independent memory maintenance complete one production chain",
      );
    }
    if (question && process.argv.includes("--lifecycle")) {
      report.questionLifecycle = [];
      for (const mode of ["stop", "revoke"]) {
        const held = await command("cli.start", {
          ...start,
          client_run_id: crypto.randomUUID(),
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
              answers: { choice: [pending.body.questions[0].options[0].label] },
            },
          },
        });
        assert.equal(late.state, "rejected");
        const stopped = await h.core.request("agent.task", {
          id: held.task_id,
        });
        assert.equal(stopped.stopped, true);
        report.questionLifecycle.push({ mode, task: stopped, late });
      }
    }
    if (!question && process.argv.includes("--lifecycle")) {
      for (const mode of ["stop", "crash", "revoke"]) {
        const held = await command("cli.start", {
          ...start,
          client_run_id: crypto.randomUUID(),
          goal: `TROOP_LIFECYCLE_${mode}`,
          tool_mode: "native",
        });
        await until(async () => {
          if (fs.existsSync(path.join(h.workspace, `started-${mode}.txt`)))
            return true;
          const state = await h.get(held.run.id);
          if (
            state.run.waiting.includes("review") ||
            ["failed", "interrupted"].includes(state.run.state)
          )
            throw Error(
              JSON.stringify(
                await h.core.request("agent.task", { id: held.task_id }),
              ),
            );
          return false;
        }, 60000);
        const shellPid = Number(
          fs.readFileSync(
            path.join(h.workspace, `started-${mode}.txt`),
            "utf8",
          ),
        );
        assert.ok(Number.isInteger(shellPid) && shellPid > 0);
        if (mode === "crash") {
          const exited = require("node:events").once(h.core.child, "exit");
          h.core.child.kill();
          await exited;
          await new Promise((resolve) => setTimeout(resolve, 500));
          await h.core.start();
        } else {
          await command(
            mode === "revoke" ? "authorizations.revoke" : "agent.stop-task",
            mode === "revoke"
              ? { id: grant.id, expected_revision: grant.revision }
              : { id: held.task_id },
          );
          await h.done(held.run.id);
        }
        const stopped = await h.get(held.run.id);
        assert.equal(stopped.allowed_actions.resume.allowed, false);
        const heldTask = await h.core.request("agent.task", {
          id: held.task_id,
        });
        await until(() => {
          try {
            process.kill(shellPid, 0);
            return false;
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            return true;
          }
        });
        if (mode === "crash") {
          assert.equal(heldTask.state, "indeterminate");
          await command("agent.reconcile-task", {
            id: heldTask.id,
            epoch: heldTask.epoch,
            source: "reviewed",
            note: "Inspected the owned sleeping process and its fixed marker",
          });
        } else assert.equal(heldTask.stopped, true);
        await h.core.stop();
        await h.core.start();
        assert.equal((await h.get(held.run.id)).tasks.length, 1);
        assert.equal(
          fs.existsSync(path.join(h.workspace, `late-${mode}.txt`)),
          false,
        );
        report.checks.push(
          `real native Copilot ${mode} stops its PowerShell descendant and remains unreplayed after restart`,
        );
      }
    }
    if (manual) assert.ok(report.manualDecisions?.length > 0);
    await h.core.stop();
    if (real)
      report.credentialScan =
        require("../test/fixtures/cli-credential-scan.cjs")(
          h.directory,
          process.env.DEEPSEEK_API_KEY,
        );
    report.passed = true;
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    report.coreStopped = !h.core.child;
    fs.writeFileSync(
      path.join(
        destination,
        manual
          ? real
            ? question
              ? "real-question.json"
              : "real-native-manual.json"
            : question
              ? "mock-question.json"
              : "mock-native-manual.json"
          : real
            ? eventMode
              ? "real-native-event.json"
              : native
                ? "real-native.json"
                : "real-text.json"
            : eventMode
              ? "mock-native-event.json"
              : process.argv.includes("--lifecycle")
                ? "mock-lifecycle.json"
                : native
                  ? "mock-native.json"
                  : "mock-text.json",
      ),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(
    `Copilot real CLI and ${real ? "real DeepSeek" : "mock-model"} acceptance passed.`,
  );
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
