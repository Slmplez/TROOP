const { app } = require("electron"),
  { bootstrap } = require("../src/main.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { once } = require("node:events");
const profile = process.argv[2],
  report = { checks: [], passed: false };
let runtime, server;
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
        : user(body).startsWith("<<TROOP_MEMORY_")
          ? '{"additions":[{"content":"UI automatic fact","tier":"log"}],"removals":[]}'
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
  const js = (code) => win.webContents.executeJavaScript(code, true);
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
  .catch((e) => {
    report.error = e.message;
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
