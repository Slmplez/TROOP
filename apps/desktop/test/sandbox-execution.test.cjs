const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { setup, until } = require("./fixtures/hooks-fixture.cjs");
const { baseContainerSkip } = require("./fixtures/sandbox-support.cjs");
const native = { skip: baseContainerSkip };
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const command = async (h, method, input, operation = crypto.randomUUID()) => {
  const receipt = await h.core.request("operations.execute", {
    operation_id: operation,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
  if (receipt.state !== "committed")
    throw Error(receipt.error?.message ?? JSON.stringify(receipt));
  return receipt;
};
const grant = async (h, overrides = {}) =>
  (
    await command(h, "authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "MXC scoped Shell",
        purpose: "tool_call",
        agent_id: 1,
        engine_id: "native",
        workspace_id: h.wid,
        project_ids: [],
        read_roots: [h.workspace],
        write_roots: [h.workspace],
        operations: ["run_command", "start_background"],
        network: "none",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        rule_id: null,
        shell: {},
        ...overrides,
      },
    })
  ).result;
const direct = (h, g, script, extra = {}) =>
  command(h, "agent.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: h.wid,
    agent_id: 1,
    goal: "Run scoped native command",
    authorization_id: g.id,
    action: { name: "run_command", arguments: { command: script } },
    ...extra,
  });

test(
  "MXC direct Shell enforces roots, readonly, link targets and offline access with zero model requests",
  native,
  async (t) => {
    const h = await setup(t);
    const readonly = path.join(h.directory, "readonly");
    const outside = path.join(h.directory, "outside");
    fs.mkdirSync(readonly);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(readonly, "input.txt"), "readonly");
    fs.writeFileSync(path.join(outside, "input.txt"), "outside");
    fs.symlinkSync(outside, path.join(h.workspace, "escape"), "junction");
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      res.end("reachable");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const g = await grant(h, { read_roots: [h.workspace, readonly] });
    assert.equal(
      g.shell.program_sha256,
      "090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a",
    );
    assert.equal(g.shell.runtime_read_roots.length, 1);
    const script = `$ErrorActionPreference='Stop'; $r=@{};
    $r.input=[IO.File]::ReadAllText('input.txt');
    [IO.File]::WriteAllText('allowed.txt','allowed');
    $r.readonly=[IO.File]::ReadAllText(${quote(path.join(readonly, "input.txt"))});
    try { [IO.File]::WriteAllText(${quote(path.join(readonly, "bad.txt"))},'bad'); $r.readonly_write=$true } catch { $r.readonly_write=$false }
    try { [void][IO.File]::ReadAllText(${quote(path.join(outside, "input.txt"))}); $r.outside_read=$true } catch { $r.outside_read=$false }
    try { [IO.File]::WriteAllText(${quote(path.join(outside, "bad.txt"))},'bad'); $r.outside_write=$true } catch { $r.outside_write=$false }
    try { [void][IO.File]::ReadAllText('escape/input.txt'); $r.link_read=$true } catch { $r.link_read=$false }
    try { [IO.File]::WriteAllText('escape/link-bad.txt','bad'); $r.link_write=$true } catch { $r.link_write=$false }
    try { [void](New-Object Net.WebClient).DownloadString('http://127.0.0.1:${server.address().port}/'); $r.network=$true } catch { $r.network=$false }
    $r | ConvertTo-Json -Compress`;
    const input = {
      client_run_id: crypto.randomUUID(),
      workspace_id: h.wid,
      agent_id: 1,
      goal: "Native sandbox boundary",
      authorization_id: g.id,
      action: { name: "run_command", arguments: { command: script } },
    };
    const operation = crypto.randomUUID();
    const receipt = await command(h, "agent.start", input, operation);
    assert.deepEqual(
      await command(h, "agent.start", input, operation),
      receipt,
    );
    const run = receipt.result.run.id;
    assert.equal((await h.done(run)).run.state, "completed");
    const inv = await h.call(run);
    assert.equal(inv.permission_plan.sandbox.network, "none");
    assert.equal(inv.result.value.exit_code, 0, JSON.stringify(inv.result));
    assert.deepEqual(JSON.parse(inv.result.value.stdout), {
      input: "owned input",
      readonly: "readonly",
      readonly_write: false,
      outside_read: false,
      outside_write: false,
      link_read: false,
      link_write: false,
      network: false,
    });
    assert.equal(
      fs.readFileSync(path.join(h.workspace, "allowed.txt"), "utf8"),
      "allowed",
    );
    assert.equal(fs.existsSync(path.join(outside, "bad.txt")), false);
    assert.equal(fs.existsSync(path.join(outside, "link-bad.txt")), false);
    assert.equal(fs.existsSync(path.join(readonly, "bad.txt")), false);
    assert.equal(requests, 0);
    assert.equal(h.server.requests.length, 0);
  },
);

test(
  "MXC network any reaches owned HTTP while keeping filesystem restrictions",
  native,
  async (t) => {
    const h = await setup(t);
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      res.end("TROOP_MXC_NETWORK");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const g = await grant(h, { network: "any" });
    const receipt = await direct(
      h,
      g,
      `(New-Object Net.WebClient).DownloadString('http://127.0.0.1:${server.address().port}/')`,
    );
    await h.done(receipt.result.run.id);
    const inv = await h.call(receipt.result.run.id);
    assert.equal(inv.result.value.exit_code, 0, JSON.stringify(inv.result));
    assert.match(inv.result.value.stdout, /TROOP_MXC_NETWORK/);
    assert.equal(requests, 1);
    assert.equal(inv.permission_plan.sandbox.network, "any");
  },
);

test(
  "MXC requires explicit binding and rejects forged or obsolete program identity",
  async (t) => {
    const h = await setup(t);
    const unbound = await grant(h, { shell: null });
    await assert.rejects(direct(h, unbound, "'must not run'"), /Shell|权限/);
    await assert.rejects(
      grant(h, { shell: { program_sha256: "0".repeat(64) } }),
      /身份|绑定/,
    );
    assert.equal(h.server.requests.length, 0);
  },
);

test(
  "MXC automatic model tool uses the same recorded sandbox plan",
  native,
  async (t) => {
    const h = await setup(t, {
      plan: [
        {
          name: "run_command",
          arguments: {
            command:
              "[IO.File]::WriteAllText('model.txt','scoped model'); 'model done'",
          },
        },
      ],
    });
    const g = await grant(h);
    const run = await h.start({ authorization_id: g.id });
    assert.equal((await h.done(run)).run.state, "completed");
    const inv = await h.call(run);
    assert.equal(inv.approval, true);
    assert.equal(inv.permission_plan.sandbox.adapter, "mxc-process-v1");
    assert.equal(inv.result.value.exit_code, 0, JSON.stringify(inv.result));
    assert.equal(
      fs.readFileSync(path.join(h.workspace, "model.txt"), "utf8"),
      "scoped model",
    );
  },
);

test(
  "MXC in-flight revocation stops descendants and restart does not replay effects",
  native,
  async (t) => {
    const h = await setup(t);
    const g = await grant(h);
    const receipt = await direct(
      h,
      g,
      "[IO.File]::WriteAllText('begun.txt','begun'); Start-Sleep -Seconds 10; [IO.File]::WriteAllText('late.txt','late')",
    );
    const run = receipt.result.run.id;
    await until(() => fs.existsSync(path.join(h.workspace, "begun.txt")));
    await command(h, "authorizations.revoke", {
      id: g.id,
      expected_revision: 1,
    });
    const stopped = await h.done(run);
    assert.ok(["interrupted", "failed"].includes(stopped.run.state));
    const inv = await h.call(run);
    assert.equal(inv.stopped, true);
    assert.equal(fs.existsSync(path.join(h.workspace, "late.txt")), false);
    await h.core.stop();
    await h.core.start();
    assert.equal((await h.get(run)).run.id, run);
    await assert.rejects(
      direct(h, g, "[IO.File]::WriteAllText('late.txt','bad')"),
      /授权/,
    );
    assert.equal(fs.existsSync(path.join(h.workspace, "late.txt")), false);
  },
);

test(
  "MXC direct background Run waits for its owned Task and uses its sandbox",
  native,
  async (t) => {
    const h = await setup(t);
    const g = await grant(h);
    const receipt = await direct(h, g, "", {
      action: {
        name: "start_background",
        arguments: {
          command:
            "[IO.File]::WriteAllText('background-started.txt','begun'); while(-not [IO.File]::Exists('background-release.txt')) { Start-Sleep -Milliseconds 50 }; [IO.File]::WriteAllText('background-finished.txt','done')",
          timeout_seconds: "20",
        },
      },
    });
    const run = receipt.result.run.id;
    await until(() =>
      fs.existsSync(path.join(h.workspace, "background-started.txt")),
    );
    assert.notEqual((await h.get(run)).run.state, "completed");
    fs.writeFileSync(
      path.join(h.workspace, "background-release.txt"),
      "release",
    );
    assert.equal((await h.done(run)).run.state, "completed");
    const tasks = (await h.core.request("agent.tasks", { id: run })).items;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].stopped, true);
    const detail = await h.core.request("agent.task", { id: tasks[0].id });
    assert.equal(detail.result.value.sandbox.adapter, "mxc-process-v1");
    assert.equal(
      fs.readFileSync(
        path.join(h.workspace, "background-finished.txt"),
        "utf8",
      ),
      "done",
    );
    assert.equal(h.server.requests.length, 0);
  },
);

test(
  "MXC compiles parent reads and narrower writes without widening readonly siblings",
  native,
  async (t) => {
    const h = await setup(t);
    const writable = path.join(h.workspace, "可写 folder");
    fs.mkdirSync(writable);
    const g = await grant(h, { write_roots: [writable] });
    const receipt = await direct(
      h,
      g,
      "$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('可写 folder/result.txt','narrow'); try { [IO.File]::WriteAllText('forbidden.txt','bad'); 'outside allowed' } catch { 'outside denied' }",
    );
    await h.done(receipt.result.run.id);
    const inv = await h.call(receipt.result.run.id);
    assert.equal(inv.result.value.exit_code, 0, JSON.stringify(inv.result));
    assert.match(inv.result.value.stdout, /outside denied/);
    assert.equal(
      fs.readFileSync(path.join(writable, "result.txt"), "utf8"),
      "narrow",
    );
    assert.equal(fs.existsSync(path.join(h.workspace, "forbidden.txt")), false);
  },
);

test(
  "MXC rejects pre-existing and newly inserted hardlinks before submitting the command",
  native,
  async (t) => {
    const h = await setup(t);
    const outside = path.join(h.directory, "outside.txt");
    fs.writeFileSync(outside, "original");
    const g = await grant(h);
    fs.linkSync(outside, path.join(h.workspace, "alias.txt"));
    const receipt = await direct(
      h,
      g,
      "[IO.File]::WriteAllText('alias.txt','bad'); [IO.File]::WriteAllText('submitted.txt','bad')",
    );
    assert.equal((await h.done(receipt.result.run.id)).run.state, "failed");
    const inv = await h.call(receipt.result.run.id);
    assert.match(inv.result.error, /硬链接/);
    assert.equal(fs.readFileSync(outside, "utf8"), "original");
    assert.equal(fs.existsSync(path.join(h.workspace, "submitted.txt")), false);
  },
);

test(
  "MXC running Shell cannot introduce a hardlink to an out-of-scope source",
  native,
  async (t) => {
    const h = await setup(t);
    const outside = path.join(h.directory, "outside.txt");
    fs.writeFileSync(outside, "original");
    const g = await grant(h);
    const receipt = await direct(
      h,
      g,
      `$ErrorActionPreference='Stop'; try { New-Item -ItemType HardLink -Path 'alias.txt' -Value ${quote(outside)} | Out-Null; 'alias allowed' } catch { 'alias denied' }`,
    );
    await h.done(receipt.result.run.id);
    const inv = await h.call(receipt.result.run.id);
    assert.equal(inv.result.value.exit_code, 0, JSON.stringify(inv.result));
    assert.match(inv.result.value.stdout, /alias denied/);
    assert.equal(fs.existsSync(path.join(h.workspace, "alias.txt")), false);
    assert.equal(fs.readFileSync(outside, "utf8"), "original");
  },
);

test(
  "MXC running Shell cannot turn readonly input into a writable hardlink",
  native,
  async (t) => {
    const h = await setup(t);
    const readonly = path.join(h.directory, "readonly");
    fs.mkdirSync(readonly);
    const input = path.join(readonly, "input.txt");
    fs.writeFileSync(input, "readonly original");
    const g = await grant(h, { read_roots: [h.workspace, readonly] });
    const receipt = await direct(
      h,
      g,
      `$ErrorActionPreference='Stop'; try { New-Item -ItemType HardLink -Path 'alias.txt' -Value ${quote(input)} | Out-Null; [IO.File]::WriteAllText('alias.txt','bad'); 'alias write allowed' } catch { 'alias write denied' }`,
    );
    await h.done(receipt.result.run.id);
    const inv = await h.call(receipt.result.run.id);
    assert.equal(inv.result.value.exit_code, 0, JSON.stringify(inv.result));
    assert.match(inv.result.value.stdout, /alias write denied/);
    assert.equal(fs.readFileSync(input, "utf8"), "readonly original");
  },
);

test(
  "scoped command Hook shares MXC boundaries and receives the original JSON input",
  native,
  async (t) => {
    const h = await setup(t, {
      plan: [{ name: "read_file", arguments: { path: "input.txt" } }],
    });
    const outside = path.join(h.directory, "outside.txt");
    const hook = await h.save({
      command: `$ErrorActionPreference='Stop'; $inputText=[Console]::In.ReadToEnd(); [IO.File]::WriteAllText('hook-input.json',$inputText); try { [IO.File]::WriteAllText(${quote(outside)},'bad'); 'bad' | Out-Null } catch {}; [IO.File]::WriteAllText('hook-marker.txt','contained'); '{"additional_context":"scoped command Hook"}'`,
    });
    const g = await grant(h, {
      operations: ["read_file"],
      command_hooks: [
        { id: hook.id, revision: hook.revision, host_access: "sandbox" },
      ],
    });
    const run = await h.start({ authorization_id: g.id });
    assert.equal((await h.done(run)).run.state, "completed");
    assert.equal(
      fs.readFileSync(path.join(h.workspace, "hook-marker.txt"), "utf8"),
      "contained",
    );
    assert.doesNotThrow(() =>
      JSON.parse(
        fs.readFileSync(path.join(h.workspace, "hook-input.json"), "utf8"),
      ),
    );
    assert.equal(fs.existsSync(outside), false);
    const calls = (await h.calls(run)).items;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].state, "succeeded");
    assert.equal(calls[0].permission_plan.host_access, "sandbox");
    assert.equal(calls[0].permission_plan.sandbox.adapter, "mxc-process-v1");
    assert.equal(calls[0].permission_plan.sandbox.network, "none");
  },
);

test(
  "scoped command Hook revocation stops its process and retains original effect evidence on restart",
  native,
  async (t) => {
    const h = await setup(t, {
      plan: [{ name: "read_file", arguments: { path: "input.txt" } }],
    });
    const hook = await h.save({
      timeout: 30,
      command:
        "[IO.File]::WriteAllText('hook-begun.txt','begun'); Start-Sleep -Seconds 10; [IO.File]::WriteAllText('hook-late.txt','bad'); '{}'",
    });
    const g = await grant(h, {
      operations: ["read_file"],
      command_hooks: [
        { id: hook.id, revision: hook.revision, host_access: "sandbox" },
      ],
    });
    const run = await h.start({ authorization_id: g.id });
    await until(() => fs.existsSync(path.join(h.workspace, "hook-begun.txt")));
    const original = (await h.calls(run)).items[0];
    await command(h, "authorizations.revoke", {
      id: g.id,
      expected_revision: 1,
    });
    await h.done(run);
    await h.core.stop();
    await h.core.start();
    const calls = (await h.calls(run)).items;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, original.id);
    assert.equal(calls[0].stopped, true);
    assert.equal(fs.existsSync(path.join(h.workspace, "hook-late.txt")), false);
  },
);

test(
  "zero-model direct action runs authorized command Hook lifecycle once and records follow-up text",
  native,
  async (t) => {
    const h = await setup(t);
    const bindings = [];
    for (const event of [
      "sessionStart",
      "preToolUse",
      "postToolUse",
      "stop",
      "sessionEnd",
    ]) {
      const response =
        event === "stop"
          ? '{"followup_message":"Inspect this result in a new task"}'
          : "{}";
      const hook = await h.save({
        name: `Direct ${event}`,
        event,
        timeout: 15,
        command: `[IO.File]::AppendAllText('hook-order.txt','${event},'); '${response}'`,
      });
      bindings.push({
        id: hook.id,
        revision: hook.revision,
        host_access: "sandbox",
      });
    }
    const g = await grant(h, {
      operations: ["write_file"],
      command_hooks: bindings,
    });
    const receipt = await direct(h, g, "", {
      action: {
        name: "write_file",
        arguments: {
          path: "direct-with-hooks.txt",
          content: "direct",
          expected_hash: "missing",
        },
      },
    });
    const run = receipt.result.run.id;
    const done = await until(async () => {
      const value = await h.get(run);
      return (
        ["completed", "failed", "interrupted"].includes(value.run.state) &&
        value
      );
    }, 60000);
    assert.equal(done.run.state, "completed", JSON.stringify(done));
    assert.match(done.run.output, /Inspect this result in a new task/);
    assert.equal(
      fs.readFileSync(path.join(h.workspace, "hook-order.txt"), "utf8"),
      "sessionStart,preToolUse,postToolUse,stop,sessionEnd,",
    );
    assert.equal(
      fs.readFileSync(path.join(h.workspace, "direct-with-hooks.txt"), "utf8"),
      "direct",
    );
    assert.equal((await h.calls(run)).items.length, 5);
    assert.equal(h.server.requests.length, 0);
    assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  },
);

test(
  "direct command Hook denial and parameter rewriting remain inside the exact action grant",
  native,
  async (t) => {
    const h = await setup(t);
    const sub = path.join(h.workspace, "approved");
    fs.mkdirSync(sub);
    const hook = await h.save({
      timeout: 15,
      command:
        '\'{"updated_input":{"path":"forbidden.txt","content":"bad","expected_hash":"missing"}}\'',
    });
    const g = await grant(h, {
      write_roots: [sub],
      operations: ["write_file"],
      command_hooks: [
        { id: hook.id, revision: hook.revision, host_access: "sandbox" },
      ],
    });
    const receipt = await direct(h, g, "", {
      action: {
        name: "write_file",
        arguments: {
          path: "approved/result.txt",
          content: "safe",
          expected_hash: "missing",
        },
      },
    });
    const done = await h.done(receipt.result.run.id);
    assert.equal(done.run.state, "failed");
    assert.equal(fs.existsSync(path.join(h.workspace, "forbidden.txt")), false);
    assert.equal(fs.existsSync(path.join(sub, "result.txt")), false);
    const inv = await h.call(receipt.result.run.id);
    assert.match(inv.result.error, /超出|目录/);
    assert.equal(h.server.requests.length, 0);
  },
);
