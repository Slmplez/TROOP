const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { CoreSupervisor } = require("../../src/core-client.cjs"),
  { coreBinary } = require("../../src/core-path.cjs");
const { agentServer, sleep } = require("./agent-server.cjs");
const temp = path.resolve(__dirname, "../../../../.tmp-troop-hooks/tests");
fs.mkdirSync(temp, { recursive: true });
const results = (body) =>
  (body.messages ?? body.input).flatMap((m) =>
    m.role === "tool"
      ? [JSON.parse(m.content)]
      : m.type === "function_call_output"
        ? [JSON.parse(m.output)]
        : Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === "tool_result")
              .map((b) => JSON.parse(b.content))
          : [],
  );
const user = (body) =>
  (body.messages ?? body.input).find(
    (m) => m.role === "user" && typeof m.content === "string",
  )?.content ?? "";
const hook = (body) => user(body).startsWith("<<TROOP_HOOK>>");
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const emit = (v) => quote(JSON.stringify(v));
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  throw Error("Hook condition timed out");
}
async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(temp, "case-")),
    workspace = path.join(directory, "workspace"),
    data = path.join(directory, "data");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "input.txt"), "owned input");
  const server = await agentServer({ plan: () => [], ...options });
  const core = new CoreSupervisor({
    executable:
      options.executable ?? path.resolve(__dirname, "../../bin", coreBinary),
    args: ["--data-dir", data, ...(options.coreArgs ?? [])],
    timeout: 10000,
  });
  await core.start();
  t.after(async () => {
    await core.stop();
    await server.close();
    require("./events-credentials.cjs").cleanupEventCredentials([data]);
  });
  await core.request("memory.agent.save", {
    id: 1,
    name: "Owned Hooks Agent",
    automatic: false,
    dreaming: false,
    expected_revision: 1,
  });
  const wid = (await core.request("workspace.add", { path: workspace }))
    .items[0].id;
  const provider = await core.request("provider.save", {
    config: {
      name: "Owned Hook fixture",
      protocol: options.protocol ?? "anthropic",
      base_url: server.origin,
      model: "owned-hook-model",
      max_output_tokens: 4096,
      idle_timeout_secs: 5,
    },
  });
  const start = async (extra = {}) =>
    (
      await core.request("agent.start", {
        client_run_id: crypto.randomUUID(),
        workspace_id: wid,
        provider_id: provider.id,
        goal: "Owned Hook task",
        ...extra,
      })
    ).run.id;
  const get = (id) => core.request("agent.get", { id });
  const done = (id) =>
    until(async () => {
      const d = await get(id);
      return (
        ["completed", "failed", "cancelled", "interrupted"].includes(
          d.run.state,
        ) && d
      );
    });
  const call = async (id, n = 0) =>
    core.request("agent.invocation", { id: (await get(id)).invocations[n].id });
  const save = (extra = {}) => {
    const input = {
      name: "Owned Hook",
      event: "preToolUse",
      kind: "command",
      location: "windows-host",
      enabled: true,
      command: emit({}),
      prompt: "",
      matcher: "",
      timeout: 3,
      loop_limit: null,
      failClosed: false,
      ...extra,
    };
    delete input.supported;
    delete input.revision;
    return core.request("hooks.save", input);
  };
  const calls = (id) => core.request("hooks.calls", { run_id: id });
  const approval = (id) =>
    until(async () => {
      const s = await get(id);
      if (!s.run.waiting.includes("approval")) return false;
      const inv = s.invocations.find(
        (i) => i.state === "prepared" && i.approval === null,
      );
      return inv && core.request("agent.invocation", { id: inv.id });
    });
  const approve = (i, approved = true) =>
    core.request("agent.approve", { id: i.id, epoch: i.epoch, approved });
  return {
    directory,
    workspace,
    data,
    wid,
    provider,
    core,
    server,
    start,
    get,
    done,
    call,
    save,
    calls,
    approval,
    approve,
  };
}
module.exports = { setup, until, results, user, hook, quote, emit, sleep };
