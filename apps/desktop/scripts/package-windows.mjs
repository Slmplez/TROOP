import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const app = path.resolve(path.dirname(script), "..");
const root = path.resolve(app, "../..");
const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const { coreBinary } = require("../src/core-path.cjs");
const manifestName = "troop-portable.json";
const sandboxDigest =
  "090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a";
const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function inventory(directory, relative = "") {
  return fs
    .readdirSync(path.join(directory, relative), { withFileTypes: true })
    .flatMap((entry) => {
      assert.ok(!entry.isSymbolicLink(), "Package rejects symbolic links");
      const name = path.posix.join(relative, entry.name);
      if (name === manifestName) return [];
      if (entry.isDirectory()) return inventory(directory, name);
      assert.ok(
        entry.isFile(),
        "Package contains an unsupported filesystem entry",
      );
      return [
        {
          path: name,
          bytes: fs.statSync(path.join(directory, name)).size,
          sha256: sha256(path.join(directory, name)),
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function verifyPortable(directory) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, manifestName), "utf8"),
  );
  assert.equal(manifest.kind, "troop-rust-electron-windows-portable");
  assert.equal(manifest.version, version);
  assert.deepEqual(inventory(directory), manifest.files);
  for (const required of [
    "TROOP.exe",
    `resources/bin/${coreBinary}`,
    "resources/app/package.json",
    "resources/app/src/entry.cjs",
    "resources/app/dist/index.html",
    "resources/app/dist/renderer.js",
    "resources/app/contracts/execution.cjs",
    "resources/bin/mxc/LICENSE.md",
  ]) {
    assert.ok(
      manifest.files.some((entry) => entry.path === required),
      `Missing ${required}`,
    );
  }
  assert.equal(
    sha256(path.join(directory, "resources/bin/mxc/wxc-exec.exe")),
    sandboxDigest,
  );
  assert.equal(
    fs.existsSync(path.join(directory, "resources/default_app.asar")),
    false,
  );
  return manifest;
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) throw Error(`Package command failed: ${program}`);
}

function buildPortable() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  run(process.execPath, [path.join(app, "scripts/build.mjs")]);
  run("cargo", [
    "build",
    "--release",
    "--offline",
    "--locked",
    "-p",
    "troop-core",
  ]);
  const sandbox = path.join(app, "bin/mxc/wxc-exec.exe");
  if (!fs.existsSync(sandbox))
    run(process.execPath, [path.join(app, "scripts/prepare-sandbox.mjs")]);
  assert.equal(sha256(sandbox), sandboxDigest);
  const parent = path.join(root, ".build/troop-desktop");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(parent, `TROOP-${version}-win32-x64-`),
  );
  const electron = path.dirname(require("electron"));
  fs.cpSync(electron, directory, { recursive: true });
  fs.renameSync(
    path.join(directory, "electron.exe"),
    path.join(directory, "TROOP.exe"),
  );
  fs.unlinkSync(path.join(directory, "resources/default_app.asar"));
  const packagedApp = path.join(directory, "resources/app");
  fs.mkdirSync(packagedApp, { recursive: true });
  for (const name of ["src", "dist", "contracts"])
    fs.cpSync(path.join(app, name), path.join(packagedApp, name), {
      recursive: true,
    });
  fs.writeFileSync(
    path.join(packagedApp, "package.json"),
    JSON.stringify(
      {
        name: "troop-desktop",
        productName: "TROOP",
        version,
        main: "src/entry.cjs",
        private: true,
      },
      null,
      2,
    ),
  );
  const binaries = path.join(directory, "resources/bin");
  fs.mkdirSync(binaries, { recursive: true });
  fs.copyFileSync(
    path.join(root, "target/release/troop-core.exe"),
    path.join(binaries, coreBinary),
  );
  fs.cpSync(path.join(app, "bin/mxc"), path.join(binaries, "mxc"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(directory, "README.txt"),
    "TROOP Windows x64 portable\r\nRun TROOP.exe. No external Node or Rust installation is needed.\r\nData defaults to %APPDATA%\\TROOP. Use --user-data-dir=<absolute path> for an isolated profile.\r\nExit TROOP explicitly before replacing the package directory. Keep the same profile when upgrading.\r\nCLI engines and model credentials are configured separately. Windows credential references remain tied to the Windows account.\r\n",
  );
  const manifest = {
    kind: "troop-rust-electron-windows-portable",
    version,
    electron_version: require("electron/package.json").version,
    platform: "win32",
    arch: "x64",
    signed: false,
    core_sha256: sha256(path.join(binaries, coreBinary)),
    files: inventory(directory),
  };
  fs.writeFileSync(
    path.join(directory, manifestName),
    JSON.stringify(manifest, null, 2),
  );
  verifyPortable(directory);
  const zip = directory + ".zip";
  run(
    "pwsh.exe",
    [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:TROOP_PACKAGE_INPUT,$env:TROOP_PACKAGE_ZIP)",
    ],
    {
      env: {
        ...process.env,
        TROOP_PACKAGE_INPUT: directory,
        TROOP_PACKAGE_ZIP: zip,
      },
    },
  );
  const evidence = path.join(root, "verification/cli-followups-2026-11-09");
  fs.mkdirSync(evidence, { recursive: true });
  const report = {
    passed: true,
    directory,
    zip,
    bytes: fs.statSync(zip).size,
    sha256: sha256(zip),
    core_sha256: manifest.core_sha256,
    version,
  };
  fs.writeFileSync(
    path.join(evidence, "portable-build.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}

if (path.resolve(process.argv[1] ?? "") === script) buildPortable();
