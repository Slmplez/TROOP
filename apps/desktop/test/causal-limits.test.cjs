const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { setup, until, results } = require("./fixtures/hooks-fixture.cjs");

async function command(h, method, input) {
  const receipt = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return receipt.result;
}

async function scenario(t, limits, count = 5) {
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "write_file",
              arguments: {
                path: "manual.txt",
                content: "manual",
                expected_hash: "missing",
              },
            },
          ],
  });
  await command(h, "rules.limits.save", {
    scope: { kind: "global" },
    expected_revision: 1,
    limits,
  });
  const initial = await h.start();
  const approval = await h.approval(initial);
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Causal write",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["write_file", "read_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const rules = [];
  for (let index = 0; index < count; index++)
    rules.push(
      await command(h, "rules.save", {
        expected_revision: 0,
        rule: {
          name: `Causal ${index}`,
          enabled: true,
          event: "run.completed",
          workspace_id: h.wid,
          source_run_id: initial,
          expires_at: grant.expires_at,
          start: {
            client_run_id: crypto.randomUUID(),
            agent_id: 1,
            workspace_id: h.wid,
            goal: "Causal direct write",
            authorization_id: grant.id,
            action: {
              name: "write_file",
              arguments: {
                path: `causal-${index}.txt`,
                content: "counted",
                expected_hash: "missing",
              },
            },
          },
        },
      }),
    );
  await h.approve(approval, true);
  await h.done(initial);
  await until(async () => {
    const pages = await Promise.all(
      rules.map((rule) => h.core.request("rules.history", { id: rule.id })),
    );
    if (
      !pages.every((page) =>
        page.deliveries.some((delivery) => delivery.event_run_id === initial),
      )
    )
      return false;
    const runs = (await h.core.request("agent.list", {})).items.filter(
      (run) => run.id !== initial,
    );
    return runs.every((run) => ["completed", "failed"].includes(run.state));
  });
  return { h, initial, rules };
}

test("different rules share a source-object write quota and retain it across policy revisions and restart", async (t) => {
  const { h, initial } = await scenario(t, {
    max_depth: 8,
    max_writes_per_hour: 3,
    cooldown_seconds: 0,
  });
  assert.equal(
    fs.readdirSync(h.workspace).filter((name) => name.startsWith("causal-"))
      .length,
    3,
  );
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  t.after(() => db.close());
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM causal_writes").get().n,
    3,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(DISTINCT subject_id) AS n FROM causal_writes")
      .get().n,
    1,
  );
  const rows = db
    .prepare("SELECT document FROM causal_writes")
    .all()
    .map((row) => JSON.parse(row.document));
  assert.ok(
    rows.every(
      (row) =>
        row.policy.revision === 2 &&
        row.context.subject_id === `run:${initial}`,
    ),
  );
  await command(h, "rules.limits.save", {
    scope: { kind: "global" },
    expected_revision: 2,
    limits: { max_depth: 8, max_writes_per_hour: 2, cooldown_seconds: 0 },
  });
  await h.core.stop();
  await h.core.start();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM causal_writes").get().n,
    3,
  );
  const history = await h.core.request("rules.limits.history", {
    scope: { kind: "global" },
  });
  assert.deepEqual(
    history.items.map((row) => row.revision),
    [3, 2, 1],
  );
  const stale = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "rules.limits.save",
    input: {
      scope: { kind: "global" },
      expected_revision: 2,
      limits: { max_depth: 8, max_writes_per_hour: 9, cooldown_seconds: 0 },
    },
  });
  assert.equal(stale.state, "rejected");
});

test("same-category cooldown is shared across rules for one source object", async (t) => {
  const { h } = await scenario(
    t,
    { max_depth: 8, max_writes_per_hour: 10, cooldown_seconds: 60 },
    2,
  );
  assert.equal(
    fs.readdirSync(h.workspace).filter((name) => name.startsWith("causal-"))
      .length,
    1,
  );
});

test("a queued writable CLI Run terminates when its shared source quota is exhausted", async (t) => {
  const built = require("node:child_process").spawnSync(
    "cargo",
    [
      "build",
      "--offline",
      "--locked",
      "-p",
      "troop-core",
      "--example",
      "cli_protocol_probe",
    ],
    {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(built.status, 0, built.stderr);
  const h = await setup(t, {
    plan: ({ body }) =>
      results(body).length
        ? []
        : [
            {
              name: "write_file",
              arguments: {
                path: "manual.txt",
                content: "manual",
                expected_hash: "missing",
              },
            },
          ],
  });
  await command(h, "rules.limits.save", {
    scope: { kind: "global" },
    expected_revision: 1,
    limits: { max_depth: 8, max_writes_per_hour: 1, cooldown_seconds: 0 },
  });
  const initial = await h.start(),
    approval = await h.approval(initial);
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Bounded writable CLI",
      purpose: "cli_start",
      agent_id: 1,
      engine_id: "codex",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      read_all: true,
      operations: ["start"],
      network: "any",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      program: path.resolve(
        __dirname,
        "../../../target/debug/examples/cli_protocol_probe.exe",
      ),
    },
  });
  for (let index = 0; index < 2; index++)
    await command(h, "rules.save", {
      expected_revision: 0,
      rule: {
        name: `CLI quota ${index}`,
        enabled: true,
        event: "run.completed",
        workspace_id: h.wid,
        source_run_id: initial,
        expires_at: grant.expires_at,
        start: {
          client_run_id: crypto.randomUUID(),
          agent_id: 1,
          workspace_id: h.wid,
          engine_id: "codex",
          tool_mode: "native",
          approval_mode: "preauthorized",
          authorization_id: grant.id,
          goal: "Owned quota CLI",
        },
      },
    });
  await h.approve(approval, true);
  await h.done(initial);
  const failed = await until(async () => {
    const runs = (await h.core.request("agent.list", {})).items.filter(
      (run) => run.kind === "external_cli",
    );
    return runs.length === 2 && runs.find((run) => run.state === "failed");
  });
  const snapshot = await h.get(failed.id);
  assert.deepEqual(snapshot.run.waiting, []);
  assert.equal(snapshot.run.causal_limit_state, "needs_attention");
  assert.match(snapshot.run.error, /来源对象写动作限额/);
  assert.equal(snapshot.tasks[0].state, "failed");
  assert.equal(snapshot.tasks[0].stopped, true);
  await h.core.stop();
  await h.core.start();
  assert.equal((await h.get(failed.id)).run.state, "failed");
});
