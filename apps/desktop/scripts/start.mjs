import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = spawnSync(
  process.execPath,
  [path.join(app, "scripts/build.mjs")],
  { stdio: "inherit", windowsHide: true },
);
if (built.status !== 0) process.exit(built.status ?? 1);
const require = createRequire(path.join(app, "package.json"));
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [app, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  windowsHide: false,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
