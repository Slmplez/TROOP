const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test(
  "Windows private runtime ACL hardening remains idempotent after rename and chmod",
  { skip: process.platform !== "win32" },
  async () => {
    const parent = path.resolve(__dirname, "../../../.tmp-troop-followups");
    fs.mkdirSync(parent, { recursive: true });
    const folder = fs.mkdtempSync(path.join(parent, "private-acl-"));
    const moduleFile = path.join(folder, "private-path.cjs");
    require("esbuild").buildSync({
      entryPoints: [
        path.resolve(
          __dirname,
          "../../../source/shared/node/windows-private-path.ts",
        ),
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: moduleFile,
    });
    const { hardenWindowsPrivatePath, windowsPowerShellEnvironment } = require(
      moduleFile,
    );
    const temporary = path.join(folder, "runtime.tmp");
    const target = path.join(folder, "runtime.cjs");
    fs.writeFileSync(temporary, "owned-runtime", { mode: 0o600 });
    const owner = (file) => {
      const read = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-Acl -LiteralPath $env:TROOP_ACL_TARGET).Owner",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: windowsPowerShellEnvironment({
            ...process.env,
            TROOP_ACL_TARGET: file,
          }),
        },
      );
      assert.equal(read.status, 0, read.stderr);
      return read.stdout.trim();
    };
    const originalOwner = owner(temporary);
    const first = await hardenWindowsPrivatePath(temporary);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    const second = await hardenWindowsPrivatePath(target);
    assert.deepEqual(second.principals, first.principals);
    assert.equal(second.inherited, false);
    assert.equal(second.accessRuleCount, 3);
    assert.equal(owner(target), originalOwner);
    assert.equal(fs.readFileSync(target, "utf8"), "owned-runtime");
    const directory = path.join(folder, "private-directory");
    fs.mkdirSync(directory);
    const directoryOwner = owner(directory);
    const directoryFirst = await hardenWindowsPrivatePath(directory);
    const directorySecond = await hardenWindowsPrivatePath(directory);
    assert.deepEqual(directorySecond.principals, directoryFirst.principals);
    assert.equal(directorySecond.inherited, false);
    assert.equal(directorySecond.accessRuleCount, 3);
    assert.equal(owner(directory), directoryOwner);
  },
);
