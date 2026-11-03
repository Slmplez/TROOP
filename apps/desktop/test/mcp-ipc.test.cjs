const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { installMcp, authorizationUrl } = require("../src/mcp-ipc.cjs");
function fixture() {
  const handlers = {},
    calls = [],
    opened = [];
  let answer = 0,
    status = {
      state: "authorizing",
      revision: 3,
      authorization_url: "https://login.example.test/authorize?state=owned",
    };
  const core = {
    request: async (method, p) => {
      calls.push({ method, p });
      if (method === "mcp.oauth.status") return status;
      if (method === "mcp.get")
        return { revision: 1, config: { name: "Owned MCP" } };
      return { saved: true };
    },
  };
  installMcp({
    handle: (name, fn) => (handlers[name] = fn),
    core,
    payload: (x) => x,
    dialog: { showMessageBox: async () => ({ response: answer }) },
    shell: { openExternal: async (url) => opened.push(url) },
    window: () => ({}),
  });
  return {
    handlers,
    calls,
    opened,
    confirm: () => (answer = 1),
    status: (d) => (status = d),
  };
}
test("MCP browser bridge uses the current Core URL and refuses renderer URLs", async () => {
  const f = fixture();
  await f.handlers["mcp-oauth-open"]({ id: "owned", auth_revision: 3 });
  assert.equal(f.opened.length, 1);
  await assert.rejects(
    f.handlers["mcp-oauth-open"]({ id: "owned", auth_revision: 2 }),
  );
  await assert.rejects(
    f.handlers["mcp-oauth-open"]({
      id: "owned",
      auth_revision: 3,
      url: "https://other.test",
    }),
  );
  f.status({
    state: "cancelled",
    revision: 3,
    authorization_url: "https://login.example.test",
  });
  await assert.rejects(
    f.handlers["mcp-oauth-open"]({ id: "owned", auth_revision: 3 }),
  );
  assert.equal(f.opened.length, 1);
});
for (const url of [
  "file:///C:/Windows/notepad.exe",
  "javascript:alert(1)",
  "data:text/html,owned",
  "http://remote.example.test/login",
  "https://u:p@example.test/login",
  "https://example.test/#owned",
])
  test(`MCP browser rejects unsafe URL ${new URL(url).protocol}`, () =>
    assert.throws(() => authorizationUrl(url)));
test("MCP browser allows HTTPS and explicit HTTP loopback only", () => {
  assert.ok(authorizationUrl("http://127.0.0.1:1234/login"));
  assert.ok(authorizationUrl("https://example.test/login"));
});
test("MCP host command enable requires the dedicated confirmation before any save", async () => {
  const f = fixture(),
    input = {
      expected_revision: 0,
      definition: {
        name: "Owned local",
        enabled: true,
        transport: "stdio",
        location: "windows-host",
        command: "C:\\owned.exe",
        args: [],
        cwd: "C:\\owned",
      },
    };
  assert.deepEqual(await f.handlers["mcp-save"](input), { cancelled: true });
  assert.equal(f.calls.length, 0);
  f.confirm();
  await f.handlers["mcp-save"](input);
  assert.equal(f.calls[0].method, "mcp.save");
});
test("MCP deletion checks revision, confirmation and local OAuth cleanup", async () => {
  const f = fixture();
  await assert.rejects(
    f.handlers["mcp-remove"]({ id: "owned", expected_revision: 0 }),
  );
  assert.equal(
    (await f.handlers["mcp-remove"]({ id: "owned", expected_revision: 1 }))
      .cancelled,
    true,
  );
  assert.ok(!f.calls.some((c) => c.method === "mcp.remove"));
  f.confirm();
  await f.handlers["mcp-remove"]({ id: "owned", expected_revision: 1 });
  const m = f.calls.map((c) => c.method);
  assert.ok(m.indexOf("mcp.oauth.disconnect") < m.indexOf("mcp.remove"));
});
