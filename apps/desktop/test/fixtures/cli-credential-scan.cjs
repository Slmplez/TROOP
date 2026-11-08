const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
module.exports = function credentialScan(directory, secret) {
  assert.ok(typeof secret === "string" && secret.length > 0);
  const needle = Buffer.from(secret);
  const report = {
    checkedFiles: 0,
    excludedLargeFiles: 0,
    credentialFound: false,
    scope: "owned_CLI_test_directory_files_up_to_2MB",
  };
  const pending = [directory];
  while (pending.length) {
    for (const entry of fs.readdirSync(pending.pop(), {
      withFileTypes: true,
    })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (fs.statSync(file).size > 2 * 1024 * 1024) {
        report.excludedLargeFiles++;
        continue;
      }
      report.checkedFiles++;
      if (fs.readFileSync(file).includes(needle)) report.credentialFound = true;
    }
  }
  assert.equal(
    report.credentialFound,
    false,
    "Credential value appeared in an owned native CLI runtime file",
  );
  return report;
};
