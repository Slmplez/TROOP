const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { DatabaseSync } = require("node:sqlite");
const { CoreSupervisor } = require("../src/core-client.cjs"),
  { coreBinary } = require("../src/core-path.cjs");
const root = path.resolve(__dirname, "../../.."),
  temp = path.join(root, ".tmp-troop-mcp/library");
fs.mkdirSync(temp, { recursive: true });
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(temp, "case-"));
  const data = path.join(directory, "data");
  const c = new CoreSupervisor({
    executable: path.resolve(__dirname, "../bin", coreBinary),
    args: ["--data-dir", data],
  });
  await c.start();
  t.after(async () => {
    try {
      await c.start();
      const db = new DatabaseSync(path.join(data, "troop.sqlite3"));
      db.exec("DROP TRIGGER IF EXISTS mcp_fail");
      db.close();
      for (;;) {
        const p = await c.request("mcp.list", {});
        if (!p.items.length) break;
        for (const item of p.items)
          await c.request("mcp.remove", {
            id: item.id,
            expected_revision: item.revision,
          });
      }
    } finally {
      await c.stop();
    }
  });
  return {
    c,
    directory,
    data,
    db: () => new DatabaseSync(path.join(data, "troop.sqlite3")),
  };
}
const definition = (over = {}) => ({
  name: "Owned MCP",
  transport: "http",
  location: "remote",
  url: "http://127.0.0.1:1/mcp",
  enabled: false,
  agent_ids: [1],
  ...over,
});
const save = (h, def = definition(), extra = {}) =>
  h.c.request("mcp.save", { expected_revision: 0, definition: def, ...extra });
test("MCP library: stable IDs, same display names, revisions and restart persistence", async (t) => {
  const h = await setup(t),
    a = await save(h),
    b = await save(h);
  assert.notEqual(a.id, b.id);
  assert.equal(a.revision, 1);
  const revised = await save(
    h,
    definition({ name: "Edited", enabled: true, disabled_tools: ["send"] }),
    { id: a.id, expected_revision: 1 },
  );
  assert.equal(revised.revision, 2);
  await assert.rejects(
    save(h, definition(), { id: a.id, expected_revision: 1 }),
    /changed/,
  );
  await h.c.stop();
  await h.c.start();
  assert.equal((await h.c.request("mcp.get", { id: a.id })).revision, 2);
  const history = await h.c.request("mcp.revisions", { id: a.id });
  assert.deepEqual(
    history.items.map((i) => i.revision),
    [2, 1],
  );
});
test("MCP secrets: vault references only, masked DTOs, replacement and deletion cleanup", async (t) => {
  const h = await setup(t),
    sentinel = "owned-secret-" + crypto.randomUUID(),
    def = definition({ header_keys: ["authorization"] });
  const a = await save(h, def, {
    secrets: { "header:authorization": sentinel },
  });
  assert.deepEqual(a.secret_keys, ["header:authorization"]);
  assert.equal(a.secret_refs, undefined);
  let db = h.db(),
    row = db
      .prepare("SELECT secret_refs FROM mcp_servers WHERE id=?")
      .get(a.id);
  db.close();
  const old = row.secret_refs;
  assert.ok(old.includes("TROOP/mcp/"));
  assert.ok(!old.includes(sentinel));
  const edited = await save(h, def, {
    id: a.id,
    expected_revision: 1,
    secrets: { "header:authorization": "replacement-" + crypto.randomUUID() },
  });
  db = h.db();
  assert.notEqual(
    db.prepare("SELECT secret_refs FROM mcp_servers WHERE id=?").get(a.id)
      .secret_refs,
    old,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM mcp_secret_gc").get().n, 0);
  db.close();
  for (const method of ["mcp.get", "mcp.revisions", "mcp.list"]) {
    const out = await h.c.request(
      method,
      method === "mcp.list" ? {} : { id: a.id },
    );
    assert.ok(!JSON.stringify(out).includes(sentinel));
    assert.ok(!JSON.stringify(out).includes("TROOP/mcp/"));
  }
  const cleared = await save(h, definition(), {
    id: a.id,
    expected_revision: edited.revision,
  });
  assert.deepEqual(cleared.secret_keys, []);
  assert.equal(cleared.credential_cleanup_pending, false);
  await h.c.request("mcp.remove", {
    id: a.id,
    expected_revision: cleared.revision,
  });
  assert.equal((await h.c.request("mcp.list", {})).items.length, 0);
  const gone = await h.c.request("mcp.get", { id: a.id });
  assert.equal(gone.deleted, true);
  assert.equal(gone.config.enabled, false);
  assert.deepEqual(gone.secret_keys, []);
  await assert.rejects(
    save(h, def, { id: a.id, expected_revision: gone.revision }),
    /changed/,
  );
  await h.c.stop();
  for (const file of fs
    .readdirSync(h.data)
    .filter((s) => s.startsWith("troop.sqlite3"))) {
    assert.ok(
      !fs.readFileSync(path.join(h.data, file)).includes(Buffer.from(sentinel)),
    );
  }
});
test("MCP SQLite revision failure rolls back definition and cleans fresh credentials", async (t) => {
  const h = await setup(t),
    def = definition({ header_keys: ["authorization"] });
  const a = await save(h, def, {
    secrets: { "header:authorization": "first" },
  });
  let db = h.db();
  const old = db
    .prepare("SELECT secret_refs FROM mcp_servers WHERE id=?")
    .get(a.id).secret_refs;
  db.exec(
    "CREATE TRIGGER mcp_fail BEFORE INSERT ON mcp_revisions BEGIN SELECT RAISE(ABORT,'fixture revision fault'); END",
  );
  db.close();
  await assert.rejects(
    save(h, def, {
      id: a.id,
      expected_revision: 1,
      secrets: { "header:authorization": "second" },
    }),
    /fixture revision fault/,
  );
  db = h.db();
  assert.equal(
    db.prepare("SELECT revision FROM mcp_servers WHERE id=?").get(a.id)
      .revision,
    1,
  );
  assert.equal(
    db.prepare("SELECT secret_refs FROM mcp_servers WHERE id=?").get(a.id)
      .secret_refs,
    old,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM mcp_secret_gc").get().n, 0);
  db.close();
});
test("MCP assignment and tool changes revoke the old revision; missing Agent rejected", async (t) => {
  const h = await setup(t),
    a = await save(h);
  await assert.rejects(
    save(h, definition({ agent_ids: [999] })),
    /Agent|agent/,
  );
  const b = await save(
    h,
    definition({ agent_ids: [], disabled_tools: ["echo"], enabled: true }),
    { id: a.id, expected_revision: 1 },
  );
  assert.equal(b.revision, 2);
  assert.deepEqual(b.config.agent_ids, []);
  assert.deepEqual(b.config.disabled_tools, ["echo"]);
});
test("MCP Linux configurations remain disabled and import/save never execute a command", async (t) => {
  const h = await setup(t),
    legacy = definition({
      transport: "stdio",
      location: "legacy-linux",
      url: "",
      command: "/usr/bin/node",
      cwd: "/work",
      args: ["server.js"],
    });
  const a = await save(h, legacy);
  await assert.rejects(
    save(h, { ...legacy, enabled: true }, { id: a.id, expected_revision: 1 }),
    /disabled/,
  );
  const marker = path.join(h.directory, "must-not-exist"),
    host = definition({
      transport: "stdio",
      location: "windows-host",
      url: "",
      command: process.execPath,
      cwd: h.directory,
      args: [
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
      ],
      enabled: true,
    });
  await save(h, host);
  assert.equal(fs.existsSync(marker), false);
});
test("MCP import previews redact secrets, require exact source and import only the chosen disabled entry", async (t) => {
  const h = await setup(t),
    raw = JSON.stringify({
      mcpServers: {
        one: {
          url: "http://127.0.0.1:1/mcp",
          headers: { Authorization: "owned-import-secret" },
        },
        two: {
          command: "/bin/node",
          args: ["server.js"],
          env: { TOKEN: "owned-env-secret" },
        },
      },
    }),
    source = { json: raw, location: "legacy-linux", cwd: "/work" };
  const p = await h.c.request("mcp.preview", source);
  assert.equal(p.total, 2);
  assert.ok(!JSON.stringify(p).includes("owned-import-secret"));
  assert.ok(!JSON.stringify(p).includes("owned-env-secret"));
  assert.equal((await h.c.request("mcp.list", {})).items.length, 0);
  await assert.rejects(
    h.c.request("mcp.import", {
      source: { ...source, json: raw + " " },
      digest: p.digest,
      index: 0,
      expected_revision: 0,
    }),
    /preview changed/,
  );
  const a = await h.c.request("mcp.import", {
    source,
    digest: p.digest,
    index: 0,
    expected_revision: 0,
  });
  assert.equal(a.config.enabled, false);
  assert.deepEqual(a.config.agent_ids, []);
  assert.equal((await h.c.request("mcp.list", {})).items.length, 1);
  await h.c.request("mcp.remove", { id: a.id, expected_revision: 1 });
});
test("MCP import rejects unsupported transport, unknown fields and ambiguous header keys", async (t) => {
  const h = await setup(t);
  for (const entry of [
    { url: "http://127.0.0.1:1/mcp", type: "evil" },
    { command: "/bin/node", shell: true },
    {
      url: "http://127.0.0.1:1/mcp",
      headers: { Authorization: "a", authorization: "b" },
    },
  ])
    await assert.rejects(
      h.c.request("mcp.preview", {
        json: JSON.stringify({ mcpServers: { one: entry } }),
        location: "legacy-linux",
        cwd: "/work",
      }),
    );
});
test("MCP invalid secrets, reserved headers and URL credentials are rejected before vault writes", async (t) => {
  const h = await setup(t);
  for (const [def, secrets] of [
    [definition({ header_keys: ["host"] }), { "header:host": "bad" }],
    [definition({ url: "https://u:p@example.com/mcp" }), {}],
    [definition({ url: "https://example.com/mcp?token=bad" }), {}],
    [
      definition({ header_keys: ["authorization"] }),
      { "header:authorization": "bad\nheader" },
    ],
    [definition({ header_keys: ["authorization"] }), {}],
    [definition(), { "env:TOKEN": "wrong target" }],
  ])
    await assert.rejects(save(h, def, { secrets }));
  const db = h.db();
  assert.equal(db.prepare("SELECT count(*) n FROM mcp_secret_gc").get().n, 0);
  db.close();
});
test("MCP pages stay inside IPC frame budget with large definitions and history", async (t) => {
  const h = await setup(t),
    def = definition({
      transport: "stdio",
      location: "legacy-linux",
      url: "",
      command: "/bin/node",
      args: ["x".repeat(10000)],
    });
  let a;
  for (let n = 0; n < 6; n++) a = await save(h, def);
  const page = await h.c.request("mcp.list", {});
  assert.ok(JSON.stringify(page).length < 50000);
  assert.ok(page.next_offset > 0);
  const next = await h.c.request("mcp.list", { offset: page.next_offset });
  assert.equal(page.items.length + next.items.length, 6);
  for (let n = 0; n < 5; n++)
    a = await save(h, def, { id: a.id, expected_revision: a.revision });
  const history = await h.c.request("mcp.revisions", { id: a.id });
  assert.ok(history.next_offset > 0);
  assert.ok(JSON.stringify(history).length < 50000);
});
function snapshot(db, tables) {
  tables ??= db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'mcp_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  return tables.map((name) => [
    name,
    crypto
      .createHash("sha256")
      .update(
        JSON.stringify(
          db
            .prepare(
              `SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
            )
            .all()
            .filter(
              (row) => name !== "sqlite_sequence" || tables.includes(row.name),
            ),
        ),
      )
      .digest("hex"),
  ]);
}
test("MCP migration from 7 preserves all old tables", async (t) => {
  const h = await setup(t);
  await h.c.request("workspace.add", { path: h.directory });
  await h.c.stop();
  let db = h.db();
  require("./fixtures/schema-before-ledger.cjs")(db);
  db.exec(
    "DROP TABLE IF EXISTS mcp_artifacts; DROP TABLE IF EXISTS mcp_connections; DROP TABLE IF EXISTS mcp_oauth; DROP TABLE mcp_secret_gc; DROP TABLE mcp_revisions; DROP TABLE mcp_servers; PRAGMA user_version=7;",
  );
  const old = snapshot(db);
  db.close();
  await h.c.start();
  await h.c.stop();
  db = h.db();
  assert.deepEqual(
    snapshot(
      db,
      old.map(([name]) => name),
    ),
    old,
  );
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 31);
  assert.equal(db.prepare("SELECT count(*) n FROM mcp_servers").get().n, 0);
  db.close();
});
