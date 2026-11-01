const fs = require("node:fs");
const readline = require("node:readline");
const generation = `fake-${process.pid}-${Date.now()}`;
const mode = process.argv[2];
const record = process.argv[3];
const send = (r, value) =>
  console.log(
    JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { generation, value } }),
  );
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (record)
    fs.appendFileSync(
      record,
      JSON.stringify({ pid: process.pid, method: r.method }) + "\n",
    );
  if (mode === "malformed") {
    console.log("not-json");
    return;
  }
  if (r.method === "system.hello") {
    setTimeout(
      () =>
        send(r, {
          protocol: 3,
          core_version: "test",
          capabilities: [...require("../../src/core-client.cjs").ALLOWED],
        }),
      mode === "slow" ? 300 : 0,
    );
  } else if (mode === "bad-event" && r.method === "workspace.list") {
    console.log(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "chat.changed",
        params: {
          generation: "stale",
          seq: 1,
          conversation_id: 1,
          turn_id: 1,
          status: "completed",
        },
      }),
    );
  } else if (r.method === "workspace.add") {
  } // Deliberately leave an accepted request pending.
  else if (r.method === "system.shutdown") {
    send(r, { stopped: true });
    process.exit(0);
  } else send(r, { items: [], total: 0, next_offset: null });
});
process.stdin.on("end", () => process.exit(0));
