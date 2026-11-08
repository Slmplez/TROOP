const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const [mode, directory] = process.argv.slice(2);
let toolCalls = 0;
if (mode.startsWith("admitted")) {
  fs.appendFileSync(path.join(directory, "initializations"), "start\n");
}
if (mode === "tree" || mode === "tree-delayed") {
  spawn(
    process.execPath,
    [
      "-e",
      `setTimeout(()=>setInterval(()=>require('node:fs').appendFileSync(process.argv[1],'x'),40),${mode === "tree-delayed" ? 2200 : 0})`,
      path.join(directory, "heartbeat"),
    ],
    { windowsHide: true, stdio: "ignore" },
  );
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const q = JSON.parse(line);
  if (q.id == null || !q.method) return;
  let result = {};
  if (q.method === "initialize")
    result = {
      protocolVersion:
        mode === "admitted-init-error" ? "2099-01-01" : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    };
  if (q.method === "tools/list")
    result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  if (q.method === "tools/call") {
    if (mode === "admitted")
      fs.appendFileSync(
        path.join(directory, "invocations"),
        JSON.stringify(q.params) + "\n",
      );
    if (mode === "tree" || mode === "tree-delayed") return;
    if (mode === "flood") {
      process.stdout.write("x".repeat(65537));
      return;
    }
    if (mode === "env")
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              cwd: process.cwd(),
              override: process.env.MCP_TEST_VALUE,
              secret: process.env.TROOP_PRIVATE_TEST_SECRET ?? null,
            }),
          },
        ],
      };
    else
      result = {
        content: [
          {
            type: "text",
            text:
              mode === "stateful"
                ? `${++toolCalls}:${q.params.arguments.text}`
                : q.params.arguments.text,
          },
        ],
      };
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      }) + "\n",
    );
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: q.id, result }) + "\n",
  );
});
