const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  { pathToFileURL } = require("node:url");
test("Windows smoke builds its fixture without persistent compiler servers", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../scripts/smoke-windows.mjs"),
    "utf8",
  );
  const start = source.indexOf("async function buildStrictFakeDocker(");
  const end = source.indexOf(
    "async function assertFakeDockerContainerState(",
    start,
  );
  assert.ok(start >= 0 && end > start);
  assert.match(
    source.slice(start, end),
    /execFileAsync\("dotnet", \[[\s\S]*"--disable-build-servers"/,
  );
});
test("Windows bootstrap uses the documented checksum-pinned carrier release", async () => {
  const root = path.resolve(__dirname, "../../..");
  const config = await import(
    pathToFileURL(path.join(root, "scripts/lib/config.mjs")).href
  );
  assert.ok(
    fs
      .readFileSync(path.join(root, "README.md"), "utf8")
      .includes(config.windowsInstallerUrl),
  );
  assert.equal(new URL(config.windowsInstallerUrl).hostname, "github.com");
  assert.equal(config.windowsInstallerBytes, 125825552);
  assert.equal(
    config.windowsInstallerSha256,
    "464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e",
  );
});
