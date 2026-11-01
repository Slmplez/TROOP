import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(app, "../..");
const result = spawnSync(
  "cargo",
  [
    "build",
    "--offline",
    "--locked",
    "-p",
    "troop-core",
    "--target-dir",
    path.join(root, "target"),
  ],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
if (result.status !== 0) process.exit(result.status ?? 1);
fs.mkdirSync(path.join(app, "bin"), { recursive: true });
const binary = process.platform === "win32" ? "troop-core.exe" : "troop-core";
const source = path.join(root, "target/debug", binary);
const destination = path.join(app, "bin", binary);
if (
  !fs.existsSync(destination) ||
  !fs.readFileSync(source).equals(fs.readFileSync(destination))
) {
  try {
    fs.copyFileSync(source, destination);
  } catch (error) {
    throw new Error("无法更新 Core 文件。请先从托盘退出 TROOP，再重新构建。", {
      cause: error,
    });
  }
}
fs.mkdirSync(path.join(app, "dist"), { recursive: true });
await build({
  entryPoints: [path.join(app, "renderer/main.jsx")],
  bundle: true,
  outfile: path.join(app, "dist/renderer.js"),
  platform: "browser",
  target: "chrome148",
  minify: true,
  loader: { ".ttf": "file" },
  assetNames: "assets/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
});
fs.copyFileSync(
  path.join(app, "renderer/index.html"),
  path.join(app, "dist/index.html"),
);
console.log("TROOP Core and desktop built from independent source.");
