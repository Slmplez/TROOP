const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process"),
  { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "../../../../.tmp-troop-hooks/tests");

function fixtureSources(data) {
  const resolved = fs.realpathSync(data);
  if (!resolved.startsWith(fs.realpathSync(root) + path.sep))
    throw Error("Credential cleanup requires an owned Hook fixture directory");
  const database = path.join(resolved, "troop.sqlite3");
  if (!fs.existsSync(database)) return [];
  if (fs.realpathSync(database) !== database)
    throw Error("Credential cleanup rejects an aliased fixture database");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='event_sources'")
        .get()
    )
      return [];
    const instance = db
      .prepare("SELECT instance_id FROM storage_identity WHERE id=1")
      .get().instance_id;
    return db
      .prepare("SELECT id FROM event_sources")
      .all()
      .map(({ id }) => `TROOP/events/${instance}/${id}/`);
  } finally {
    db.close();
  }
}

// Fixture teardown calls this after awaiting the owning Core's stop.
function cleanupEventCredentials(directories) {
  if (process.platform !== "win32") return { matched: 0, removed: 0 };
  const prefixes = directories.flatMap(fixtureSources);
  if (!prefixes.length) return { matched: 0, removed: 0 };
  const inventory = spawnSync("cmdkey.exe", ["/list"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (inventory.status !== 0)
    throw Error("Cannot enumerate test credential targets");
  const references = new Set(
    inventory.stdout.match(
      /TROOP\/events\/[0-9a-f-]{32,36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}/g,
    ) ?? [],
  );
  const owned = [...references].filter((reference) =>
    prefixes.some((prefix) => reference.startsWith(prefix)),
  );
  let removed = 0;
  for (const reference of owned) {
    const result = spawnSync("cmdkey.exe", [`/delete:${reference}`], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.status !== 0)
      throw Error("Cannot remove an owned event test credential");
    removed++;
  }
  return { matched: owned.length, removed };
}

module.exports = { cleanupEventCredentials };
