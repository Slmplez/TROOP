const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

test("debug port reads retry only absent or exclusively locked startup files", async () => {
  const { readDebugPort } = await import(
    pathToFileURL(
      path.resolve(__dirname, "../../../scripts/lib/debug-port.mjs"),
    ).href
  );
  for (const code of ["EBUSY", "ENOENT"]) {
    assert.equal(
      await readDebugPort("owned-port", async () => {
        throw Object.assign(Error(code), { code });
      }),
      null,
    );
  }
  const denied = Object.assign(Error("owned access denied"), {
    code: "EACCES",
  });
  await assert.rejects(
    readDebugPort("owned-port", async () => {
      throw denied;
    }),
    (error) => error === denied,
  );
  assert.equal(
    await readDebugPort(
      "owned-port",
      async () => "9222\n/devtools/browser/owned",
    ),
    9222,
  );
  for (const value of ["", "0", "65536", "1.5", "invalid"]) {
    assert.equal(await readDebugPort("owned-port", async () => value), null);
  }
});
