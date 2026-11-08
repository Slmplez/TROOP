const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { setup, until, sleep } = require("./fixtures/hooks-fixture.cjs");
async function command(h, method, input, key = crypto.randomUUID()) {
  const r = await h.core.request("operations.execute", {
    operation_id: key,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
  assert.equal(r.state, "committed", JSON.stringify(r.error));
  return r.result;
}
const create = (h, dependencies = []) =>
  command(h, "work_items.save", {
    expected_revision: 0,
    item: {
      title: "事件工作",
      goal: "核对固定资料",
      acceptance: "核对结论",
      owner_agent_id: 1,
      workspace_id: h.wid,
      dependency_ids: dependencies,
    },
  });
async function accept(h, item) {
  const current = await h.core.request("work_items.get", { id: item.id }),
    result = (await h.core.request("work_items.runs", { id: item.id }))
      .items[0];
  return command(h, "work_items.accept", {
    id: item.id,
    expected_revision: current.revision,
    run_id: result.run.id,
    expected_run_revision: result.run.revision,
    evidence_sha256: result.evidence_sha256,
    note: "已核对固定证据",
  });
}
async function rule(h, source, target, extra = {}) {
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "工作推进授权",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["read_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const saved = await command(h, "rules.save", {
    expected_revision: 0,
    rule: {
      name: "接纳后推进",
      enabled: true,
      event: "work.accepted",
      workspace_id: h.wid,
      source_run_id: null,
      source_work_item_id: source.id,
      work_item_id: target.id,
      expires_at: grant.expires_at,
      start: {
        client_run_id: crypto.randomUUID(),
        agent_id: 1,
        workspace_id: h.wid,
        project_ids: [],
        provider_id: h.provider.id,
        authorization_id: grant.id,
        goal: "推进后续工作",
      },
      ...extra,
    },
  });
  return { saved, grant };
}
test("only explicit work acceptance releases a dependency and dispatches one linked authorized Run", async (t) => {
  const h = await setup(t),
    source = await create(h),
    target = await create(h, [source.id]);
  const { saved } = await rule(h, source, target);
  const started = await command(h, "work_items.start", {
    id: source.id,
    expected_revision: source.revision,
    execution: { kind: "agent", provider_id: h.provider.id },
  });
  await h.done(started.current_run_id);
  await sleep(250);
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  await accept(h, source);
  const next = await until(async () => {
    const item = await h.core.request("work_items.get", { id: target.id });
    return item.current_run_id && item;
  });
  await h.done(next.current_run_id);
  const history = await h.core.request("rules.history", { id: saved.id });
  assert.equal(history.deliveries.length, 1);
  assert.equal(history.deliveries[0].state, "dispatched");
  assert.equal(history.deliveries[0].work_item_id, target.id);
  await h.core.stop();
  await h.core.start();
  await sleep(200);
  assert.equal((await h.core.request("agent.list", {})).items.length, 2);
});

async function finish(h, item) {
  const started = await command(h, "work_items.start", {
    id: item.id,
    expected_revision: item.revision,
    execution: { kind: "agent", provider_id: h.provider.id },
  });
  await h.done(started.current_run_id);
  return accept(h, item);
}
test("all dependencies may complete in either order and a waiting decision later dispatches once", async (t) => {
  const h = await setup(t),
    a = await create(h),
    b = await create(h),
    target = await create(h, [a.id, b.id]);
  const { saved } = await rule(h, a, target);
  await finish(h, a);
  await until(async () =>
    (await h.core.request("rules.history", { id: saved.id })).deliveries.some(
      (d) => d.state === "waiting",
    ),
  );
  await finish(h, b);
  const current = await until(async () => {
    const i = await h.core.request("work_items.get", { id: target.id });
    return i.current_run_id && i;
  });
  await h.done(current.current_run_id);
  assert.equal((await h.core.request("agent.list", {})).items.length, 3);
});
test("revoked preauthorization records a skipped decision and never starts the target work", async (t) => {
  const h = await setup(t),
    a = await create(h),
    target = await create(h, [a.id]);
  const { saved, grant } = await rule(h, a, target);
  await command(h, "authorizations.revoke", {
    id: grant.id,
    expected_revision: grant.revision,
  });
  await finish(h, a);
  const d = await until(
    async () =>
      (await h.core.request("rules.history", { id: saved.id })).deliveries[0],
  );
  assert.equal(d.state, "skipped");
  assert.equal(
    (await h.core.request("work_items.get", { id: target.id })).current_run_id,
    null,
  );
});
test("acceptance and its durable event roll back together when the event write fails", async (t) => {
  const h = await setup(t),
    a = await create(h),
    target = await create(h, [a.id]);
  await rule(h, a, target);
  const started = await command(h, "work_items.start", {
    id: a.id,
    expected_revision: a.revision,
    execution: { kind: "agent", provider_id: h.provider.id },
  });
  await h.done(started.current_run_id);
  const { DatabaseSync } = require("node:sqlite"),
    path = require("node:path"),
    db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec(
    "CREATE TRIGGER owned_accept_fail BEFORE INSERT ON agent_events WHEN new.kind='work_accepted' BEGIN SELECT RAISE(ABORT,'owned acceptance failure'); END;",
  );
  await assert.rejects(() => accept(h, a), /owned acceptance failure/);
  assert.equal(
    (await h.core.request("work_items.get", { id: a.id })).progress.state,
    "awaiting_acceptance",
  );
  db.exec("DROP TRIGGER owned_accept_fail");
  db.close();
  await accept(h, a);
  await until(
    async () =>
      (await h.core.request("work_items.get", { id: target.id }))
        .current_run_id,
  );
});
test("mock GitHub current-state review dispatches one work-linked Run across duplicate deliveries", async (t) => {
  const http = require("node:http"),
    api = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: 42,
          run_attempt: 1,
          status: "completed",
          conclusion: "failure",
        }),
      );
    });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => api.close(r)));
  const h = await setup(t),
    target = await create(h),
    id = crypto.randomUUID(),
    secret = crypto.randomBytes(32).toString("hex");
  await command(h, "events.source.save", {
    id,
    expected_revision: 0,
    definition: {
      name: "mock GitHub",
      kind: "github",
      project: "owner/repo",
      workspace_id: h.wid,
      enabled: true,
      mode: "local",
      api_base_url: `http://127.0.0.1:${api.address().port}`,
      consumer_id: h.core.snapshot().storage_instance,
    },
    secrets: {
      webhook_secret: secret,
      consumer_token: crypto.randomBytes(32).toString("hex"),
    },
  });
  const { saved } = await rule(h, target, target, {
    event: "github.workflow.completed",
    event_state: "failure",
    source_id: id,
    source_work_item_id: null,
  });
  const body = JSON.stringify({
      action: "completed",
      repository: { full_name: "owner/repo" },
      workflow_run: {
        id: 42,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      },
    }),
    headers = {
      "x-github-event": "workflow_run",
      "x-github-delivery": "f1-owned",
      "x-hub-signature-256":
        "sha256=" +
        crypto.createHmac("sha256", secret).update(body).digest("hex"),
    },
    url =
      (await h.core.request("events.health", {})).address + "/webhooks/" + id;
  assert.equal(
    (await fetch(url, { method: "POST", headers, body })).status,
    202,
  );
  const item = await until(async () => {
    const i = await h.core.request("work_items.get", { id: target.id });
    return i.current_run_id && i;
  });
  await h.done(item.current_run_id);
  await fetch(url, { method: "POST", headers, body });
  await sleep(200);
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  assert.equal(
    (await h.core.request("rules.history", { id: saved.id })).deliveries[0]
      .work_item_id,
    target.id,
  );
});

test("a source moved to a different project cannot trigger its old rule", async (t) => {
  const h = await setup(t),
    a = await create(h),
    target = await create(h, [a.id]);
  const { saved } = await rule(h, a, target);
  await h.core.request("memory.membership", {
    agent_id: 1,
    project: "B",
    action: "create",
  });
  const moved = await command(h, "work_items.save", {
    id: a.id,
    expected_revision: a.revision,
    item: {
      title: a.title,
      goal: a.goal,
      acceptance: a.acceptance,
      owner_agent_id: 1,
      workspace_id: h.wid,
      project_id: "B",
    },
  });
  await finish(h, moved);
  const d = await until(
    async () =>
      (await h.core.request("rules.history", { id: saved.id })).deliveries[0],
  );
  assert.equal(d.state, "skipped");
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
});

test("declared work source must be a real target dependency", async (t) => {
  const h = await setup(t),
    a = await create(h),
    target = await create(h);
  await assert.rejects(() => rule(h, a, target), /来源工作项加入/);
});
test("Run completion work routes retain waiting decisions until dependency acceptance", async (t) => {
  const h = await setup(t),
    a = await create(h),
    b = await create(h),
    target = await create(h, [b.id]);
  await rule(h, a, target, {
    event: "run.completed",
    source_work_item_id: null,
  });
  const started = await command(h, "work_items.start", {
    id: a.id,
    expected_revision: a.revision,
    execution: { kind: "agent", provider_id: h.provider.id },
  });
  await h.done(started.current_run_id);
  await sleep(200);
  assert.equal(
    (await h.core.request("work_items.get", { id: target.id })).current_run_id,
    null,
  );
  await finish(h, b);
  await until(
    async () =>
      (await h.core.request("work_items.get", { id: target.id }))
        .current_run_id,
  );
  assert.equal((await h.core.request("agent.list", {})).items.length, 3);
});

test("stopping an automatically dispatched Run does not let another dependency event restart it", async (t) => {
  const h = await setup(t, {
      beforeResponse: async (_r, requests) => {
        if (requests.length >= 3) await sleep(1000);
      },
    }),
    a = await create(h),
    b = await create(h),
    target = await create(h, [a.id, b.id]);
  const { saved } = await rule(h, a, target);
  await finish(h, a);
  await finish(h, b);
  const current = await until(async () => {
    const i = await h.core.request("work_items.get", { id: target.id });
    return i.current_run_id && i;
  });
  await command(h, "agent.cancel", { id: current.current_run_id });
  await h.done(current.current_run_id);
  await until(async () => {
    const history = await h.core.request("rules.history", { id: saved.id });
    return history.deliveries.some((d) =>
      String(d.reason).includes("重新交办"),
    );
  });
  assert.equal((await h.core.request("agent.list", {})).items.length, 3);
});
