const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  setup,
  until,
  results,
  hook,
  emit,
  quote,
  sleep,
  user,
} = require("./fixtures/hooks-fixture.cjs");
const read = ({ body }) =>
  hook(body) || results(body).length
    ? []
    : [{ name: "read_file", arguments: { path: "input.txt" } }];

async function allCalls(h, id) {
  let rows = [],
    offset = 0;
  for (;;) {
    const p = await h.core.request("hooks.calls", { run_id: id, offset });
    rows.push(...p.items);
    if (p.next_offset === null) return rows;
    offset = p.next_offset;
  }
}
test("all 17 supported Hook events have live dispatch evidence; opaque reasoning never enters Hook input", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const h = await setup(t, {
    thinking: true,
    plan: ({ body }) =>
      hook(body) ||
      results(body).length ||
      user(body).includes("matrix-child") ||
      user(body).startsWith("Original task:") ||
      user(body).startsWith("<<TROOP_COMPACTION>>")
        ? []
        : [
            { name: "read_file", arguments: { path: "input.txt" } },
            {
              name: "write_file",
              arguments: {
                path: "matrix.txt",
                content: "once",
                expected_hash: "missing",
              },
            },
            {
              name: "run_command",
              arguments: { command: "Write-Output 'matrix-shell'" },
            },
            { name: "read_file", arguments: { path: "missing.txt" } },
            {
              name: "spawn_agent",
              arguments: { goal: "matrix-child", access: "inherit" },
            },
            {
              name: "start_background",
              arguments: {
                command: "Write-Output 'matrix-background'",
                timeout_seconds: "3",
              },
            },
          ],
    reply: ({ body }) =>
      hook(body)
        ? "{}"
        : user(body).startsWith("<<TROOP_COMPACTION>>")
          ? "Owned summary: commands and writes complete; do not replay."
          : "Owned matrix complete",
  });
  const supported = (await h.core.request("hooks.list", {})).events;
  assert.equal(supported.length, 19);
  const events = supported.filter((e) => !e.includes("MCPExecution"));
  assert.equal(events.length, 17);
  for (const event of events)
    await h.save({
      name: event,
      event,
      kind: "prompt",
      command: "",
      prompt: "Return {}. Event audit only.",
    });
  const id = await h.start({ goal: "event-matrix" });
  let requested = false;
  const final = await until(async () => {
    const s = await h.get(id);
    if (s.run.waiting.includes("approval")) {
      const inv = await h.call(
        id,
        s.invocations.findIndex(
          (i) => i.state === "prepared" && i.approval === null,
        ),
      );
      if (!requested) {
        await h.core.request("agent.compact", { id });
        requested = true;
      }
      await h.approve(inv);
    }
    return ["completed", "failed", "interrupted"].includes(s.run.state) && s;
  }, 30000);
  assert.equal(final.run.state, "completed");
  let calls = await allCalls(h, id);
  for (const task of final.tasks)
    if (task.child_run_id)
      calls.push(...(await allCalls(h, task.child_run_id)));
  assert.deepEqual(
    [
      ...new Set(
        calls.filter((c) => c.state === "succeeded").map((c) => c.event),
      ),
    ].sort(),
    [...events].sort(),
  );
  const afterBg = calls.find(
    (c) => c.event === "afterShellExecution" && c.event_key.includes("task-"),
  );
  assert.ok(afterBg);
  const detail = await h.core.request("hooks.call", { id: afterBg.id });
  assert.ok(JSON.stringify(detail.input).includes("matrix-background"));
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"), {
    readOnly: true,
  });
  for (const row of db.prepare("SELECT document FROM hook_calls").all()) {
    const d = JSON.parse(row.document);
    assert.ok(!JSON.stringify(d.input).includes("owned-signature"));
    assert.ok(!JSON.stringify(d.input).includes("owned reasoning"));
  }
  db.close();
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "matrix.txt"), "utf8"),
    "once",
  );
});

test("Core crash interrupts a live Hook, requires reconciliation and never replays its command", async (t) => {
  const h = await setup(t);
  await h.save({
    event: "sessionStart",
    timeout: 30,
    command:
      "while($true){[IO.File]::AppendAllText((Join-Path (Get-Location) 'crash-hook.txt'),'x');Start-Sleep -Milliseconds 40}",
  });
  const id = await h.start();
  await until(() => fs.existsSync(path.join(h.workspace, "crash-hook.txt")));
  const exit = new Promise((r) => h.core.child.once("exit", r));
  h.core.child.kill();
  await exit;
  await sleep(200);
  const size = fs.statSync(path.join(h.workspace, "crash-hook.txt")).size;
  await sleep(120);
  assert.equal(
    fs.statSync(path.join(h.workspace, "crash-hook.txt")).size,
    size,
  );
  await h.core.start();
  assert.equal((await h.get(id)).run.state, "interrupted");
  assert.equal(h.server.requests.length, 0);
  const c = (await h.calls(id)).items[0];
  assert.equal(c.state, "indeterminate");
  await assert.rejects(h.core.request("agent.resume", { id }), /Hooks/);
  await h.core.request("hooks.reconcile", {
    id: c.id,
    stopped: true,
    note: "Owned heartbeat file and whole process tree checked stopped",
  });
  await h.core.request("agent.resume", { id });
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal(
    fs.statSync(path.join(h.workspace, "crash-hook.txt")).size,
    size,
  );
  assert.equal((await h.calls(id)).total, 1);
});

test("disabling a running command revokes its revision and waits for effect reconciliation", async (t) => {
  const h = await setup(t);
  const rule = await h.save({
    event: "sessionStart",
    timeout: 30,
    command:
      "while($true){[IO.File]::AppendAllText((Join-Path (Get-Location) 'revoke.txt'),'x');Start-Sleep -Milliseconds 40}",
  });
  const id = await h.start();
  await until(() => fs.existsSync(path.join(h.workspace, "revoke.txt")));
  await h.save({ ...rule, expected_revision: rule.revision, enabled: false });
  assert.equal((await h.done(id)).run.state, "interrupted");
  const c = (await h.calls(id)).items[0];
  assert.equal(c.state, "indeterminate");
  assert.equal(c.stopped, true);
  const size = fs.statSync(path.join(h.workspace, "revoke.txt")).size;
  await h.done(await h.start());
  await sleep(100);
  assert.equal(fs.statSync(path.join(h.workspace, "revoke.txt")).size, size);
});

test("disabled prompt Hook discards a late deny without changing another model result", async (t) => {
  let signal, release;
  const arrived = new Promise((r) => (signal = r)),
    gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    plan: read,
    beforeResponse: async ({ body }) => {
      if (hook(body)) {
        signal();
        await gate;
      }
    },
    reply: ({ body }) =>
      hook(body) ? '{"permission":"deny"}' : "Owned response",
  });
  t.after(() => release());
  const rule = await h.save({
      kind: "prompt",
      command: "",
      prompt: "Test delayed response",
    }),
    id = await h.start();
  await arrived;
  await h.save({ ...rule, expected_revision: rule.revision, enabled: false });
  const final = await h.done(id);
  release();
  await sleep(100);
  assert.equal(final.run.state, "completed");
  assert.equal((await h.call(id)).state, "succeeded");
  const c = (await h.calls(id)).items[0];
  assert.equal(c.state, "skipped");
  assert.deepEqual(c.result, {});
});

test("prompt Hook streams share all four global slots and the fifth task remains queued", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    beforeResponse: async ({ body }) => {
      if (hook(body)) await gate;
    },
    reply: ({ body }) => (hook(body) ? "{}" : "Owned response"),
  });
  t.after(() => release());
  await h.save({
    event: "sessionStart",
    kind: "prompt",
    command: "",
    prompt: "Return {}",
  });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await h.start());
  await until(() => h.server.requests.length === 4);
  await sleep(120);
  assert.equal(h.server.requests.length, 4);
  assert.ok((await h.get(ids[4])).run.state !== "completed");
  release();
  for (const id of ids) assert.equal((await h.done(id)).run.state, "completed");
});

test("Hook ready gate commits before execution; ledger fault prevents the script effect", async (t) => {
  const { DatabaseSync } = require("node:sqlite"),
    h = await setup(t);
  await h.save({
    event: "sessionStart",
    command:
      "[IO.File]::WriteAllText((Join-Path (Get-Location) 'ghost-hook.txt'),'bad')",
  });
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER hook_gate_fault BEFORE UPDATE ON hook_calls WHEN json_extract(NEW.document,'$.state')='running' BEGIN SELECT RAISE(ABORT,'hook-gate-fault'); END",
  );
  const exit = new Promise((r) => h.core.child.once("exit", r));
  await h.start();
  await exit;
  await sleep(100);
  assert.ok(!fs.existsSync(path.join(h.workspace, "ghost-hook.txt")));
  db.exec("DROP TRIGGER hook_gate_fault");
  db.close();
});

test("new instruction during post Hook retains successful tool result and valid message ordering", async (t) => {
  let signal, release;
  const arrived = new Promise((r) => (signal = r)),
    gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    plan: ({ body }) =>
      hook(body) || results(body).length
        ? []
        : [
            {
              name: "write_file",
              arguments: {
                path: "post-once.txt",
                content: "once",
                expected_hash: "missing",
              },
            },
          ],
    beforeResponse: async ({ body }) => {
      if (hook(body) && user(body).includes('"event":"postToolUse"')) {
        signal();
        await gate;
      }
    },
    reply: ({ body }) =>
      hook(body)
        ? user(body).includes('"event":"beforeSubmitPrompt"')
          ? '{"additional_context":"OWNED_SUBMIT_CONTEXT"}'
          : "{}"
        : "Owned result",
  });
  t.after(() => release());
  await h.save({
    kind: "prompt",
    command: "",
    event: "postToolUse",
    prompt: "Return {}",
  });
  await h.save({
    kind: "prompt",
    command: "",
    event: "beforeSubmitPrompt",
    prompt: "Return a context",
  });
  const id = await h.start();
  await h.approve(await h.approval(id));
  await arrived;
  await h.core.request("agent.steer", {
    id,
    client_input_id: require("node:crypto").randomUUID(),
    text: "NEW_SAFE_BOUNDARY_INPUT",
  });
  release();
  assert.equal((await h.done(id)).run.state, "completed");
  const inv = await h.call(id);
  assert.equal(inv.state, "succeeded");
  assert.equal(inv.result.ok, true);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "post-once.txt"), "utf8"),
    "once",
  );
  const messages = h.server.requests.filter((r) => !hook(r.body)).at(-1)
    .body.messages;
  let pending = 0;
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content))
      pending += m.content.filter((b) => b.type === "tool_use").length;
    if (m.role === "user" && typeof m.content === "string")
      assert.equal(pending, 0);
    if (m.role === "user" && Array.isArray(m.content))
      pending -= m.content.filter((b) => b.type === "tool_result").length;
  }
  assert.equal(pending, 0);
});
test("preToolUse deny reaches the ledger without dispatching a host write", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "write_file",
              arguments: {
                path: "denied.txt",
                content: "owned",
                expected_hash: "missing",
              },
            },
          ],
  });
  await h.save({
    command: emit({ permission: "deny", user_message: "Owned policy denied" }),
  });
  const id = await h.start();
  await h.done(id);
  const inv = await h.call(id);
  assert.equal(inv.state, "failed");
  assert.equal(inv.result.hook_denied, true);
  assert.ok(!fs.existsSync(path.join(h.workspace, "denied.txt")));
  assert.equal((await h.calls(id)).items[0].state, "succeeded");
});
test("ask makes a normally automatic read wait for exact invocation approval", async (t) => {
  const h = await setup(t, { plan: read });
  await h.save({
    command: emit({ permission: "ask", user_message: "Review this read" }),
  });
  const id = await h.start(),
    inv = await h.approval(id);
  assert.equal(inv.name, "read_file");
  assert.equal(inv.hook_ask, true);
  assert.equal(inv.state, "prepared");
  await h.approve(inv);
  assert.equal((await h.done(id)).run.state, "completed");
  assert.equal((await h.call(id)).state, "succeeded");
});
test("allow cannot bypass normal file or command approval and updated_input is frozen before approval", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "write_file",
              arguments: {
                path: "old.txt",
                content: "old",
                expected_hash: "missing",
              },
            },
          ],
  });
  await h.save({
    command: emit({
      permission: "allow",
      updated_input: {
        path: "new.txt",
        content: "NEW_FROZEN",
        expected_hash: "missing",
      },
    }),
  });
  const id = await h.start(),
    inv = await h.approval(id);
  assert.equal(inv.arguments.path, "new.txt");
  assert.equal(inv.model_arguments.path, "old.txt");
  assert.ok(!fs.existsSync(path.join(h.workspace, "new.txt")));
  await h.approve(inv);
  await h.done(id);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "new.txt"), "utf8"),
    "NEW_FROZEN",
  );
  assert.ok(!fs.existsSync(path.join(h.workspace, "old.txt")));
});
test("pre Hook failClosed differs from default fail-open; post errors never repeat the tool", async (t) => {
  const h = await setup(t, { plan: read });
  let r = await h.save({ command: "throw 'owned-hook-error'" });
  let id = await h.start();
  await h.done(id);
  assert.equal((await h.call(id)).state, "succeeded");
  assert.equal((await h.calls(id)).items[0].state, "failed");
  r = await h.save({ ...r, expected_revision: r.revision, failClosed: true });
  id = await h.start();
  await h.done(id);
  assert.equal((await h.call(id)).state, "failed");
  await h.save({ ...r, expected_revision: r.revision, enabled: false });
  await h.save({
    event: "postToolUse",
    command: "throw 'owned-post-error'",
    failClosed: true,
  });
  id = await h.start();
  await h.done(id);
  assert.equal((await h.get(id)).invocations.length, 1);
  assert.equal((await h.call(id)).state, "succeeded");
  assert.equal((await h.calls(id)).items[0].state, "failed");
});
test("command Hook receives JSON stdin and additional context reaches the next model request", async (t) => {
  const h = await setup(t, { plan: read });
  await h.save({
    timeout: 15,
    command:
      "$e=[Console]::In.ReadToEnd()|ConvertFrom-Json; if($e.data.tool_input.path -ne 'input.txt'){exit 8}; " +
      emit({ additional_context: "OWNED_HOOK_CONTEXT" }),
  });
  const id = await h.start();
  await h.done(id);
  const c = (await h.calls(id)).items[0];
  assert.equal(c.state, "succeeded", JSON.stringify(c));
  assert.ok(
    JSON.stringify(h.server.requests.at(-1).body).includes(
      "OWNED_HOOK_CONTEXT",
    ),
  );
  const detail = await h.core.request("hooks.call", { id: c.id });
  assert.equal(detail.input.data.tool_input.path, "input.txt");
});
for (const protocol of ["chat_completions", "responses", "anthropic"])
  test(
    protocol +
      ": prompt Hooks use the selected provider without tools and expose usage",
    async (t) => {
      const h = await setup(t, {
        protocol,
        plan: read,
        reply: ({ body }) =>
          hook(body)
            ? JSON.stringify({
                permission: "allow",
                additional_context: "PROMPT_HOOK_OWNED",
              })
            : "Task done",
      });
      await h.save({
        kind: "prompt",
        command: "",
        prompt: "Allow the owned read and add a short context",
      });
      const id = await h.start();
      await h.done(id);
      const c = (await h.calls(id)).items[0];
      assert.equal(c.state, "succeeded");
      assert.ok(c.usage);
      const req = h.server.requests.find((r) => hook(r.body));
      assert.ok(!req.body.tools);
      assert.ok(!JSON.stringify(req.body).includes("secret_ref"));
      assert.ok(
        JSON.stringify(h.server.requests.at(-1).body).includes(
          "PROMPT_HOOK_OWNED",
        ),
      );
    },
  );
test("timeout and excessive output are visible failures with confirmed process-tree exit", async (t) => {
  const h = await setup(t, { plan: read });
  let r = await h.save({
    command: "Start-Sleep -Seconds 30",
    timeout: 0.15,
    failClosed: true,
  });
  let id = await h.start();
  await h.done(id);
  let c = (await h.calls(id)).items[0];
  assert.equal(c.state, "failed");
  assert.equal(c.stopped, true);
  assert.equal((await h.call(id)).state, "failed");
  await h.save({
    ...r,
    expected_revision: r.revision,
    command: "'x' * 12000",
    timeout: 3,
  });
  id = await h.start();
  await h.done(id);
  c = (await h.calls(id)).items[0];
  assert.equal(c.state, "failed");
  assert.equal(c.stopped, true);
});
test("matcher, loop_limit and explicit Linux location retain their separate semantics", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            { name: "read_file", arguments: { path: "input.txt" } },
            { name: "read_file", arguments: { path: "input.txt" } },
          ],
  });
  await h.save({ matcher: "^read_file$", loop_limit: 1 });
  await h.save({
    name: "No match",
    matcher: "^write_file$",
    command: emit({ permission: "deny" }),
  });
  await h.save({
    name: "Old Linux",
    location: "legacy-linux",
    command: "cat /workspace/input.txt",
    enabled: false,
  });
  await assert.rejects(
    h.save({ location: "legacy-linux", enabled: true }),
    /disabled/,
  );
  await assert.rejects(h.save({ matcher: "(?=read)" }), /regex/);
  const id = await h.start();
  await h.done(id);
  const calls = (await h.calls(id)).items;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].state, "succeeded");
  assert.equal(calls[1].state, "skipped");
  assert.equal((await h.get(id)).invocations.length, 2);
});
test("stop cancels the whole Hook process tree and does not execute a configured stop script afterward", async (t) => {
  const h = await setup(t, { plan: read });
  await h.save({
    event: "sessionStart",
    timeout: 30,
    command:
      "while($true){[IO.File]::AppendAllText((Join-Path (Get-Location) 'heartbeat.txt'),'x'); Start-Sleep -Milliseconds 50}",
  });
  await h.save({
    event: "stop",
    command:
      "[IO.File]::WriteAllText((Join-Path (Get-Location) 'should-not-run.txt'),'bad')",
  });
  const id = await h.start();
  await until(() => fs.existsSync(path.join(h.workspace, "heartbeat.txt")));
  await h.core.request("agent.cancel", { id });
  const final = await h.done(id);
  assert.ok(["cancelled", "interrupted"].includes(final.run.state));
  const size = fs.statSync(path.join(h.workspace, "heartbeat.txt")).size;
  await sleep(150);
  assert.equal(fs.statSync(path.join(h.workspace, "heartbeat.txt")).size, size);
  assert.ok(!fs.existsSync(path.join(h.workspace, "should-not-run.txt")));
  const c = (await h.calls(id)).items[0];
  assert.equal(c.stopped, true);
});
test("stop follow-up runs within budgets once, then loop_limit permits natural completion", async (t) => {
  const h = await setup(t);
  await h.save({
    event: "stop",
    loop_limit: 1,
    command: emit({ followup_message: "Perform the final owned check" }),
  });
  const id = await h.start();
  await h.done(id);
  assert.equal(h.server.requests.length, 2);
  const c = (await h.calls(id)).items;
  assert.equal(c[0].state, "succeeded");
  assert.equal(c[1].state, "skipped");
});
test("read-only child never runs command Hooks with inherited host privileges", async (t) => {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : user(body).includes("owned-child")
          ? [{ name: "read_file", arguments: { path: "input.txt" } }]
          : [
              {
                name: "spawn_agent",
                arguments: { goal: "owned-child", access: "read_only" },
              },
            ],
  });
  await h.save({ event: "sessionStart", command: emit({}) });
  const id = await h.start();
  const final = await h.done(id);
  const child = final.tasks[0].child_run_id;
  const c = (await h.calls(child)).items[0];
  assert.equal(c.state, "failed");
  assert.match(c.error, /read-only/);
  assert.equal(c.stopped, true);
});
