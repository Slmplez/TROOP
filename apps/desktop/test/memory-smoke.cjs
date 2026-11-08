const { app } = require("electron"),
  { bootstrap } = require("../src/main.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { once } = require("node:events");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime, server, conflictProposal, forgettingProposal;
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(40);
  }
  throw Error("Memory UI condition timed out");
}
const user = (body) =>
  (body.messages ?? body.input).find(
    (m) => m.role === "user" && typeof m.content === "string",
  )?.content ?? "";
async function run() {
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  server = await agentServer({
    plan: ({ body }) =>
      user(body) === "UI memory task" &&
      !body.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === "tool_result"),
      )
        ? [
            {
              name: "write_file",
              arguments: {
                path: "ui-memory.txt",
                content: "owned",
                expected_hash: "missing",
              },
            },
          ]
        : [],
    reply: ({ body }) =>
      user(body).startsWith("<<TROOP_COMPACTION>>")
        ? "Summary: the UI write completed once; do not repeat it."
        : user(body).startsWith("<<TROOP_MEMORY_VALIDATE>>")
          ? JSON.stringify({ approved: !forgettingProposal })
          : user(body).startsWith("<<TROOP_MEMORY_")
            ? forgettingProposal
              ? JSON.stringify({
                  additions: [{ content: forgettingProposal, tier: "profile" }],
                  removals: [],
                })
              : conflictProposal
                ? JSON.stringify({
                    additions: [],
                    removals: [],
                    conflicts: [conflictProposal],
                  })
                : '{"additions":[{"content":"UI automatic fact","tier":"log"}],"removals":[]}'
            : "Task done.",
  });
  runtime = await bootstrap({ userData: profile, show: false });
  const { window: win, core } = runtime;
  win.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  report.corePid = core.snapshot().pid;
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const provider = await core.request("provider.save", {
    config: {
      name: "Owned memory UI",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-memory-ui",
      max_output_tokens: 4096,
      idle_timeout_secs: 5,
    },
  });
  await core.request("memory.membership", {
    agent_id: 1,
    project: "ui-shared-project",
    action: "create",
  });
  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code, true);
    } catch (error) {
      throw new Error(`${error.message}\n${code}`);
    }
  };
  const field = async (id, value, type) => {
    await js(
      "(()=>{const el=document.getElementById(" +
        JSON.stringify(id) +
        ");Object.getOwnPropertyDescriptor(" +
        type +
        ".prototype,'value').set.call(el," +
        JSON.stringify(value) +
        ");el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await sleep(70);
  };
  const nav = async (text) => {
    await js(
      "[...document.querySelectorAll('nav button')].find(b=>b.textContent===" +
        JSON.stringify(text) +
        ").click()",
    );
    await sleep(80);
  };
  const loaded = once(win.webContents, "did-finish-load");
  win.webContents.reload();
  await loaded;
  await until(() => js("Boolean(document.querySelector('nav'))"));
  await nav("记忆");
  await until(() =>
    js("document.querySelectorAll('#memory-agent option').length===1"),
  );
  await until(() =>
    js("document.querySelectorAll('#maintenance-provider option').length===2"),
  );
  await field("maintenance-provider", provider.id, "HTMLSelectElement");
  await field(
    "maintenance-model",
    "independent-ui-maintainer",
    "HTMLInputElement",
  );
  await js(
    "document.querySelector('#maintenance-enabled').click();document.querySelector('#maintenance-save').click()",
  );
  await until(
    async () =>
      (await core.request("memory.maintenance.get", { agent_id: 1 }))
        .revision === 1,
  );
  report.checks.push(
    "independent maintenance model is explicitly saved through its real typed form",
  );
  await field(
    "memory-content",
    "UI explicit preference",
    "HTMLTextAreaElement",
  );
  await js("document.querySelector('#memory-save').click()");
  await until(() =>
    js(
      "document.querySelector('.memory-records')?.textContent.includes('UI explicit preference')",
    ),
  );
  await js(
    "[...document.querySelectorAll('.memory-records button')].find(b=>b.textContent==='编辑').click()",
  );
  await field("memory-content", "Updated UI preference", "HTMLTextAreaElement");
  await js("document.querySelector('#memory-save').click()");
  await until(() =>
    js(
      "document.querySelector('.memory-records')?.textContent.includes('Updated UI preference')",
    ),
  );
  report.checks.push(
    "memory form saves and edits a versioned fact through production IPC and SQLite",
  );
  await nav("任务");
  await until(() =>
    js(
      "document.querySelectorAll('#agent-provider option').length===2 && document.querySelectorAll('#agent-profile option').length===1",
    ),
  );
  await field("agent-provider", provider.id, "HTMLSelectElement");
  await field("agent-workspace", String(wid), "HTMLSelectElement");
  await field("agent-goal", "UI memory task", "HTMLTextAreaElement");
  await js("document.querySelector('#agent-start').click()");
  await until(() => js("Boolean(document.querySelector('#agent-approve'))"));
  assert.ok(server.requests[0].body.system.includes("Updated UI preference"));
  report.checks.push(
    "selected Agent's saved fact is actually injected into the model request",
  );
  await js("document.querySelector('#agent-compact').click()");
  await sleep(80);
  await js("document.querySelector('#agent-approve').click()");
  await until(() =>
    js(
      "document.querySelector('.agent-status strong')?.textContent.includes('已完成')",
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, "ui-memory.txt"), "utf8"),
    "owned",
  );
  await until(() =>
    js(
      "[...document.querySelectorAll('summary')].some(el=>el.textContent.includes('本次上下文的记忆来源'))",
    ),
  );
  await js(
    "[...document.querySelectorAll('summary')].find(el=>el.textContent.includes('本次上下文的记忆来源')).parentElement.open=true",
  );
  await until(() =>
    js(
      "document.querySelectorAll('select[aria-label=\"记忆来源模型请求\"] option').length>1",
    ),
  );
  const firstRequest = (
    await core.request("memory.usage", { run_id: 1 })
  ).requests.at(-1);
  await js(
    "(()=>{const el=document.querySelector('select[aria-label=\"记忆来源模型请求\"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el," +
      JSON.stringify(String(firstRequest.id)) +
      ");el.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await until(() =>
    js(
      "document.querySelector('select[aria-label=\"记忆来源模型请求\"]')?.value===" +
        JSON.stringify(String(firstRequest.id)),
    ),
  );
  report.checks.push(
    "per-request memory provenance can select an earlier persisted model attempt through the real typed UI",
  );
  const cps = await core.request("agent.checkpoints", { id: 1 });
  assert.equal(cps.length, 1);
  await js(
    "[...document.querySelectorAll('.memory-actions button')].find(b=>b.textContent.includes('查看摘要检查点')).click()",
  );
  await until(() =>
    js(
      "document.querySelector('.memory-job-detail')?.textContent.includes('UI write completed once')",
    ),
  );
  report.checks.push(
    "safe-boundary compaction creates a visible checkpoint and retains the exact tool result",
  );
  await nav("记忆");
  await until(() =>
    js(
      "document.querySelector('.memory-records')?.textContent.includes('UI automatic fact')",
    ),
  );
  await until(() =>
    js(
      "document.querySelector('.memory-jobs')?.textContent.includes('已完成')",
    ),
  );
  await js(
    "[...document.querySelectorAll('.memory-jobs button')].find(b=>b.textContent==='查看提案').click()",
  );
  await until(() =>
    js(
      "document.querySelector('.memory-page .memory-job-detail')?.textContent.includes('UI automatic fact')",
    ),
  );
  assert.ok(
    !(await js(
      "document.querySelector('.memory-page .memory-job-detail').textContent.includes('secret_ref')",
    )),
  );
  report.checks.push(
    "automatic extraction appears in the memory list with inspectable maintenance proposal and no credential fields",
  );
  await js(
    "[...document.querySelectorAll('.memory-records li')].find(li=>li.textContent.includes('Updated UI preference')).querySelectorAll('button')[1].click()",
  );
  await until(() =>
    js(
      "!document.querySelector('.memory-records').textContent.includes('Updated UI preference')",
    ),
  );
  report.checks.push(
    "Forget creates a durable deletion without deleting original task history",
  );
  const historyReload = once(win.webContents, "did-finish-load");
  win.webContents.reload();
  await historyReload;
  await until(() => js("Boolean(document.querySelector('nav'))"));
  await nav("记忆");
  await until(() =>
    js("Boolean(document.querySelector('#memory-include-deleted'))"),
  );
  await js("document.querySelector('#memory-include-deleted').click()");
  await until(() =>
    js(
      "document.querySelector('.memory-records')?.textContent.includes('Updated UI preference')",
    ),
  );
  await js(
    "[...document.querySelectorAll('.memory-records li')].find(li=>li.textContent.includes('Updated UI preference')).querySelectorAll('button')[2].click()",
  );
  await until(() =>
    js(
      "document.querySelector('[aria-label=\"记忆修订历史\"]')?.textContent.includes('UI explicit preference')",
    ),
  );
  await js(
    "const restore=[...document.querySelectorAll('[aria-label=\"记忆修订历史\"] button')].find(b=>b.textContent==='明确恢复这条记忆');restore.click();restore.click()",
  );
  await until(async () =>
    (await core.request("memory.list", { agent_id: 1 })).items.some(
      (m) =>
        m.id === 1 && m.content === "Updated UI preference" && m.revision === 4,
    ),
  );
  report.checks.push(
    "after renderer reload the forgotten archive exposes immutable history; duplicate restore clicks produce one revision on the original MemoryId",
  );
  const baseFact = (
    await core.request("memory.list", { agent_id: 1 })
  ).items.find((m) => m.id === 1);
  conflictProposal = {
    memory_id: baseFact.id,
    expected_revision: baseFact.revision,
    content: "UI preference is revised after evidence review",
    tier: "profile",
    evidence_quote: "UI preference is revised after evidence review",
  };
  await core.request("agent.start", {
    client_run_id: require("node:crypto").randomUUID(),
    workspace_id: wid,
    provider_id: provider.id,
    goal: "Please review this updated evidence for future tasks. UI preference is revised after evidence review",
  });
  await until(() =>
    js(
      `document.querySelector('[aria-label="记忆冲突"]')?.textContent.includes('待核对')`,
    ),
  );
  await js(
    `const button=[...document.querySelectorAll('[aria-label="记忆冲突"] button')].find(b=>b.textContent==='采用候选正文');button.click();button.click()`,
  );
  await until(
    async () =>
      (await core.request("memory.conflicts", { agent_id: 1 })).items[0]
        ?.state === "resolved",
  );
  const resolvedFact = (
    await core.request("memory.list", { agent_id: 1 })
  ).items.find((m) => m.id === 1);
  assert.equal(resolvedFact.content, conflictProposal.content);
  assert.equal(resolvedFact.revision, baseFact.revision + 1);
  report.checks.push(
    "background proposal preserves the protected fact; real typed conflict controls resolve duplicate clicks once on the original MemoryId",
  );
  for (const [scope, project, revision] of [
    ["project", "ui-shared-project", 2],
    ["user", "", 3],
    ["agent", "", 4],
  ]) {
    await field("maintenance-scope", scope, "HTMLSelectElement");
    if (project)
      await field("maintenance-project", project, "HTMLSelectElement");
    await js(
      "document.querySelector('#maintenance-save').click();document.querySelector('#maintenance-save').click()",
    );
    await until(
      async () =>
        (await core.request("memory.maintenance.get", { agent_id: 1 }))
          .revision === revision,
    );
    const savedScope = await core.request("memory.maintenance.get", {
      agent_id: 1,
    });
    assert.equal(savedScope.target_scope, scope);
    assert.equal(savedScope.target_project, project);
  }
  report.checks.push(
    "typed maintenance form saves project, user and private scopes once per duplicate click",
  );
  conflictProposal = null;
  forgettingProposal = "A paraphrase of the retired UI preference";
  await until(() =>
    js(
      `(()=>{const row=document.querySelector('[data-memory-id="${resolvedFact.id}"]');return row?.textContent.includes(${JSON.stringify(resolvedFact.content)})&&!row.querySelectorAll('button')[1].disabled})()`,
    ),
  );
  await js(
    `document.querySelector('[data-memory-id="${resolvedFact.id}"]').querySelectorAll('button')[1].click()`,
  );
  await until(
    async () =>
      !(await core.request("memory.list", { agent_id: 1 })).items.some(
        (entry) => entry.id === resolvedFact.id,
      ),
  );
  const guardRun = await core.request("agent.start", {
    client_run_id: require("node:crypto").randomUUID(),
    workspace_id: wid,
    provider_id: provider.id,
    goal: "Inspect this fixed UI evidence and consider whether any durable knowledge is suitable.",
  });
  await until(async () =>
    (await core.request("memory.jobs", { agent_id: 1 })).some(
      (job) =>
        job.source_run_id === guardRun.run.id && job.state === "waiting_review",
    ),
  );
  await until(() =>
    js(
      "document.querySelector('.memory-jobs')?.textContent.includes('遗忘核对待判定')",
    ),
  );
  await js(
    `[...document.querySelectorAll('.memory-jobs li')].find(li=>li.textContent.includes('任务 #${guardRun.run.id} ')).querySelector('button').click()`,
  );
  await until(() =>
    js(
      `document.querySelector('.memory-page .memory-job-detail')?.textContent.includes(${JSON.stringify(forgettingProposal)})`,
    ),
  );
  assert.equal(
    (await core.request("memory.list", { agent_id: 1 })).items.some(
      (entry) => entry.content === forgettingProposal,
    ),
    false,
  );
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(120);
    await js(
      "document.querySelector('.memory-page .memory-job-detail').scrollIntoView({block:'start'})",
    );
    assert.equal(
      await js("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
    fs.writeFileSync(
      path.join(profile, `forgetting-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  await js(
    `(()=>{const button=[...document.querySelectorAll('.memory-jobs li')].find(li=>li.textContent.includes('任务 #${guardRun.run.id} ')).querySelectorAll('button')[1];button.click();button.click()})()`,
  );
  await until(() =>
    js(
      "document.querySelector('.memory-page .memory-job-detail')?.textContent.includes('cancelled')",
    ),
  );
  report.checks.push(
    "semantic forgetting keeps an unapproved paraphrase outside memory; typed pending-review details and duplicate cancellation stay synchronized at three widths",
  );
  const layouts = [];
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(120);
    layouts.push(
      await js(
        "({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth})",
      ),
    );
    fs.writeFileSync(
      path.join(profile, "memory-" + width + ".png"),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  assert.ok(layouts.every((l) => !l.overflow));
  report.layouts = layouts;
  report.checks.push("memory view has no horizontal overflow at 1440/768/660");
  const count = server.requests.length;
  const reload = once(win.webContents, "did-finish-load");
  win.webContents.reload();
  await reload;
  await until(() => js("Boolean(document.querySelector('nav'))"));
  await nav("记忆");
  await until(() =>
    js(
      "document.querySelector('.memory-records')?.textContent.includes('UI automatic fact')",
    ),
  );
  assert.equal(server.requests.length, count);
  report.checks.push(
    "renderer reload restores facts and maintenance state without a new model request",
  );
  report.passed = true;
}
run()
  .catch(async (e) => {
    report.error = e.stack;
    if (runtime?.window && !runtime.window.isDestroyed()) {
      fs.writeFileSync(
        path.join(profile, "failure.txt"),
        await runtime.window.webContents.executeJavaScript(
          "document.body.innerText",
        ),
      );
    }
  })
  .finally(async () => {
    try {
      await runtime?.core.stop();
      report.coreStopped = !runtime?.core.child;
      await server?.close();
    } catch {
      report.coreStopped = false;
    }
    fs.writeFileSync(
      path.join(profile, "memory-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
