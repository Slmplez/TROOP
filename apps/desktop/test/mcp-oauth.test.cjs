const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { DatabaseSync } = require("node:sqlite");
const { CoreSupervisor } = require("../src/core-client.cjs"),
  { coreBinary } = require("../src/core-path.cjs"),
  { oauthServer } = require("./fixtures/oauth-server.cjs");
const root = path.resolve(__dirname, "../../.."),
  temp = path.join(root, ".tmp-troop-mcp/oauth");
fs.mkdirSync(temp, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await sleep(20);
  }
  throw Error("OAuth fixture deadline");
}
async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(temp, "case-")),
    data = path.join(directory, "data"),
    s = await oauthServer(options),
    c = new CoreSupervisor({
      executable: path.resolve(__dirname, "../bin", coreBinary),
      args: ["--data-dir", data],
    });
  await c.start();
  const saved = await c.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "Owned OAuth fixture",
      transport: "http",
      location: "remote",
      url: s.resource,
      agent_ids: [1],
    },
  });
  const id = saved.id;
  const status = () => c.request("mcp.oauth.status", { id });
  const db = () => new DatabaseSync(path.join(data, "troop.sqlite3"));
  t.after(async () => {
    try {
      let d = db();
      d.exec("DROP TRIGGER IF EXISTS oauth_fail");
      d.close();
      await c.start();
      let a = await status();
      if (a.state !== "disconnected" && a.state !== "revoked")
        await c.request("mcp.oauth.disconnect", {
          id,
          auth_revision: a.revision,
        });
    } finally {
      await c.stop();
      await s.close();
    }
  });
  const begin = async (extra = {}) =>
    c.request("mcp.oauth.begin", {
      id,
      expected_revision: 1,
      auth_revision: (await status()).revision,
      client_id: "owned-client",
      scopes: ["files.read"],
      ...extra,
    });
  const ready = () =>
    until(async () => {
      const r = await status();
      return r.authorization_url && r;
    });
  const finish = async () => {
    const r = await ready();
    await fetch(r.authorization_url);
    return until(async () => {
      const r = await status();
      return r.state !== "authorizing" && r;
    });
  };
  const login = async (extra = {}) => {
    await begin(extra);
    const r = await finish();
    assert.equal(r.state, "connected", r.error);
    return r;
  };
  return { c, s, id, directory, data, status, db, begin, ready, finish, login };
}
test("OAuth opaque visible-ASCII tokens survive login and refresh without lexical decoding", async (t) => {
  const h = await setup(t, { tokenPrefix: "owned:opaque=token!~+/_%" });
  const a = await h.login();
  await h.c.request("mcp.oauth.refresh", {
    id: h.id,
    auth_revision: a.revision,
  });
  const b = await until(async () => {
    const s = await h.status();
    return s.state !== "refreshing" && s;
  });
  assert.equal(b.state, "connected", b.error);
  assert.equal(b.grant_id, a.grant_id);
});

for (const [name, tokenPrefix] of [
  ["space", "owned token"],
  ["tab", "owned\ttoken"],
  ["CRLF", "owned\r\nX-Test: value"],
  ["non-ASCII", "owned令牌"],
])
  test(`OAuth bearer rejects ${name} without persisting credentials`, async (t) => {
    const h = await setup(t, { tokenPrefix });
    await h.begin();
    const a = await h.finish();
    assert.equal(a.state, "error");
    const d = h.db();
    const row = d
      .prepare("SELECT secret_refs FROM mcp_oauth WHERE server_id=?")
      .get(h.id);
    assert.deepEqual(JSON.parse(row.secret_refs), {});
    d.close();
  });

test("OAuth public PKCE: issuer/resource binding, private vault chunks and persisted status", async (t) => {
  const h = await setup(t, { longToken: true });
  const a = await h.login();
  assert.equal(a.issuer, h.s.issuer);
  assert.equal(a.resource, h.s.resource);
  assert.equal(a.has_refresh_token, true);
  assert.equal(a.secret_refs, undefined);
  assert.ok(!JSON.stringify(a).includes("owned-refresh"));
  const auth = h.s.calls.find((c) => c.path === "/token");
  const form = new URLSearchParams(auth.body);
  assert.equal(form.get("resource"), h.s.resource);
  assert.equal(form.get("code_verifier").length, 96);
  let db = h.db();
  const row = db
    .prepare("SELECT document,secret_refs FROM mcp_oauth WHERE server_id=?")
    .get(h.id);
  assert.ok(Object.keys(JSON.parse(row.secret_refs)).length >= 3);
  assert.ok(!row.document.includes("owned-refresh"));
  db.close();
  await h.c.stop();
  await h.c.start();
  assert.equal((await h.status()).state, "connected");
  assert.equal(h.s.calls.filter((c) => c.path === "/token").length, 1);
});
test("OAuth callback rejects wrong state, duplicate state and issuer, then accepts a fresh valid observation", async (t) => {
  const h = await setup(t);
  await h.begin();
  const a = await h.ready(),
    u = new URL(a.authorization_url),
    callback = new URL(u.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", "wrong");
  callback.searchParams.set("state", "wrong");
  callback.searchParams.set("iss", h.s.issuer);
  assert.equal((await fetch(callback)).status, 400);
  callback.searchParams.set("state", u.searchParams.get("state"));
  callback.searchParams.append("state", "duplicate");
  assert.equal((await fetch(callback)).status, 400);
  callback.searchParams.delete("state");
  callback.searchParams.set("state", u.searchParams.get("state"));
  callback.searchParams.set("iss", h.s.base + "/wrong");
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(h.s.calls.filter((c) => c.path === "/token").length, 0);
  assert.equal((await h.finish()).state, "connected");
  assert.equal(h.s.calls.filter((c) => c.path === "/token").length, 1);
});
test("OAuth dynamic registration uses an explicit public client and exact loopback redirect", async (t) => {
  const h = await setup(t);
  await h.login({ client_id: null, register: true });
  const r = JSON.parse(h.s.calls.find((c) => c.path === "/register").body);
  assert.equal(r.token_endpoint_auth_method, "none");
  assert.match(
    r.redirect_uris[0],
    /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/,
  );
});
for (const method of ["client_secret_basic", "client_secret_post"])
  test(`OAuth ${method} does not serialize client secrets`, async (t) => {
    const h = await setup(t, {
      authMethods: [method],
      clientSecret: "sec ret:+?",
    });
    const a = await h.login({
      client_id: "owned:client",
      client_secret: "sec ret:+?",
    });
    assert.ok(!JSON.stringify(a).includes("sec ret"));
    assert.equal(a.auth_method, method);
  });
test("OAuth protected resource WWW-Authenticate discovery path is supported", async (t) => {
  const h = await setup(t, { challenge: true });
  await h.login();
  assert.ok(h.s.calls.some((c) => c.path === "/resource-metadata"));
});
test("OAuth concurrent refresh requests join one rotation and preserve durable credentials", async (t) => {
  const h = await setup(t, { tokenDelay: 100 }),
    a = await h.login();
  const request = { id: h.id, auth_revision: a.revision };
  await Promise.all([
    h.c.request("mcp.oauth.refresh", request),
    h.c.request("mcp.oauth.refresh", request),
  ]);
  const b = await until(async () => {
    const r = await h.status();
    return r.state !== "refreshing" && r;
  });
  assert.equal(b.state, "connected");
  assert.equal(
    h.s.calls.filter(
      (c) => c.path === "/token" && c.body.includes("refresh_token"),
    ).length,
    1,
  );
  const db = h.db();
  assert.equal(db.prepare("SELECT count(*) n FROM mcp_secret_gc").get().n, 0);
  db.close();
});
test("OAuth cancelled code exchange cannot install a late result", async (t) => {
  const h = await setup(t, { tokenDelay: 400 });
  await h.begin();
  const a = await h.ready();
  const browser = fetch(a.authorization_url).catch(() => {});
  await until(() => h.s.calls.some((c) => c.path === "/token"));
  await h.c.request("mcp.oauth.cancel", {
    id: h.id,
    auth_revision: a.revision,
  });
  await browser;
  await sleep(500);
  const b = await h.status();
  assert.equal(b.state, "cancelled");
  assert.equal(b.authorization_url, undefined);
  const db = h.db();
  assert.deepEqual(
    JSON.parse(
      db.prepare("SELECT secret_refs FROM mcp_oauth").get().secret_refs,
    ),
    {},
  );
  db.close();
});
test("OAuth cancel closes the old callback listener and never starts token exchange", async (t) => {
  const h = await setup(t);
  await h.begin();
  const a = await h.ready();
  await h.c.request("mcp.oauth.cancel", {
    id: h.id,
    auth_revision: a.revision,
  });
  await sleep(50);
  await assert.rejects(fetch(a.authorization_url));
  assert.equal(h.s.calls.filter((c) => c.path === "/token").length, 0);
});
test("OAuth definition changes invalidate pending login and old authorization", async (t) => {
  const h = await setup(t);
  await h.begin();
  const a = await h.ready();
  const def = (await h.c.request("mcp.get", { id: h.id })).config;
  await h.c.request("mcp.save", {
    id: h.id,
    expected_revision: 1,
    definition: { ...def, name: "Changed" },
  });
  await until(async () => {
    const s = await h.status();
    return s.state === "cancelled";
  });
  await assert.rejects(fetch(a.authorization_url));
});
for (const options of [
  { badResource: true },
  { badIssuer: true },
  { noPkce: true },
  { multipleIssuers: true },
])
  test(`OAuth discovery rejects ${Object.keys(options)[0]}`, async (t) => {
    const h = await setup(t, options);
    await h.begin();
    const r = await until(async () => {
      const r = await h.status();
      return r.state === "error" && r;
    });
    assert.ok(r.error);
    assert.equal(h.s.calls.filter((c) => c.path === "/token").length, 0);
  });
for (const options of [{ invalidGrant: true }, { refreshFailure: true }])
  test(`OAuth ${Object.keys(options)[0]} does not replay refresh`, async (t) => {
    const h = await setup(t, options),
      a = await h.login();
    await h.c.request("mcp.oauth.refresh", {
      id: h.id,
      auth_revision: a.revision,
    });
    const r = await until(async () => {
      const r = await h.status();
      return r.state !== "refreshing" && r;
    });
    assert.equal(
      r.state,
      options.invalidGrant ? "reauth_required" : "refresh_uncertain",
    );
    await assert.rejects(
      h.c.request("mcp.oauth.refresh", { id: h.id, auth_revision: r.revision }),
    );
    assert.equal(
      h.s.calls.filter(
        (c) => c.path === "/token" && c.body.includes("refresh_token"),
      ).length,
      1,
    );
    assert.ok(!JSON.stringify(r).includes("must-not-echo"));
  });
for (const options of [{}, { noRevoke: true }, { revokeFailure: true }])
  test(`OAuth disconnect clears local credentials and reports revocation ${JSON.stringify(options)}`, async (t) => {
    const h = await setup(t, options),
      a = await h.login();
    await h.c.request("mcp.oauth.disconnect", {
      id: h.id,
      auth_revision: a.revision,
    });
    const db = h.db();
    assert.deepEqual(
      JSON.parse(
        db.prepare("SELECT secret_refs FROM mcp_oauth").get().secret_refs,
      ),
      {},
    );
    db.close();
    const r = await until(async () => {
      const r = await h.status();
      return r.state !== "revoking" && r;
    });
    assert.equal(
      r.remote_revocation,
      options.noRevoke
        ? "unsupported"
        : options.revokeFailure
          ? "unknown"
          : "confirmed",
    );
    assert.equal(
      h.s.calls.filter((c) => c.path === "/revoke").length,
      options.noRevoke ? 0 : options.revokeFailure ? 1 : 2,
    );
  });
test("OAuth restart after pending login never reopens the listener or redeems an old code", async (t) => {
  const h = await setup(t);
  await h.begin();
  const a = await h.ready();
  h.c.child.kill();
  await until(() => h.c.state === "faulted");
  await h.c.start();
  assert.equal((await h.status()).state, "interrupted");
  await assert.rejects(fetch(a.authorization_url));
  assert.equal(h.s.calls.filter((c) => c.path === "/token").length, 0);
});
test("OAuth interrupted refresh is uncertain after restart and never repeats rotation", async (t) => {
  const h = await setup(t, { hangRefresh: true }),
    a = await h.login();
  await h.c.request("mcp.oauth.refresh", {
    id: h.id,
    auth_revision: a.revision,
  });
  await until(() =>
    h.s.calls.some(
      (c) => c.path === "/token" && c.body.includes("refresh_token"),
    ),
  );
  h.c.child.kill();
  await until(() => h.c.state === "faulted");
  await h.c.start();
  const r = await h.status();
  assert.equal(r.state, "refresh_uncertain");
  await assert.rejects(
    h.c.request("mcp.oauth.refresh", { id: h.id, auth_revision: r.revision }),
  );
  assert.equal(
    h.s.calls.filter(
      (c) => c.path === "/token" && c.body.includes("refresh_token"),
    ).length,
    1,
  );
});
test("OAuth refusal and unrequested scope do not install credentials", async (t) => {
  const h = await setup(t, { denied: true });
  await h.begin();
  assert.equal((await h.finish()).state, "error");
  h.s.options.denied = false;
  h.s.options.broadScope = true;
  await h.begin();
  assert.equal((await h.finish()).state, "error");
  const db = h.db();
  assert.deepEqual(
    JSON.parse(
      db.prepare("SELECT secret_refs FROM mcp_oauth").get().secret_refs,
    ),
    {},
  );
  db.close();
});
test("OAuth token persistence failure leaves no active grant or orphaned vault references", async (t) => {
  const h = await setup(t);
  let db = h.db();
  db.exec(
    "CREATE TRIGGER oauth_fail BEFORE INSERT ON mcp_oauth WHEN json_extract(NEW.document,'$.state')='connected' BEGIN SELECT RAISE(ABORT,'owned OAuth commit fault'); END",
  );
  db.close();
  await h.begin();
  const r = await h.finish();
  assert.equal(r.state, "error");
  assert.match(r.error, /owned OAuth commit fault/);
  db = h.db();
  assert.deepEqual(
    JSON.parse(
      db.prepare("SELECT secret_refs FROM mcp_oauth").get().secret_refs,
    ),
    {},
  );
  assert.equal(db.prepare("SELECT count(*) n FROM mcp_secret_gc").get().n, 0);
  db.close();
});
test("OAuth a connected grant requires explicit disconnect before new login", async (t) => {
  const h = await setup(t);
  await h.login();
  await assert.rejects(h.begin(), /Disconnect/);
  assert.equal((await h.status()).state, "connected");
});
test("OAuth discovery never blocks Core ping and four pending logins bound new starts", async (t) => {
  const h = await setup(t, { discoveryDelay: 300 });
  await h.begin();
  const start = Date.now();
  assert.equal((await h.c.request("system.ping", {})).ready, true);
  assert.ok(Date.now() - start < 500);
  for (let n = 0; n < 3; n++) {
    const s = await h.c.request("mcp.save", {
      expected_revision: 0,
      definition: {
        name: "Owned extra login",
        transport: "http",
        location: "remote",
        url: h.s.resource,
      },
    });
    await h.c.request("mcp.oauth.begin", {
      id: s.id,
      expected_revision: 1,
      auth_revision: 0,
      client_id: "owned-client",
      scopes: ["files.read"],
    });
  }
  const fifth = await h.c.request("mcp.save", {
    expected_revision: 0,
    definition: {
      name: "Owned fifth login",
      transport: "http",
      location: "remote",
      url: h.s.resource,
    },
  });
  await assert.rejects(
    h.c.request("mcp.oauth.begin", {
      id: fifth.id,
      expected_revision: 1,
      auth_revision: 0,
      client_id: "owned-client",
      scopes: ["files.read"],
    }),
    /capacity/,
  );
});
test("OAuth explicit issuer selection succeeds when metadata advertises several servers", async (t) => {
  const h = await setup(t, { multipleIssuers: true });
  await h.login({ issuer: h.s.issuer });
});
test("OAuth disconnect interrupted by Core death keeps local grant revoked and never retries remotely", async (t) => {
  const h = await setup(t, { revokeDelay: 400 }),
    a = await h.login();
  await h.c.request("mcp.oauth.disconnect", {
    id: h.id,
    auth_revision: a.revision,
  });
  await until(() => h.s.calls.some((c) => c.path === "/revoke"));
  h.c.child.kill();
  await until(() => h.c.state === "faulted");
  await h.c.start();
  const r = await h.status();
  assert.equal(r.state, "revocation_unknown");
  const count = h.s.calls.filter((c) => c.path === "/revoke").length;
  await sleep(450);
  assert.equal(h.s.calls.filter((c) => c.path === "/revoke").length, count);
  const db = h.db();
  assert.deepEqual(
    JSON.parse(
      db.prepare("SELECT secret_refs FROM mcp_oauth").get().secret_refs,
    ),
    {},
  );
  db.close();
});
test("OAuth schema 8 upgrade preserves MCP definitions and starts with no authorization", async (t) => {
  const h = await setup(t);
  await h.c.stop();
  let db = h.db();
  require("./fixtures/schema-before-ledger.cjs")(db);
  const before = db.prepare("SELECT * FROM mcp_servers ORDER BY id").all();
  db.exec(
    "DROP TABLE mcp_artifacts;DROP TABLE mcp_connections;DROP TABLE mcp_oauth;PRAGMA user_version=8;",
  );
  db.close();
  await h.c.start();
  assert.equal((await h.status()).state, "disconnected");
  await h.c.stop();
  db = h.db();
  assert.deepEqual(
    db.prepare("SELECT * FROM mcp_servers ORDER BY id").all(),
    before,
  );
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 29);
  db.close();
});
