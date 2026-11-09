import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDirectory = path.resolve(app, "../../verification/desktop-ci");
fs.mkdirSync(reportDirectory, { recursive: true });
const tests = fs
  .readdirSync(path.join(app, "test"))
  .filter((name) => name.endsWith(".test.cjs"))
  .sort()
  .map((name) => path.join(app, "test", name));
if (tests.length === 0)
  throw new Error("No desktop regression files were found");
fs.writeFileSync(
  path.join(reportDirectory, "environment.json"),
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      os_release: os.release(),
      test_files: tests.length,
      commit: process.env.GITHUB_SHA ?? null,
    },
    null,
    2,
  ),
);
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=${path.join(reportDirectory, "desktop.junit.xml")}`,
    "--test-reporter=./scripts/ci-skips.mjs",
    `--test-reporter-destination=${path.join(reportDirectory, "skips.jsonl")}`,
    ...tests,
  ],
  { cwd: app, stdio: "inherit", windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
