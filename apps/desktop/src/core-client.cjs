const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const PROTOCOL = 10;
const ALLOWED = new Set([
  "followups.preview",
  "followups.chain",
  "followups.list",
  "followups.get",
  "followups.history",
  "followups.save",
  "followups.request",
  "followups.run",
  "followups.set_enabled",
  "followups.cancel",
  "followups.stop_chain",
  "followups.handoff",
  "schedules.set_enabled",
  "schedules.preview",
  "schedules.get",
  "schedules.history",
  "schedules.run",
  "schedules.cancel",
  "notifications.pending",
  "reminders.run",
  "reminders.get",
  "reminders.history",
  "reminders.cancel",
  "notifications.list",
  "notifications.preferences",
  "notifications.preferences.save",
  "notifications.claim",
  "notifications.complete",
  "notifications.read",
  "automations.preview",
  "automations.result",
  "automations.confirm",
  "reminders.preview",
  "topics.create",
  "topics.get",
  "topics.list",
  "topics.save",
  "topics.member",
  "topics.archive",
  "groups.list",
  "groups.executor.get",
  "groups.executor.preview",
  "groups.executor.save",
  "groups.chain",
  "groups.stop_chain",
  "groups.get",
  "groups.preview",
  "groups.save",
  "groups.archive",
  "groups.member",
  "groups.send",
  "groups.messages",
  "groups.deliveries",
  "groups.resolve_delivery",
  "work_items.list",
  "work_items.get",
  "work_items.save",
  "work_items.archive",
  "work_items.runs",
  "work_items.preview",
  "work_items.start",
  "work_items.accept",
  "work_items.cancel",
  "cli.start",
  "cli.review",
  "cli.interaction",
  "cli.interactions",
  "cli.preview",
  "cli.respond",
  "events.recheck",
  "events.records",
  "events.health",
  "events.sources",
  "events.inbox",
  "events.payload",
  "events.source.save",
  "memory.maintenance.get",
  "memory.maintenance.save",
  "engines.capabilities",
  "engines.list",
  "rules.list",
  "rules.get",
  "rules.history",
  "rules.save",
  "rules.simulate",
  "authorizations.list",
  "authorizations.get",
  "authorizations.history",
  "authorizations.evaluate",
  "authorizations.save",
  "authorizations.revoke",

  "operations.execute",
  "operations.get",
  "mcp.list",
  "mcp.get",
  "mcp.save",
  "mcp.remove",
  "mcp.revisions",
  "mcp.preview",
  "mcp.import",
  "mcp.oauth.begin",
  "mcp.oauth.status",
  "mcp.oauth.cancel",
  "mcp.oauth.refresh",
  "mcp.oauth.disconnect",
  "skills.list",
  "skills.preview",
  "skills.import",
  "skills.get",
  "skills.versions",
  "skills.enable",
  "skills.remove",
  "skills.edit",
  "skills.refresh",
  "hooks.list",
  "hooks.definition",
  "hooks.save",
  "hooks.remove",
  "hooks.calls",
  "hooks.call",
  "hooks.reconcile",
  "system.ping",
  "workspace.list",
  "workspace.add",
  "workspace.rename",
  "workspace.remove",
  "provider.list",
  "provider.save",
  "provider.remove",
  "chat.list",
  "chat.create",
  "chat.remove",
  "chat.messages",
  "chat.send",
  "chat.cancel",
  "agent.list",
  "agent.mcp-catalogue",
  "agent.mcp-sessions",
  "agent.mcp-reconcile",
  "agent.mcp-artifact",
  "agent.get",
  "agent.follow",
  "agent.follow-content",
  "agent.content",
  "agent.events",
  "agent.event",
  "agent.invocation",
  "agent.start",
  "agent.cancel",
  "agent.approve",
  "agent.steer",
  "agent.reconcile",
  "agent.resume",
  "memory.agents",
  "memory.agent.save",
  "memory.projects",
  "memory.membership",
  "memory.conflicts",
  "memory.resolve",
  "memory.usage",
  "memory.history",
  "memory.list",
  "memory.restore",
  "memory.write",
  "memory.edit",
  "memory.jobs",
  "memory.job",
  "memory.job.cancel",
  "memory.job.retry",
  "agent.compact",
  "agent.checkpoints",
  "agent.tasks",
  "agent.task",
  "agent.stop-task",
  "agent.reconcile-task",
]);
const MAX_FRAME = 65536;
class CoreSupervisor extends EventEmitter {
  constructor({ executable, args = [], timeout = 30000 }) {
    super();
    this.executable = executable;
    this.args = args;
    this.timeout = timeout;
    this.child = null;
    this.pending = new Map();
    this.generation = null;
    this.state = "stopped";
    this.statusRevision = 0;
    this.info = null;
    this.eventSequence = 0;
    this.lastError = null;
    this.restartTimes = [];
    this.prefix = crypto.randomUUID();
    this.nextId = 0;
    this.starting = null;
    this.stopping = null;
  }
  snapshot() {
    return {
      state: this.state,
      revision: this.statusRevision,
      generation: this.generation,
      pid: this.child?.pid ?? null,
      version: this.info?.core_version ?? null,
      protocol: this.info?.protocol ?? null,
      storage_instance: this.info?.storage_instance ?? null,
      capabilities: this.info?.capabilities ?? [],
      follow_resources: this.info?.follow_resources ?? ["run", "task"],
      error: this.lastError,
    };
  }
  _status(state, error = null) {
    this.statusRevision += 1;
    this.state = state;
    this.lastError = error;
    this.emit("status", this.snapshot());
  }
  async start() {
    if (
      this.child &&
      (this.child.exitCode !== null || this.child.signalCode !== null)
    ) {
      const child = this.child;
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await closed;
    }
    if (this.starting) return this.starting;
    if (this.state === "ready") return this.snapshot();
    if (this.child || this.stopping) throw Error("Core 正在停止，请稍后重试。");
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < 60000);
    if (this.restartTimes.length >= 3)
      throw Error("Core 已多次启动失败。请检查运行环境后重新打开应用。");
    this.restartTimes.push(now);
    this.shutdownRequested = false;
    this._status("starting");
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async _start() {
    const child = spawn(this.executable, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.generation = null;
    this.info = null;
    let buffer = Buffer.alloc(0);
    let stderr = "";
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", (error) =>
      this._fault(child, `无法启动 Core：${error.message}`),
    );
    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      buffer = Buffer.concat([buffer, chunk]);
      let index;
      while ((index = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, index);
        buffer = buffer.subarray(index + 1);
        if (line.length > MAX_FRAME) {
          this._fault(child, "Core 返回了过大的消息。");
          return;
        }
        let response;
        try {
          response = JSON.parse(line.toString("utf8"));
        } catch {
          this._fault(child, "Core 返回了无效消息。");
          return;
        }
        if (response.method) {
          const event = response.params;
          if (
            response.jsonrpc !== "2.0" ||
            response.method !== "chat.changed" ||
            !event ||
            event.generation !== this.generation ||
            !Number.isSafeInteger(event.seq) ||
            event.seq <= this.eventSequence ||
            !Number.isSafeInteger(event.conversation_id) ||
            !Number.isSafeInteger(event.turn_id) ||
            typeof event.status !== "string"
          ) {
            this._fault(child, "Core 返回了无效的对话事件。");
            return;
          }
          this.eventSequence = event.seq;
          this.emit("chat-event", event);
          continue;
        }
        const p = this.pending.get(response.id);
        if (!p || p.child !== child) continue;
        if (response.jsonrpc !== "2.0") {
          this._fault(child, "Core 协议无效。");
          return;
        }
        if (response.error) {
          if (
            p.method !== "system.hello" &&
            response.error.data?.generation !== p.generation
          ) {
            this._fault(child, "Core 错误消息的连接版本不匹配。");
            return;
          }
          this.pending.delete(response.id);
          clearTimeout(p.timer);
          const error = Error(response.error.message || "Core 请求失败");
          error.code = response.error.code;
          error.kind = response.error.data?.kind;
          p.reject(error);
          continue;
        }
        const result = response.result;
        if (
          !result ||
          typeof result.generation !== "string" ||
          !result.generation ||
          (p.method !== "system.hello" && result.generation !== p.generation)
        ) {
          this._fault(child, "Core 连接版本已变化，请重新连接。");
          return;
        }
        this.pending.delete(response.id);
        clearTimeout(p.timer);
        p.resolve(result);
      }
      if (buffer.length > MAX_FRAME)
        this._fault(child, "Core 消息超过大小限制。");
    });
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.generation = null;
      this.info = null;
      this._rejectAll(child, Error("Core 已退出；未完成操作不会自动重试。"));
      if (this.state === "stopping") this._status("stopped");
      else if (this.state !== "faulted")
        this._status(
          "faulted",
          stderr.trim() || `Core 意外退出（${signal ?? code}）。`,
        );
    });
    try {
      const hello = await this._send(
        "system.hello",
        { protocol: PROTOCOL, client: "troop-desktop" },
        child,
      );
      if (
        this.child !== child ||
        this.state === "faulted" ||
        this.shutdownRequested
      )
        throw Error("Core 启动已失效。");
      if (
        hello.value?.protocol !== PROTOCOL ||
        !Array.isArray(hello.value.capabilities) ||
        ![...ALLOWED]
          .filter(
            (x) =>
              !x.startsWith("events.") &&
              !x.startsWith("memory.maintenance.") &&
              !x.startsWith("authorizations.") &&
              !x.startsWith("rules.") &&
              x !== "engines.capabilities" &&
              x !== "engines.list" &&
              x !== "cli.start" &&
              x !== "cli.review" &&
              x !== "cli.respond" &&
              x !== "cli.interaction" &&
              x !== "cli.interactions" &&
              x !== "cli.preview" &&
              !x.startsWith("work_items.") &&
              !x.startsWith("groups.") &&
              !x.startsWith("topics.") &&
              !x.startsWith("reminders.") &&
              !x.startsWith("schedules.") &&
              !x.startsWith("notifications.") &&
              !x.startsWith("memory.conflict") &&
              x !== "memory.resolve" &&
              x !== "memory.usage" &&
              x !== "memory.history" &&
              x !== "memory.restore",
          )
          .every((x) => hello.value.capabilities.includes(x))
      )
        throw Error("Core 与桌面版本不兼容。");
      this.generation = hello.generation;
      this.eventSequence = 0;
      this.info = hello.value;
      this._status("ready");
      return this.snapshot();
    } catch (error) {
      this._fault(child, error.message);
      throw error;
    }
  }
  _rejectAll(child, error) {
    for (const [id, p] of this.pending) {
      if (p.child === child) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(error);
      }
    }
  }
  _fault(child, message) {
    if (this.child !== child) return;
    if (this.state !== "stopping") this._status("faulted", message);
    this._rejectAll(child, Error(message));
    child.kill();
  }
  _send(method, params, child = this.child) {
    if (!child || child.stdin.destroyed)
      return Promise.reject(Error("Core 未连接。"));
    if (this.pending.size >= 64)
      return Promise.reject(Error("请求过多，请稍后重试。"));
    const id = `${this.prefix}:${++this.nextId}`;
    const frame =
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
        ...(method === "system.hello" ? {} : { generation: this.generation }),
      }) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME)
      return Promise.reject(Error("请求内容过大。"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this._fault(child, "Core 请求超时；操作结果需要核对，不会自动重试。"),
        this.timeout,
      );
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        child,
        method,
        generation: this.generation,
      });
      child.stdin.write(frame, (error) => {
        if (error) this._fault(child, "Core 控制连接已中断。");
      });
    });
  }
  async request(method, params = {}) {
    if (!ALLOWED.has(method)) throw Error("该接口不可调用。");
    if (this.state !== "ready") throw Error("Core 尚未就绪。");
    const result = await this._send(method, params);
    return result.value;
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this._stop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
  async _stop() {
    const child = this.child;
    if (!child) {
      this._status("stopped");
      return;
    }
    const wasReady = this.state === "ready";
    let shutdownAcknowledged = false;
    this.shutdownRequested = true;
    this._status("stopping");
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", resolve);
    });
    try {
      const result = await this._send("system.shutdown", {}, child);
      shutdownAcknowledged = result.value?.stopped === true;
    } catch {}
    child.stdin.end();
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 2000);
      }),
    ]);
    clearTimeout(timer);
    if (this.child === child) {
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    if (this.child === child) throw Error("无法确认 Core 已退出。");
    if (wasReady && shutdownAcknowledged) this.restartTimes = [];
  }
}
module.exports = { CoreSupervisor, MAX_FRAME, ALLOWED, PROTOCOL };
