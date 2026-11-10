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
import { readPortableStatus } from "./portable-status.mjs";

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
let child, exit, socket, legacy, upstream;

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
    if (child.exitCode !== null)
      throw Error(`Portable exited ${child.exitCode}: ${stderr}`);
    const value = await readPortableStatus(evaluate);
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
  try {
    await evaluate("window.troop.quit()");
  } catch (error) {
    if (!error.message.includes("Execution context was destroyed")) throw error;
  }
  await until(() => child.exitCode !== null, 20000);
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
  if (process.env.TROOP_PREVIOUS_CORE) {
    upstream = await require("../test/fixtures/model-server.cjs").modelServer();
    const profile = path.join(folder, "previous-profile");
    const data = path.join(profile, "core");
    const previous =
      await require("../test/fixtures/previous-core.cjs").seedPreviousCore(
        path.resolve(process.env.TROOP_PREVIOUS_CORE),
        data,
        upstream.origin,
      );
    legacy = { data, provider_id: previous.provider.id };
    const before = new DatabaseSync(path.join(data, "troop.sqlite3"), {
      readOnly: true,
    });
    const schema = before.prepare("PRAGMA user_version").get().user_version;
    before.close();
    const auxiliary = path.join(profile, "retained-attachment.txt");
    fs.writeFileSync(auxiliary, "TROOP_PREVIOUS_AUXILIARY_FILE");
    running = await start(profile);
    assert.ok(
      (await running.evaluate("window.troop.listWorkspaces()")).items.some(
        (item) => item.id === previous.workspace_id,
      ),
    );
    const providers = await running.evaluate("window.troop.listProviders()");
    const retained = providers.find((item) => item.id === previous.provider.id);
    assert.ok(retained);
    for (const key of ["name", "model", "base_url", "protocol"])
      assert.deepEqual(
        (retained.config ?? retained)[key],
        (previous.provider.config ?? previous.provider)[key],
      );
    const messages = await running.evaluate(
      `window.troop.listMessages(${previous.conversation_id})`,
    );
    const text = (items) =>
      items.map(({ id, role, content, text, status }) => ({
        id,
        role,
        text: content ?? text,
        status,
      }));
    assert.deepEqual(text(messages.items), text(previous.messages));
    const sent = await running.evaluate(
      `window.troop.sendMessage(${JSON.stringify({ conversation_id: previous.conversation_id, provider_id: previous.provider.id, client_turn_id: crypto.randomUUID(), text: "TROOP_AFTER_UPGRADE_MESSAGE" })})`,
    );
    await until(async () =>
      (
        await running.evaluate(
          `window.troop.listMessages(${previous.conversation_id})`,
        )
      ).items.some(
        (message) =>
          message.turn_id === sent.turn_id &&
          message.role === "assistant" &&
          message.status === "completed",
      ),
    );
    assert.equal(
      upstream.requests.at(-1).headers.authorization,
      "Bearer TROOP_PREVIOUS_PROFILE_SYNTHETIC_KEY",
    );
    assert.equal(
      fs.readFileSync(auxiliary, "utf8"),
      "TROOP_PREVIOUS_AUXILIARY_FILE",
    );
    await quit(running.evaluate, running.status.pid);
    report.previous_upgrade = {
      version: previous.version,
      sha256: previous.sha256,
      schema_before: schema,
      schema_after: 30,
      retained_messages: previous.messages.length,
      retained_credentials_used: true,
    };
    report.checks.push(
      "An actual previous Core creates workspace, provider, credential and conversation messages; production upgrade preserves them and uses the original credential for a new loopback model response, retaining an auxiliary profile file",
    );
  }
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
  if (legacy) {
    const cleaner = new CoreSupervisor({
      executable: path.join(installed, "resources/bin", coreBinary),
      args: ["--data-dir", legacy.data],
    });
    try {
      await cleaner.start();
      await cleaner.request("provider.remove", { id: legacy.provider_id });
      report.previous_credential_removed = true;
    } catch (error) {
      report.passed = false;
      report.error ??= error.message;
      process.exitCode = 1;
    } finally {
      await cleaner.stop();
    }
  }
  await upstream?.close();
  report.processes_stopped = report.core_pids.every((pid) => !alive(pid));
  if (!report.processes_stopped) {
    report.passed = false;
    process.exitCode = 1;
  }
  if (report.passed && report.processes_stopped) {
    const owned = fs.realpathSync(folder);
    assert.equal(path.dirname(owned), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(owned).startsWith("troop-portable-"));
    fs.rmSync(owned, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    report.temporary_directory_removed = true;
  }
  fs.writeFileSync(
    path.join(evidence, "portable-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
