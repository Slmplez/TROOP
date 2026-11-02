const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { once } = require("node:events");
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const executable = path.resolve(__dirname, "../bin", coreBinary);
const temp = path.resolve(__dirname, "../../../.tmp-troop-bootstrap/tests");
fs.mkdirSync(temp, { recursive: true });
const dir = () => fs.mkdtempSync(path.join(temp, "case-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(20);
  }
  throw Error("Condition timed out");
}
async function create(t, d = dir()) {
  const c = new CoreSupervisor({ executable, args: ["--data-dir", d] });
  t.after(() => c.stop());
  await c.start();
  return { c, d };
}
function raw(d) {
  const child = spawn(executable, ["--data-dir", d], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const lines = [];
  const waits = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const v = JSON.parse(line);
    if (waits.length) waits.shift()(v);
    else lines.push(v);
  });
  return {
    child,
    get stderr() {
      return stderr;
    },
    next: () =>
      lines.length
        ? Promise.resolve(lines.shift())
        : new Promise((resolve) => waits.push(resolve)),
    send: (value) => child.stdin.write(JSON.stringify(value) + "\n"),
  };
}
test("real Core persists Unicode workspaces; removing registration preserves files", async (t) => {
  const { c, d } = await create(t);
  const work = path.join(dir(), "项目 with spaces 🧪");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "keep.txt"), "do not remove");
  let page = await c.request("workspace.add", { path: work });
  assert.equal(page.total, 1);
  const id = page.items[0].id;
  page = await c.request("workspace.add", { path: work });
  assert.equal(page.total, 1);
  await c.request("workspace.rename", { id, name: "长期项目 中文" });
  const old = c.generation;
  await c.stop();
  await c.start();
  assert.notEqual(c.generation, old);
  page = await c.request("workspace.list");
  assert.equal(page.items[0].name, "长期项目 中文");
  assert.ok(fs.existsSync(path.join(d, "troop.sqlite3")));
  page = await c.request("workspace.remove", { id });
  assert.equal(page.total, 0);
  assert.equal(
    fs.readFileSync(path.join(work, "keep.txt"), "utf8"),
    "do not remove",
  );
});
test("data directory allows exactly one live Core owner", async (t) => {
  const { c, d } = await create(t);
  const other = raw(d);
  const [code] = await once(other.child, "exit");
  assert.equal(code, 1);
  assert.match(other.stderr, /Another Core/);
  assert.equal((await c.request("system.ping")).ready, true);
});
test("protocol rejects bad handshakes, stale generations, unknown fields and duplicate IDs without duplicate writes", async (t) => {
  const d = dir(),
    r = raw(d);
  t.after(() => r.child.kill());
  const work = dir();
  const send = async (id, method, params = {}, generation) => {
    r.send({
      jsonrpc: "2.0",
      id,
      method,
      params,
      ...(generation ? { generation } : {}),
    });
    return r.next();
  };
  let v = await send("pre", "workspace.add", { path: work });
  assert.equal(v.error.data.kind, "handshake_required");
  v = await send("bad", "system.hello", {
    protocol: 99,
    client: "troop-desktop",
  });
  assert.equal(v.error.data.kind, "protocol_mismatch");
  v = await send("hello", "system.hello", {
    protocol: 6,
    client: "troop-desktop",
  });
  const generation = v.result.generation;
  v = await send("old", "workspace.add", { path: work }, "old-generation");
  assert.equal(v.error.data.kind, "stale_generation");
  v = await send(
    "missing",
    "shell.exec",
    { command: "must not execute" },
    generation,
  );
  assert.equal(v.error.code, -32601);
  r.send({
    jsonrpc: "2.0",
    id: "fields",
    method: "workspace.add",
    generation,
    params: { path: work },
    command: "unexpected",
  });
  assert.equal((await r.next()).error.code, -32700);
  v = await send("add", "workspace.add", { path: work }, generation);
  assert.equal(v.result.value.total, 1);
  v = await send(
    "add",
    "workspace.remove",
    { id: v.result.value.items[0].id },
    generation,
  );
  assert.equal(v.error.data.kind, "duplicate_id");
  v = await send("list", "workspace.list", {}, generation);
  assert.equal(v.result.value.total, 1);
  await send("quit", "system.shutdown", {}, generation);
  await once(r.child, "exit");
});
test("oversize input is rejected and EOF releases the store lock", async (t) => {
  const d = dir(),
    r = raw(d);
  r.child.stdin.write("x".repeat(65537) + "\n");
  const answer = await r.next();
  assert.equal(answer.error.data.kind, "frame_too_large");
  await once(r.child, "exit");
  const r2 = raw(d);
  r2.child.stdin.end();
  await once(r2.child, "exit");
  await create(t, d);
});
test("workspace pages stay bounded and cover every persisted registration", async (t) => {
  const { c } = await create(t);
  const root = dir();
  for (let i = 0; i < 55; i++) {
    const p = path.join(root, "workspace-" + i);
    fs.mkdirSync(p);
    await c.request("workspace.add", { path: p });
  }
  const first = await c.request("workspace.list");
  assert.equal(first.total, 55);
  assert.equal(first.items.length, 50);
  assert.equal(first.next_offset, 50);
  const last = await c.request("workspace.list", { offset: first.next_offset });
  assert.equal(last.items.length, 5);
  assert.equal(last.next_offset, null);
  assert.equal(
    new Set([...first.items, ...last.items].map((x) => x.id)).size,
    55,
  );
});
test("crash rejects pending work and explicit restart never replays a mutation", async (t) => {
  const record = path.join(dir(), "requests.jsonl");
  const c = new CoreSupervisor({
    executable: process.execPath,
    args: [path.join(__dirname, "fixtures/fake-core.cjs"), "normal", record],
  });
  t.after(() => c.stop());
  await c.start();
  const generation = c.generation;
  const pending = assert.rejects(
    c.request("workspace.add", { path: "test-only" }),
  );
  await until(() => fs.readFileSync(record, "utf8").includes("workspace.add"));
  const previousChild = c.child;
  previousChild.kill();
  await pending;
  await until(() => c.child === null);
  assert.equal(c.state, "faulted");
  await c.start();
  assert.notEqual(c.generation, generation);
  previousChild.emit("close", 1, null);
  assert.equal(c.state, "ready");
  assert.equal((await c.request("workspace.list")).total, 0);
  const calls = fs
    .readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.filter((x) => x.method === "workspace.add").length, 1);
  await assert.rejects(c.request("shell.exec"), /不可调用/);
});
test("shutdown while handshake is pending cannot resurrect readiness", async () => {
  const c = new CoreSupervisor({
    executable: process.execPath,
    args: [path.join(__dirname, "fixtures/fake-core.cjs"), "slow"],
  });
  const starting = assert.rejects(c.start());
  await sleep(20);
  await c.stop();
  await starting;
  assert.equal(c.state, "stopped");
  assert.equal(c.child, null);
});
test("malformed child messages fail closed", async () => {
  const c = new CoreSupervisor({
    executable: process.execPath,
    args: [path.join(__dirname, "fixtures/fake-core.cjs"), "malformed"],
  });
  await assert.rejects(c.start());
  await c.stop();
  assert.equal(c.child, null);
});
test("stale generation notifications cannot reach the renderer projection", async () => {
  const c = new CoreSupervisor({
    executable: process.execPath,
    args: [path.join(__dirname, "fixtures/fake-core.cjs"), "bad-event"],
  });
  const events = [];
  c.on("chat-event", (event) => events.push(event));
  try {
    await c.start();
    await assert.rejects(c.request("workspace.list"));
    assert.equal(events.length, 0);
  } finally {
    await c.stop();
  }
});
test("parent process death closes inherited control pipe and leaves no Core writer", async (t) => {
  const d = dir();
  const parent = spawn(
    process.execPath,
    [path.join(__dirname, "fixtures/parent.cjs"), executable, d],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  t.after(() => parent.kill());
  const read = readline.createInterface({ input: parent.stdout });
  const [line] = await once(read, "line");
  const pid = JSON.parse(line).pid;
  parent.kill();
  await once(parent, "exit");
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return e.code === "ESRCH";
    }
  });
  await create(t, d);
});
