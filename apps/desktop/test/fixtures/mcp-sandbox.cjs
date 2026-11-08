// Controlled native MCP peer for filesystem/network containment acceptance.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const [mode, workspace, readonly, outside, origin, argument] =
  process.argv.slice(2);
fs.appendFileSync(path.join(workspace, "initializations"), "start\n");
const audit = {
  readonly: fs.readFileSync(path.join(readonly, "input.txt"), "utf8"),
};
for (const [name, file] of [
  ["outside_write", outside],
  ["readonly_write", path.join(readonly, "bad.txt")],
]) {
  try {
    fs.writeFileSync(file, "bad");
    audit[name] = true;
  } catch {
    audit[name] = false;
  }
}
try {
  fs.readFileSync(outside);
  audit.outside_read = true;
} catch {
  audit.outside_read = false;
}
const ready = new Promise((resolve) => {
  let finished = false;
  const done = (value) => {
    if (finished) return;
    finished = true;
    audit.network = value;
    fs.writeFileSync(path.join(workspace, "audit.json"), JSON.stringify(audit));
    resolve();
  };
  const request = http.get(origin, (response) => {
    response.resume();
    response.on("end", () => done(true));
  });
  request.on("error", () => done(false));
  request.setTimeout(2000, () => {
    request.destroy();
    done(false);
  });
});
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  await ready;
  let result = {};
  if (request.method === "initialize")
    result = {
      protocolVersion: mode === "init-error" ? "2099-01-01" : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "contained-peer", version: "1" },
    };
  if (request.method === "tools/list")
    result = {
      tools: [
        {
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ],
    };
  if (request.method === "tools/call") {
    fs.appendFileSync(
      path.join(workspace, "calls"),
      JSON.stringify(request.params) + "\n",
    );
    if (mode === "hang") {
      const script = `const fs=require('node:fs'),path=require('node:path');let outside_write=false;try{fs.writeFileSync(process.argv[2],'bad child');outside_write=true;}catch{}fs.writeFileSync(path.join(process.argv[1],'child-boundary.json'),JSON.stringify({outside_write}));setInterval(()=>fs.appendFileSync(path.join(process.argv[1],'heartbeat'),'x'),50);`;
      spawn(process.execPath, ["-e", script, workspace, outside], {
        windowsHide: true,
        stdio: "ignore",
      });
      setTimeout(
        () => fs.writeFileSync(path.join(workspace, "late.txt"), "bad"),
        10000,
      );
      return;
    }
    result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            audit,
            argument,
            env_sha256: crypto
              .createHash("sha256")
              .update(process.env.TROOP_SDK_TEST_ENV ?? "")
              .digest("hex"),
            secret_in_arguments: process.argv.some((value) =>
              value.includes(process.env.TROOP_SDK_TEST_ENV || "NEVER_MATCH"),
            ),
          }),
        },
      ],
    };
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
});
