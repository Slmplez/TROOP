// Fixed Microsoft runtime. No npm lifecycle scripts or global installation.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("当前固定 MXC 运行时需要 Windows x64。");
}
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(app, "bin/mxc");
const digest =
  "090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a";
const integrity =
  "2cP925G5+lQyKzjBVha8uNtVd7XESgDBtgi1yCYYSo9M3xiFyZWtCO4SWPGTk509rdI6nqjyGcZxvEP3t6l8Hg==";
const url = "https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-1.0.1.tgz";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "troop-mxc-"));
try {
  const cached = process.argv.indexOf("--archive");
  let archive;
  if (cached >= 0) {
    if (!process.argv[cached + 1])
      throw new Error("--archive 需要已下载的发行包路径。");
    archive = fs.readFileSync(path.resolve(process.argv[cached + 1]));
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`下载 MXC 失败 (${response.status})。`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (
    crypto.createHash("sha512").update(archive).digest("base64") !== integrity
  ) {
    throw new Error("MXC 发行包摘要不匹配。");
  }
  const file = path.join(temp, "sdk.tgz");
  fs.writeFileSync(file, archive);
  const extracted = spawnSync(
    "tar",
    [
      "-xzf",
      file,
      "-C",
      temp,
      "package/bin/x64/wxc-exec.exe",
      "package/LICENSE.md",
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  if (extracted.status !== 0) throw new Error("无法解包 MXC 固定发行包。");
  const binary = fs.readFileSync(
    path.join(temp, "package/bin/x64/wxc-exec.exe"),
  );
  if (crypto.createHash("sha256").update(binary).digest("hex") !== digest) {
    throw new Error("MXC 原生程序摘要不匹配。");
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "wxc-exec.exe"), binary);
  fs.copyFileSync(
    path.join(temp, "package/LICENSE.md"),
    path.join(destination, "LICENSE.md"),
  );
  fs.writeFileSync(
    path.join(destination, "source.json"),
    JSON.stringify(
      {
        name: "@microsoft/mxc-sdk",
        version: "1.0.1",
        url,
        sha512: integrity,
        program_sha256: digest,
      },
      null,
      2,
    ),
  );
  console.log(
    "MXC 1.0.1 固定运行时已准备。每次执行使用 1.0.0 稳定请求，遥测及 ACL 回退关闭。",
  );
} finally {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (
    !path.resolve(temp).startsWith(tempRoot) ||
    !path.basename(temp).startsWith("troop-mxc-")
  ) {
    throw new Error("临时清理目录超出本次准备任务范围。");
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
