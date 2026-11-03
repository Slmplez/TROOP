const { test, before } = require("node:test"),
  assert = require("node:assert/strict"),
  http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../../.."),
  exe = path.join(root, "target/debug/examples/probe.exe");
before(() => {
  const r = spawnSync(
    "cargo",
    ["build", "--offline", "--locked", "-p", "troop-mcp", "--example", "probe"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(r.status, 0, r.stderr);
});
async function probe(input) {
  const p = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, TROOP_PRIVATE_TEST_SECRET: "never-inherit" },
  });
  let out = "",
    err = "";
  p.stdout.on("data", (b) => (out += b));
  p.stderr.on("data", (b) => (err += b));
  p.stdin.end(JSON.stringify(input));
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      p.kill();
      reject(Error("Probe deadline"));
    }, 12000);
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, err);
        const report = JSON.parse(out);
        if (!report.open_error) assert.equal(report.close_error, null);
        resolve(report);
      } catch (e) {
        reject(e);
      }
    });
  });
}
async function server(t, mode = "json") {
  const calls = [];
  let stream,
    deleted = false;
  const replies = [];
  const s = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      stream = res;
      const endpoint =
        mode === "cross-origin" ? "http://127.0.0.1:1/steal" : "/messages";
      res.write(`event: endpoint\r\ndata: ${endpoint}\r\n\r\n`);
      return;
    }
    if (req.method === "DELETE") {
      deleted = true;
      res.writeHead(200);
      res.end();
      return;
    }
    let bytes = "";
    for await (const b of req) bytes += b;
    const q = JSON.parse(bytes);
    calls.push(q);
    if (!q.method) {
      replies.push(q);
      res.writeHead(202);
      res.end();
      return;
    }
    if (q.id == null) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (q.method !== "initialize") {
      assert.equal(req.headers["mcp-protocol-version"], "2025-06-18");
      if (!mode.startsWith("legacy"))
        assert.equal(req.headers["mcp-session-id"], "fixture-session");
    }
    let result = {};
    if (q.method === "initialize")
      result = {
        protocolVersion: mode === "version" ? "2099-01-01" : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    if (q.method === "tools/list") {
      result = {
        tools: [
          {
            name: q.params.cursor ? "second" : "echo",
            inputSchema: { type: "object" },
          },
        ],
      };
      if (["pages", "cursor"].includes(mode))
        result.nextCursor = q.params.cursor
          ? mode === "cursor"
            ? "page2"
            : undefined
          : "page2";
      if (mode === "schema") result.tools[0].inputSchema = { type: "array" };
      if (mode === "external-ref")
        result.tools[0].inputSchema = {
          type: "object",
          $ref: "file:///C:/private-mcp-schema.json",
        };
    }
    if (q.method === "tools/call") {
      if (["401", "404"].includes(mode)) {
        res.writeHead(+mode);
        res.end("private-endpoint-token");
        return;
      }
      if (mode === "hang") return;
      result = {
        content: [{ type: "text", text: q.params.arguments.text }],
        isError: mode === "tool-error",
      };
    }
    const v = {
      jsonrpc: "2.0",
      id: mode === "wrong-id" && q.method === "tools/call" ? 999 : q.id,
      result,
    };
    const data = JSON.stringify(v);
    if (mode.startsWith("legacy")) {
      res.writeHead(202);
      res.end();
      stream.write(`event: message\ndata: ${data}\n\n`);
      return;
    }
    const h = {
      "content-type": mode.startsWith("sse")
        ? "text/event-stream"
        : "application/json",
    };
    if (q.method === "initialize") h["mcp-session-id"] = "fixture-session";
    if (mode === "redirect") {
      res.writeHead(307, { location: "http://127.0.0.1:1/steal" });
      res.end();
      return;
    }
    res.writeHead(200, h);
    if (mode.startsWith("sse")) {
      if (q.method === "tools/call") {
        res.write(
          'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\n\r\n',
        );
        if (mode === "sse-request")
          res.write(
            'data: {"jsonrpc":"2.0","id":"server1","method":"sampling/createMessage","params":{}}\n\n',
          );
      }
      const raw = Buffer.from(`data: ${data}\r\n\r\n`);
      for (let i = 0; i < raw.length; i += 3) res.write(raw.subarray(i, i + 3));
      res.end();
    } else res.end(mode === "oversize" ? "x".repeat(65537) : data);
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  return {
    endpoint: `http://127.0.0.1:${s.address().port}/mcp`,
    calls,
    replies,
    deleted: () => deleted,
  };
}
for (const mode of [
  "json",
  "sse",
  "legacy",
  "pages",
  "tool-error",
  "sse-request",
])
  test(`MCP ${mode}: initialize, discovery, Unicode call, explicit close`, async (t) => {
    const s = await server(t, mode),
      r = await probe({
        endpoint: s.endpoint,
        legacy: mode === "legacy",
        call: true,
      });
    assert.equal(r.call.content[0].text, "中文");
    assert.equal(r.error, null);
    assert.equal(r.tools.length, mode === "pages" ? 2 : 1);
    if (mode.startsWith("sse")) assert.equal(r.changed, true);
    if (mode === "sse-request") assert.equal(s.replies[0].error.code, -32601);
    assert.equal(s.deleted(), mode !== "legacy");
  });
for (const mode of ["401", "404", "hang", "wrong-id"])
  test(`MCP ${mode}: tool dispatch is never replayed or reused`, async (t) => {
    const s = await server(t, mode),
      r = await probe({
        endpoint: s.endpoint,
        call: true,
        second: true,
        timeout_ms: 300,
      });
    assert.equal(r.error.indeterminate, true);
    assert.equal(r.second_error.indeterminate, false);
    assert.equal(s.calls.filter((q) => q.method === "tools/call").length, 1);
    if (mode === "hang")
      assert.equal(
        s.calls.filter((q) => q.method === "notifications/cancelled").length,
        1,
      );
    assert.ok(!JSON.stringify(r).includes("private-endpoint-token"));
  });
for (const mode of ["cross-origin", "version", "redirect", "oversize"])
  test(`MCP ${mode}: invalid startup is rejected`, async (t) => {
    const s = await server(t, mode),
      r = await probe({
        endpoint: s.endpoint,
        legacy: mode === "cross-origin",
      });
    assert.ok(r.open_error);
  });
for (const mode of ["schema", "cursor", "external-ref"])
  test(`MCP ${mode}: catalogue rejected without partial success`, async (t) => {
    const s = await server(t, mode),
      r = await probe({ endpoint: s.endpoint });
    assert.ok(r.list_error);
    assert.equal(r.tools, null);
  });
test("MCP reserved headers and nonlocal plaintext URL are rejected", async () => {
  assert.ok((await probe({ endpoint: "http://example.com/mcp" })).open_error);
  assert.ok(
    (
      await probe({
        endpoint: "http://127.0.0.1:1/mcp",
        headers: { "Mcp-Session-Id": "injected" },
      })
    ).open_error,
  );
});
function stdio(t, mode) {
  const directory = fs.mkdtempSync(path.join(root, ".tmp-mcp-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    config: {
      command: process.execPath,
      args: [path.join(__dirname, "fixtures/mcp-stdio.cjs"), mode, directory],
      cwd: directory,
      env: { MCP_TEST_VALUE: "值 with spaces" },
    },
  };
}
test("MCP caller cancellation poisons session and close sends cancellation without replay", async (t) => {
  const s = await server(t, "hang");
  const r = await probe({
    endpoint: s.endpoint,
    call: true,
    second: true,
    abort_after_ms: 50,
  });
  assert.equal(r.error.indeterminate, true);
  assert.equal(r.second_error.indeterminate, false);
  assert.equal(s.calls.filter((q) => q.method === "tools/call").length, 1);
  assert.equal(
    s.calls.filter((q) => q.method === "notifications/cancelled").length,
    1,
  );
});
test("MCP Windows stdio: exact args/cwd, bounded environment and notifications", async (t) => {
  const h = stdio(t, "env"),
    r = await probe({ stdio: h.config, call: true });
  assert.equal(r.error, null);
  const v = JSON.parse(r.call.content[0].text);
  assert.equal(v.override, "值 with spaces");
  assert.equal(v.secret, null);
  assert.equal(v.cwd.toLowerCase(), h.directory.toLowerCase());
  assert.equal(r.changed, true);
});
test("MCP Windows stdio: oversized output terminates session", async (t) => {
  const h = stdio(t, "flood"),
    r = await probe({ stdio: h.config, call: true, second: true });
  assert.ok(r.error);
  assert.ok(r.second_error);
});
test("MCP Windows stdio: timeout and close stop owned grandchild heartbeat", async (t) => {
  const h = stdio(t, "tree"),
    r = await probe({ stdio: h.config, call: true, timeout_ms: 800 });
  assert.equal(r.error.indeterminate, true);
  const file = path.join(h.directory, "heartbeat");
  assert.ok(fs.existsSync(file));
  const n = fs.statSync(file).size;
  assert.ok(n > 0);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(fs.statSync(file).size, n);
});
test("MCP Windows stdio: parent crash closes Job without replay or surviving grandchild", async (t) => {
  const h = stdio(t, "tree");
  const p = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  p.stdin.end(
    JSON.stringify({ stdio: h.config, call: true, timeout_ms: 5000 }),
  );
  const file = path.join(h.directory, "heartbeat");
  for (let n = 0; n < 100 && !fs.existsSync(file); n++)
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(file));
  p.kill();
  await new Promise((r) => p.on("close", r));
  await new Promise((r) => setTimeout(r, 150));
  const n = fs.statSync(file).size;
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(fs.statSync(file).size, n);
});
