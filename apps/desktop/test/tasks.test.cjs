const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { once } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const { agentServer, sleep } = require("./fixtures/agent-server.cjs");
const base = path.resolve(__dirname, "../../../.tmp-troop-tasks");
fs.mkdirSync(base, { recursive: true });

test("supplement reaches a safe boundary while a long background task is still running", async (t) => {
  const h = await setup(t, ({ body }) => {
    const r = results(body),
      messages = body.messages;
    if (
      messages.some((m) => m.role === "user" && m.content === "stop-owned-now")
    )
      return r.some((i) => i.task)
        ? []
        : [{ name: "stop_task", arguments: { task_id: String(r[0].task_id) } }];
    return r.length
      ? []
      : [
          {
            name: "start_background",
            arguments: {
              command:
                "Set-Content -LiteralPath 'steer-started.txt' -Value 'owned'; Start-Sleep -Seconds 30",
              timeout_seconds: "60",
            },
          },
        ];
  });
  const id = await h.start();
  await h.approve(await h.approval(id));
  await until(() => fs.existsSync(path.join(h.workspace, "steer-started.txt")));
  await until(async () => (await h.get(id)).run.waiting.includes("background"));
  await h.core.request("agent.steer", {
    id,
    client_input_id: crypto.randomUUID(),
    text: "stop-owned-now",
  });
  await until(async () =>
    (await h.get(id)).invocations.some(
      (i) => i.name === "stop_task" && i.state === "succeeded",
    ),
  );
  assert.equal((await h.done(id)).run.state, "interrupted");
});

test("finished Worker receipt recovers a lost business result without rerunning command", async (t) => {
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? []
      : [
          {
            name: "start_background",
            arguments: {
              command: "Add-Content -LiteralPath 'once.txt' -Value 'once'",
              timeout_seconds: "10",
            },
          },
        ],
  );
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER result_fault BEFORE INSERT ON agent_events WHEN NEW.kind='background_finished' BEGIN SELECT RAISE(ABORT,'result-fault'); END",
  );
  const id = await h.start(),
    exit = once(h.core.child, "exit");
  await h.approve(await h.approval(id));
  await exit;
  db.exec("DROP TRIGGER result_fault");
  db.close();
  const content = fs.readFileSync(path.join(h.workspace, "once.txt"), "utf8");
  await h.core.start();
  const task = (await h.tasks(id))[0];
  assert.equal(task.state, "indeterminate");
  await h.core.request("agent.reconcile-task", {
    id: task.id,
    epoch: task.epoch,
    source: "receipt",
    note: "",
  });
  await h.core.request("agent.resume", { id });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "once.txt"), "utf8"),
    content,
  );
});

test("explicit shutdown stops nested owned work and startup never resumes models", async (t) => {
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? []
      : initial(body) === "shutdown-child"
        ? [
            {
              name: "start_background",
              arguments: {
                command:
                  "while ($true) { Add-Content -LiteralPath 'shutdown.txt' -Value 'beat'; Start-Sleep -Milliseconds 100 }",
                timeout_seconds: "60",
              },
            },
          ]
        : [
            {
              name: "spawn_agent",
              arguments: { goal: "shutdown-child", access: "inherit" },
            },
          ],
  );
  const id = await h.start(),
    child = await until(async () => (await h.tasks(id))[0]?.child_run_id);
  await h.approve(await h.approval(child));
  await until(() => fs.existsSync(path.join(h.workspace, "shutdown.txt")));
  await h.core.stop();
  const size = fs.statSync(path.join(h.workspace, "shutdown.txt")).size;
  await sleep(250);
  assert.equal(fs.statSync(path.join(h.workspace, "shutdown.txt")).size, size);
  const count = h.server.requests.length;
  await h.core.start();
  await sleep(200);
  assert.equal(h.server.requests.length, count);
  assert.equal((await h.get(id)).run.state, "interrupted");
  assert.equal((await h.get(child)).run.state, "interrupted");
  assert.ok(
    (await h.tasks(id)).every(
      (t) =>
        !["running", "queued", "dispatched", "cancelling"].includes(t.state),
    ),
  );
});

test("child background timeout pauses owner and requires descendant reconciliation", async (t) => {
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? []
      : initial(body) === "timeout-child"
        ? [
            {
              name: "start_background",
              arguments: {
                command: "Start-Sleep -Seconds 30",
                timeout_seconds: "1",
              },
            },
          ]
        : [
            {
              name: "spawn_agent",
              arguments: { goal: "timeout-child", access: "inherit" },
            },
          ],
  );
  const id = await h.start(),
    child = await until(async () => (await h.tasks(id))[0]?.child_run_id);
  await h.approve(await h.approval(child));
  assert.equal((await h.done(id)).run.state, "interrupted");
  const tree = await h.tasks(id),
    agent = tree.find((t) => t.kind === "agent"),
    background = tree.find((t) => t.kind === "background");
  await assert.rejects(
    h.core.request("agent.reconcile-task", {
      id: agent.id,
      epoch: agent.epoch,
      source: "reviewed",
      note: "Cannot bypass descendant review",
    }),
  );
  await h.core.request("agent.reconcile-task", {
    id: background.id,
    epoch: background.epoch,
    source: "reviewed",
    note: "Timed-out fixture command stopped; effects checked",
  });
  await h.core.request("agent.reconcile-task", {
    id: agent.id,
    epoch: agent.epoch,
    source: "reviewed",
    note: "Child output and all descendant effects checked; old child will not restart",
  });
  await h.core.request("agent.resume", { id });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal((await h.get(child)).run.state, "interrupted");
  assert.equal((await h.tasks(id)).length, 2);
});

test("child nesting is bounded at depth two and read-only cannot widen access", async (t) => {
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? []
      : [
          {
            name: "spawn_agent",
            arguments: { goal: "nested-child", access: "inherit" },
          },
        ],
  );
  const id = await h.start();
  assert.equal((await h.done(id)).run.state, "completed");
  const tasks = await h.tasks(id);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((j) => j.state === "succeeded" && j.consumed));
  const deepest = await h.get(tasks[1].child_run_id);
  assert.equal(deepest.run.depth, 2);
  assert.equal(deepest.invocations[0].state, "failed");
});

test("model failure stops still-owned background before completing failure cleanup", async (t) => {
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? Array.from({ length: 9 }, () => ({
          name: "read_file",
          arguments: { path: "input.txt" },
        }))
      : [
          {
            name: "start_background",
            arguments: {
              command:
                "while ($true) { Add-Content -LiteralPath 'heartbeat.txt' -Value 'beat'; Start-Sleep -Milliseconds 100 }",
              timeout_seconds: "60",
            },
          },
        ],
  );
  const id = await h.start();
  await h.approve(await h.approval(id));
  const final = await h.done(id);
  assert.equal(final.run.intent, "failure");
  const tasks = await h.tasks(id);
  assert.ok(
    tasks.every((j) => !["running", "queued", "dispatched"].includes(j.state)),
  );
  const file = path.join(h.workspace, "heartbeat.txt"),
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  await sleep(350);
  assert.equal(fs.existsSync(file) ? fs.statSync(file).size : 0, size);
  await assert.rejects(h.core.request("agent.resume", { id }));
});

test("task tool cannot inspect a different run's background job", async (t) => {
  let stolen;
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? []
      : initial(body) === "probe"
        ? [{ name: "task_status", arguments: { task_id: String(stolen) } }]
        : [
            {
              name: "start_background",
              arguments: {
                command: "Start-Sleep -Seconds 2",
                timeout_seconds: "10",
              },
            },
          ],
  );
  const owner = await h.start();
  await h.approve(await h.approval(owner));
  stolen = await until(async () => (await h.tasks(owner))[0]?.id);
  const probe = await h.start("probe");
  const done = await h.done(probe);
  assert.equal(done.invocations[0].state, "failed");
  const inv = await h.core.request("agent.invocation", {
    id: done.invocations[0].id,
  });
  assert.match(inv.result.error, /does not own/);
});

test("crash at completion consumption retains outbox and accepts exactly once after manual resume", async (t) => {
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? []
      : [
          {
            name: "start_background",
            arguments: {
              command: "Start-Sleep -Seconds 1; Write-Output 'receipt-proof'",
              timeout_seconds: "10",
            },
          },
        ],
  );
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER consume_fault BEFORE INSERT ON agent_events WHEN NEW.kind='owned_completions_consumed' BEGIN SELECT RAISE(ABORT,'consume-fault'); END",
  );
  const id = await h.start();
  const exit = once(h.core.child, "exit");
  await h.approve(await h.approval(id));
  await exit;
  const raw = JSON.parse(
    db.prepare("SELECT document FROM owned_tasks").get().document,
  );
  assert.equal(raw.state, "succeeded");
  assert.equal(raw.consumed, false);
  db.exec("DROP TRIGGER consume_fault");
  db.close();
  const before = h.server.requests.length;
  await h.core.start();
  await sleep(200);
  assert.equal(h.server.requests.length, before);
  await h.core.request("agent.resume", { id });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal((await h.tasks(id))[0].consumed, true);
  const snapshot = h.server.requests.at(-1).body;
  assert.equal(JSON.stringify(snapshot).split(raw.completion_id).length - 1, 1);
});
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(25);
  }
  throw Error("Owned task condition timed out");
}
function results(body) {
  const messages = body.messages ?? body.input;
  return messages
    .flatMap((m) =>
      m.role === "tool"
        ? [m.content]
        : m.type === "function_call_output"
          ? [m.output]
          : Array.isArray(m.content)
            ? m.content
                .filter((b) => b.type === "tool_result")
                .map((b) => b.content)
            : [],
    )
    .map((v) => {
      try {
        return JSON.parse(v);
      } catch {
        return {};
      }
    });
}
function initial(body) {
  return (body.messages ?? body.input)[0].content;
}
async function setup(t, plan, protocol = "anthropic") {
  const directory = fs.mkdtempSync(path.join(base, "case-")),
    workspace = path.join(directory, "workspace"),
    data = path.join(directory, "data");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "input.txt"), "owned-child-proof");
  const server = await agentServer({ plan });
  const core = new CoreSupervisor({
    executable: path.resolve(__dirname, "../bin", coreBinary),
    args: ["--data-dir", data],
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
    await server.close();
  });
  const w = (await core.request("workspace.add", { path: workspace })).items[0];
  const provider = await core.request("provider.save", {
    config: {
      name: "Owned tasks fixture",
      protocol,
      base_url: server.origin,
      model: "owned-tasks",
      max_output_tokens: 1024,
      idle_timeout_secs: 5,
    },
  });
  const start = async (goal = "parent-private-context") =>
    (
      await core.request("agent.start", {
        client_run_id: crypto.randomUUID(),
        workspace_id: w.id,
        provider_id: provider.id,
        goal,
      })
    ).run.id;
  const get = (id) => core.request("agent.get", { id });
  const tasks = async (id) => (await core.request("agent.tasks", { id })).items;
  const approval = (id) =>
    until(async () =>
      (await get(id)).invocations.find(
        (i) =>
          i.state === "prepared" &&
          i.approval === null &&
          [
            "run_command",
            "start_background",
            "write_file",
            "git_status",
          ].includes(i.name),
      ),
    );
  const approve = (i) =>
    core.request("agent.approve", { id: i.id, epoch: i.epoch, approved: true });
  const done = (id) =>
    until(async () => {
      const s = await get(id);
      return ["completed", "failed", "cancelled", "interrupted"].includes(
        s.run.state,
      )
        ? s
        : false;
    });
  return {
    directory,
    workspace,
    data,
    core,
    server,
    start,
    get,
    tasks,
    approval,
    approve,
    done,
  };
}
for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(`${protocol}: child independent context and durable completion consumed once`, async (t) => {
    const h = await setup(
      t,
      ({ body }) => {
        if (initial(body) === "owned-child")
          return results(body).length
            ? []
            : [{ name: "read_file", arguments: { path: "input.txt" } }];
        return results(body).length
          ? []
          : [
              {
                name: "spawn_agent",
                arguments: { goal: "owned-child", access: "read_only" },
              },
            ];
      },
      protocol,
    );
    const id = await h.start();
    const final = await h.done(id);
    assert.equal(final.run.state, "completed");
    const [task] = await h.tasks(id);
    assert.equal(task.owner_run_id, id);
    assert.equal(task.kind, "agent");
    assert.equal(task.state, "succeeded");
    assert.equal(task.consumed, true);
    const child = await h.get(task.child_run_id);
    assert.equal(child.run.read_only, true);
    assert.equal(child.run.owner_task_id, task.id);
    assert.equal(child.run.state, "completed");
    const requests = h.server.requests.filter(
      (r) => initial(r.body) === "owned-child",
    );
    assert.equal(requests.length, 2);
    assert.ok(!JSON.stringify(requests).includes("parent-private-context"));
    assert.ok(
      requests.every(
        (r) =>
          !r.body.tools.some(
            (d) => (d.name ?? d.function?.name) === "run_command",
          ),
      ),
    );
    const before = h.server.requests.length;
    const ended = once(h.core.child, "exit");
    h.core.child.kill();
    await ended;
    await h.core.start();
    await sleep(300);
    assert.equal(h.server.requests.length, before);
    assert.equal((await h.tasks(id))[0].completion_id, task.completion_id);
    assert.equal((await h.tasks(id))[0].consumed, true);
  });
test("read-only child rejects unadvertised write without approval or effects", async (t) => {
  const h = await setup(t, ({ body }) => {
    if (results(body).length) return [];
    return initial(body) === "malicious-child"
      ? [
          {
            name: "write_file",
            arguments: {
              path: "forbidden.txt",
              content: "bad",
              expected_hash: "missing",
            },
          },
        ]
      : [
          {
            name: "spawn_agent",
            arguments: { goal: "malicious-child", access: "read_only" },
          },
        ];
  });
  const id = await h.start();
  assert.equal((await h.done(id)).run.state, "completed");
  const task = (await h.tasks(id))[0],
    child = await h.get(task.child_run_id);
  assert.equal(child.invocations[0].state, "failed");
  assert.equal(fs.existsSync(path.join(h.workspace, "forbidden.txt")), false);
});
test("background exact approval, live output, held resource, and parent final waits", async (t) => {
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? []
      : initial(body) === "other"
        ? [{ name: "read_file", arguments: { path: "input.txt" } }]
        : [
            {
              name: "start_background",
              arguments: {
                command:
                  "Write-Output 'live-proof'; Set-Content -LiteralPath 'begin.txt' -Value 'owned'; Start-Sleep -Seconds 3; Write-Output 'done-proof'",
                timeout_seconds: "20",
              },
            },
          ],
  );
  const id = await h.start(),
    inv = await h.approval(id);
  assert.equal((await h.tasks(id)).length, 0);
  assert.equal(fs.existsSync(path.join(h.workspace, "begin.txt")), false);
  await h.approve(inv);
  await until(() => fs.existsSync(path.join(h.workspace, "begin.txt")));
  const task = (await h.tasks(id))[0];
  await until(async () => {
    const d = await h.core.request("agent.task", { id: task.id });
    return d.output?.stdout?.includes("live-proof");
  });
  assert.notEqual((await h.get(id)).run.state, "completed");
  const other = await h.start("other");
  await until(async () =>
    (await h.get(other)).run.waiting.includes("resource"),
  );
  assert.equal((await h.get(other)).invocations[0].state, "prepared");
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal((await h.done(other)).run.state, "completed");
  const detail = await h.core.request("agent.task", { id: task.id });
  assert.equal(detail.state, "succeeded");
  assert.equal(detail.consumed, true);
  assert.equal(detail.result.stopped, true);
  assert.ok(detail.result.value.stdout.includes("done-proof"));
});
test("wait_task waits without model polling and consumes result with tool history", async (t) => {
  const h = await setup(t, ({ body }) => {
    const r = results(body);
    if (!r.length)
      return [
        {
          name: "start_background",
          arguments: {
            command: "Start-Sleep -Seconds 2; Write-Output 'wait-proof'",
            timeout_seconds: "10",
          },
        },
      ];
    return r.length === 1
      ? [{ name: "wait_task", arguments: { task_id: String(r[0].task_id) } }]
      : [];
  });
  const id = await h.start();
  await h.approve(await h.approval(id));
  await until(async () =>
    (await h.get(id)).invocations.some((i) => i.name === "wait_task"),
  );
  const count = h.server.requests.length;
  await sleep(500);
  assert.equal(h.server.requests.length, count);
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal((await h.tasks(id))[0].consumed, true);
  assert.equal(h.server.requests.length, 3);
});
test("parent stop propagates to child background and old work cannot resume", async (t) => {
  const h = await setup(t, ({ body }) => {
    if (results(body).length) return [];
    return initial(body) === "command-child"
      ? [
          {
            name: "start_background",
            arguments: {
              command:
                "Set-Content -LiteralPath 'running.txt' -Value 'owned'; while ($true) { Add-Content -LiteralPath 'heartbeat.txt' -Value 'beat'; Start-Sleep -Milliseconds 100 }",
              timeout_seconds: "60",
            },
          },
        ]
      : [
          {
            name: "spawn_agent",
            arguments: { goal: "command-child", access: "inherit" },
          },
        ];
  });
  const id = await h.start();
  const child = await until(async () => (await h.tasks(id))[0]?.child_run_id);
  await h.approve(await h.approval(child));
  await until(() => fs.existsSync(path.join(h.workspace, "heartbeat.txt")));
  await h.core.request("agent.cancel", { id });
  const stopped = await h.done(id);
  assert.equal(stopped.run.intent, "cancel");
  const size = fs.statSync(path.join(h.workspace, "heartbeat.txt")).size;
  await sleep(350);
  assert.equal(fs.statSync(path.join(h.workspace, "heartbeat.txt")).size, size);
  const tree = await h.tasks(id);
  assert.ok(
    tree.every((j) => !["running", "queued", "dispatched"].includes(j.state)),
  );
  await assert.rejects(h.core.request("agent.resume", { id }));
  await assert.rejects(h.core.request("agent.resume", { id: child }));
  const count = h.server.requests.length;
  await sleep(200);
  assert.equal(h.server.requests.length, count);
});
test("Core crash stops owned command, restart quarantines, receipt/manual review does not replay", async (t) => {
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? []
      : [
          {
            name: "start_background",
            arguments: {
              command:
                "while ($true) { Add-Content -LiteralPath 'heartbeat.txt' -Value 'beat'; Start-Sleep -Milliseconds 100 }",
              timeout_seconds: "60",
            },
          },
        ],
  );
  const id = await h.start();
  await h.approve(await h.approval(id));
  await until(() => fs.existsSync(path.join(h.workspace, "heartbeat.txt")));
  const task = (await h.tasks(id))[0],
    ended = once(h.core.child, "exit");
  h.core.child.kill();
  await ended;
  await sleep(400);
  const size = fs.statSync(path.join(h.workspace, "heartbeat.txt")).size;
  await sleep(300);
  assert.equal(fs.statSync(path.join(h.workspace, "heartbeat.txt")).size, size);
  const count = h.server.requests.length;
  await h.core.start();
  await sleep(200);
  assert.equal(h.server.requests.length, count);
  assert.equal((await h.get(id)).run.state, "interrupted");
  assert.equal((await h.tasks(id))[0].state, "indeterminate");
  await assert.rejects(h.core.request("agent.resume", { id }));
  await h.core.request("agent.reconcile-task", {
    id: task.id,
    epoch: task.epoch,
    source: "reviewed",
    note: "Owned fixture heartbeat stopped; output reviewed; no replay",
  });
  await h.core.request("agent.resume", { id });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal((await h.tasks(id)).length, 1);
  assert.equal(fs.statSync(path.join(h.workspace, "heartbeat.txt")).size, size);
});
test("atomic child/task creation rejects SQLite fault before any child request", async (t) => {
  const h = await setup(t, ({ body }) =>
    results(body).length
      ? []
      : [
          {
            name: "spawn_agent",
            arguments: { goal: "never-start", access: "inherit" },
          },
        ],
  );
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER task_fault BEFORE INSERT ON owned_tasks BEGIN SELECT RAISE(ABORT,'owned-task-fault'); END",
  );
  const id = await h.start();
  const final = await h.done(id);
  assert.equal(final.run.state, "completed");
  assert.equal((await h.tasks(id)).length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM agent_runs").get().n, 1);
  assert.ok(!h.server.requests.some((r) => initial(r.body) === "never-start"));
  db.close();
});
