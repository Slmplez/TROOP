const { app } = require("electron");
const { bootstrap } = require("../src/main.cjs");
const { sleep, agentServer } = require("./fixtures/agent-server.cjs");
const { hook, results } = require("./fixtures/hooks-fixture.cjs");
const { mcpServer } = require("./fixtures/mcp-agent-server.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const profile = process.argv[2],
  report = { checks: [], passed: false };
const cliEngine = process.argv[3] ?? "codex";
const nativeTools =
  ["pi", "oh-my-pi", "copilot", "claude", "opencode", "grok"].includes(
    cliEngine,
  ) && process.argv.includes("--native");
const cliPeer = {
  codex: { program: "cli_protocol_probe", text: "owned CLI output" },
  "oh-my-pi": { program: "omp_protocol_probe", text: "Owned OMP text result" },
  pi: { program: "pi_protocol_probe", text: "Owned Pi text result" },
  copilot: {
    program: "copilot_protocol_probe",
    text: "Owned Copilot text result",
  },
  claude: {
    program: "claude_protocol_probe",
    text: "Owned Claude text result",
  },
  opencode: {
    program: "opencode_protocol_probe",
    text: "Owned OpenCode text result",
  },
  grok: { program: "grok_protocol_probe", text: "Owned Grok text result" },
}[cliEngine];
let runtime, promptServer, remoteServer;
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(30);
  }
  throw Error("Authorization UI timed out");
}
async function run() {
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "input.txt"), "owned");
  runtime = await bootstrap({ userData: profile, show: false });
  const { core, window: win } = runtime;
  win.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  await core.request("memory.agent.save", {
    id: 1,
    name: "Authorization fixture",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code, true);
    } catch (error) {
      throw new Error(
        `Desktop acceptance script failed. ${code} ${error.message}`,
        {
          cause: error,
        },
      );
    }
  };
  const field = async (id, value, type = "HTMLInputElement") => {
    await js(
      `(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(45);
  };
  win.webContents.reload();
  await until(() =>
    js(
      "[...document.querySelectorAll('nav button')].some(b=>b.textContent==='授权')",
    ),
  );
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() =>
    js(
      "document.querySelectorAll('#authorization-workspace option').length===2",
    ),
  );
  assert.deepEqual(
    await js(
      "[...document.querySelectorAll('#authorization-engine option')].map(option => option.value)",
    ),
    ["native", "claude", "codex", "pi", "opencode"],
  );
  await field("authorization-name", "Scoped authorization");
  await field("authorization-workspace", String(wid), "HTMLSelectElement");
  const request = core.request.bind(core);
  let lost = false;
  core.request = async (method, input, ...args) => {
    const value = await request(method, input, ...args);
    if (
      method === "operations.execute" &&
      input.method === "authorizations.save" &&
      !lost
    ) {
      lost = true;
      throw Error("Fixture response lost");
    }
    return value;
  };
  await js(
    "document.querySelector('#authorization-save').click();document.querySelector('#authorization-save').click()",
  );
  await until(() => lost);
  assert.equal((await core.request("authorizations.list", {})).items.length, 1);
  await until(() =>
    js("Boolean(document.querySelector('[aria-label=待确认操作]'))"),
  );
  win.webContents.reload();
  await until(() =>
    js(
      "document.querySelector('[aria-label=待确认操作]')?.textContent.includes('命令已接纳')",
    ),
  );
  await js(
    "[...document.querySelectorAll('[aria-label=待确认操作] button')].find(b=>b.textContent==='查看资源当前状态').click()",
  );
  await until(() =>
    js(
      "[...document.querySelectorAll('[aria-label=授权列表] button')].some(b=>b.textContent.includes('Scoped authorization'))",
    ),
  );
  await js(
    "[...document.querySelectorAll('[aria-label=授权列表] button')].find(b=>b.textContent.includes('Scoped authorization')).click()",
  );
  await field("authorization-target", path.join(workspace, "input.txt"));
  await js("document.querySelector('#authorization-evaluate').click()");
  await until(() =>
    js(
      "document.querySelector('#authorization-result')?.textContent.includes('范围符合')",
    ),
  );
  report.checks.push(
    "real typed form creates one grant on duplicate clicks; lost response is recovered after reload without duplicate grant",
  );
  await js(
    "document.querySelector('#authorization-execute').click();document.querySelector('#authorization-execute').click()",
  );
  await until(() =>
    js(
      "document.querySelector('[aria-label=任务执行记录]')?.textContent.includes('直接工具动作')",
    ),
  );
  await until(
    async () =>
      (await core.request("agent.list", {})).items[0]?.state === "completed",
  );
  assert.equal((await core.request("agent.list", {})).items.length, 1);
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() =>
    js("document.querySelector('[aria-label=授权列表] button')"),
  );
  await js("document.querySelector('[aria-label=授权列表] button').click()");
  report.checks.push(
    "direct tool action uses typed Client Models and opens a real completed Run without a configured model",
  );
  const currentGrant = (await core.request("authorizations.list", {})).items[0];
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='规则').click()",
  );
  await until(() => js("document.querySelector('#rule-definition')"));
  const ruleDefinition = {
    name: "Completion rule",
    enabled: false,
    event: "run.completed",
    workspace_id: wid,
    source_run_id: null,
    expires_at: currentGrant.expires_at,
    start: {
      client_run_id: require("node:crypto").randomUUID(),
      agent_id: 1,
      workspace_id: wid,
      goal: "Rule read",
      authorization_id: currentGrant.id,
      action: { name: "read_file", arguments: { path: "input.txt" } },
    },
  };
  await field(
    "rule-definition",
    JSON.stringify(ruleDefinition),
    "HTMLTextAreaElement",
  );
  await js(
    "document.querySelector('#rule-save').click();document.querySelector('#rule-save').click()",
  );
  await until(() => js("document.querySelector('#rule-toggle')"));
  assert.equal((await core.request("rules.list", {})).items.length, 1);
  await js("document.querySelector('#rule-toggle').click()");
  await until(() =>
    js("document.querySelector('#rule-toggle')?.textContent==='暂停规则'"),
  );
  await field("rule-source", "1");
  await js("document.querySelector('#rule-simulate').click()");
  await until(() =>
    js(
      "document.querySelector('[role=status]')?.textContent.includes('matched')",
    ),
  );
  const sourceOp = {
    operation_id: require("node:crypto").randomUUID(),
    instance_id: core.snapshot().storage_instance,
    method: "agent.start",
    input: {
      ...ruleDefinition.start,
      client_run_id: require("node:crypto").randomUUID(),
    },
  };
  await core.request("operations.execute", sourceOp);
  await until(async () =>
    (
      await core.request("rules.history", {
        id: (await core.request("rules.list", {})).items[0].id,
      })
    ).deliveries.some((d) => d.state === "dispatched"),
  );
  await until(() =>
    js(
      "document.querySelector('.provider-form')?.textContent.includes('dispatched')",
    ),
  );
  await js("document.querySelector('#rule-toggle').click()");
  await until(() =>
    js("document.querySelector('#rule-toggle')?.textContent==='启用规则'"),
  );
  assert.equal(
    await js("document.querySelector('nav [aria-current=page]')?.textContent"),
    "规则",
  );
  await win.webContents.capturePage(undefined, {
    stayHidden: true,
    stayAwake: true,
  });
  win.setContentSize(1440, 900);
  await sleep(250);
  fs.writeFileSync(
    path.join(profile, "rules-1440.png"),
    (
      await win.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
    ).toPNG(),
  );
  report.checks.push(
    "real rule form saves once, simulates, enables, dispatches an internal completion event and pauses with visible history",
  );
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() =>
    js("document.querySelector('[aria-label=授权列表] button')"),
  );
  await js("document.querySelector('[aria-label=授权列表] button').click()");
  await field("authorization-target", path.join(profile, "outside.txt"));
  await js("document.querySelector('#authorization-evaluate').click()");
  await until(() =>
    js(
      "document.querySelector('#authorization-result')?.textContent.includes('范围不符')",
    ),
  );
  await js("document.querySelector('#authorization-revoke').click()");
  await until(() =>
    js("document.querySelector('#authorization-save').matches(':disabled')"),
  );
  await field("authorization-target", path.join(workspace, "input.txt"));
  await js("document.querySelector('#authorization-evaluate').click()");
  await until(() =>
    js(
      "document.querySelector('#authorization-result')?.textContent.includes('授权已撤销')",
    ),
  );
  assert.equal(
    (await core.request("authorizations.list", {})).items[0].revision,
    2,
  );
  report.checks.push(
    "scope preview reflects target boundaries and revocation; history and revision survive real IPC",
  );
  const modelSettings = path.join(profile, "model-settings.json");
  if (cliEngine === "claude") {
    fs.writeFileSync(
      modelSettings,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          ANTHROPIC_MODEL: "owned-claude-model",
          ANTHROPIC_AUTH_TOKEN: "TROOP_CLAUDE_TEST_CREDENTIAL",
        },
      }),
    );
  }
  if (cliEngine === "opencode") {
    fs.writeFileSync(
      modelSettings,
      JSON.stringify({
        model: "owned/fixture",
        provider: {
          owned: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: "http://127.0.0.1:9/v1",
              apiKey: "TROOP_OPENCODE_TEST_CREDENTIAL",
            },
            models: { fixture: { limit: { context: 32768, output: 4096 } } },
          },
        },
      }),
    );
  }
  const shellRoots = [];
  if (["claude", "opencode"].includes(cliEngine) && nativeTools) {
    const shell = require("node:child_process").spawnSync(
      "where.exe",
      ["pwsh.exe"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(shell.status, 0, shell.stderr);
    shellRoots.push(path.dirname(shell.stdout.trim().split(/\r?\n/)[0]));
  }
  const cliGrant = await core.request("operations.execute", {
    operation_id: require("node:crypto").randomUUID(),
    instance_id: core.snapshot().storage_instance,
    method: "authorizations.save",
    input: {
      expected_revision: 0,
      grant: {
        name: "CLI protocol fixture",
        purpose: "cli_start",
        engine_id: cliEngine,
        agent_id: 1,
        workspace_id: wid,
        project_ids: [],
        read_roots: [workspace, ...shellRoots],
        write_roots: [workspace],
        operations: ["start"],
        network:
          ["codex", "copilot", "claude", "opencode", "grok"].includes(
            cliEngine,
          ) || nativeTools
            ? "any"
            : "none",
        ...(["claude", "opencode"].includes(cliEngine)
          ? { model_settings: { file: modelSettings } }
          : {}),
        ...(cliEngine === "grok"
          ? { credential_env_keys: ["XAI_API_KEY"] }
          : {}),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        program: path.resolve(
          __dirname,
          `../../../target/debug/examples/${cliPeer.program}.exe`,
        ),
      },
    },
  });
  assert.equal(cliGrant.state, "committed");
  win.webContents.reload();
  await until(() =>
    js(
      "[...document.querySelectorAll('nav button')].some(b=>b.textContent==='授权')",
    ),
  );
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() =>
    js(
      "[...document.querySelectorAll('[aria-label=授权列表] button')].some(b=>b.textContent.includes('CLI protocol fixture'))",
    ),
  );
  await js(
    "[...document.querySelectorAll('[aria-label=授权列表] button')].find(b=>b.textContent.includes('CLI protocol fixture')).click()",
  );
  if (["claude", "opencode"].includes(cliEngine)) {
    await until(() =>
      js("Boolean(document.querySelector('#authorization-model-settings'))"),
    );
    await field("authorization-model-settings", modelSettings);
    await js("document.querySelector('#authorization-save').click()");
    await until(
      async () =>
        (await core.request("authorizations.get", { id: cliGrant.result.id }))
          .revision === 2,
    );
    const current = await core.request("authorizations.get", {
      id: cliGrant.result.id,
    });
    assert.equal(
      current.model_settings.sha256,
      require("node:crypto")
        .createHash("sha256")
        .update(fs.readFileSync(modelSettings))
        .digest("hex"),
    );
    report.checks.push(
      "the typed model settings field saves the original file binding and recomputes its fingerprint without copying credentials",
    );
  }
  const cliGoal =
    cliEngine !== "codex" ? "Produce a text-only answer" : "write owned output";
  if (cliEngine !== "codex" && !nativeTools)
    await field("authorization-cli-tool-mode", "disabled", "HTMLSelectElement");
  await field("authorization-cli-goal", cliGoal, "HTMLTextAreaElement");
  await js(
    "document.querySelector('#authorization-cli-start').click();document.querySelector('#authorization-cli-start').click()",
  );
  await until(() =>
    js(
      `document.querySelector('[aria-label=任务执行记录]')?.textContent.includes(${JSON.stringify(cliGoal)})`,
    ),
  );
  const cliRun = (await core.request("agent.list", {})).items.find(
    (row) => row.kind === "external_cli",
  );
  await until(async () =>
    (await core.request("agent.get", { id: cliRun.id })).run.waiting.includes(
      "review",
    ),
  );
  await until(() =>
    js("Boolean(document.querySelector('[data-task-id] button'))"),
  );
  await js("document.querySelector('[data-task-id] button').click()");
  await until(() =>
    js(
      `document.querySelector('[aria-label="CLI 固定结果证据"]')?.textContent.includes(${JSON.stringify(cliPeer.text)})`,
    ),
  );
  await field(
    "cli-review-note",
    "The captured protocol fixture result matches the requested output.",
    "HTMLTextAreaElement",
  );
  await js("document.querySelector('#cli-review-confirm').click()");
  await until(() =>
    js("document.querySelector('#cli-review-accept')?.disabled===false"),
  );
  report.checks.push(
    "real Electron launch and follow display use the typed CLI contract, operation ledger and sealed evidence; native protocol is a controlled fixture",
  );
  report.cli_engine = cliEngine;
  report.cli_tool_mode =
    nativeTools || cliEngine === "codex" ? "native" : "disabled";
  report.layouts = [];
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(100);
    await js(
      "document.querySelector('[aria-label=\"CLI 固定结果证据\"]').scrollIntoView({block:'start'})",
    );
    report.layouts.push(
      await js(
        "({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth})",
      ),
    );
    fs.writeFileSync(
      path.join(profile, `authorization-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  assert.ok(report.layouts.every((row) => !row.overflow));
  await js(
    "document.querySelector('#cli-review-accept').click();document.querySelector('#cli-review-accept').click()",
  );
  await until(
    async () =>
      (await core.request("agent.get", { id: cliRun.id })).run.state ===
      "completed",
  );
  assert.equal(
    (await core.request("agent.list", {})).items.filter(
      (row) => row.kind === "external_cli",
    ).length,
    1,
  );
  report.checks.push(
    "duplicate launch/review clicks create one external Run; accepting its exact evidence completes the Run",
  );
  if (cliEngine === "codex") {
    fs.writeFileSync(path.join(workspace, "constructor-question"), "");
    const questionRun = await core.request("operations.execute", {
      operation_id: require("node:crypto").randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method: "cli.start",
      input: {
        client_run_id: require("node:crypto").randomUUID(),
        workspace_id: wid,
        engine_id: "codex",
        authorization_id: cliGrant.result.id,
        goal: "ask owned question",
        collaboration_mode: "plan",
        timeout_seconds: 60,
      },
    });
    assert.equal(
      questionRun.state,
      "committed",
      JSON.stringify(questionRun.error),
    );
    const selectQuestion = async () => {
      await until(() =>
        js(
          "[...document.querySelectorAll('nav button')].some(b=>b.textContent==='任务')",
        ),
      );
      await js(
        "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='任务').click()",
      );
      await until(() =>
        js(
          "[...document.querySelectorAll('[aria-label=任务历史] button')].some(b=>b.textContent.includes('ask owned question'))",
        ),
      );
      await js(
        "[...document.querySelectorAll('[aria-label=任务历史] button')].find(b=>b.textContent.includes('ask owned question')).click()",
      );
      await until(() =>
        js(
          `document.querySelector('[data-task-id="${questionRun.result.task_id}"] button')`,
        ),
      );
      await js(
        `document.querySelector('[data-task-id="${questionRun.result.task_id}"] button').click()`,
      );
      await until(() =>
        js(
          `document.querySelector('[aria-label="CLI 运行时交互"]')?.textContent.includes('Choose an owned target')`,
        ),
      );
    };
    await selectQuestion();
    await js(
      `document.querySelector('[aria-label="CLI 运行时交互"] input[value=alpha]').click()`,
    );
    await sleep(100);
    win.webContents.reload();
    await selectQuestion();
    assert.equal(
      await js(
        `document.querySelector('[aria-label="CLI 运行时交互"] input[value=alpha]').checked`,
      ),
      true,
    );
    await js(
      `(()=>{const b=[...document.querySelectorAll('[aria-label="CLI 运行时交互"] button')].find(b=>b.textContent==='提交回答');b.click();b.click()})()`,
    );
    await until(() => fs.existsSync(path.join(workspace, "answer.txt")));
    assert.equal(
      fs.readFileSync(path.join(workspace, "answer.txt"), "utf8"),
      "alpha",
    );
    await until(() =>
      js(
        `document.querySelector('[aria-label="CLI 运行时交互"]')?.textContent.includes('回答已发送')`,
      ),
    );
    report.checks.push(
      "a persisted Codex question with a constructor ID renders and survives reload; the real typed card submits duplicate clicks once and the same native peer resumes",
    );

    const planRun = await core.request("operations.execute", {
      operation_id: require("node:crypto").randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method: "cli.start",
      input: {
        client_run_id: require("node:crypto").randomUUID(),
        workspace_id: wid,
        engine_id: "codex",
        authorization_id: cliGrant.result.id,
        goal: "Owned plan confirmation fixture",
        collaboration_mode: "plan",
        timeout_seconds: 60,
      },
    });
    assert.equal(planRun.state, "committed", JSON.stringify(planRun.error));
    await until(() =>
      js(
        "[...document.querySelectorAll('[aria-label=任务历史] button')].some(b=>b.textContent.includes('Owned plan confirmation'))",
      ),
    );
    await js(
      "[...document.querySelectorAll('[aria-label=任务历史] button')].find(b=>b.textContent.includes('Owned plan confirmation')).click()",
    );
    await until(() =>
      js(
        `document.querySelector('[data-task-id="${planRun.result.task_id}"] button')`,
      ),
    );
    await js(
      `document.querySelector('[data-task-id="${planRun.result.task_id}"] button').click()`,
    );
    await until(() =>
      js(
        "[...document.querySelectorAll('[aria-label=\"CLI 运行时交互\"] button')].some(b=>b.textContent==='确认计划')",
      ),
    );
    await js(
      "document.querySelector('[aria-label=\"CLI 运行时交互\"] input[type=checkbox]').click()",
    );
    await js(
      "(()=>{const b=[...document.querySelectorAll('[aria-label=\"CLI 运行时交互\"] button')].find(b=>b.textContent==='确认计划');b.click();b.click()})()",
    );
    await until(async () =>
      (
        await core.request("agent.get", { id: planRun.result.run.id })
      ).run.waiting.includes("review"),
    );
    report.checks.push(
      "the versioned plan card binds its displayed digest and duplicate confirmation clicks persist one decision",
    );
    const planSnapshot = await core.request("agent.get", {
      id: planRun.result.run.id,
    });
    const oldPlanTask = await core.request("agent.task", {
      id: planSnapshot.tasks[0].id,
    });
    const review = await core.request("operations.execute", {
      operation_id: require("node:crypto").randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method: "cli.review",
      input: {
        id: oldPlanTask.id,
        epoch: oldPlanTask.epoch,
        expected_task_revision: oldPlanTask.revision,
        evidence_sha256: oldPlanTask.evidence.sha256,
        accepted: true,
        note: "Inspected the owned plan and its existing effects before linked work.",
      },
    });
    assert.equal(review.state, "committed", JSON.stringify(review.error));
    const expanded = await core.request("operations.execute", {
      operation_id: require("node:crypto").randomUUID(),
      instance_id: core.snapshot().storage_instance,
      method: "authorizations.save",
      input: {
        expected_revision: 0,
        grant: {
          name: "Expanded plan continuation fixture",
          purpose: "cli_start",
          agent_id: 1,
          engine_id: "codex",
          workspace_id: wid,
          project_ids: [],
          read_roots: [workspace],
          write_roots: [workspace],
          read_all: true,
          network: "any",
          operations: ["start"],
          expires_at: Math.floor(Date.now() / 1000) + 300,
          program: cliGrant.result.program,
        },
      },
    });
    assert.equal(expanded.state, "committed", JSON.stringify(expanded.error));
    await js(
      "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
    );
    await until(() =>
      js(
        "[...document.querySelectorAll('[aria-label=授权列表] button')].some(b=>b.textContent.includes('Expanded plan continuation'))",
      ),
    );
    await js(
      "[...document.querySelectorAll('[aria-label=授权列表] button')].find(b=>b.textContent.includes('Expanded plan continuation')).click()",
    );
    await field(
      "authorization-cli-goal",
      "Owned linked continuation fixture",
      "HTMLTextAreaElement",
    );
    await field("authorization-cli-continuation", String(oldPlanTask.id));
    await js(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='检查关联执行与权限差异').click()",
    );
    await until(() =>
      js(
        "document.querySelector('[aria-label=\"关联执行权限差异\"]')?.textContent.includes('read_all')",
      ),
    );
    await js(
      "[...document.querySelectorAll('label')].find(label=>label.textContent.includes('已核对旧效果与权限差异')).querySelector('input').click()",
    );
    await js(
      "document.querySelector('#authorization-cli-start').click();document.querySelector('#authorization-cli-start').click()",
    );
    let continued;
    await until(async () => {
      continued = (await core.request("agent.list", {})).items.find(
        (row) => row.title === "Owned linked continuation fixture",
      );
      return continued;
    });
    const linked = await core.request("agent.get", { id: continued.id });
    assert.equal(linked.run.continuation_of.task_id, oldPlanTask.id);
    assert.equal(
      (await core.request("agent.list", {})).items.filter(
        (row) => row.title === "Owned linked continuation fixture",
      ).length,
      1,
    );
    report.checks.push(
      "the real permission-difference form confirms a new grant, binds reviewed old evidence and creates one linked Run through duplicate clicks",
    );
  }

  if (cliEngine === "opencode" && nativeTools) {
    fs.writeFileSync(path.join(workspace, "approval-case"), "correlated");
    await js(
      "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
    );
    await until(() =>
      js(
        "[...document.querySelectorAll('[aria-label=授权列表] button')].some(b=>b.textContent.includes('CLI protocol fixture'))",
      ),
    );
    await js(
      "[...document.querySelectorAll('[aria-label=授权列表] button')].find(b=>b.textContent.includes('CLI protocol fixture')).click()",
    );
    await field(
      "authorization-cli-approval-mode",
      "manual",
      "HTMLSelectElement",
    );
    await field(
      "authorization-cli-goal",
      "Owned OpenCode correlated UI approval",
      "HTMLTextAreaElement",
    );
    await js(
      "document.querySelector('#authorization-cli-start').click();document.querySelector('#authorization-cli-start').click()",
    );
    let permissionRun, permissionTask;
    await until(async () => {
      permissionRun = (await core.request("agent.list", {})).items.find(
        (row) => row.title === "Owned OpenCode correlated UI approval",
      );
      return Boolean(permissionRun);
    });
    await until(async () => {
      permissionTask = (
        await core.request("agent.get", { id: permissionRun.id })
      ).tasks[0];
      return Boolean(permissionTask);
    });
    await until(() =>
      js(
        `Boolean(document.querySelector('[data-task-id="${permissionTask.id}"] button'))`,
      ),
    );
    await js(
      `document.querySelector('[data-task-id="${permissionTask.id}"] button').click()`,
    );
    await until(() =>
      js(
        "document.querySelector('[aria-label=\"CLI 运行时交互\"]')?.textContent.includes('owned approved effect')",
      ),
    );
    for (const width of [1440, 768, 660]) {
      win.setContentSize(width, 900);
      await sleep(100);
      await js(
        "document.querySelector('[aria-label=\"CLI 运行时交互\"]').scrollIntoView({block:'start'})",
      );
      assert.equal(
        await js("document.documentElement.scrollWidth>innerWidth"),
        false,
      );
      fs.writeFileSync(
        path.join(profile, `opencode-approval-${width}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    assert.equal(fs.existsSync(path.join(workspace, "approved.txt")), false);
    await js(
      "(()=>{const b=[...document.querySelectorAll('[aria-label=\"CLI 运行时交互\"] button')].find(b=>b.textContent==='Allow once');b.click();b.click()})()",
    );
    await until(async () =>
      (
        await core.request("agent.get", { id: permissionRun.id })
      ).run.waiting.includes("review"),
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, "approved.txt"), "utf8"),
      "owned approved effect",
    );
    assert.equal(
      (await core.request("agent.list", {})).items.filter(
        (row) => row.title === "Owned OpenCode correlated UI approval",
      ).length,
      1,
    );
    const interactions = (
      await core.request("cli.interactions", { task_id: permissionTask.id })
    ).items;
    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].decision.answer.option_id, "once");
    report.checks.push(
      "OpenCode's typed manual form starts once, the approval card shows same-call parameters, duplicate clicks decide once and the contained native writer completes after the unsupported editor mirror is declined",
    );
  }

  if (cliEngine === "copilot" && nativeTools) {
    await js(
      "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
    );
    await until(() =>
      js(
        "[...document.querySelectorAll('[aria-label=授权列表] button')].some(b=>b.textContent.includes('CLI protocol fixture'))",
      ),
    );
    await js(
      "[...document.querySelectorAll('[aria-label=授权列表] button')].find(b=>b.textContent.includes('CLI protocol fixture')).click()",
    );
    await field(
      "authorization-cli-approval-mode",
      "manual",
      "HTMLSelectElement",
    );
    await field(
      "authorization-cli-goal",
      "owned approval",
      "HTMLTextAreaElement",
    );
    await js(
      "document.querySelector('#authorization-cli-start').click();document.querySelector('#authorization-cli-start').click()",
    );
    let permissionRun, permissionTask;
    await until(async () => {
      permissionRun = (await core.request("agent.list", {})).items.find(
        (row) => row.kind === "external_cli" && row.title === "owned approval",
      );
      return !!permissionRun;
    });
    await until(async () => {
      permissionTask = (
        await core.request("agent.get", { id: permissionRun.id })
      ).tasks[0];
      return !!permissionTask;
    });
    await until(
      async () =>
        (await core.request("cli.interactions", { task_id: permissionTask.id }))
          .items[0]?.state === "pending",
    );
    await until(() =>
      js(
        `document.querySelector('[data-task-id="${permissionTask.id}"] button')`,
      ),
    );
    await js(
      `document.querySelector('[data-task-id="${permissionTask.id}"] button').click()`,
    );
    await until(() =>
      js(
        `document.querySelector('[aria-label="CLI 运行时交互"]')?.textContent.includes('CLI 工具审批')`,
      ),
    );
    const pending = await core.request("agent.task", { id: permissionTask.id });
    const marker = path.join(
      pending.permission_plan.engine_runtime_directory,
      "approved.txt",
    );
    assert.equal(fs.existsSync(marker), false);
    await js(
      `(()=>{const b=[...document.querySelectorAll('[aria-label="CLI 运行时交互"] button')].find(b=>b.textContent==='Allow once');b.click();b.click()})()`,
    );
    await until(() => fs.existsSync(marker));
    assert.equal(fs.readFileSync(marker, "utf8"), "owned approved effect");
    report.checks.push(
      "manual native permission is visible through the typed form and card; no effect occurs before the persisted allow-once decision and duplicate clicks send once",
    );
    await js(
      "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
    );
    await until(() =>
      js(
        "[...document.querySelectorAll('[aria-label=授权列表] button')].some(b=>b.textContent.includes('CLI protocol fixture'))",
      ),
    );
    await js(
      "[...document.querySelectorAll('[aria-label=授权列表] button')].find(b=>b.textContent.includes('CLI protocol fixture')).click()",
    );
    await until(() =>
      js("Boolean(document.querySelector('#authorization-cli-transport'))"),
    );
    await field(
      "authorization-cli-transport",
      "sdk_questions",
      "HTMLSelectElement",
    );
    await until(() =>
      js(
        "document.querySelector('#authorization-cli-transport')?.value==='sdk_questions' && !document.querySelector('#authorization-cli-approval-mode')",
      ),
    );
    await field("authorization-cli-transport", "acp", "HTMLSelectElement");
    await field(
      "authorization-cli-transport",
      "sdk_questions",
      "HTMLSelectElement",
    );
    await field(
      "authorization-cli-goal",
      "Owned SDK question UI fixture",
      "HTMLTextAreaElement",
    );
    await js("document.querySelector('#authorization-cli-start').click()");
    let sdkRun, sdkTask;
    await until(async () => {
      sdkRun = (await core.request("agent.list", {})).items.find(
        (row) => row.title === "Owned SDK question UI fixture",
      );
      return sdkRun;
    });
    await until(async () => {
      sdkTask = (await core.request("agent.get", { id: sdkRun.id })).tasks[0];
      return sdkTask;
    });
    await until(() =>
      js(`document.querySelector('[data-task-id="${sdkTask.id}"] button')`),
    );
    await js(
      `document.querySelector('[data-task-id="${sdkTask.id}"] button').click()`,
    );
    await until(() =>
      js(
        `document.querySelector('[aria-label="CLI 运行时交互"] input[value=Alpha]')`,
      ),
    );
    await js(
      `document.querySelector('[aria-label="CLI 运行时交互"] input[value=Alpha]').click()`,
    );
    await js(
      `(()=>{const b=[...document.querySelectorAll('[aria-label="CLI 运行时交互"] button')].find(b=>b.textContent==='提交回答');b.click();b.click()})()`,
    );
    await until(async () =>
      (await core.request("agent.get", { id: sdkRun.id })).run.waiting.includes(
        "review",
      ),
    );
    const sdkEvidence = (await core.request("agent.task", { id: sdkTask.id }))
      .evidence;
    assert.deepEqual(sdkEvidence.permission_plan.native_tools, ["ask_user"]);
    assert.equal(sdkEvidence.result.tool_calls[0].name, "ask_user");
    report.checks.push(
      "the Copilot transport selector remains editable; SDK question-only mode hides inapplicable approval options and its shared card resumes the native peer once",
    );
  }
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() => js("document.querySelector('#authorization-new')"));
  await js("document.querySelector('#authorization-new').click()");
  await field("authorization-name", "MXC Shell UI grant");
  await field("authorization-workspace", String(wid), "HTMLSelectElement");
  await field("authorization-read", workspace, "HTMLTextAreaElement");
  await field("authorization-write", workspace, "HTMLTextAreaElement");
  await js(
    "(()=>{const select=document.querySelector('#authorization-operations'); for(const option of select.options) option.selected=option.value==='run_command'; select.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#authorization-shell').click();})()",
  );
  await js(
    "document.querySelector('#authorization-save').click();document.querySelector('#authorization-save').click()",
  );
  let shellGrant;
  await until(async () => {
    shellGrant = (await core.request("authorizations.list", {})).items.find(
      (row) => row.name === "MXC Shell UI grant",
    );
    return !!shellGrant;
  });
  assert.equal(shellGrant.revision, 1);
  assert.equal(
    shellGrant.shell.program_sha256,
    "090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a",
  );
  await until(() =>
    js("Boolean(document.querySelector('#authorization-action'))"),
  );
  await field("authorization-action", "run_command", "HTMLSelectElement");
  await field(
    "authorization-arguments",
    JSON.stringify({
      command:
        "[IO.File]::WriteAllText('shell-ui.txt','contained'); 'TROOP_SHELL_UI_OK'",
    }),
    "HTMLTextAreaElement",
  );
  await js(
    "document.querySelector('#authorization-execute').click();document.querySelector('#authorization-execute').click()",
  );
  let shellRun;
  await until(async () => {
    shellRun = (await core.request("agent.list", {})).items.find(
      (row) => row.authorization_id === shellGrant.id,
    );
    return shellRun?.state === "completed";
  });
  assert.equal(
    (await core.request("agent.list", {})).items.filter(
      (row) => row.authorization_id === shellGrant.id,
    ).length,
    1,
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, "shell-ui.txt"), "utf8"),
    "contained",
  );
  await until(() =>
    js(
      "document.querySelector('.agent-tool')?.textContent.includes('mxc-process-v1')",
    ),
  );
  await js("document.querySelector('.agent-tool details').open=true");
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(100);
    assert.equal(
      await js("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
  }
  report.checks.push(
    "real Shell grant form explicitly binds the fixed MXC runtime; duplicate clicks dispatch one contained command and follow shows its filesystem/network enforcement at three widths",
  );
  promptServer = await agentServer({
    plan: ({ body }) =>
      hook(body) || results(body).length
        ? []
        : [{ name: "read_file", arguments: { path: "input.txt" } }],
    reply: ({ body }) =>
      hook(body) ? "{}" : "Pinned prompt Hook task complete",
  });
  const provider = await core.request("provider.save", {
    config: {
      name: "Prompt Hook UI fixture",
      protocol: "anthropic",
      base_url: promptServer.origin,
      model: "owned-prompt-hook-model",
      max_output_tokens: 4096,
      idle_timeout_secs: 5,
    },
  });
  const promptHook = await core.request("hooks.save", {
    name: "UI pinned prompt Hook",
    event: "preToolUse",
    kind: "prompt",
    location: "windows-host",
    enabled: true,
    agent_id: 1,
    workspace_id: wid,
    command: "",
    prompt: "Return {}. Audit the tool parameters.",
    matcher: "",
    timeout: 5,
    loop_limit: null,
    failClosed: true,
  });
  const bindings = [{ id: promptHook.id, revision: promptHook.revision }];
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() => js("document.querySelector('#authorization-new')"));
  await js("document.querySelector('#authorization-new').click()");
  await field("authorization-name", "Pinned prompt Hook grant");
  await field("authorization-workspace", String(wid), "HTMLSelectElement");
  await field("authorization-read", workspace, "HTMLTextAreaElement");
  await field(
    "authorization-prompt-hooks",
    JSON.stringify(bindings),
    "HTMLTextAreaElement",
  );
  await js(
    "document.querySelector('#authorization-save').click();document.querySelector('#authorization-save').click()",
  );
  let pinned;
  await until(async () => {
    pinned = (await core.request("authorizations.list", {})).items.find(
      (row) => row.name === "Pinned prompt Hook grant",
    );
    return !!pinned;
  });
  assert.deepEqual(pinned.prompt_hooks, bindings);
  assert.equal(pinned.revision, 1);
  win.webContents.reload();
  await until(() =>
    js(
      "[...document.querySelectorAll('nav button')].some(b=>b.textContent==='授权')",
    ),
  );
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() =>
    js(
      "[...document.querySelectorAll('[aria-label=授权列表] button')].some(b=>b.querySelector('strong')?.textContent==='Pinned prompt Hook grant')",
    ),
  );
  await js(
    "[...document.querySelectorAll('[aria-label=授权列表] button')].find(b=>b.querySelector('strong')?.textContent==='Pinned prompt Hook grant').click()",
  );
  await until(() =>
    js(
      "document.querySelector('#authorization-prompt-hooks')?.value.includes('revision')",
    ),
  );
  assert.deepEqual(
    await js(
      "JSON.parse(document.querySelector('#authorization-prompt-hooks').value)",
    ),
    bindings,
  );
  const started = await core.request("operations.execute", {
    operation_id: require("node:crypto").randomUUID(),
    instance_id: core.snapshot().storage_instance,
    method: "agent.start",
    input: {
      client_run_id: require("node:crypto").randomUUID(),
      workspace_id: wid,
      agent_id: 1,
      provider_id: provider.id,
      authorization_id: pinned.id,
      goal: "Pinned prompt Hook UI task",
    },
  });
  assert.equal(started.state, "committed", JSON.stringify(started.error));
  await until(
    async () =>
      (await core.request("agent.get", { id: started.result.run.id })).run
        .state === "completed",
  );
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='任务').click()",
  );
  await until(() =>
    js(
      "[...document.querySelectorAll('[aria-label=任务历史] button')].some(b=>b.textContent.includes('Pinned prompt Hook UI task'))",
    ),
  );
  await js(
    "[...document.querySelectorAll('[aria-label=任务历史] button')].find(b=>b.textContent.includes('Pinned prompt Hook UI task')).click()",
  );
  await until(() =>
    js(
      `document.querySelector('.hook-records')?.textContent.includes(${JSON.stringify(pinned.id)})`,
    ),
  );
  await js("document.querySelector('.hook-details').click()");
  await until(() =>
    js(
      "document.querySelector('.hook-detail')?.textContent.includes('input_sha256')",
    ),
  );
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(150);
    assert.equal(
      await js("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
  }
  report.checks.push(
    "typed prompt Hook bindings save once and survive reload; an authorized Agent executes the fixed revision and real UI shows its authority and input digest",
  );
  await core.request("hooks.remove", {
    id: promptHook.id,
    expected_revision: promptHook.revision,
  });
  remoteServer = await mcpServer();
  const service = await core.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "UI remote action",
      transport: "http",
      location: "remote",
      url: remoteServer.url,
      enabled: true,
      agent_ids: [1],
      auth_mode: "none",
    },
  });
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() => js("document.querySelector('#authorization-new')"));
  await js("document.querySelector('#authorization-new').click()");
  await field("authorization-name", "Exact MCP service grant");
  await field("authorization-purpose", "mcp_call", "HTMLSelectElement");
  await field("authorization-workspace", String(wid), "HTMLSelectElement");
  await field(
    "authorization-mcp-calls",
    JSON.stringify([
      {
        server_id: service.id,
        revision: service.revision,
        tool: "echo",
        arguments: { text: "UI exact operation" },
      },
    ]),
    "HTMLTextAreaElement",
  );
  assert.equal(
    await js("document.querySelector('#authorization-read').value"),
    "",
  );
  assert.equal(
    await js("document.querySelector('#authorization-network').value"),
    "any",
  );
  await js(
    "document.querySelector('#authorization-save').click();document.querySelector('#authorization-save').click()",
  );
  let mcpGrant;
  await until(async () => {
    mcpGrant = (await core.request("authorizations.list", {})).items.find(
      (row) => row.name === "Exact MCP service grant",
    );
    return !!mcpGrant;
  });
  await until(() =>
    js(
      "document.querySelector('#authorization-arguments')?.value.includes('server_id')",
    ),
  );
  assert.equal(mcpGrant.revision, 1);
  await js("document.querySelector('#authorization-evaluate').click()");
  await until(() =>
    js(
      "document.querySelector('#authorization-result')?.textContent.includes('范围符合')",
    ),
  );
  const modelRequests = promptServer.requests.length;
  await js(
    "document.querySelector('#authorization-execute').click();document.querySelector('#authorization-execute').click()",
  );
  let remoteRun;
  await until(async () => {
    remoteRun = (await core.request("agent.list", {})).items.find((row) =>
      row.title.includes("call_mcp"),
    );
    return remoteRun?.state === "completed";
  });
  assert.equal(
    remoteServer.calls.filter((call) => call.method === "tools/call").length,
    1,
  );
  assert.equal(promptServer.requests.length, modelRequests);
  const remoteState = await core.request("agent.get", { id: remoteRun.id });
  const remoteInvocation = await core.request("agent.invocation", {
    id: remoteState.invocations[0].id,
  });
  assert.equal(remoteInvocation.permission_plan.mcp.server_id, service.id);
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(150);
    assert.equal(
      await js("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
  }
  report.checks.push(
    "real MCP authorization form records exact service/revision/arguments and current identity; duplicate direct-action clicks execute one HTTP operation with zero model requests",
  );
  await core.request("mcp.remove", {
    id: service.id,
    expected_revision: service.revision,
  });
  const node = require("node:child_process")
    .execFileSync("where.exe", ["node"], {
      encoding: "utf8",
      windowsHide: true,
    })
    .trim()
    .split(/\r?\n/)[0];
  const nativeService = await core.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "UI pinned native service",
      transport: "stdio",
      location: "windows-host",
      command: node,
      args: [
        path.join(__dirname, "fixtures/mcp-stdio.cjs"),
        "admitted",
        workspace,
      ],
      cwd: workspace,
      enabled: true,
      agent_ids: [1],
    },
  });
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() => js("document.querySelector('#authorization-new')"));
  await js("document.querySelector('#authorization-new').click()");
  await field("authorization-name", "Explicit stdio UI grant");
  await field("authorization-purpose", "mcp_call", "HTMLSelectElement");
  await field("authorization-workspace", String(wid), "HTMLSelectElement");
  await field(
    "authorization-mcp-calls",
    JSON.stringify([
      {
        server_id: nativeService.id,
        revision: nativeService.revision,
        tool: "echo",
        arguments: { text: "native UI operation" },
        host_access: "full_host",
      },
    ]),
    "HTMLTextAreaElement",
  );
  assert.ok(
    await js(
      "document.querySelector('#authorization-mcp-help').textContent.includes('full_host')",
    ),
  );
  await js("document.querySelector('#authorization-save').click()");
  let nativeGrant;
  await until(async () => {
    nativeGrant = (await core.request("authorizations.list", {})).items.find(
      (row) => row.name === "Explicit stdio UI grant",
    );
    return !!nativeGrant;
  });
  assert.match(nativeGrant.mcp_calls[0].program_sha256, /^[a-f0-9]{64}$/);
  await until(() =>
    js(
      "document.querySelector('#authorization-arguments')?.value.includes('native UI operation')",
    ),
  );
  await js(
    "document.querySelector('#authorization-execute').click();document.querySelector('#authorization-execute').click()",
  );
  await until(() => fs.existsSync(path.join(workspace, "invocations")));
  await until(async () =>
    (await core.request("agent.list", {})).items.some(
      (row) =>
        row.authorization_id === nativeGrant.id && row.state === "completed",
    ),
  );
  assert.equal(
    fs
      .readFileSync(path.join(workspace, "invocations"), "utf8")
      .trim()
      .split("\n").length,
    1,
  );
  assert.equal(promptServer.requests.length, modelRequests);
  await until(() =>
    js(
      "document.querySelector('.mcp-session-list')?.textContent.includes('初始化授权')",
    ),
  );
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(150);
    assert.equal(
      await js("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
  }
  await core.request("mcp.remove", {
    id: nativeService.id,
    expected_revision: nativeService.revision,
  });
  report.checks.push(
    "stdio UI grant requires explicit full_host, saves the binary fingerprint, and dispatches one real native operation with zero model requests",
  );

  const scopedPeer = path.join(workspace, "scoped-stdio-peer.cjs");
  fs.copyFileSync(path.join(__dirname, "fixtures/mcp-stdio.cjs"), scopedPeer);
  const scopedService = await core.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "UI contained native service",
      transport: "stdio",
      location: "windows-host",
      command: node,
      args: [scopedPeer, "admitted", workspace],
      cwd: workspace,
      enabled: true,
      agent_ids: [1],
    },
  });
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() =>
    js("Boolean(document.querySelector('#authorization-new'))"),
  );
  await js("document.querySelector('#authorization-new').click()");
  await field("authorization-name", "Contained stdio UI grant");
  await field("authorization-purpose", "mcp_call", "HTMLSelectElement");
  await field("authorization-workspace", String(wid), "HTMLSelectElement");
  await field("authorization-read", workspace, "HTMLTextAreaElement");
  await field("authorization-write", workspace, "HTMLTextAreaElement");
  await field("authorization-network", "none", "HTMLSelectElement");
  await field(
    "authorization-mcp-calls",
    JSON.stringify([
      {
        server_id: scopedService.id,
        revision: scopedService.revision,
        tool: "echo",
        arguments: { text: "contained UI operation" },
        host_access: "sandbox",
      },
    ]),
    "HTMLTextAreaElement",
  );
  await js(
    "document.querySelector('#authorization-save').click();document.querySelector('#authorization-save').click()",
  );
  let scopedMcpGrant;
  await until(async () => {
    scopedMcpGrant = (await core.request("authorizations.list", {})).items.find(
      (row) => row.name === "Contained stdio UI grant",
    );
    return !!scopedMcpGrant;
  });
  assert.equal(scopedMcpGrant.revision, 1);
  assert.equal(scopedMcpGrant.network, "none");
  assert.equal(
    scopedMcpGrant.mcp_calls[0].sandbox_adapter,
    "mxc-stdio-v1-sdk-1.0.1",
  );
  await until(() =>
    js(
      "document.querySelector('#authorization-arguments')?.value.includes('contained UI operation')",
    ),
  );
  await js(
    "document.querySelector('#authorization-execute').click();document.querySelector('#authorization-execute').click()",
  );
  await until(async () =>
    (await core.request("agent.list", {})).items.some(
      (row) =>
        row.authorization_id === scopedMcpGrant.id && row.state === "completed",
    ),
  );
  assert.equal(
    (await core.request("agent.list", {})).items.filter(
      (row) => row.authorization_id === scopedMcpGrant.id,
    ).length,
    1,
  );
  assert.equal(
    fs
      .readFileSync(path.join(workspace, "invocations"), "utf8")
      .trim()
      .split("\n").length,
    2,
  );
  assert.equal(promptServer.requests.length, modelRequests);
  await until(() =>
    js(
      "document.querySelector('.mcp-session-list')?.textContent.includes('MXC 范围隔离')",
    ),
  );
  await js("document.querySelector('.mcp-session-list details').open=true");
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(150);
    await js(
      "document.querySelector('.mcp-run').scrollIntoView({block:'start'})",
    );
    assert.equal(
      await js("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
    fs.writeFileSync(
      path.join(profile, `scoped-stdio-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  await core.request("mcp.remove", {
    id: scopedService.id,
    expected_revision: scopedService.revision,
  });
  report.checks.push(
    "scoped stdio form records directory/offline authority and SDK identity; one zero-model call exposes initialization containment and ancestor metadata visibility at three widths",
  );

  const marker = path.join(profile, "command-hook-ui-effect");
  const commandHook = await core.request("hooks.save", {
    name: "Explicit UI command Hook",
    event: "preToolUse",
    kind: "command",
    location: "windows-host",
    enabled: true,
    command: `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}','approved'); '{}'`,
    prompt: "",
    matcher: "",
    timeout: 5,
    loop_limit: null,
    failClosed: true,
  });
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() => js("document.querySelector('#authorization-new')"));
  await js("document.querySelector('#authorization-new').click()");
  await field("authorization-name", "Explicit command UI grant");
  await field("authorization-workspace", String(wid), "HTMLSelectElement");
  await field("authorization-write", "", "HTMLTextAreaElement");
  await field("authorization-network", "any", "HTMLSelectElement");
  await field(
    "authorization-command-hooks",
    JSON.stringify([
      {
        id: commandHook.id,
        revision: commandHook.revision,
        host_access: "full_host",
      },
    ]),
    "HTMLTextAreaElement",
  );
  await js(
    "document.querySelector('#authorization-save').click();document.querySelector('#authorization-save').click()",
  );
  let commandGrant;
  await until(async () => {
    commandGrant = (await core.request("authorizations.list", {})).items.find(
      (row) => row.name === "Explicit command UI grant",
    );
    return !!commandGrant;
  });
  assert.equal(commandGrant.revision, 1);
  assert.match(commandGrant.command_hooks[0].command_sha256, /^[a-f0-9]{64}$/);
  await until(() =>
    js("Boolean(document.querySelector('#authorization-agent-provider'))"),
  );
  await field("authorization-agent-provider", provider.id, "HTMLSelectElement");
  await field(
    "authorization-agent-goal",
    "Command Hook UI task",
    "HTMLTextAreaElement",
  );
  await js(
    "document.querySelector('#authorization-agent-start').click();document.querySelector('#authorization-agent-start').click()",
  );
  let nativeRun;
  await until(async () => {
    nativeRun = (await core.request("agent.list", {})).items.find(
      (row) => row.authorization_id === commandGrant.id,
    );
    return nativeRun?.state === "completed";
  });
  assert.equal(
    (await core.request("agent.list", {})).items.filter(
      (row) => row.authorization_id === commandGrant.id,
    ).length,
    1,
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "approved");
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='任务').click()",
  );
  await until(() =>
    js(
      "[...document.querySelectorAll('[aria-label=任务历史] button')].some(b=>b.textContent.includes('Command Hook UI task'))",
    ),
  );
  await js(
    "[...document.querySelectorAll('[aria-label=任务历史] button')].find(b=>b.textContent.includes('Command Hook UI task')).click()",
  );
  await until(() =>
    js(
      "document.querySelector('.hook-records')?.textContent.includes('当前用户宿主权限')",
    ),
  );
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(150);
    assert.equal(
      await js("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
  }
  report.checks.push(
    "command Hook UI saves explicit current-user host authority and fixed script/program fingerprints, executes PowerShell and displays the effective scope without overflow",
  );
  const scopedHook = await core.request("hooks.save", {
    id: commandHook.id,
    expected_revision: commandHook.revision,
    name: "Scoped UI command Hook",
    event: "preToolUse",
    kind: "command",
    location: "windows-host",
    enabled: true,
    command: "[IO.File]::WriteAllText('scoped-hook-ui.txt','contained'); '{}'",
    prompt: "",
    matcher: "",
    timeout: 15,
    loop_limit: null,
    failClosed: true,
  });
  const modelRequestsBeforeDirectHook = promptServer.requests.length;
  await js(
    "[...document.querySelectorAll('nav button')].find(b=>b.textContent==='授权').click()",
  );
  await until(() =>
    js("Boolean(document.querySelector('#authorization-new'))"),
  );
  await js("document.querySelector('#authorization-new').click()");
  await field("authorization-name", "Scoped command UI grant");
  await field("authorization-workspace", String(wid), "HTMLSelectElement");
  await field("authorization-read", workspace, "HTMLTextAreaElement");
  await field("authorization-write", workspace, "HTMLTextAreaElement");
  await field(
    "authorization-command-hooks",
    JSON.stringify([
      {
        id: scopedHook.id,
        revision: scopedHook.revision,
        host_access: "sandbox",
      },
    ]),
    "HTMLTextAreaElement",
  );
  await js(
    "document.querySelector('#authorization-shell').click(); document.querySelector('#authorization-save').click(); document.querySelector('#authorization-save').click()",
  );
  let scopedGrant;
  await until(async () => {
    scopedGrant = (await core.request("authorizations.list", {})).items.find(
      (row) => row.name === "Scoped command UI grant",
    );
    return !!scopedGrant;
  });
  assert.equal(scopedGrant.revision, 1);
  assert.equal(scopedGrant.command_hooks[0].host_access, "sandbox");
  await field("authorization-action", "read_file", "HTMLSelectElement");
  await field(
    "authorization-arguments",
    '{"path":"input.txt"}',
    "HTMLTextAreaElement",
  );
  await js(
    "document.querySelector('#authorization-execute').click();document.querySelector('#authorization-execute').click()",
  );
  await until(async () =>
    (await core.request("agent.list", {})).items.some(
      (row) =>
        row.authorization_id === scopedGrant.id && row.state === "completed",
    ),
  );
  assert.equal(
    (await core.request("agent.list", {})).items.filter(
      (row) => row.authorization_id === scopedGrant.id,
    ).length,
    1,
  );
  assert.equal(promptServer.requests.length, modelRequestsBeforeDirectHook);
  assert.equal(
    fs.readFileSync(path.join(workspace, "scoped-hook-ui.txt"), "utf8"),
    "contained",
  );
  await until(() =>
    js(
      "document.querySelector('.hook-records')?.textContent.includes('MXC 范围隔离')",
    ),
  );
  await js("document.querySelector('.hook-records button').click()");
  await until(() =>
    js(
      "document.querySelector('.hook-detail')?.textContent.includes('mxc-process-v1')",
    ),
  );
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(150);
    await js(
      "document.querySelector('.hook-records').scrollIntoView({block:'start'})",
    );
    assert.equal(
      await js("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
    fs.writeFileSync(
      path.join(profile, `scoped-hook-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  report.checks.push(
    "typed sandbox Hook binding follows granted roots and offline policy, executes once with a zero-model direct action, and exposes its fixed permission evidence without overflow",
  );
  report.passed = true;
}
run()
  .catch((error) => {
    report.error = error.stack;
  })
  .finally(async () => {
    await runtime?.core.stop();
    await promptServer?.close();
    await remoteServer?.close();
    report.coreStopped = !runtime?.core.child;
    fs.writeFileSync(
      path.join(profile, "authorizations-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
