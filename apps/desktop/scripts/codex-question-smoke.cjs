const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const { until } = require("../test/fixtures/hooks-fixture.cjs");
async function main() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "troop-codex-question-"),
  );
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const core = new CoreSupervisor({
    executable: path.resolve(__dirname, "../bin", coreBinary),
    args: ["--data-dir", path.join(directory, "data")],
  });
  const report = {
    directory,
    realEngine: true,
    realModel: true,
    passed: false,
  };
  try {
    await core.start();
    const wid = (await core.request("workspace.add", { path: workspace }))
      .items[0].id;
    const command = async (method, input) => {
      const result = await core.request("operations.execute", {
        operation_id: crypto.randomUUID(),
        instance_id: core.snapshot().storage_instance,
        method,
        input,
      });
      assert.equal(result.state, "committed", JSON.stringify(result.error));
      return result.result;
    };
    const grant = await command("authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "Owned synthetic Codex question",
        purpose: "cli_start",
        engine_id: "codex",
        agent_id: 1,
        workspace_id: wid,
        project_ids: [],
        read_roots: [workspace],
        read_all: true,
        write_roots: [workspace],
        operations: ["start"],
        network: "any",
        expires_at: Math.floor(Date.now() / 1000) + 600,
      },
    });
    const started = await command("cli.start", {
      client_run_id: crypto.randomUUID(),
      engine_id: "codex",
      workspace_id: wid,
      authorization_id: grant.id,
      collaboration_mode: "plan",
      timeout_seconds: 180,
      goal: "This is a fixed synthetic TROOP_CODEX_ARTIFACT interaction acceptance task. Use the request_user_input tool exactly once to ask which synthetic target to choose, with two options Alpha and Beta. Wait for the actual user tool response. Then reply TROOP_CODEX_QUESTION_COMPLETE and name the selected target. Complete this question-only task without reading files or invoking file, shell, web, or MCP tools.",
    });
    report.runId = started.run.id;
    const request = await until(async () => {
      const item = (
        await core.request("cli.interactions", { task_id: started.task_id })
      ).items[0];
      if (item) return item;
      const run = await core.request("agent.get", { id: started.run.id });
      if (
        ["failed", "interrupted", "completed"].includes(run.run.state) ||
        run.run.waiting.includes("review")
      )
        throw Error(
          JSON.stringify(
            await core.request("agent.task", { id: started.task_id }),
          ),
        );
      return false;
    }, 180000);
    report.question = request;
    const answers = Object.fromEntries(
      request.body.questions.map((question) => [
        question.id,
        [question.options[0].label],
      ]),
    );
    await command("cli.respond", {
      interaction_id: request.interaction_id,
      expected_revision: request.revision,
      task_epoch: request.task_epoch,
      request_sha256: request.request_sha256,
      answer: { kind: "question", answers },
    });
    await until(async () => {
      for(const plan of (await core.request("cli.interactions",{task_id:started.task_id})).items.filter(item=>item.state==="pending"&&item.kind==="plan")) {
        report.plan=plan;
        await command("cli.respond",{interaction_id:plan.interaction_id,expected_revision:plan.revision,task_epoch:plan.task_epoch,request_sha256:plan.request_sha256,answer:{kind:"plan",accepted:true,plan_sha256:plan.body.sha256}});
      }
      const value = await core.request("agent.get", { id: started.run.id });
      if(["failed","interrupted"].includes(value.run.state))throw Error(JSON.stringify(value.run.error));
      return value.run.waiting.includes("review");
    }, 180000);
    const task = await core.request("agent.task", { id: started.task_id });
    report.task = task;
    report.interaction = await core.request("cli.interaction", {
      interaction_id: request.interaction_id,
    });
    assert.equal(report.interaction.delivery.write_state, "written");
    assert.ok(
      task.evidence.result.text.includes("TROOP_CODEX_QUESTION_COMPLETE"),
    );
    await command("cli.review", {
      id: task.id,
      epoch: task.epoch,
      expected_task_revision: task.revision,
      evidence_sha256: task.evidence.sha256,
      accepted: true,
      note: "Verified fixed synthetic question and actual selected answer",
    });
    report.passed = true;
  } finally {
    await core.stop();
    report.coreStopped = !core.child;
    const file = path.resolve(
      "verification/cli-interactions-2026-11-08/real-codex-question.json",
    );
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  }
  console.log("Real Codex question and answer acceptance passed.");
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
