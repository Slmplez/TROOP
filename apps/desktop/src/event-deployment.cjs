const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { DatabaseSync, backup } = require("node:sqlite");
const { CoreSupervisor } = require("./core-client.cjs");

const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function configuration(input) {
  const fields = new Set([
    "version",
    "mode",
    "executable",
    "core_sha256",
    "data_directory",
    "listen",
    "public_url",
    "health_file",
    "health_interval_ms",
  ]);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !fields.has(key))
  )
    throw Error("部署配置包含未知字段。");
  const config = { health_interval_ms: 5000, ...input };
  if (config.version !== 1 || !["local", "receiver"].includes(config.mode))
    throw Error("部署配置版本或运行模式无效。");
  for (const field of ["executable", "data_directory", "health_file"]) {
    if (typeof config[field] !== "string" || !path.isAbsolute(config[field]))
      throw Error(`${field} 必须是绝对路径。`);
    config[field] = path.resolve(config[field]);
  }
  if (!/^[a-f0-9]{64}$/.test(config.core_sha256 ?? ""))
    throw Error("请固定 Core 构建的 SHA256。");
  const match = /^(127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(config.listen ?? "");
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw Error("部署监听需要固定 loopback 端口。");
  config.listen = `${match[1]}:${Number(match[2])}`;
  if (
    !Number.isInteger(config.health_interval_ms) ||
    config.health_interval_ms < 1000 ||
    config.health_interval_ms > 60000
  )
    throw Error("健康检查间隔应为 1000–60000 毫秒。");
  if (config.public_url != null) {
    let url;
    try {
      url = new URL(config.public_url);
    } catch {
      throw Error("公开入口地址无效。");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw Error("公开入口需要无凭据、查询参数和路径的 HTTPS 地址。");
    config.public_url = url.origin;
  }
  const reserved = [
    config.executable,
    path.join(config.data_directory, "troop.sqlite3"),
    path.join(config.data_directory, "troop.sqlite3-wal"),
    path.join(config.data_directory, "troop.sqlite3-shm"),
    path.join(config.data_directory, "core.lock"),
  ];
  if (reserved.some((file) => path.relative(file, config.health_file) === ""))
    throw Error("健康文件不能覆盖程序或 Core 存储。");
  return config;
}

function preflight(input, { requirePublic = false } = {}) {
  const config = configuration(input);
  const actual = sha256(config.executable);
  if (actual !== config.core_sha256) throw Error("Core 构建指纹不匹配。");
  if (requirePublic && !config.public_url)
    throw Error("真实平台部署缺少公开 HTTPS 入口。");
  return {
    config,
    node: process.versions.node,
    platform: process.platform,
    core_sha256: actual,
    account: os.userInfo().username,
    public_entry: config.public_url ? "configured_unverified" : "missing",
    credentials: "Windows Credential Manager under the service account",
  };
}

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// The owner holds the only Core stdio channel. No management listener is opened.
class EventDeployment {
  constructor(input) {
    this.config = configuration(input);
    this.core = new CoreSupervisor({
      executable: this.config.executable,
      args: [
        "--data-dir",
        this.config.data_directory,
        ...(this.config.mode === "receiver" ? ["--event-receiver"] : []),
        "--event-listen",
        this.config.listen,
      ],
      timeout: 10000,
    });
    this.timer = null;
    this.checking = null;
    this.stopping = null;
    this.expectedInstance = null;
  }
  async start() {
    preflight(this.config);
    try {
      await this.core.start();
      const health = await this.refresh();
      if (!health.ready) throw Error("部署启动后的健康检查失败。");
      this.expectedInstance = health.instance_id;
      this.timer = setInterval(() => {
        this.refresh().catch(() => {});
      }, this.config.health_interval_ms);
      return health;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async refresh() {
    if (this.checking) return this.checking;
    this.checking = this.inspect().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  async inspect() {
    const snapshot = this.core.snapshot();
    const health = {
      version: 1,
      mode: this.config.mode,
      ready: false,
      checked_at: new Date().toISOString(),
      host_pid: process.pid,
      core_pid: snapshot.pid,
      core_sha256: this.config.core_sha256,
      state: snapshot.state,
      instance_id: snapshot.storage_instance,
      public_entry: this.config.public_url
        ? "configured_unverified"
        : "missing",
    };
    if (snapshot.state === "ready") {
      try {
        const status = await this.core.request("events.health", {});
        health.ready =
          status.instance_id === snapshot.storage_instance &&
          (this.expectedInstance === null ||
            status.instance_id === this.expectedInstance) &&
          status.receiver_only === (this.config.mode === "receiver") &&
          status.address === `http://${this.config.listen}`;
        health.address = status.address;
        health.sources = status.sources ?? {};
      } catch {
        health.reason = "Core 健康查询失败。";
      }
    }
    atomicJSON(this.config.health_file, health);
    return health;
  }
  async control(method, input = {}) {
    if (
      ![
        "system.ping",
        "events.health",
        "events.sources",
        "events.inbox",
        "events.records",
        "operations.get",
        "operations.execute",
      ].includes(method)
    )
      throw Error("部署控制仅开放事件管理及健康查询。");
    if (
      method === "operations.execute" &&
      input.method !== "events.source.save"
    )
      throw Error("部署控制仅允许事件来源配置。");
    return this.core.request(method, input);
  }
  async restart() {
    await this.stop();
    this.stopping = null;
    return this.start();
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      clearInterval(this.timer);
      this.timer = null;
      await this.checking;
      await this.core.stop();
      return this.refresh();
    })();
    return this.stopping;
  }
}

function databaseFacts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw Error("备份数据库完整性检查失败。");
    const instance = db
      .prepare("SELECT instance_id FROM storage_identity WHERE id=1")
      .get().instance_id;
    const sources = db
      .prepare("SELECT id,revision,document FROM event_sources ORDER BY id")
      .all()
      .map((row) => {
        const source = JSON.parse(row.document);
        return {
          id: row.id,
          revision: row.revision,
          kind: source.kind,
          consumer_id: source.consumer_id,
          secret_ref: source.secret_ref,
        };
      });
    return {
      schema: db.prepare("PRAGMA user_version").get().user_version,
      instance_id: instance,
      sources,
      unacked: db
        .prepare("SELECT COUNT(*) AS n FROM event_inbox WHERE acked=0")
        .get().n,
    };
  } finally {
    db.close();
  }
}

async function createBackup(input, destination) {
  const config = configuration(input);
  if (!path.isAbsolute(destination)) throw Error("备份目录必须是绝对路径。");
  // Exclusive directory creation prevents an existing snapshot being replaced.
  fs.mkdirSync(destination, { mode: 0o700 });
  const target = path.join(destination, "troop.sqlite3");
  const db = new DatabaseSync(
    path.join(config.data_directory, "troop.sqlite3"),
    { readOnly: true },
  );
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
  const facts = databaseFacts(target);
  const manifest = {
    version: 1,
    created_at: new Date().toISOString(),
    mode: config.mode,
    core_sha256: config.core_sha256,
    database_sha256: sha256(target),
    account: os.userInfo().username,
    ...facts,
  };
  atomicJSON(path.join(destination, "manifest.json"), manifest);
  return manifest;
}

function restoreBackup(source, destination) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination))
    throw Error("恢复源和目标必须是绝对路径。");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, "manifest.json"), "utf8"),
  );
  const database = path.join(source, "troop.sqlite3");
  if (manifest.version !== 1 || sha256(database) !== manifest.database_sha256)
    throw Error("备份版本或数据库摘要不匹配。");
  const facts = databaseFacts(database);
  if (
    facts.instance_id !== manifest.instance_id ||
    facts.schema !== manifest.schema ||
    JSON.stringify(facts.sources) !== JSON.stringify(manifest.sources)
  )
    throw Error("备份来源身份与清单不匹配。");
  // A fresh directory also excludes a running Core and stale WAL companions.
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.copyFileSync(
    database,
    path.join(destination, "troop.sqlite3"),
    fs.constants.COPYFILE_EXCL,
  );
  return {
    ...manifest,
    restored_directory: destination,
    credentials_require_same_account: true,
  };
}

module.exports = {
  configuration,
  preflight,
  EventDeployment,
  databaseFacts,
  createBackup,
  restoreBackup,
  sha256,
};
