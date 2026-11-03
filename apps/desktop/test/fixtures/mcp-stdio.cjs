const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const [mode, directory] = process.argv.slice(2);
if (mode === "tree") {
  spawn(
    process.execPath,
    [
      "-e",
      `setInterval(()=>require('node:fs').appendFileSync(process.argv[1],'x'),40)`,
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
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    };
  if (q.method === "tools/list")
    result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  if (q.method === "tools/call") {
    if (mode === "tree") return;
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
      result = { content: [{ type: "text", text: q.params.arguments.text }] };
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
