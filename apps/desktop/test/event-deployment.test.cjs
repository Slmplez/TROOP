const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { setup } = require("./fixtures/hooks-fixture.cjs");
const { until } = require("./fixtures/hooks-fixture.cjs");
const { coreBinary } = require("../src/core-path.cjs");
test(
  "host heartbeat preserves UTC dates parsed by PowerShell JSON",
  { skip: process.platform !== "win32" },
  () => {
    const script = `
$h = '{"checked_at":"2026-11-09T00:00:00Z"}' | ConvertFrom-Json
$checkedAt = [datetimeoffset]$h.checked_at
$age = ([datetimeoffset]'2026-11-09T00:00:01Z' - $checkedAt.ToUniversalTime()).TotalSeconds
if ($age -ne 1) { throw "UTC heartbeat changed timezone" }
Write-Output $age
`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "1");
    assert.ok(
      fs
        .readFileSync(
          path.join(__dirname, "../scripts/host-events.ps1"),
          "utf8",
        )
        .includes("[datetimeoffset]$health.checked_at"),
    );
  },
);
const {
  configuration,
  preflight,
  EventDeployment,
  createBackup,
  restoreBackup,
  databaseFacts,
  sha256,
} = require("../src/event-deployment.cjs");

async function settings(h, mode = "receiver") {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const executable = path.resolve(__dirname, "../bin", coreBinary);
  return {
    version: 1,
    mode,
    executable,
    core_sha256: sha256(executable),
    data_directory: path.join(h.directory, "deployment"),
    listen: `127.0.0.1:${port}`,
    health_file: path.join(h.directory, "health.json"),
    health_interval_ms: 1000,
  };
}

test("deployment preflight fixes the binary, loopback and public endpoint without starting Core", async (t) => {
  const h = await setup(t),
    config = await settings(h);
  assert.equal(preflight(config).public_entry, "missing");
  assert.throws(() => preflight(config, { requirePublic: true }), /HTTPS/);
  assert.equal(
    preflight(
      { ...config, public_url: "https://events.example.test" },
      { requirePublic: true },
    ).public_entry,
    "configured_unverified",
  );
  assert.throws(
    () => configuration({ ...config, listen: "0.0.0.0:8080" }),
    /loopback/,
  );
  assert.throws(
    () => configuration({ ...config, api_token: "secret" }),
    /未知/,
  );
  assert.throws(
    () => preflight({ ...config, core_sha256: "0".repeat(64) }),
    /指纹/,
  );
  assert.throws(
    () => configuration({ ...config, health_file: config.executable }),
    /覆盖/,
  );
  assert.equal(fs.existsSync(config.data_directory), false);
});

for (const mode of ["local", "receiver"]) {
  test(`deployment ${mode} owns stdio and retains instance identity across stop and restart`, async (t) => {
    const h = await setup(t),
      config = await settings(h, mode);
    const host = new EventDeployment(config);
    t.after(() => host.stop());
    const first = await host.start();
    assert.equal(first.ready, true);
    assert.equal(first.mode, mode);
    assert.equal(
      (await host.control("events.health")).receiver_only,
      mode === "receiver",
    );
    await assert.rejects(host.control("agent.start", {}), /事件管理/);
    await assert.rejects(
      host.control("operations.execute", { method: "agent.start" }),
      /来源配置/,
    );
    assert.equal((await host.stop()).ready, false);
    const restarted = await host.restart();
    assert.equal(restarted.ready, true);
    assert.equal(restarted.instance_id, first.instance_id);
    const persisted = JSON.parse(fs.readFileSync(config.health_file));
    assert.equal(persisted.instance_id, first.instance_id);
  });
}

test("deployment CLI restricts trusted control and stops the actual Core on pipe EOF", async (t) => {
  const h = await setup(t);
  const config = await settings(h);
  const file = path.join(h.directory, "receiver.json");
  fs.writeFileSync(file, JSON.stringify(config));
  const cli = path.resolve(__dirname, "../scripts/event-deployment.mjs");
  const child = spawn(process.execPath, [cli, "run", file], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages = [];
  let pending = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  t.after(async () => {
    child.stdin.end();
    await exited;
  });
  const started = await until(() =>
    messages.find((message) => message.type === "started"),
  );
  assert.equal(started.health.ready, true);
  child.stdin.write(
    JSON.stringify({ id: "blocked", method: "agent.start", params: {} }) + "\n",
  );
  assert.ok(
    (await until(() => messages.find((message) => message.id === "blocked")))
      .error,
  );
  child.stdin.write(
    JSON.stringify({ id: "restart", method: "deployment.restart" }) + "\n",
  );
  const restarted = await until(() =>
    messages.find((message) => message.id === "restart"),
  );
  assert.equal(restarted.result.instance_id, started.health.instance_id);
  const healthy = spawnSync(process.execPath, [cli, "health", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(healthy.status, 0, healthy.stderr);
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(config.health_file)).state,
    "stopped",
  );
  const stopped = spawnSync(process.execPath, [cli, "health", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(stopped.status, 1);
});

test(
  "Windows deployment host bounds actual failing Core launches",
  { skip: process.platform !== "win32" },
  async (t) => {
    const h = await setup(t),
      config = await settings(h);
    const occupied = net.createServer();
    await new Promise((resolve) =>
      occupied.listen(
        Number(config.listen.split(":").at(-1)),
        "127.0.0.1",
        resolve,
      ),
    );
    t.after(() => new Promise((resolve) => occupied.close(resolve)));
    const file = path.join(h.directory, "blocked-port.json");
    fs.writeFileSync(file, JSON.stringify(config));
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        path.resolve(__dirname, "../scripts/host-events.ps1"),
        "-Config",
        file,
        "-Node",
        process.execPath,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 25000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1);
    const starts = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "host_start");
    assert.deepEqual(
      starts.map((entry) => entry.attempt),
      [1, 2, 3],
      result.stdout + result.stderr,
    );
    assert.equal(JSON.parse(fs.readFileSync(config.health_file)).ready, false);
  },
);

test("consistent online backup restores Inbox and source credential identities into a fresh directory", async (t) => {
  const h = await setup(t),
    config = await settings(h);
  const host = new EventDeployment(config);
  t.after(async () => {
    await host.stop();
    require("./fixtures/events-credentials.cjs").cleanupEventCredentials([
      config.data_directory,
    ]);
  });
  const first = await host.start();
  const source = crypto.randomUUID();
  const operation = crypto.randomUUID();
  const saved = await host.control("operations.execute", {
    operation_id: operation,
    instance_id: first.instance_id,
    method: "events.source.save",
    input: {
      id: source,
      expected_revision: 0,
      definition: {
        name: "Deployment backup",
        kind: "webhook",
        project: "deployment",
        workspace_id: h.wid,
        enabled: true,
        mode: "local",
        api_base_url: h.server.origin,
        consumer_id: h.core.snapshot().storage_instance,
      },
      secrets: {
        webhook_secret: "owned-deployment-webhook-secret",
        consumer_token: "owned-deployment-consumer-token",
      },
    },
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  const body = JSON.stringify({
    schema: "troop.webhook.v1",
    id: "backup-event",
    subject_id: "backup-subject",
    subject_version: "v1",
    project: "deployment",
    state: "failed",
    occurred_at: Math.floor(Date.now() / 1000),
  });
  const headers = {
    "x-troop-delivery": crypto.randomUUID(),
    "x-troop-signature":
      "sha256=" +
      crypto
        .createHmac("sha256", "owned-deployment-webhook-secret")
        .update(body)
        .digest("hex"),
  };
  const response = await fetch(first.address + "/webhooks/" + source, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(response.status, 202);
  const destination = path.join(h.directory, "snapshot");
  const manifest = await createBackup(config, destination);
  assert.equal(manifest.instance_id, first.instance_id);
  assert.equal(manifest.unacked, 1);
  assert.equal(manifest.sources[0].id, source);
  assert.ok(manifest.sources[0].secret_ref.startsWith("TROOP/events/"));
  assert.ok(!JSON.stringify(manifest).includes("owned-deployment-"));
  await assert.rejects(createBackup(config, destination), /exist/i);
  const restored = path.join(h.directory, "restored");
  restoreBackup(destination, restored);
  assert.deepEqual(
    databaseFacts(path.join(restored, "troop.sqlite3")),
    databaseFacts(path.join(destination, "troop.sqlite3")),
  );
  await host.stop();
  const recovered = new EventDeployment({
    ...config,
    data_directory: restored,
  });
  t.after(() => recovered.stop());
  assert.equal((await recovered.start()).instance_id, first.instance_id);
  const redelivery = await fetch(first.address + "/webhooks/" + source, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(redelivery.status, 202);
  assert.equal((await redelivery.json()).duplicate, true);
  const inbox = await recovered.control("events.inbox", { source_id: source });
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].acked, false);
  if (process.platform === "win32") {
    const reference = manifest.sources[0].secret_ref;
    assert.ok(
      reference.startsWith(`TROOP/events/${first.instance_id}/${source}/`),
    );
    const removed = spawnSync("cmdkey.exe", [`/delete:${reference}`], {
      windowsHide: true,
      stdio: "ignore",
    });
    assert.equal(removed.status, 0);
    assert.equal(
      (
        await fetch(first.address + "/webhooks/" + source, {
          method: "POST",
          headers,
          body,
        })
      ).status,
      503,
    );
    const rebound = await recovered.control("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: first.instance_id,
      method: "events.source.save",
      input: {
        id: source,
        expected_revision: saved.result.revision,
        definition: {
          name: "Rebound deployment",
          kind: "webhook",
          project: "deployment",
          workspace_id: h.wid,
          enabled: true,
          mode: "local",
          api_base_url: h.server.origin,
          consumer_id: h.core.snapshot().storage_instance,
        },
        secrets: {
          webhook_secret: "owned-rebound-webhook-secret",
          consumer_token: "owned-rebound-consumer-token",
        },
      },
    });
    assert.equal(rebound.state, "committed", JSON.stringify(rebound.error));
    assert.equal(rebound.result.id, source);
    assert.equal(
      (
        await fetch(first.address + "/webhooks/" + source, {
          method: "POST",
          headers,
          body,
        })
      ).status,
      401,
    );
    const reboundHeaders = {
      ...headers,
      "x-troop-signature":
        "sha256=" +
        crypto
          .createHmac("sha256", "owned-rebound-webhook-secret")
          .update(body)
          .digest("hex"),
    };
    const delivered = await fetch(first.address + "/webhooks/" + source, {
      method: "POST",
      headers: reboundHeaders,
      body,
    });
    assert.equal(delivered.status, 202);
    assert.equal((await delivered.json()).duplicate, true);
    assert.equal(
      (await recovered.control("events.inbox", { source_id: source })).items
        .length,
      1,
    );
  }
  await recovered.stop();
  assert.throws(() => restoreBackup(destination, restored), /exist/i);
  const broken = JSON.parse(
    fs.readFileSync(path.join(destination, "manifest.json")),
  );
  broken.database_sha256 = "0".repeat(64);
  fs.writeFileSync(
    path.join(destination, "manifest.json"),
    JSON.stringify(broken),
  );
  assert.throws(
    () => restoreBackup(destination, path.join(h.directory, "bad")),
    /摘要/,
  );
  assert.equal(fs.existsSync(path.join(h.directory, "bad")), false);
});
