const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  setup,
  hook,
  results,
  until,
  sleep,
} = require("./fixtures/hooks-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");
const contract = require("../contracts/execution.cjs");

async function rpc(h, method, input = {}) {
  contract.validate(method, input);
  const value = await h.core.request(method, input);
  return contract.validate(method, value, true);
}
function command(h, method, input) {
  return rpc(h, "operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
}
async function fixture(t, options = {}) {
  const h = await setup(t, {
    plan: ({ body }) =>
      hook(body) || results(body).length
        ? []
        : [{ name: "read_file", arguments: { path: "input.txt" } }],
    reply: ({ body }) => (hook(body) ? "{}" : "Authorized read completed"),
    ...options,
  });
  const rule = await h.save({
    name: "Pinned prompt policy",
    kind: "prompt",
    command: "",
    prompt: "Return {}. Audit the proposed operation.",
    event: "preToolUse",
  });
  const grant = {
    name: "Workspace read with pinned prompt Hook",
    purpose: "tool_call",
    agent_id: 1,
    engine_id: "native",
    workspace_id: h.wid,
    project_ids: [],
    read_roots: [h.workspace],
    write_roots: [],
    operations: ["read_file"],
    network: "none",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    rule_id: null,
    prompt_hooks: [{ id: rule.id, revision: rule.revision }],
  };
  return { h, rule, grant };
}

test("a scoped Agent executes only its explicitly pinned prompt Hook and records authority", async (t) => {
  const { h, rule, grant } = await fixture(t);
  const receipt = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  const id = await h.start({ authorization_id: receipt.result.id });
  const end = await h.done(id);
  assert.equal(end.run.state, "completed", JSON.stringify(end.run.error));
  const inv = await h.call(id);
  assert.equal(inv.state, "succeeded");
  assert.equal(inv.approval, true);
  const calls = await rpc(h, "hooks.calls", { run_id: id });
  assert.equal(calls.items.length, 1);
  const call = calls.items[0];
  assert.equal(call.state, "succeeded");
  assert.equal(call.permission_plan.grant_id, receipt.result.id);
  assert.equal(call.permission_plan.grant_revision, 1);
  assert.equal(call.permission_plan.hook_id, rule.id);
  assert.equal(call.permission_plan.hook_revision, rule.revision);
  assert.match(call.permission_plan.input_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    (await rpc(h, "authorizations.get", { id: receipt.result.id }))
      .prompt_hooks,
    grant.prompt_hooks,
  );
});

test("a pinned prompt Hook cannot move a file read outside the granted directory", async (t) => {
  const { h, grant } = await fixture(t, {
    plan: ({ body }) =>
      hook(body) || results(body).length
        ? []
        : [{ name: "read_file", arguments: { path: "allowed/input.txt" } }],
    reply: ({ body }) =>
      hook(body)
        ? JSON.stringify({
            permission: "allow",
            updated_input: { path: "private.txt" },
          })
        : "The rejected operation was inspected",
  });
  const allowed = path.join(h.workspace, "allowed");
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(allowed, "input.txt"), "allowed material");
  fs.writeFileSync(
    path.join(h.workspace, "private.txt"),
    "forbidden-marker-8739",
  );
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: { ...grant, read_roots: [allowed] },
  });
  assert.equal(saved.state, "committed");
  const id = await h.start({ authorization_id: saved.result.id });
  await h.done(id);
  const inv = await h.call(id);
  assert.equal(inv.arguments.path, "private.txt");
  assert.equal(inv.state, "failed");
  assert.equal(inv.result.ok, false);
  assert.match(inv.result.error, /授权/);
  assert.ok(
    !JSON.stringify(h.server.requests).includes("forbidden-marker-8739"),
  );
});

for (const change of ["revoke", "revise", "expire"])
  test(`a scoped prompt Hook discards a response after ${change} and stops its owner`, async (t) => {
    let arrived = false,
      release;
    const gate = new Promise((resolve) => (release = resolve));
    const { h, rule, grant } = await fixture(t, {
      beforeResponse: async ({ body }) => {
        if (hook(body)) {
          arrived = true;
          await gate;
        }
      },
      reply: ({ body }) =>
        hook(body)
          ? '{"permission":"allow","additional_context":"late-response-marker"}'
          : "Unexpected late final",
    });
    t.after(() => release());
    const saved = await command(h, "authorizations.save", {
      expected_revision: 0,
      grant:
        change === "expire"
          ? { ...grant, expires_at: Math.floor(Date.now() / 1000) + 3 }
          : grant,
    });
    assert.equal(saved.state, "committed");
    const id = await h.start({ authorization_id: saved.result.id });
    await until(() => arrived);
    if (change === "revoke") {
      const revoked = await command(h, "authorizations.revoke", {
        id: saved.result.id,
        expected_revision: 1,
      });
      assert.equal(revoked.state, "committed");
    } else if (change === "revise") {
      await h.save({
        ...rule,
        expected_revision: rule.revision,
        prompt: "Revised instruction",
      });
    } else {
      await until(
        () => Math.floor(Date.now() / 1000) >= saved.result.expires_at,
      );
    }
    const end = await h.done(id);
    assert.notEqual(end.run.state, "completed");
    assert.equal(end.run.intent, "failure");
    release();
    await sleep(100);
    const call = (await rpc(h, "hooks.calls", { run_id: id })).items[0];
    assert.ok(["skipped", "cancelled"].includes(call.state), call.state);
    assert.deepEqual(call.result, {});
    assert.notEqual((await h.call(id)).state, "succeeded");
    assert.ok(
      !JSON.stringify(h.server.requests).includes("late-response-marker"),
    );
  });

test("missing, stale and command Hook bindings never start a scoped Agent", async (t) => {
  const { h, rule, grant } = await fixture(t);
  const unbound = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: { ...grant, prompt_hooks: [] },
  });
  assert.equal(unbound.state, "committed");
  await assert.rejects(
    h.start({ authorization_id: unbound.result.id }),
    /提示 Hook/,
  );
  for (const prompt_hooks of [
    [grant.prompt_hooks[0], grant.prompt_hooks[0]],
    [{ id: rule.id, revision: rule.revision + 1 }],
  ]) {
    const saved = await command(h, "authorizations.save", {
      expected_revision: 0,
      grant: { ...grant, prompt_hooks },
    });
    assert.equal(saved.state, "rejected");
  }
  const commandRule = await h.save({
    name: "Unadmitted command Hook",
    command: "'{}'",
  });
  const commandGrant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      ...grant,
      prompt_hooks: [{ id: commandRule.id, revision: commandRule.revision }],
    },
  });
  assert.equal(commandGrant.state, "rejected");
  assert.equal(h.server.requests.length, 0);
});

test("revoking a prompt Hook grant rejects an outstanding tool approval", async (t) => {
  const { h, grant } = await fixture(t, {
    reply: ({ body }) => (hook(body) ? '{"permission":"ask"}' : "Inspected"),
  });
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  const id = await h.start({ authorization_id: saved.result.id });
  const inv = await h.approval(id);
  const revoked = await command(h, "authorizations.revoke", {
    id: saved.result.id,
    expected_revision: 1,
  });
  assert.equal(revoked.state, "committed");
  const answer = await command(h, "agent.approve", {
    id: inv.id,
    epoch: inv.epoch,
    approved: true,
  });
  assert.equal(answer.state, "rejected");
  assert.notEqual((await h.done(id)).run.state, "completed");
  assert.notEqual((await h.call(id)).state, "succeeded");
});

test("rule simulation and dispatch honor pinned prompt Hooks and reject changed revisions", async (t) => {
  const { h, rule, grant } = await fixture(t);
  const saved = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant,
  });
  const source = await h.start();
  await h.done(source);
  const configured = await command(h, "rules.save", {
    expected_revision: 0,
    rule: {
      name: "Scoped prompt Hook rule",
      enabled: true,
      event: "run.completed",
      workspace_id: h.wid,
      source_run_id: null,
      expires_at: grant.expires_at,
      start: {
        client_run_id: crypto.randomUUID(),
        workspace_id: h.wid,
        provider_id: h.provider.id,
        agent_id: 1,
        goal: "Rule read",
        authorization_id: saved.result.id,
      },
    },
  });
  assert.equal(configured.state, "committed", JSON.stringify(configured.error));
  const simulation = await rpc(h, "rules.simulate", {
    id: configured.result.id,
    run_id: source,
  });
  assert.equal(simulation.matched, true);
  assert.equal(simulation.executable, true, simulation.reason);
  const next = await h.start();
  await h.done(next);
  const delivery = await until(async () => {
    const history = await rpc(h, "rules.history", { id: configured.result.id });
    return history.deliveries.find((item) => item.state === "dispatched");
  });
  assert.equal((await h.done(delivery.run_id)).run.state, "completed");
  const calls = await rpc(h, "hooks.calls", { run_id: delivery.run_id });
  assert.equal(calls.items[0].permission_plan.grant_id, saved.result.id);
  await h.save({
    ...rule,
    expected_revision: rule.revision,
    prompt: "A new policy",
  });
  assert.equal(
    (
      await rpc(h, "rules.simulate", {
        id: configured.result.id,
        run_id: source,
      })
    ).executable,
    false,
  );
  await assert.rejects(
    h.start({ authorization_id: saved.result.id }),
    /提示 Hook/,
  );
});

for (const change of ["disable", "delete"])
  test(`a ${change}d pinned prompt Hook cannot silently disappear from a new scoped Run`, async (t) => {
    const { h, rule, grant } = await fixture(t);
    const saved = await command(h, "authorizations.save", {
      expected_revision: 0,
      grant,
    });
    assert.equal(saved.state, "committed");
    if (change === "disable") {
      await h.save({
        ...rule,
        expected_revision: rule.revision,
        enabled: false,
      });
    } else {
      await rpc(h, "hooks.remove", {
        id: rule.id,
        expected_revision: rule.revision,
      });
    }
    await assert.rejects(
      h.start({ authorization_id: saved.result.id }),
      /提示 Hook/,
    );
    assert.equal(h.server.requests.length, 0);
  });
