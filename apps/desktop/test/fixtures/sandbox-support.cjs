const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const runtime = path.resolve(__dirname, "../../bin/mxc/wxc-exec.exe");
const expectedDigest =
  "090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a";

function probe() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    return {
      available: false,
      reason: "BaseContainer acceptance requires Windows x64",
      runtime_present: false,
    };
  }
  if (!fs.existsSync(runtime)) {
    return {
      available: false,
      reason: "Run prepare-sandbox.mjs to install the fixed MXC runtime",
      runtime_present: false,
    };
  }
  const sha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(runtime))
    .digest("hex");
  if (sha256 !== expectedDigest)
    throw new Error(
      "MXC capability probe rejected an unexpected runtime digest",
    );
  const result = spawnSync(runtime, ["--probe"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
  });
  if (result.error) throw result.error;
  const capabilities = JSON.parse(result.stdout);
  if (typeof capabilities.tier !== "string")
    throw new Error("MXC capability probe has no tier");
  const available =
    result.status === 0 && capabilities.tier === "base-container";
  return {
    available,
    runtime_present: true,
    sha256,
    exit_code: result.status,
    capabilities,
    reason: available
      ? null
      : `Host MXC probe reports tier ${capabilities.tier}, exit ${result.status}; verified BaseContainer is required`,
  };
}

const support = probe();
const baseContainerSkip = support.reason || false;
function sandboxTest(name, options, callback) {
  if (typeof options === "function") {
    return test(name, { skip: baseContainerSkip }, options);
  }
  return test(
    name,
    { ...options, skip: options.skip || baseContainerSkip },
    callback,
  );
}
// These text-mode adapters also require whole-process MXC containment.
function cliTest(engine, name, callback) {
  if (engine === "claude" || engine === "opencode") {
    return sandboxTest(name, callback);
  }
  return test(name, callback);
}
module.exports = { support, baseContainerSkip, sandboxTest, cliTest };
