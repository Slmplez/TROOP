const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { setup } = require("./fixtures/hooks-fixture.cjs");
test("authenticated HTTP deliveries are durable and duplicate delivery does not create another event", async (t) => {
  const h = await setup(t, { coreArgs: ["--event-listen", "127.0.0.1:0"] });
  const health = await h.core.request("events.health", {});
  const id = crypto.randomUUID(),
    secret = crypto.randomBytes(32).toString("hex"),
    consumerToken = crypto.randomBytes(32).toString("hex");
  const saved = await h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method: "events.source.save",
    input: {
      id,
      expected_revision: 0,
      definition: {
        name: "Mock GitHub",
        kind: "github",
        project: "owner/repo",
        workspace_id: h.wid,
        enabled: true,
        mode: "local",
        api_base_url: "http://127.0.0.1:1",
        consumer_id: h.core.snapshot().storage_instance,
      },
      secrets: { webhook_secret: secret, consumer_token: consumerToken },
    },
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  const body = JSON.stringify({
    action: "completed",
    repository: { full_name: "owner/repo" },
    workflow_run: {
      id: 42,
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
    },
  });
  const signature =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  const headers = {
    "content-type": "application/json",
    "x-github-event": "workflow_run",
    "x-github-delivery": "mock-delivery",
    "x-hub-signature-256": signature,
  };
  const url = health.address + "/webhooks/" + id;
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "x-hub-signature-256": "sha256=" + "0".repeat(64),
        },
        body,
      })
    ).status,
    401,
  );
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(
    "CREATE TRIGGER fail_event_delivery BEFORE INSERT ON event_deliveries BEGIN SELECT RAISE(ABORT,'injected delivery failure'); END",
  );
  assert.equal(
    (await fetch(url, { method: "POST", headers, body })).status,
    503,
  );
  assert.equal(
    (await h.core.request("events.inbox", { source_id: id })).items.length,
    0,
  );
  db.exec("DROP TRIGGER fail_event_delivery");
  db.exec(
    "CREATE TRIGGER fail_source_accept BEFORE INSERT ON source_events WHEN new.state<>'rejected' BEGIN SELECT RAISE(ABORT,'injected acceptance failure'); END",
  );
  const first = await fetch(url, { method: "POST", headers, body });
  assert.equal(first.status, 202);
  await until(
    async () =>
      (await h.core.request("events.health", {})).sources[id]?.state ===
      "needs_attention",
  );
  assert.equal(
    (await h.core.request("events.records", { source_id: id })).items.length,
    0,
  );
  assert.equal(
    (await h.core.request("events.inbox", { source_id: id })).items[0].acked,
    false,
  );
  db.exec("DROP TRIGGER fail_source_accept");
  db.close();
  const second = await fetch(url, { method: "POST", headers, body });
  assert.equal(second.status, 202);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(
    (await h.core.request("events.inbox", { source_id: id })).items.length,
    1,
  );
  await until(
    async () =>
      (await h.core.request("events.inbox", { source_id: id })).items[0].acked,
  );
  await h.core.stop();
  const expiredPayload = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  expiredPayload
    .prepare(
      "UPDATE event_inbox SET received_at=unixepoch()-2678400 WHERE source_id=?",
    )
    .run(id);
  expiredPayload.close();
  await h.core.start();
  assert.equal(
    (await h.core.request("events.inbox", { source_id: id })).items.length,
    1,
  );
  const retained = await until(async () => {
    const page = await h.core.request("events.inbox", { source_id: id });
    return page.items[0].payload_archived && page.items[0];
  });
  const archived = await h.core.request("events.payload", {
    source_id: id,
    id: retained.inbox_id,
  });
  assert.equal(archived.archived, true);
  assert.equal(archived.content, "");
});
const fs = require("node:fs"),
  path = require("node:path");
const { until } = require("./fixtures/hooks-fixture.cjs");
const command = (h, method, input) =>
  h.core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
test("mock GitHub state -> durable acceptance -> authorized file Run, repaired events are skipped", async (t) => {
  const http = require("node:http");
  let state = "failure",
    checks = 0;
  const api = http.createServer((req, res) => {
    checks++;
    const id = Number(req.url.split("/").at(-1));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id,
        run_attempt: 1,
        status: "completed",
        conclusion: state,
      }),
    );
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => api.close(r)));
  const h = await setup(t);
  const sourceId = crypto.randomUUID(),
    secret = crypto.randomBytes(32).toString("hex");
  const definition = {
    name: "Mock actions",
    kind: "github",
    project: "owner/repo",
    workspace_id: h.wid,
    enabled: true,
    mode: "local",
    api_base_url: `http://127.0.0.1:${api.address().port}`,
    consumer_id: h.core.snapshot().storage_instance,
  };
  const source = await command(h, "events.source.save", {
    id: sourceId,
    expected_revision: 0,
    definition,
    secrets: {
      webhook_secret: secret,
      consumer_token: crypto.randomBytes(32).toString("hex"),
    },
  });
  assert.equal(source.state, "committed", JSON.stringify(source.error));
  const grant = (
    await command(h, "authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "Event file",
        purpose: "tool_call",
        agent_id: 1,
        engine_id: "native",
        workspace_id: h.wid,
        project_ids: [],
        read_roots: [h.workspace],
        write_roots: [h.workspace],
        operations: ["write_file"],
        network: "none",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        rule_id: null,
      },
    })
  ).result;
  const saved = await command(h, "rules.save", {
    expected_revision: 0,
    rule: {
      name: "Failed workflow",
      enabled: true,
      event: "github.workflow.completed",
      event_state: "failure",
      source_id: sourceId,
      source_run_id: null,
      workspace_id: h.wid,
      expires_at: grant.expires_at,
      start: {
        client_run_id: crypto.randomUUID(),
        workspace_id: h.wid,
        agent_id: 1,
        authorization_id: grant.id,
        goal: "Write event evidence",
        action: {
          name: "write_file",
          arguments: {
            path: "event-result.txt",
            content: "accepted failure",
            expected_hash: "missing",
          },
        },
      },
    },
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  const health = await h.core.request("events.health", {});
  const post = async (id, delivery, updated_at) => {
    const body = JSON.stringify({
      action: "completed",
      repository: { full_name: "owner/repo" },
      workflow_run: {
        id,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        updated_at,
      },
    });
    return fetch(health.address + "/webhooks/" + sourceId, {
      method: "POST",
      headers: {
        "x-github-event": "workflow_run",
        "x-github-delivery": delivery,
        "x-hub-signature-256":
          "sha256=" +
          crypto.createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    });
  };
  assert.equal((await post(42, "first")).status, 202);
  const delivery = await until(async () => {
    const result = await h.core.request("rules.history", {
      id: saved.result.id,
    });
    return result.deliveries.find((d) => d.state === "dispatched");
  });
  assert.equal((await h.done(delivery.run_id)).run.state, "completed");
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "event-result.txt"), "utf8"),
    "accepted failure",
  );
  assert.equal(h.server.requests.length, 0);
  assert.equal((await post(42, "same-business-new-delivery")).status, 202);
  state = "success";
  assert.equal((await post(43, "already-fixed")).status, 202);
  await until(async () =>
    (
      await h.core.request("events.records", { source_id: sourceId })
    ).items.some((e) => e.subject_id === "43" && e.review_state === "invalid"),
  );
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  state = "failure";
  assert.equal(
    (await post(44, "late-history", new Date(Date.now() - 60000).toISOString()))
      .status,
    202,
  );
  const oldEvent = await until(async () =>
    (
      await h.core.request("events.records", { source_id: sourceId })
    ).items.find((e) => e.subject_id === "44" && e.review_state === "valid"),
  );
  assert.equal(
    (
      await h.core.request("rules.simulate", {
        id: saved.result.id,
        external_event_id: oldEvent.id,
      })
    ).matched,
    false,
  );
  assert.equal((await post(45, "before-revision")).status, 202);
  const priorRevisionEvent = await until(async () =>
    (
      await h.core.request("events.records", { source_id: sourceId })
    ).items.find((e) => e.subject_id === "45" && e.review_state === "valid"),
  );
  assert.equal(
    (
      await h.core.request("rules.simulate", {
        id: saved.result.id,
        external_event_id: priorRevisionEvent.id,
      })
    ).matched,
    true,
  );
  const {
    id: ruleId,
    revision,
    after_event,
    author,
    updated_at,
    created_at_ms,
    effective_from_ms,
    ...ruleDefinition
  } = saved.result;
  const changed = await command(h, "rules.save", {
    id: ruleId,
    expected_revision: revision,
    rule: { ...ruleDefinition, name: "Revised failure" },
  });
  assert.equal(changed.state, "committed");
  assert.equal(
    (
      await h.core.request("rules.simulate", {
        id: ruleId,
        external_event_id: priorRevisionEvent.id,
      })
    ).matched,
    false,
  );
  const count = checks;
  await h.core.stop();
  await h.core.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  assert.equal(checks, count);
});
async function receiverFor(t, h) {
  const { CoreSupervisor } = require("../src/core-client.cjs"),
    { coreBinary } = require("../src/core-path.cjs");
  const receiver = new CoreSupervisor({
    executable: path.resolve(__dirname, "../bin", coreBinary),
    args: [
      "--data-dir",
      path.join(h.directory, "receiver"),
      "--event-receiver",
      "--event-listen",
      "127.0.0.1:0",
    ],
    timeout: 10000,
  });
  await receiver.start();
  t.after(async () => {
    await receiver.stop();
    require("./fixtures/events-credentials.cjs").cleanupEventCredentials([
      path.join(h.directory, "receiver"),
    ]);
  });
  return receiver;
}
test("independent Inbox keeps offline events and the Core resumes through a fenced consumer lease", async (t) => {
  const http = require("node:http");
  const api = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: 55,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      }),
    );
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => api.close(r)));
  const h = await setup(t),
    receiver = await receiverFor(t, h),
    health = await receiver.request("events.health", {});
  let lostAck = 0;
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      health.address + req.url,
      { method: req.method, headers: req.headers, agent: false },
      (reply) => {
        if (req.url.endsWith("/ack") && lostAck === 0) {
          lostAck++;
          reply.resume();
          reply.on("end", () => res.destroy());
        } else {
          res.writeHead(reply.statusCode, reply.headers);
          reply.pipe(res);
        }
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => proxy.close(r)));
  const id = crypto.randomUUID(),
    webhook = crypto.randomBytes(32).toString("hex"),
    consumer = crypto.randomBytes(32).toString("hex");
  const definition = {
    name: "Independent mock GitHub",
    kind: "github",
    project: "owner/repo",
    workspace_id: h.wid,
    enabled: true,
    mode: "local",
    api_base_url: `http://127.0.0.1:${api.address().port}`,
    consumer_id: h.core.snapshot().storage_instance,
  };
  assert.equal(
    (
      await command({ core: receiver }, "events.source.save", {
        id,
        expected_revision: 0,
        definition,
        secrets: { webhook_secret: webhook, consumer_token: consumer },
      })
    ).state,
    "committed",
  );
  assert.equal(
    (
      await command(h, "events.source.save", {
        id,
        expected_revision: 0,
        definition: {
          ...definition,
          mode: "remote",
          receiver_url: `http://127.0.0.1:${proxy.address().port}`,
          receiver_instance: health.instance_id,
        },
        secrets: { consumer_token: consumer },
      })
    ).state,
    "committed",
  );
  const grant = (
    await command(h, "authorizations.save", {
      expected_revision: 0,
      grant: {
        name: "Offline event",
        purpose: "tool_call",
        agent_id: 1,
        engine_id: "native",
        workspace_id: h.wid,
        project_ids: [],
        read_roots: [h.workspace],
        write_roots: [h.workspace],
        operations: ["write_file"],
        network: "none",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        rule_id: null,
      },
    })
  ).result;
  const rule = (
    await command(h, "rules.save", {
      expected_revision: 0,
      rule: {
        name: "Offline failure",
        enabled: true,
        event: "github.workflow.completed",
        event_state: "failure",
        source_id: id,
        source_run_id: null,
        workspace_id: h.wid,
        expires_at: grant.expires_at,
        start: {
          client_run_id: crypto.randomUUID(),
          workspace_id: h.wid,
          agent_id: 1,
          authorization_id: grant.id,
          goal: "Offline file",
          action: {
            name: "write_file",
            arguments: {
              path: "offline-event.txt",
              content: "durable",
              expected_hash: "missing",
            },
          },
        },
      },
    })
  ).result;
  await until(
    async () =>
      (await h.core.request("events.health", {})).sources[id]?.state ===
      "connected",
  );
  await h.core.stop();
  const database = path.join(h.data, "troop.sqlite3");
  const backup = path.join(h.directory, "before-event.sqlite3");
  fs.copyFileSync(database, backup);
  const body = JSON.stringify({
    action: "completed",
    repository: { full_name: "owner/repo" },
    workflow_run: {
      id: 55,
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
    },
  });
  const headers = {
    "x-github-delivery": "offline-delivery",
    "x-github-event": "workflow_run",
    "x-hub-signature-256":
      "sha256=" +
      crypto.createHmac("sha256", webhook).update(body).digest("hex"),
  };
  assert.equal(
    (
      await fetch(health.address + "/webhooks/" + id, {
        method: "POST",
        headers,
        body,
      })
    ).status,
    202,
  );
  const { DatabaseSync } = require("node:sqlite");
  const receiverDatabase = new DatabaseSync(
    path.join(h.directory, "receiver/troop.sqlite3"),
  );
  const poisoned = receiverDatabase
    .prepare("SELECT document FROM event_inbox WHERE source_id=?")
    .get(id).document;
  const poisonedDocument = JSON.parse(poisoned);
  delete poisonedDocument.semantic_key;
  receiverDatabase
    .prepare(
      "INSERT INTO event_inbox(source_id,semantic_key,document,payload,received_at) VALUES(?,?,?,'{}',unixepoch())",
    )
    .run(id, "historical-invalid-record", JSON.stringify(poisonedDocument));
  receiverDatabase.close();
  assert.equal(
    (await receiver.request("events.inbox", { source_id: id })).items[0].acked,
    false,
  );
  await h.core.start();
  const delivery = await until(
    async () =>
      (await h.core.request("rules.history", { id: rule.id })).deliveries.find(
        (d) => d.state === "dispatched",
      ),
    30000,
  );
  assert.equal((await h.done(delivery.run_id)).run.state, "completed");
  await until(
    async () =>
      (await receiver.request("events.inbox", { source_id: id })).items[0]
        .acked,
  );
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "offline-event.txt"), "utf8"),
    "durable",
  );
  assert.equal(h.server.requests.length, 0);
  assert.equal(lostAck, 1);
  assert.equal(
    (
      await fetch(health.address + "/webhooks/" + id, {
        method: "POST",
        headers,
        body,
      })
    ).status,
    202,
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await h.core.request("agent.list", {})).items.length, 1);
  await h.core.stop();
  fs.copyFileSync(backup, database);
  await h.core.start();
  await until(
    async () =>
      (await h.core.request("events.records", { source_id: id })).items[0],
    30000,
  );
  assert.equal(
    (await h.core.request("events.records", { source_id: id })).items.length,
    2,
  );
  await until(async () =>
    (await h.core.request("events.records", { source_id: id })).items.some(
      (e) => e.review_state === "rejected",
    ),
  );
  await until(async () =>
    (await receiver.request("events.inbox", { source_id: id })).items.every(
      (e) => e.acked,
    ),
  );
});
test("consumer authentication, generation fences and contiguous ACK cursor protect Inbox holes", async (t) => {
  const h = await setup(t),
    receiver = await receiverFor(t, h),
    health = await receiver.request("events.health", {});
  const id = crypto.randomUUID(),
    consumerId = crypto.randomUUID(),
    webhook = crypto.randomBytes(32).toString("hex"),
    token = crypto.randomBytes(32).toString("hex");
  const saved = await command({ core: receiver }, "events.source.save", {
    id,
    expected_revision: 0,
    definition: {
      name: "Lease scope",
      kind: "github",
      project: "owner/repo",
      workspace_id: 1,
      enabled: true,
      mode: "local",
      api_base_url: "http://127.0.0.1:1",
      consumer_id: consumerId,
    },
    secrets: { webhook_secret: webhook, consumer_token: token },
  });
  assert.equal(saved.state, "committed");
  for (let n = 1; n <= 3; n++) {
    const body = JSON.stringify({
      action: "completed",
      repository: { full_name: "owner/repo" },
      workflow_run: {
        id: n,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      },
    });
    assert.equal(
      (
        await fetch(health.address + "/webhooks/" + id, {
          method: "POST",
          headers: {
            "x-github-delivery": "d" + n,
            "x-github-event": "workflow_run",
            "x-hub-signature-256":
              "sha256=" +
              crypto.createHmac("sha256", webhook).update(body).digest("hex"),
          },
          body,
        })
      ).status,
      202,
    );
  }
  const call = async (action, extra = {}, auth = token) =>
    fetch(health.address + "/inbox/" + id + "/" + action, {
      method: "POST",
      headers: { authorization: "Bearer " + auth },
      body: JSON.stringify({
        consumer_id: consumerId,
        generation: "owner-A",
        ...extra,
      }),
    });
  assert.equal((await call("claim", {}, "wrong-token")).status, 401);
  assert.equal(
    (await call("claim", { consumer_id: crypto.randomUUID() })).status,
    403,
  );
  const claim = await (await call("claim")).json(),
    epoch = claim.lease.epoch;
  assert.equal((await call("claim", { generation: "owner-B" })).status, 409);
  const batch = await (await call("next", { epoch })).json();
  assert.equal(batch.items.length, 3);
  assert.equal(
    (
      await call("ack", {
        epoch,
        event_id: batch.items[0].inbox_id,
        generation: "owner-B",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await (
        await call("ack", { epoch, event_id: batch.items[1].inbox_id })
      ).json()
    ).cursor,
    0,
  );
  assert.equal(
    (
      await (
        await call("ack", { epoch, event_id: batch.items[0].inbox_id })
      ).json()
    ).cursor,
    batch.items[1].inbox_id,
  );
  assert.equal(
    (
      await (
        await call("ack", { epoch, event_id: batch.items[2].inbox_id })
      ).json()
    ).cursor,
    batch.items[2].inbox_id,
  );
  assert.equal((await (await call("next", { epoch })).json()).items.length, 0);
  const restored = await (
    await call("next", { epoch, accepted_through: 0 })
  ).json();
  assert.deepEqual(
    restored.items.map((e) => e.inbox_id),
    batch.items.map((e) => e.inbox_id),
  );
  assert.equal(
    (await call("next", { epoch, accepted_through: 999999 })).status,
    422,
  );
});
test("GitLab standard signatures and registered Webhook events use the same durable review path", async (t) => {
  const http = require("node:http");
  const updated = new Date().toISOString();
  const api = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url.includes("/pipelines/")
          ? { id: 66, status: "failed", finished_at: updated }
          : { subject_id: "case-7", subject_version: "v1", state: "failed" },
      ),
    );
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => api.close(r)));
  const h = await setup(t),
    health = await h.core.request("events.health", {});
  for (const kind of ["gitlab", "webhook"]) {
    const id = crypto.randomUUID(),
      key = crypto.randomBytes(32),
      secret =
        kind === "gitlab"
          ? "whsec_" + key.toString("base64")
          : key.toString("hex");
    const source = await command(h, "events.source.save", {
      id,
      expected_revision: 0,
      definition: {
        name: kind + " mock",
        kind,
        project: kind === "gitlab" ? "7" : "project-x",
        workspace_id: h.wid,
        mode: "local",
        enabled: true,
        api_base_url: `http://127.0.0.1:${api.address().port}`,
        consumer_id: h.core.snapshot().storage_instance,
        auth_mode: "standard",
      },
      secrets: {
        webhook_secret: secret,
        consumer_token: crypto.randomBytes(32).toString("hex"),
      },
    });
    assert.equal(source.state, "committed", JSON.stringify(source.error));
    const body = JSON.stringify(
      kind === "gitlab"
        ? {
            object_kind: "pipeline",
            project: { id: 7 },
            object_attributes: {
              id: 66,
              status: "failed",
              finished_at: updated,
            },
          }
        : {
            schema: "troop.webhook.v1",
            id: "stable-event",
            subject_id: "case-7",
            subject_version: "v1",
            project: "project-x",
            state: "failed",
            occurred_at: Math.floor(Date.now() / 1000),
          },
    );
    const delivery = crypto.randomUUID(),
      timestamp = String(Math.floor(Date.now() / 1000));
    const headers =
      kind === "gitlab"
        ? {
            "x-gitlab-event": "Pipeline Hook",
            "webhook-id": delivery,
            "webhook-timestamp": timestamp,
            "webhook-signature":
              "v1," +
              crypto
                .createHmac("sha256", key)
                .update(delivery + "." + timestamp + "." + body)
                .digest("base64"),
          }
        : {
            "x-troop-delivery": delivery,
            "x-troop-signature":
              "sha256=" +
              crypto.createHmac("sha256", secret).update(body).digest("hex"),
          };
    assert.equal(
      (
        await fetch(health.address + "/webhooks/" + id, {
          method: "POST",
          headers,
          body,
        })
      ).status,
      202,
    );
    const records = await until(async () => {
      const page = await h.core.request("events.records", { source_id: id });
      return page.items[0]?.review_state === "valid" && page.items;
    });
    assert.equal(records[0].project, kind === "gitlab" ? "7" : "project-x");
    const invalid = {
      ...headers,
      ...(kind === "gitlab"
        ? { "webhook-timestamp": "1" }
        : { "x-troop-signature": "sha256=" + "0".repeat(64) }),
    };
    assert.equal(
      (
        await fetch(health.address + "/webhooks/" + id, {
          method: "POST",
          headers: invalid,
          body,
        })
      ).status,
      401,
    );
  }
});

test("object-version identity survives changed payload and poisoned historical metadata stays isolated", async (t) => {
  const h = await setup(t),
    health = await h.core.request("events.health", {});
  const id = crypto.randomUUID(),
    secret = crypto.randomBytes(32).toString("hex");
  assert.equal(
    (
      await command(h, "events.source.save", {
        id,
        expected_revision: 0,
        definition: {
          name: "Version identity",
          kind: "github",
          project: "owner/repo",
          workspace_id: h.wid,
          mode: "local",
          enabled: true,
          api_base_url: "http://127.0.0.1:1",
          consumer_id: h.core.snapshot().storage_instance,
        },
        secrets: {
          webhook_secret: secret,
          consumer_token: crypto.randomBytes(32).toString("hex"),
        },
      })
    ).state,
    "committed",
  );
  const updated = new Date().toISOString();
  for (const title of ["Original", "Different delivery envelope"]) {
    const body = JSON.stringify({
      action: "edited",
      repository: { full_name: "owner/repo" },
      issue: { number: 9, updated_at: updated, state: "open", title },
    });
    const response = await fetch(health.address + "/webhooks/" + id, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256":
          "sha256=" +
          crypto.createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    });
    assert.equal(response.status, 202);
  }
  assert.equal(
    (await h.core.request("events.inbox", { source_id: id })).items.length,
    1,
  );
  await h.core.stop();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(h.data, "troop.sqlite3"));
  db.exec("PRAGMA busy_timeout=5000");
  db.prepare("DELETE FROM source_events WHERE source_id=?").run(id);
  db.prepare(
    "UPDATE event_inbox SET acked=0,document=json_set(document,'$.subject_version','') WHERE source_id=?",
  ).run(id);
  db.close();
  await h.core.start();
  const rejected = await until(async () =>
    (await h.core.request("events.records", { source_id: id })).items.find(
      (e) => e.review_state === "rejected",
    ),
  );
  assert.match(rejected.review_reason, /元数据无效/);
  assert.equal(
    (await h.core.request("events.inbox", { source_id: id })).items[0].acked,
    true,
  );
  await h.core.stop();
  await h.core.start();
  assert.equal(
    (await h.core.request("events.records", { source_id: id })).items[0]
      .review_state,
    "rejected",
  );
});

test("authenticated malformed Pipeline versions are rejected before durable acceptance", async (t) => {
  const h = await setup(t),
    health = await h.core.request("events.health", {});
  const id = crypto.randomUUID(),
    secret = crypto.randomBytes(32).toString("hex");
  assert.equal(
    (
      await command(h, "events.source.save", {
        id,
        expected_revision: 0,
        definition: {
          name: "Pipeline validation",
          kind: "gitlab",
          project: "7",
          workspace_id: h.wid,
          mode: "local",
          enabled: true,
          auth_mode: "token",
          api_base_url: "http://127.0.0.1:1",
          consumer_id: h.core.snapshot().storage_instance,
        },
        secrets: {
          webhook_secret: secret,
          consumer_token: crypto.randomBytes(32).toString("hex"),
        },
      })
    ).state,
    "committed",
  );
  for (const version of ["", "x".repeat(201), "bad\nversion"]) {
    const response = await fetch(health.address + "/webhooks/" + id, {
      method: "POST",
      headers: {
        "x-gitlab-token": secret,
        "x-gitlab-event": "Pipeline Hook",
        "x-gitlab-event-uuid": crypto.randomUUID(),
      },
      body: JSON.stringify({
        object_kind: "pipeline",
        project: { id: 7 },
        object_attributes: { id: 66, status: "failed", updated_at: version },
      }),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(
    (await h.core.request("events.inbox", { source_id: id })).items.length,
    0,
  );
});

test("recheck fences stale HTTP failures and obtains a new current-state result", async (t) => {
  const http = require("node:http");
  let first,
    checks = 0;
  const api = http.createServer((req, res) => {
    checks++;
    if (checks === 1) {
      first = res;
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        subject_id: "case",
        subject_version: "v1",
        state: "failed",
      }),
    );
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => {
    first?.destroy();
    api.closeAllConnections();
    return new Promise((r) => api.close(r));
  });
  const h = await setup(t),
    health = await h.core.request("events.health", {});
  const id = crypto.randomUUID(),
    secret = crypto.randomBytes(32).toString("hex");
  assert.equal(
    (
      await command(h, "events.source.save", {
        id,
        expected_revision: 0,
        definition: {
          name: "Recheck fence",
          kind: "webhook",
          project: "test",
          workspace_id: h.wid,
          mode: "local",
          enabled: true,
          api_base_url: `http://127.0.0.1:${api.address().port}`,
          consumer_id: h.core.snapshot().storage_instance,
        },
        secrets: {
          webhook_secret: secret,
          consumer_token: crypto.randomBytes(32).toString("hex"),
        },
      })
    ).state,
    "committed",
  );
  const body = JSON.stringify({
    schema: "troop.webhook.v1",
    id: "event",
    project: "test",
    subject_id: "case",
    subject_version: "v1",
    state: "failed",
  });
  assert.equal(
    (
      await fetch(health.address + "/webhooks/" + id, {
        method: "POST",
        body,
        headers: {
          "x-troop-delivery": "d",
          "x-troop-signature":
            "sha256=" +
            crypto.createHmac("sha256", secret).update(body).digest("hex"),
        },
      })
    ).status,
    202,
  );
  await until(async () => first);
  assert.equal(
    (
      await command(h, "events.recheck", {
        source_id: id,
        expected_revision: 1,
      })
    ).state,
    "committed",
  );
  first.writeHead(403, { "content-type": "application/json" });
  first.end("{}");
  await until(
    async () =>
      checks >= 2 &&
      (await h.core.request("events.records", { source_id: id })).items[0]
        ?.review_state === "valid",
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    (await h.core.request("events.records", { source_id: id })).items[0]
      .review_state,
    "valid",
  );
});

test("local and independent receivers preserve source identity with separate delivery boundaries", async (t) => {
  const h = await setup(t),
    receiver = await receiverFor(t, h);
  const local = await h.core.request("events.health", {}),
    remote = await receiver.request("events.health", {});
  const id = crypto.randomUUID(),
    secret = crypto.randomBytes(32).toString("hex"),
    token = crypto.randomBytes(32).toString("hex");
  const definition = {
    name: "Receiver migration",
    kind: "github",
    project: "owner/repo",
    workspace_id: h.wid,
    mode: "local",
    enabled: true,
    api_base_url: "http://127.0.0.1:1",
    consumer_id: h.core.snapshot().storage_instance,
  };
  for (const core of [h.core, receiver]) {
    assert.equal(
      (
        await command({ core }, "events.source.save", {
          id,
          expected_revision: 0,
          definition,
          secrets: { webhook_secret: secret, consumer_token: token },
        })
      ).state,
      "committed",
    );
  }
  const post = async (address, number) => {
    const body = JSON.stringify({
      action: "completed",
      repository: { full_name: "owner/repo" },
      workflow_run: {
        id: number,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      },
    });
    assert.equal(
      (
        await fetch(address + "/webhooks/" + id, {
          method: "POST",
          body,
          headers: {
            "x-github-event": "workflow_run",
            "x-github-delivery": crypto.randomUUID(),
            "x-hub-signature-256":
              "sha256=" +
              crypto.createHmac("sha256", secret).update(body).digest("hex"),
          },
        })
      ).status,
      202,
    );
  };
  for (const number of [1, 2, 3]) await post(local.address, number);
  await until(async () =>
    (await h.core.request("events.inbox", { source_id: id })).items.every(
      (e) => e.acked,
    ),
  );
  await post(remote.address, 3);
  await post(remote.address, 4);
  const remoteDefinition = {
    ...definition,
    mode: "remote",
    receiver_url: remote.address,
    receiver_instance: remote.instance_id,
  };
  assert.equal(
    (
      await command(h, "events.source.save", {
        id,
        expected_revision: 1,
        definition: remoteDefinition,
      })
    ).state,
    "committed",
  );
  await until(async () =>
    (await receiver.request("events.inbox", { source_id: id })).items.every(
      (e) => e.acked,
    ),
  );
  assert.equal(
    (await h.core.request("events.records", { source_id: id })).items.length,
    4,
  );
  assert.equal(
    (
      await command(h, "events.source.save", {
        id,
        expected_revision: 2,
        definition,
      })
    ).state,
    "committed",
  );
  await post(local.address, 5);
  await until(
    async () =>
      (await h.core.request("events.records", { source_id: id })).items
        .length === 5,
  );
  assert.equal(
    (
      await command(h, "events.source.save", {
        id,
        expected_revision: 3,
        definition: remoteDefinition,
      })
    ).state,
    "committed",
  );
  await until(
    async () =>
      (await h.core.request("events.health", {})).sources[id]?.state ===
      "connected",
  );
  assert.equal(
    (await h.core.request("events.records", { source_id: id })).items.length,
    5,
  );
});
