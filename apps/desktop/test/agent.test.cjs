const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const temp = path.resolve(__dirname, "../../../.tmp-troop-agent/tests");
fs.mkdirSync(temp, { recursive: true });
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(25);
  }
  throw Error("Agent condition timed out");
}
async function setup(t, plan, protocol = "anthropic", options = {}) {
  const directory = fs.mkdtempSync(path.join(temp, "case-")),
    workspace = path.join(directory, "project");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "input.txt"), "真实工具 中文");
  execFileSync("git", ["init", "--quiet"], {
    cwd: workspace,
    windowsHide: true,
  });
  const upstream = await agentServer({ plan, ...options });
  const core = new CoreSupervisor({
    executable: path.resolve(__dirname, "../bin", coreBinary),
    args: ["--data-dir", path.join(directory, "data")],
  });
  await core.start();
  await core.request("memory.agent.save", {
    id: 1,
    name: "Fixture Agent",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  t.after(async () => {
    await core.stop();
    await upstream.close();
  });
  const page = await core.request("workspace.add", { path: workspace });
  const provider = await core.request("provider.save", {
    config: {
      name: "自有 Agent 夹具",
      protocol,
      base_url: upstream.origin,
      model: "owned-tool-fixture",
      max_output_tokens: 1024,
      idle_timeout_secs: 5,
    },
  });
  const input = {
    client_run_id: crypto.randomUUID(),
    workspace_id: page.items[0].id,
    provider_id: provider.id,
    goal: "在自有临时工作区验证工具循环",
  };
  const start = async (extra = {}) =>
    (await core.request("agent.start", { ...input, ...extra })).run.id;
  const get = (id) => core.request("agent.get", { id });
  const inv = (id) => core.request("agent.invocation", { id });
  const approve = (i, approved = true) =>
    core.request("agent.approve", { id: i.id, epoch: i.epoch, approved });
  const done = (id) =>
    until(async () => {
      const s = await get(id);
      return ["completed", "failed", "cancelled", "interrupted"].includes(
        s.run.state,
      )
        ? s
        : false;
    });
  const approval = (id) =>
    until(async () => {
      const s = await get(id);
      return s.invocations.find(
        (i) =>
          i.state === "prepared" &&
          i.approval === null &&
          ["write_file", "run_command", "git_status"].includes(i.name),
      );
    });
  return {
    directory,
    workspace,
    upstream,
    core,
    input,
    start,
    get,
    inv,
    approve,
    done,
    approval,
  };
}
for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(`Agent ${protocol}: split tool JSON -> real files/PowerShell/Git -> model results`, async (t) => {
    const h = await setup(
      t,
      [
        { name: "read_file", arguments: { path: "input.txt" } },
        {
          name: "write_file",
          arguments: {
            path: "output.txt",
            content: "工具写入成功 中文",
            expected_hash: "missing",
          },
        },
        {
          name: "run_command",
          arguments: {
            command:
              "Set-Content -LiteralPath 'command.txt' -Value 'owned-command' -NoNewline",
          },
        },
        { name: "git_status", arguments: {} },
        { name: "search_text", arguments: { path: ".", text: "中文" } },
        { name: "list_directory", arguments: { path: "." } },
      ],
      protocol,
    );
    const id = await h.start();
    for (let i = 0; i < 3; i++) {
      const inv = await h.approval(id);
      await h.approve(inv);
    }
    const result = await h.done(id);
    assert.equal(result.run.state, "completed");
    assert.equal(result.run.output, "工具结果已核对。");
    assert.equal(
      fs.readFileSync(path.join(h.workspace, "output.txt"), "utf8"),
      "工具写入成功 中文",
    );
    assert.equal(
      fs.readFileSync(path.join(h.workspace, "command.txt"), "utf8"),
      "owned-command",
    );
    assert.equal(result.invocations.length, 6);
    assert.ok(result.invocations.every((i) => i.state === "succeeded"));
    assert.equal(h.upstream.requests.length, 2);
    const first = h.upstream.requests[0].body;
    assert.equal(first.tools.length, 15);
    const second = JSON.stringify(h.upstream.requests[1].body);
    assert.ok(
      second.includes("owned-call-0") &&
        second.includes("真实工具") &&
        second.includes("sha256"),
    );
    const duplicate = await h.core.request("agent.start", h.input);
    assert.equal(duplicate.run.id, id);
    assert.equal(duplicate.duplicate, true);
    assert.equal(h.upstream.requests.length, 2);
    await assert.rejects(
      h.core.request("agent.start", { ...h.input, goal: "改变目标" }),
    );
  });
test("denied approval is immutable, idempotent and never writes", async (t) => {
  const h = await setup(t, [
    {
      name: "write_file",
      arguments: {
        path: "denied.txt",
        content: "never",
        expected_hash: "missing",
      },
    },
  ]);
  const id = await h.start(),
    inv = await h.approval(id);
  await h.approve(inv, false);
  assert.equal((await h.approve(inv, false)).duplicate, true);
  await assert.rejects(h.approve(inv, true));
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal(fs.existsSync(path.join(h.workspace, "denied.txt")), false);
  assert.equal((await h.inv(inv.id)).state, "failed");
});
test("Anthropic signed thinking and redacted blocks survive the tool round trip", async (t) => {
  const h = await setup(
    t,
    [{ name: "read_file", arguments: { path: "input.txt" } }],
    "anthropic",
    { thinking: true },
  );
  assert.equal((await h.done(await h.start())).run.state, "completed");
  const assistant = h.upstream.requests[1].body.messages.find(
    (m) => m.role === "assistant",
  );
  assert.deepEqual(assistant.content[0], {
    type: "thinking",
    thinking: "owned reasoning",
    signature: "owned-signature",
  });
  assert.deepEqual(assistant.content[1], {
    type: "redacted_thinking",
    data: "owned-opaque",
  });
  assert.deepEqual(assistant.content[2].input, { path: "input.txt" });
});
test("model step budget stops a repeated read plan without further requests", async (t) => {
  const h = await setup(t, () => [
    { name: "read_file", arguments: { path: "input.txt" } },
  ]);
  const result = await h.done(await h.start());
  assert.equal(result.run.state, "failed");
  assert.equal(result.run.intent, "failure");
  assert.equal(h.upstream.requests.length, 16);
  assert.equal(result.invocations.length, 16);
});
test("write precondition rejects external edits and retains user content", async (t) => {
  const hash = crypto
    .createHash("sha256")
    .update("真实工具 中文")
    .digest("hex");
  const h = await setup(t, [
    {
      name: "write_file",
      arguments: {
        path: "input.txt",
        content: "overwrite",
        expected_hash: hash,
      },
    },
  ]);
  const id = await h.start(),
    inv = await h.approval(id);
  fs.writeFileSync(path.join(h.workspace, "input.txt"), "external edit");
  await h.approve(inv);
  await h.done(id);
  assert.equal((await h.inv(inv.id)).state, "failed");
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "input.txt"), "utf8"),
    "external edit",
  );
});
for (const target of [
  "../escaped.txt",
  "C:\\outside.txt",
  "NUL",
  ".git/config",
])
  test(`workspace tool rejects unsafe path ${target}`, async (t) => {
    const h = await setup(t, [
      {
        name: "write_file",
        arguments: { path: target, content: "never", expected_hash: "missing" },
      },
    ]);
    const id = await h.start(),
      inv = await h.approval(id);
    await h.approve(inv);
    await h.done(id);
    assert.equal((await h.inv(inv.id)).state, "failed");
    assert.equal(fs.existsSync(path.join(h.directory, "escaped.txt")), false);
  });
test("junction escape is refused", async (t) => {
  const h = await setup(t, [
    {
      name: "write_file",
      arguments: {
        path: "link/escape.txt",
        content: "never",
        expected_hash: "missing",
      },
    },
  ]);
  const outside = path.join(h.directory, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(h.workspace, "link"), "junction");
  const id = await h.start(),
    inv = await h.approval(id);
  await h.approve(inv);
  await h.done(id);
  assert.equal((await h.inv(inv.id)).state, "failed");
  assert.equal(fs.existsSync(path.join(outside, "escape.txt")), false);
});
for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(`incomplete ${protocol} tool JSON fails before preparing or executing`, async (t) => {
    const h = await setup(
      t,
      [
        {
          name: "write_file",
          arguments: {
            path: "bad.txt",
            content: "never",
            expected_hash: "missing",
          },
        },
      ],
      protocol,
      { malformed: true },
    );
    const result = await h.done(await h.start());
    assert.equal(result.run.state, "failed");
    assert.equal(result.invocations.length, 0);
    assert.equal(h.upstream.requests.length, 1);
  });
test("cancel while approval is pending invalidates approval across restart", async (t) => {
  const h = await setup(t, [
    {
      name: "write_file",
      arguments: {
        path: "cancelled.txt",
        content: "never",
        expected_hash: "missing",
      },
    },
  ]);
  const id = await h.start(),
    inv = await h.approval(id);
  await h.core.request("agent.cancel", { id });
  await h.done(id);
  await assert.rejects(h.approve(inv));
  await h.core.stop();
  await h.core.start();
  assert.equal((await h.get(id)).run.state, "cancelled");
  await assert.rejects(h.core.request("agent.resume", { id }));
  assert.equal(fs.existsSync(path.join(h.workspace, "cancelled.txt")), false);
});
test("steering is applied at a safe boundary and invalidates the old plan", async (t) => {
  const h = await setup(t, [
    {
      name: "write_file",
      arguments: {
        path: "old-plan.txt",
        content: "never",
        expected_hash: "missing",
      },
    },
  ]);
  const id = await h.start(),
    inv = await h.approval(id);
  await h.core.request("agent.steer", {
    id,
    client_input_id: crypto.randomUUID(),
    text: "取消尚未执行的文件计划，只总结当前状态",
  });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal((await h.inv(inv.id)).state, "cancelled");
  assert.equal(fs.existsSync(path.join(h.workspace, "old-plan.txt")), false);
  assert.ok(
    JSON.stringify(h.upstream.requests[1].body).includes("只总结当前状态"),
  );
});
test("PowerShell captures Unicode output and bounds noisy streams", async (t) => {
  const h = await setup(t, [
    {
      name: "run_command",
      arguments: {
        command: "Write-Output '命令输出 中文'; Write-Output ('x' * 5000)",
      },
    },
  ]);
  const id = await h.start(),
    inv = await h.approval(id);
  await h.approve(inv);
  await h.done(id);
  const result = (await h.inv(inv.id)).result;
  assert.equal(result.ok, true);
  assert.ok(result.value.stdout.includes("命令输出 中文"));
  assert.equal(result.value.truncated, true);
  assert.ok(Buffer.byteLength(result.value.stdout) < 3100);
});
const psLiteral = (s) => "'" + s.replaceAll("'", "''") + "'";
async function runningTree(t) {
  const h = await setup(t, (request) => {
    const history = request.body.messages;
    const hasResults = history.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result"),
    );
    return hasResults
      ? []
      : [
          {
            name: "run_command",
            arguments: {
              command: `& ${psLiteral(process.execPath)} ${psLiteral(path.join(h.workspace, "tree.cjs"))}`,
            },
          },
        ];
  });
  fs.writeFileSync(
    path.join(h.workspace, "tree.cjs"),
    `const fs=require('node:fs'),{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"setInterval(()=>require('node:fs').appendFileSync('heartbeat.txt','x'),50)"],{stdio:'ignore',windowsHide:true});fs.writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`,
  );
  const id = await h.start(),
    inv = await h.approval(id);
  await h.approve(inv);
  await until(() => fs.existsSync(path.join(h.workspace, "pids.json")));
  const pids = JSON.parse(
    fs.readFileSync(path.join(h.workspace, "pids.json"), "utf8"),
  );
  return { ...h, id, invocation: inv, pids };
}
async function assertTreeStopped(h) {
  await until(() =>
    h.pids.every((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return e.code === "ESRCH";
      }
    }),
  );
  const heartbeat = path.join(h.workspace, "heartbeat.txt");
  const before = fs.existsSync(heartbeat)
    ? fs.readFileSync(heartbeat, "utf8")
    : "";
  await sleep(200);
  assert.equal(
    fs.existsSync(heartbeat) ? fs.readFileSync(heartbeat, "utf8") : "",
    before,
  );
}
test("Stop terminates the actual command process tree and retains effects", async (t) => {
  const h = await runningTree(t);
  const started = Date.now();
  await h.core.request("agent.cancel", { id: h.id });
  assert.equal((await h.done(h.id)).run.state, "cancelled");
  assert.ok(Date.now() - started < 2000);
  await assertTreeStopped(h);
  const inv = await h.inv(h.invocation.id);
  assert.equal(inv.state, "indeterminate");
  assert.equal(inv.stopped, true);
  assert.ok(fs.existsSync(path.join(h.workspace, "pids.json")));
});
test("Core crash stops owned jobs; restart requires review and never replays old command", async (t) => {
  const h = await runningTree(t);
  const closed = once(h.core.child, "close");
  h.core.child.kill();
  await closed;
  await assertTreeStopped(h);
  await h.core.start();
  const state = await h.get(h.id);
  assert.equal(state.run.state, "interrupted");
  assert.equal(state.invocations[0].state, "indeterminate");
  await sleep(200);
  assert.equal(h.upstream.requests.length, 1);
  await assert.rejects(h.core.request("agent.resume", { id: h.id }));
  await h.core.request("agent.reconcile", {
    id: h.invocation.id,
    epoch: h.invocation.epoch,
    source: "reviewed",
    note: "核对真实 PID 均已停止，保留已产生的测试文件。",
  });
  await h.core.request("agent.resume", { id: h.id });
  const result = await h.done(h.id);
  assert.equal(result.run.state, "completed");
  assert.equal(result.run.epoch, 2);
  assert.equal(result.invocations.length, 1);
  assert.equal(h.upstream.requests.length, 2);
  await assertTreeStopped(h);
});
test("explicit shutdown interrupts an active task for manual continuation", async (t) => {
  const h = await runningTree(t);
  await h.core.stop();
  await assertTreeStopped(h);
  await h.core.start();
  const state = await h.get(h.id);
  assert.equal(state.run.state, "interrupted");
  assert.equal(state.run.intent, null);
  assert.equal(h.upstream.requests.length, 1);
});
test("normal command completion drains surviving descendants before releasing resources", async (t) => {
  let h;
  h = await setup(t, (request) => {
    const hasResults = request.body.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result"),
    );
    return hasResults
      ? []
      : [
          {
            name: "run_command",
            arguments: {
              command: `& ${psLiteral(process.execPath)} ${psLiteral(path.join(h.workspace, "detach.cjs"))}`,
            },
          },
        ];
  });
  fs.writeFileSync(
    path.join(h.workspace, "detach.cjs"),
    "const fs=require('node:fs'),{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"setInterval(()=>require('node:fs').appendFileSync('heartbeat.txt','x'),10)\"],{stdio:'ignore',windowsHide:true});fs.writeFileSync('child-pid.json',JSON.stringify([c.pid]));c.unref();",
  );
  const id = await h.start(),
    inv = await h.approval(id);
  await h.approve(inv);
  assert.equal((await h.done(id)).run.state, "completed");
  h.pids = JSON.parse(
    fs.readFileSync(path.join(h.workspace, "child-pid.json"), "utf8"),
  );
  await assertTreeStopped(h);
  assert.equal((await h.inv(inv.id)).result.stopped, true);
});
test("host resource queue serializes commands from separate runs", async (t) => {
  const h = await setup(t, [
    {
      name: "run_command",
      arguments: {
        command:
          "Add-Content -LiteralPath 'sequence.txt' -Value 'start'; Start-Sleep -Milliseconds 350; Add-Content -LiteralPath 'sequence.txt' -Value 'end'",
      },
    },
  ]);
  const first = await h.start(),
    second = await h.start({
      client_run_id: crypto.randomUUID(),
      goal: "第二个排队任务",
    });
  await h.approve(await h.approval(first));
  await h.approve(await h.approval(second));
  await until(async () =>
    (await h.get(second)).run.waiting.includes("resource"),
  );
  assert.equal((await h.done(first)).run.state, "completed");
  assert.equal((await h.done(second)).run.state, "completed");
  assert.deepEqual(
    fs
      .readFileSync(path.join(h.workspace, "sequence.txt"), "utf8")
      .trim()
      .split(/\r?\n/),
    ["start", "end", "start", "end"],
  );
});
test("steering arriving during final model text schedules a new safe model step", async (t) => {
  const h = await setup(t, [], "anthropic", { delay: 100 });
  const id = await h.start();
  await until(async () => (await h.get(id)).run.state === "running");
  await h.core.request("agent.steer", {
    id,
    client_input_id: crypto.randomUUID(),
    text: "请在下一步核对补充说明",
  });
  const result = await h.done(id);
  assert.equal(result.run.state, "completed");
  assert.equal(result.run.step, 2);
  assert.equal(h.upstream.requests.length, 2);
  assert.ok(
    JSON.stringify(h.upstream.requests[1].body).includes("下一步核对补充说明"),
  );
});
test("large run snapshots and history pages stay within RPC bounds", async (t) => {
  const h = await setup(t, []);
  const id = await h.start();
  await h.done(id);
  await h.core.stop();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(h.directory, "data/troop.sqlite3"));
  const original = JSON.parse(
    db.prepare("SELECT document FROM agent_runs WHERE id=?").get(id).document,
  );
  const goal = "large goal" + "\n".repeat(11000),
    output = "text" + "\n".repeat(23000);
  for (let i = 0; i < 35; i++) {
    const doc = {
      ...original,
      id: 100 + i,
      goal,
      output,
      supplements: Array.from({ length: 8 }, (_, j) => ({
        id: String(j),
        text: "\n".repeat(11000),
        applied: true,
      })),
    };
    db.prepare(
      "INSERT INTO agent_runs(id,client_id,request,state,document) VALUES(?,?,?,'completed',?)",
    ).run(doc.id, crypto.randomUUID(), "{}", JSON.stringify(doc));
  }
  db.close();
  await h.core.start();
  const page = await h.core.request("agent.list");
  assert.equal(page.items.length, 30);
  assert.equal(page.total, 36);
  assert.equal(page.next_offset, 30);
  assert.equal(
    (await h.core.request("agent.list", { offset: 30 })).items.length,
    6,
  );
  const data = await h.get(134);
  assert.equal(data.run.goal_truncated, true);
  assert.equal(data.run.output_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 50000);
  assert.equal(
    (await h.core.request("agent.content", { id: 134, field: "goal" })).text,
    goal,
  );
  assert.equal(
    (await h.core.request("agent.content", { id: 134, field: "output" })).text,
    output,
  );
});
test("a lost Core result is reconciled from the durable Worker receipt without rerunning", async (t) => {
  const h = await setup(t, [
    {
      name: "write_file",
      arguments: {
        path: "receipt.txt",
        content: "once",
        expected_hash: "missing",
      },
    },
  ]);
  const id = await h.start(),
    inv = await h.approval(id);
  const { DatabaseSync } = require("node:sqlite");
  const database = path.join(h.directory, "data/troop.sqlite3");
  let db = new DatabaseSync(database, { readOnly: true });
  const cut = JSON.parse(
    db.prepare("SELECT document FROM agent_runs WHERE id=?").get(id).document,
  );
  db.close();
  await h.approve(inv);
  await h.done(id);
  await h.core.stop();
  // Controlled cut: retain the real Worker result but restore Core's pre-result checkpoint.
  db = new DatabaseSync(database);
  const tool = JSON.parse(
    db.prepare("SELECT document FROM agent_invocations WHERE id=?").get(inv.id)
      .document,
  );
  tool.state = "running";
  tool.result = null;
  tool.reviewed = false;
  tool.stopped = false;
  cut.state = "waiting";
  db.prepare("UPDATE agent_runs SET state='waiting',document=? WHERE id=?").run(
    JSON.stringify(cut),
    id,
  );
  db.prepare("UPDATE agent_invocations SET document=? WHERE id=?").run(
    JSON.stringify(tool),
    inv.id,
  );
  db.close();
  await h.core.start();
  await assert.rejects(h.core.request("agent.resume", { id }));
  const receiptFile = path.join(
    h.directory,
    `data/worker-receipts/${inv.id}-${inv.epoch}.json`,
  );
  const realReceipt = fs.readFileSync(receiptFile, "utf8"),
    uncertain = JSON.parse(realReceipt);
  uncertain.result.indeterminate = true;
  fs.writeFileSync(receiptFile, JSON.stringify(uncertain));
  await assert.rejects(
    h.core.request("agent.reconcile", {
      id: inv.id,
      epoch: inv.epoch,
      source: "receipt",
      note: "",
    }),
  );
  fs.writeFileSync(receiptFile, realReceipt);
  await h.core.request("agent.reconcile", {
    id: inv.id,
    epoch: inv.epoch,
    source: "receipt",
    note: "",
  });
  await h.core.request("agent.resume", { id });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal((await h.get(id)).invocations.length, 1);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "receipt.txt"), "utf8"),
    "once",
  );
  assert.equal((await h.inv(inv.id)).state, "succeeded");
});
test("a storage commit failure prevents side-effect dispatch", async (t) => {
  const h = await setup(t, [
    {
      name: "write_file",
      arguments: {
        path: "must-not-exist.txt",
        content: "never",
        expected_hash: "missing",
      },
    },
  ]);
  const id = await h.start(),
    inv = await h.approval(id);
  const { DatabaseSync } = require("node:sqlite");
  const database = path.join(h.directory, "data/troop.sqlite3");
  let db = new DatabaseSync(database);
  db.exec(
    "CREATE TRIGGER reject_dispatch BEFORE UPDATE ON agent_runs WHEN json_extract(NEW.document,'$.waiting[0]')='tool' BEGIN SELECT RAISE(ABORT,'owned-storage-fault'); END;",
  );
  db.close();
  const closed = once(h.core.child, "close");
  await h.approve(inv);
  await closed;
  assert.equal(
    fs.existsSync(path.join(h.workspace, "must-not-exist.txt")),
    false,
  );
  assert.equal(
    fs.readdirSync(path.join(h.directory, "data/worker-receipts")).length,
    0,
  );
  db = new DatabaseSync(database);
  db.exec("DROP TRIGGER reject_dispatch");
  db.close();
  await h.core.start();
  assert.equal((await h.get(id)).run.state, "interrupted");
  await sleep(150);
  assert.equal(h.upstream.requests.length, 1);
});
test("Git status requires approval and ignores workspace executables and fsmonitor", async (t) => {
  const gitExecutable = execFileSync("where.exe", ["git"], {
    encoding: "utf8",
    windowsHide: true,
  })
    .trim()
    .split(/\r?\n/)
    .find((p) => p.toLowerCase().endsWith("git.exe"));
  const h = await setup(t, [{ name: "git_status", arguments: {} }]);
  fs.copyFileSync(process.execPath, path.join(h.workspace, "git.exe"));
  execFileSync(
    gitExecutable,
    ["config", "core.fsmonitor", "echo unsafe-monitor > monitor.txt"],
    { cwd: h.workspace, windowsHide: true },
  );
  const firstId = await h.start();
  const firstApproval = await h.approval(firstId);
  assert.equal(h.upstream.requests.length, 1);
  await h.approve(firstApproval);
  const first = await h.done(firstId);
  assert.equal(first.invocations[0].state, "succeeded");
  assert.equal(fs.existsSync(path.join(h.workspace, "monitor.txt")), false);
  execFileSync(
    gitExecutable,
    ["-c", "core.fsmonitor=false", "add", "input.txt"],
    { cwd: h.workspace, windowsHide: true },
  );
  fs.writeFileSync(
    path.join(h.workspace, ".gitattributes"),
    "input.txt filter=owned\n",
  );
  fs.writeFileSync(path.join(h.workspace, "input.txt"), "changed tracked file");
  execFileSync(
    gitExecutable,
    ["config", "filter.owned.clean", "echo unsafe-filter > filter.txt"],
    { cwd: h.workspace, windowsHide: true },
  );
  const secondId = await h.start({ client_run_id: crypto.randomUUID() });
  const secondApproval = await h.approval(secondId);
  assert.equal(fs.existsSync(path.join(h.workspace, "filter.txt")), false);
  const secondReceipt = path.join(
    h.directory,
    `data/worker-receipts/${secondApproval.id}-${secondApproval.epoch}.json`,
  );
  assert.equal(fs.existsSync(secondReceipt), false);
  await h.approve(secondApproval);
  const second = await h.done(secondId);
  assert.equal(second.invocations[0].state, "succeeded");
  assert.equal((await h.inv(secondApproval.id)).approval, true);
  assert.equal(
    JSON.parse(fs.readFileSync(secondReceipt, "utf8")).result.stopped,
    true,
  );
});
test("active run quota applies to both new starts and manual resume", async (t) => {
  const h = await setup(t, [
    {
      name: "write_file",
      arguments: {
        path: "quota.txt",
        content: "never",
        expected_hash: "missing",
      },
    },
  ]);
  const interrupted = await h.start();
  await h.approval(interrupted);
  await h.core.stop();
  await h.core.start();
  const active = [];
  for (let i = 0; i < 16; i++)
    active.push(
      await h.start({
        client_run_id: crypto.randomUUID(),
        goal: `bounded-${i}`,
      }),
    );
  await assert.rejects(h.core.request("agent.resume", { id: interrupted }));
  await assert.rejects(h.start({ client_run_id: crypto.randomUUID() }));
  for (const id of active) await h.core.request("agent.cancel", { id });
  assert.equal(fs.existsSync(path.join(h.workspace, "quota.txt")), false);
});
