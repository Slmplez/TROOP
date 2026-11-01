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
          protocol: 1,
          core_version: "test",
          capabilities: [
            "system.ping",
            "workspace.list",
            "workspace.add",
            "workspace.rename",
            "workspace.remove",
          ],
        }),
      mode === "slow" ? 300 : 0,
    );
  } else if (r.method === "workspace.add") {
  } // Deliberately leave an accepted request pending.
  else if (r.method === "system.shutdown") {
    send(r, { stopped: true });
    process.exit(0);
  } else send(r, { items: [], total: 0, next_offset: null });
});
process.stdin.on("end", () => process.exit(0));
