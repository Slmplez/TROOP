import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import deployment from "../src/event-deployment.cjs";

const [command, configFile, destination] = process.argv.slice(2);
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");

async function main() {
  if (command === "restore") {
    output(
      deployment.restoreBackup(
        path.resolve(configFile),
        path.resolve(destination),
      ),
    );
    return;
  }
  if (!configFile)
    throw Error(
      "用法 event-deployment.mjs preflight|run|serve|health|backup <config.json> [备份目录]",
    );
  const config = deployment.configuration(
    JSON.parse(fs.readFileSync(configFile, "utf8")),
  );
  if (command === "preflight") {
    output(
      deployment.preflight(config, {
        requirePublic: destination === "--public",
      }),
    );
    return;
  }
  if (command === "health") {
    const health = JSON.parse(fs.readFileSync(config.health_file, "utf8"));
    const age = Date.now() - Date.parse(health.checked_at);
    const ready =
      health.ready === true &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= config.health_interval_ms * 3 &&
      health.core_sha256 === config.core_sha256 &&
      health.mode === config.mode &&
      health.address === `http://${config.listen}`;
    output({
      ...health,
      ready,
      stale: !Number.isFinite(age) || age > config.health_interval_ms * 3,
    });
    if (!ready) process.exitCode = 1;
    return;
  }
  if (command === "backup") {
    if (!destination) throw Error("请指定新建的绝对备份目录。");
    output(await deployment.createBackup(config, destination));
    return;
  }
  if (!["run", "serve"].includes(command)) throw Error("未知部署命令。");
  const host = new deployment.EventDeployment(config);
  let finishing = null;
  const stop = () => {
    if (finishing) return finishing;
    finishing = host.stop().finally(() => {
      process.stdin.pause();
      process.stdin.destroy();
    });
    return finishing;
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      stop().catch(() => {
        process.exitCode = 1;
      }),
    );
  output({ type: "started", health: await host.start() });
  if (command === "serve") return;
  // Only the supervising process receives this pipe. Secrets in requests are
  // passed directly to Core and never included in deployment status output.
  const { MAX_FRAME } = createRequire(import.meta.url)(
    "../src/core-client.cjs",
  );
  let buffer = Buffer.alloc(0),
    queue = Promise.resolve();
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if (line.length > MAX_FRAME) {
        output({ error: "控制请求超过容量。" });
        void stop();
        return;
      }
      queue = queue.then(async () => {
        let id = null;
        try {
          if (finishing) throw Error("部署正在停止。");
          const request = JSON.parse(line.toString("utf8"));
          id = request.id;
          if (typeof id !== "string" && !Number.isSafeInteger(id))
            throw Error("控制请求需要字符串或整数 ID。");
          const result =
            request.method === "deployment.shutdown"
              ? await stop()
              : request.method === "deployment.restart"
                ? await host.restart()
                : await host.control(request.method, request.params ?? {});
          output({ id, result });
        } catch {
          output({ id, error: "控制请求失败，请核对方法、参数及 Core 状态。" });
        }
      });
    }
    if (buffer.length > MAX_FRAME) {
      output({ error: "控制请求超过容量。" });
      void stop();
    }
  });
  process.stdin.on("end", () => {
    void queue.then(stop);
  });
}
main().catch((error) => {
  // Syntax errors may include a fragment of the input file.
  process.stderr.write(
    error instanceof SyntaxError
      ? "部署 JSON 文件无效。\n"
      : error.message + "\n",
  );
  process.exitCode = 1;
});
