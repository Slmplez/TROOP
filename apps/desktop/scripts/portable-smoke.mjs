import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyPortable } from "./package-windows.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const require = createRequire(import.meta.url);
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const { until } = require("../test/fixtures/hooks-fixture.cjs");
const evidence = path.join(root, "verification/cli-followups-2026-11-09");
const built = JSON.parse(
  fs.readFileSync(path.join(evidence, "portable-build.json"), "utf8"),
);
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "troop-portable-"));
const installed = path.join(folder, "installed");
fs.mkdirSync(installed);
const extracted = spawnSync(
  "pwsh.exe",
  [
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:TROOP_ZIP,$env:TROOP_INSTALL)",
  ],
  {
    windowsHide: true,
    env: { ...process.env, TROOP_ZIP: built.zip, TROOP_INSTALL: installed },
  },
);
assert.equal(extracted.status, 0);
verifyPortable(installed);
const report = {
  passed: false,
  directory: installed,
  checks: [],
  core_pids: [],
};
let child, exit, socket;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function start(profile) {
  const env = {
    ...process.env,
    PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  let stderr = "";
  child = spawn(
    path.join(installed, "TROOP.exe"),
    [
      "--user-data-dir=" + profile,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--disable-gpu",
    ],
    {
      cwd: installed,
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-4000);
  });
  exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  const portFile = path.join(profile, "DevToolsActivePort");
  const page = await until(async () => {
    report.phase = "waiting_renderer";
    if (child.exitCode !== null)
      throw Error(`Portable exited ${child.exitCode}: ${stderr}`);
    if (!fs.existsSync(portFile)) return false;
    try {
      const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
      const pages = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      report.pages = pages.map(({ type, url }) => ({ type, url }));
      return pages.find(
        (value) =>
          value.type === "page" && value.url.endsWith("/dist/index.html"),
      );
    } catch {
      return false;
    }
  }, 60000);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let next = 0;
  socket.addEventListener("message", ({ data }) => {
    const result = JSON.parse(data);
    const waiter = pending.get(result.id);
    if (waiter) {
      pending.delete(result.id);
      clearTimeout(waiter.timer);
      result.error
        ? waiter.reject(Error(result.error.message))
        : waiter.resolve(result.result);
    }
  });
  const evaluate = async (expression) => {
    const id = ++next;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("Portable renderer request timed out"));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    const value = result.result.value;
    if (value?.ok === false) throw Error(value.error?.message ?? value.error);
    return value?.ok === true ? value.value : value;
  };
  const status = await until(async () => {
    report.phase = "waiting_core";
    const value = await evaluate("window.troop?.status()");
    report.last_status = value && {
      state: value.state,
      version: value.version,
      error: value.error,
    };
    if (value?.state === "faulted") throw Error(value.error);
    return value?.state === "ready" && value;
  }, 30000);
  report.core_pids.push(status.pid);
  assert.equal(await evaluate("typeof require"), "undefined");
  assert.equal(await evaluate("typeof process"), "undefined");
  return { evaluate, status };
}

async function quit(evaluate, pid) {
  await evaluate("window.troop.quit()");
  assert.equal(await exit, 0);
  socket.close();
  await until(() => !alive(pid), 10000);
}

try {
  const fresh = path.join(folder, "fresh-profile");
  let running = await start(fresh);
  const identity = running.status.storage_instance;
  assert.equal(
    (await running.evaluate("window.troop.listWorkspaces()")).items.length,
    0,
  );
  await quit(running.evaluate, running.status.pid);
  running = await start(fresh);
  assert.equal(running.status.storage_instance, identity);
  await quit(running.evaluate, running.status.pid);
  report.checks.push(
    "ZIP starts and explicitly exits outside the repository with Node and Rust absent from PATH; renderer bridge remains isolated and profile identity survives restart",
  );

  const profile = path.join(folder, "upgrade-profile");
  const workspace = path.join(folder, "workspace");
  fs.mkdirSync(workspace);
  const seed = new CoreSupervisor({
    executable: path.join(installed, "resources/bin", coreBinary),
    args: ["--data-dir", path.join(profile, "core")],
  });
  let work;
  try {
    await seed.start();
    const wid = (await seed.request("workspace.add", { path: workspace }))
      .items[0].id;
    const receipt = await seed.request("operations.execute", {
      operation_id: crypto.randomUUID(),
      instance_id: seed.snapshot().storage_instance,
      method: "work_items.save",
      input: {
        expected_revision: 0,
        item: {
          title: "Portable upgrade retained work",
          goal: "Keep the previous work definition",
          acceptance: "Fixed text retained",
          owner_agent_id: 1,
          workspace_id: wid,
        },
      },
    });
    assert.equal(receipt.state, "committed");
    work = receipt.result;
  } finally {
    await seed.stop();
  }
  const database = path.join(profile, "core/troop.sqlite3");
  const previous = new DatabaseSync(database);
  previous.exec(
    "DROP TABLE followup_appointments; DROP TABLE followup_chains; DROP TABLE followup_states; PRAGMA user_version=29",
  );
  previous.close();
  running = await start(profile);
  const retained = await running.evaluate(
    `window.troop.resourceworkItem({id:${work.id}})`,
  );
  assert.equal(retained.title, work.title);
  assert.equal(retained.goal, work.goal);
  await quit(running.evaluate, running.status.pid);
  const upgraded = new DatabaseSync(database, { readOnly: true });
  assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 30);
  upgraded.close();
  report.checks.push(
    "Production entry migrates a schema-29 fixture to schema 30 while retaining its work item and workspace; application quit leaves no Core process",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  socket?.close();
  if (child && child.exitCode === null) {
    spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-Command",
        `[Diagnostics.Process]::GetProcessById(${child.pid}).Kill($true)`,
      ],
      { windowsHide: true },
    );
    await exit;
  }
  report.processes_stopped = report.core_pids.every((pid) => !alive(pid));
  if (!report.processes_stopped) {
    report.passed = false;
    process.exitCode = 1;
  }
  fs.writeFileSync(
    path.join(evidence, "portable-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
