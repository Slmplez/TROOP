const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { until } = require("./hooks-fixture.cjs");

// The previous Core deliberately has fewer capabilities than today's client.
// This fixture speaks its original JSON-RPC protocol without a modern handshake.
async function seedPreviousCore(executable, directory, origin) {
  const child = spawn(executable, ["--data-dir", directory], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let generation,
    sequence = 0,
    provider;
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    clearTimeout(waiter.timer);
    response.error
      ? waiter.reject(Error(`${waiter.method}: ${response.error.message}`))
      : waiter.resolve(response.result);
  });
  async function request(method, params = {}) {
    const id = String(++sequence);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`Previous Core timed out at ${method}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
          ...(generation ? { generation } : {}),
        }) + "\n",
      );
    });
    generation = result.generation;
    return result.value;
  }
  try {
    const hello = await request("system.hello", {
      protocol: 10,
      client: "troop-desktop",
    });
    assert.notEqual(hello.core_version, require("../../package.json").version);
    const workspace = path.join(path.dirname(directory), "legacy-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const wid = (await request("workspace.add", { path: workspace })).items[0]
      .id;
    provider = await request("provider.save", {
      config: {
        name: "Retained previous provider",
        protocol: "chat_completions",
        base_url: origin + "/normal",
        model: "owned-upgrade-model",
        max_output_tokens: 1024,
        idle_timeout_secs: 5,
      },
      api_key: "TROOP_PREVIOUS_PROFILE_SYNTHETIC_KEY",
    });
    const conversation = await request("chat.create", {
      title: "Retained previous conversation",
      workspace_id: wid,
    });
    await request("chat.send", {
      conversation_id: conversation.id,
      provider_id: provider.id,
      client_turn_id: crypto.randomUUID(),
      text: "TROOP_PREVIOUS_PROFILE_MESSAGE",
    });
    const messages = await until(async () => {
      const value = await request("chat.messages", {
        conversation_id: conversation.id,
      });
      return (
        value.items.some(
          (message) =>
            message.role === "assistant" && message.status === "completed",
        ) && value.items
      );
    });
    return {
      version: hello.core_version,
      sha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(executable))
        .digest("hex"),
      provider,
      conversation_id: conversation.id,
      workspace_id: wid,
      messages,
    };
  } catch (error) {
    if (provider) await request("provider.remove", { id: provider.id });
    throw error;
  } finally {
    child.stdin.end();
    assert.equal(await exited, 0);
    lines.close();
  }
}
module.exports = { seedPreviousCore };
