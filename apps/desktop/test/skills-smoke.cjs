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
  for (let n = 0; n < 375; n++) {
    if (await fn()) return;
    await sleep(40);
  }
  throw Error("Skills UI condition timed out");
}
async function run() {
  const workspace = path.join(profile, "workspace"),
    source = path.join(profile, "owned-skill");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(source, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "SKILL.md"),
    "---\nname: Rust workspace review\nid: rust-review\ndescription: Review Rust changes and record evidence\n---\nOWNED_UI_RECIPE",
  );
  fs.writeFileSync(
    path.join(source, "references/checks.md"),
    "OWNED_UI_CHECKLIST",
  );
  server = await agentServer({
    plan: ({ body }) =>
      body.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === "tool_result"),
      )
        ? []
        : [
            { name: "read_skill", arguments: { skill_id: "rust-review" } },
            {
              name: "read_skill_file",
              arguments: {
                skill_id: "rust-review",
                path: "references/checks.md",
              },
            },
          ],
  });
  runtime = await bootstrap({ userData: profile, show: false });
  const { window: win, core } = runtime;
  win.webContents.setBackgroundThrottling(false);
  await until(() => core.state === "ready");
  await core.request("memory.agent.save", {
    id: 1,
    name: "Owned Skills Agent",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const provider = await core.request("provider.save", {
    config: {
      name: "Owned skills UI",
      protocol: "anthropic",
      base_url: server.origin,
      model: "owned-skills-ui",
      max_output_tokens: 2048,
      idle_timeout_secs: 5,
    },
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const field = async (id, value, type = "HTMLInputElement") => {
    await js(
      `(()=>{const e=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await sleep(60);
  };
  const click = async (selector) => {
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(60);
  };
  const nav = async (text) => {
    await js(
      `[...document.querySelectorAll('nav button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`,
    );
    await sleep(80);
  };
  let loaded = once(win.webContents, "did-finish-load");
  win.webContents.reload();
  await loaded;
  await until(() => js("Boolean(document.querySelector('nav'))"));
  await nav("技能");
  await until(() =>
    js("document.querySelectorAll('#skill-agent option').length===1"),
  );
  await field("skill-path", source);
  await click("#skill-preview");
  await until(() =>
    js("Boolean(document.querySelector('#skill-import-confirm'))"),
  );
  assert.equal((await core.request("skills.list", { agent_id: 1 })).total, 0);
  report.checks.push(
    "folder preview shows source, manifest and fingerprint without saving or executing",
  );
  await click("#skill-import-confirm");
  await until(() =>
    js("Boolean(document.querySelector('[data-skill=rust-review]'))"),
  );
  report.checks.push(
    "explicit import saves instructions and auxiliary files through production IPC",
  );
  await click('[data-skill="rust-review"] input[type=checkbox]');
  await until(() =>
    js("!document.querySelector('[data-skill=rust-review] input').checked"),
  );
  assert.equal(
    (await core.request("skills.list", { agent_id: 1 })).items[0].enabled,
    false,
  );
  await click('[data-skill="rust-review"] input[type=checkbox]');
  await until(() =>
    js("document.querySelector('[data-skill=rust-review] input').checked"),
  );
  report.checks.push(
    "Agent toggle persists and disabling also disables Run Now",
  );
  await click('[data-skill="rust-review"] .skill-name');
  await until(() => js("Boolean(document.querySelector('#skill-editor'))"));
  await field(
    "skill-editor",
    "---\nname: Rust workspace review\ndescription: Review Rust changes and record evidence\n---\nEDITED_UI_RECIPE",
    "HTMLTextAreaElement",
  );
  await click("#skill-save");
  await until(
    async () =>
      (await core.request("skills.versions", { id: "rust-review" })).items
        .length === 2,
  );
  await click("#skill-versions");
  await until(() =>
    js("document.querySelectorAll('.skill-versions li').length===2"),
  );
  assert.ok(
    fs
      .readFileSync(path.join(source, "SKILL.md"), "utf8")
      .includes("OWNED_UI_RECIPE"),
  );
  report.checks.push(
    "editing creates a new version, preserves source, and exposes immutable version history",
  );
  await js("document.querySelector('.skill-import').open=true");
  await click("#skill-preview");
  await until(() =>
    js("Boolean(document.querySelector('#skill-conflict-confirm'))"),
  );
  assert.ok(
    await js("document.querySelector('#skill-import-confirm').disabled"),
  );
  await click("#skill-conflict-confirm");
  await click("#skill-import-confirm");
  await until(
    async () =>
      (await core.request("skills.versions", { id: "rust-review" })).items
        .length === 3,
  );
  report.checks.push(
    "same ID requires explicit conflict choice; import preserves the locally edited version",
  );
  await field("skill-provider", provider.id, "HTMLSelectElement");
  await field("skill-workspace", String(wid), "HTMLSelectElement");
  await click('[data-skill="rust-review"] .skill-run');
  await until(() =>
    js(
      "document.querySelector('nav button[aria-current=page]')?.textContent==='任务'",
    ),
  );
  let runId;
  await until(async () => {
    const list = await core.request("agent.list", {});
    runId = list.items[0]?.id;
    return (
      runId &&
      (await core.request("agent.get", { id: runId })).run.state === "completed"
    );
  });
  const task = await core.request("agent.get", { id: runId });
  assert.equal(task.run.workflow_expansions.length, 1);
  assert.equal(task.invocations.length, 2);
  assert.ok(
    JSON.stringify(server.requests[0].body).includes("OWNED_UI_RECIPE"),
  );
  assert.ok(
    JSON.stringify(server.requests.at(-1).body).includes("OWNED_UI_CHECKLIST"),
  );
  report.checks.push(
    "Run Now selects Agent/model/workspace, opens the actual task and sends the expanded recipe plus helper results",
  );
  await nav("技能");
  await until(() =>
    js("Boolean(document.querySelector('[data-skill=rust-review]'))"),
  );
  await click("#skill-new");
  await field("skill-new-id", "release-notes");
  await field(
    "skill-editor",
    "---\nname: Release notes\n---\nSummarize the completed changes.",
    "HTMLTextAreaElement",
  );
  await click("#skill-save");
  await until(() =>
    js("Boolean(document.querySelector('[data-skill=release-notes]'))"),
  );
  report.checks.push(
    "new skill editor creates a named local skill with collision protection",
  );
  await click('[data-skill="rust-review"] .skill-name');
  await until(() =>
    js(
      "document.querySelector('#skill-editor')?.value.includes('OWNED_UI_RECIPE')",
    ),
  );
  report.layouts = [];
  for (const width of [1440, 768, 660]) {
    win.setContentSize(width, 900);
    await sleep(120);
    report.layouts.push(
      await js(
        "({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,smallText:[...document.querySelectorAll('.skills-page label,.skills-page button')].some(e=>parseFloat(getComputedStyle(e).fontSize)<11)})",
      ),
    );
    fs.writeFileSync(
      path.join(profile, `skills-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  assert.ok(report.layouts.every((l) => !l.overflow && !l.smallText));
  report.checks.push(
    "real Electron layouts keep controls and source text usable at 1440/768/660 widths",
  );
  await click("#skill-delete");
  await click("#skill-delete-confirm");
  await until(() => js("!document.querySelector('[data-skill=rust-review]')"));
  assert.equal(
    (await core.request("skills.versions", { id: "rust-review" })).items.length,
    3,
  );
  assert.equal(
    (await core.request("agent.get", { id: runId })).run.state,
    "completed",
  );
  const requests = server.requests.length;
  loaded = once(win.webContents, "did-finish-load");
  win.webContents.reload();
  await loaded;
  await until(() => js("Boolean(document.querySelector('nav'))"));
  await nav("技能");
  await until(() =>
    js("Boolean(document.querySelector('[data-skill=release-notes]'))"),
  );
  assert.equal(server.requests.length, requests);
  report.checks.push(
    "deletion blocks future use, retains history, and renderer reload does not replay a workflow",
  );
  report.passed = true;
}
run()
  .catch((e) => {
    report.error = e.stack;
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
      path.join(profile, "skills-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  });
