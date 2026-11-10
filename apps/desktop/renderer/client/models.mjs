import contract from "../../contracts/execution.cjs";
import { ClientError } from "./troop-client.mjs";
import { QueryModel } from "./query-model.mjs";
import { FollowModel } from "./follow-model.mjs";
export { QueryModel } from "./query-model.mjs";
const descending = (a, b) => b.id - a.id;
export class ClientModels {
  constructor(
    client,
    { clock = globalThis, pollInterval = 350, journal = null } = {},
  ) {
    this.client = client;
    this.journal = journal;
    this.clock = clock;
    this.pollInterval = pollInterval;
    this.ready = false;
    this.generation = null;
    this.cache = new Map();
    this.statusRevision = -1;
    this.observed = new Set();
    this.eventSequence = 0;
    this.commands = new Map();
    this.connectionVersion = 0;
  }
  observe(model, active) {
    if (active) this.observed.add(model);
    else this.observed.delete(model);
    if (this.observed.size && !this.unsubscribe && this.client.onChatEvent) {
      this.unsubscribe = this.client.onChatEvent((event) => {
        if (
          !this.ready ||
          event.generation !== this.generation ||
          !Number.isSafeInteger(event.seq) ||
          event.seq <= this.eventSequence
        )
          return;
        this.eventSequence = event.seq;
        // Notifications invalidate queries; they are not a durable follow cursor.
        for (const key of ["sessions", `session:${event.conversation_id}`]) {
          const query = this.cache.get(key);
          if (query?.listeners.size) void query.refresh();
        }
      });
    } else if (!this.observed.size && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
  connect(status) {
    if (
      Number.isSafeInteger(status.revision) &&
      status.revision < this.statusRevision
    )
      return;
    if (Number.isSafeInteger(status.revision))
      this.statusRevision = status.revision;
    const ready = status.state === "ready" && status.protocol === 10;
    if (ready === this.ready && status.generation === this.generation) return;
    this.connectionVersion++;
    this.ready = ready;
    this.generation = status.generation;
    if (ready) {
      this.capabilities = status.capabilities ?? [];
      this.instance = status.storage_instance;
      this.followResources = status.follow_resources ?? ["run", "task"];
      this.followEnabled =
        status.capabilities?.includes("agent.follow") &&
        status.capabilities?.includes("agent.follow-content");
      this.journal?.select(this.instance);
      if (this.instance) void this.journal?.recover(this.client, this.instance);
    }
    this.eventSequence = 0;
    for (const model of this.cache.values()) model.reset();
  }
  model(key, load, options) {
    if (!this.cache.has(key)) {
      // Bound inactive history caches; active observers always retain shared identity.
      if (this.cache.size >= 100)
        for (const [id, model] of this.cache) {
          if (!model.listeners.size) {
            model.suspend();
            this.cache.delete(id);
          }
        }
      this.cache.set(
        key,
        new (options?.follow ? FollowModel : QueryModel)(this, load, options),
      );
    }
    return this.cache.get(key);
  }
  runs() {
    return this.model(
      "runs",
      (offset) => this.client.request("agent.list", { offset: offset ?? 0 }),
      { interval: this.pollInterval, cursor: "next_offset", order: descending },
    );
  }
  run(id) {
    return this.model(
      `run:${id}`,
      async () => {
        const snapshot = await this.client.request("agent.get", { id });
        const run = { ...snapshot.run };
        for (const field of ["goal", "output"])
          if (run[field + "_truncated"])
            run[field] = (
              await this.client.request("agent.content", { id, field })
            ).text;
        return { ...snapshot, run };
      },
      {
        interval: this.pollInterval,
        revision: (data) => data.run.revision,
        follow: { resource: "run", id },
      },
    );
  }
  events(id) {
    return this.model(
      `events:${id}`,
      (before) => this.client.request("agent.events", { id, before }),
      {
        interval: this.pollInterval,
        cursor: "next_before",
        order: descending,
        appendOnly: true,
      },
    );
  }
  event(id) {
    return this.model(
      `event:${id}`,
      () => this.client.request("agent.event", { id }),
      {},
    );
  }
  checkpoints(id) {
    return this.model(
      `checkpoints:${id}`,
      () => this.client.request("agent.checkpoints", { id }),
      {},
    );
  }
  invocation(id) {
    return this.model(
      `invocation:${id}`,
      () => this.client.request("agent.invocation", { id }),
      { interval: this.pollInterval, follow: { resource: "invocation", id } },
    );
  }
  task(id) {
    return this.model(
      `task:${id}`,
      () => this.client.request("agent.task", { id }),
      { interval: this.pollInterval, follow: { resource: "task", id } },
    );
  }
  resetFollowEvents(target) {
    if (target.resource === "run")
      this.cache.get(`events:${target.id}`)?.reset();
  }
  acceptFollowEvents(target, frame) {
    if (target.resource !== "run") return;
    for (const change of frame.changes) {
      const affected =
        change.resource === "invocation"
          ? this.cache.get(`invocation:${change.resource_id}`)
          : change.resource === "task"
            ? this.cache.get(`task:${change.resource_id}`)
            : null;
      if (affected?.listeners.size) void affected.refresh();
    }
    const model = this.cache.get(`events:${target.id}`);
    if (!model?.state.data) return;
    const items = new Map(
      model.state.data.items.map((item) => [item.id, item]),
    );
    for (const change of frame.changes)
      if (change.run_id === target.id && change.event)
        items.set(change.event.id, change.event);
    for (const event of frame.snapshot?.events?.items ?? [])
      items.set(event.id, event);
    model.publish({
      data: {
        ...model.state.data,
        items: [...items.values()].sort(descending),
      },
    });
  }
  agents() {
    return this.model(
      "agents",
      () => this.client.request("memory.agents", {}),
      {},
    );
  }
  sessions() {
    return this.model(
      "sessions",
      (offset) => this.client.request("chat.list", { offset: offset ?? 0 }),
      {
        cursor: "next_offset",
        interval: this.pollInterval,
        order: (a, b) =>
          b.updated_at.localeCompare(a.updated_at) || b.id - a.id,
      },
    );
  }
  session(id) {
    return this.model(
      `session:${id}`,
      (before) =>
        this.client.request("chat.messages", { conversation_id: id, before }),
      {
        cursor: "next_before",
        interval: this.pollInterval,
        order: (a, b) => a.id - b.id,
      },
    );
  }
  invalidate() {
    for (const model of this.cache.values())
      if (model.listeners.size) void model.refresh();
  }
  async read(method, input) {
    const connection = this.connectionVersion;
    if (!this.ready) throw Error("Core 尚未连接。");
    const value = await this.client.request(method, input);
    if (this.connectionVersion !== connection || !this.ready) {
      const error = Error("连接已变化，请核对操作结果；不会自动重试。");
      error.kind = "stale_generation";
      throw error;
    }
    return value;
  }
  resource(method, input = {}) {
    if (method === "authorizations.list") {
      contract.validate(method, input);
      return this.model(
        `authorizations:${input.offset ?? 0}`,
        (offset) =>
          this.client.request(method, { offset: offset ?? input.offset ?? 0 }),
        {
          cursor: "next_offset",
          refreshPages: true,
          interval: this.pollInterval,
          order: () => 0,
        },
      );
    }
    if (
      [
        "groups.list",
        "groups.messages",
        "groups.deliveries",
        "topics.list",
        "reminders.history",
        "schedules.history",
        "notifications.list",
      ].includes(method)
    ) {
      contract.validate(method, input);
      const filters = Object.fromEntries(
        Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
      );
      return this.model(
        `group-resource:${method}:${JSON.stringify(filters)}`,
        (before) =>
          this.client.request(method, {
            ...filters,
            ...(before ? { before } : {}),
          }),
        {
          cursor: "next_before",
          refreshPages: true,
          interval: this.pollInterval,
          order: descending,
        },
      );
    }
    if (method === "work_items.runs") {
      contract.validate(method, input);
      return this.model(
        `work-item-runs:${input.id}`,
        (before) =>
          this.client.request(method, {
            id: input.id,
            ...(before ? { before } : {}),
          }),
        {
          cursor: "next_before",
          refreshPages: true,
          interval: this.pollInterval,
          identity: (item) => item.run.id,
          order: (a, b) => b.run.id - a.run.id,
        },
      );
    }
    if (method === "work_items.list") {
      contract.validate(method, input);
      const filters = Object.fromEntries(
        Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
      );
      return this.model(
        `work-items:${JSON.stringify(filters)}`,
        (before) =>
          this.client.request(method, {
            ...filters,
            ...(before ? { before } : {}),
          }),
        {
          cursor: "next_before",
          refreshPages: true,
          interval: this.pollInterval,
          order: descending,
        },
      );
    }
    if (method === "cli.interactions")
      return this.model(
        `cli-interactions:${input.task_id}`,
        (before) =>
          this.client.request(method, {
            task_id: input.task_id,
            ...(before ? { before } : {}),
          }),
        {
          cursor: "next_cursor",
          interval: this.pollInterval,
          identity: (item) => item.interaction_id,
          order: (a, b) =>
            b.created_at - a.created_at ||
            b.interaction_id.localeCompare(a.interaction_id),
        },
      );
    if (method === "agent.get") return this.run(input.id);
    if (method === "agent.invocation") return this.invocation(input.id);
    if (method === "agent.task") return this.task(input.id);
    if (!contract.methods[method] || contract.methods[method].command)
      throw new ClientError("此接口不是资源查询。", "invalid_request");
    if (contract.methods[method].sensitive)
      throw new ClientError("敏感预览不能进入查询缓存。", "invalid_request");
    contract.validate(method, input);
    const canonical = (value) =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])]),
            )
          : value;
    return this.model(
      `resource:${method}:${JSON.stringify(canonical(input))}`,
      () => this.client.request(method, input),
      {
        interval: [
          "memory.job",
          "reminders.get",
          "schedules.get",
          "notifications.preferences",
          "work_items.get",
          "groups.get",
          "topics.get",
          "groups.preview",
          "groups.executor.get",
          "groups.chain",
          "cli.interactions",
          "cli.interaction",
          "memory.history",
          "memory.usage",
          "memory.conflicts",
          "events.sources",
          "events.health",
          "events.records",
          "events.inbox",
          "rules.list",
          "followups.list",
          "followups.get",
          "followups.history",
          "rules.get",
          "rules.history",
          "authorizations.list",
          "authorizations.get",
          "authorizations.history",
          "office.reference.get",
        ].includes(method)
          ? this.pollInterval
          : 0,
      },
    );
  }
  async fetchResource(method, input = {}) {
    if (contract.methods[method]?.sensitive) return this.read(method, input);
    const connection = this.connectionVersion;
    if (!this.ready)
      throw new ClientError("Core 尚未连接。", "transport_error");
    const model = this.resource(method, input);
    // Concurrent views join one read. Explicit invalidation may still queue a
    // follow-up refresh when a command changes the resource during that read.
    await (model.pending ?? model.refresh());
    if (connection !== this.connectionVersion || !this.ready)
      throw new ClientError("连接已变化，请刷新资源。", "stale_generation");
    const state = model.getSnapshot();
    if (state.error) throw state.error;
    return state.data;
  }
  async command(method, input) {
    const key = JSON.stringify([this.connectionVersion, method, input]);
    if (this.commands.has(key)) return this.commands.get(key);
    const connection = this.connectionVersion;
    const result = (async () => {
      if (!this.ready) throw Error("Core 尚未连接。");
      if (!this.journal || !contract.operationCommands.includes(method))
        return this.read(method, input);
      const sensitive = contract.methods[method]?.sensitive;
      const entry = sensitive
        ? await this.journal.prepareSensitive(this.instance, method, input)
        : this.journal.prepare(this.instance, method, input);
      if (connection !== this.connectionVersion || !this.ready)
        throw new ClientError("连接已变化，请查询原操作。", "stale_generation");
      const receipt = await this.journal.resolve(
        this.client,
        entry,
        sensitive ? input : undefined,
      );
      if (connection !== this.connectionVersion || !this.ready)
        throw new ClientError(
          "连接已变化，请在待确认操作中查询结果。",
          "stale_generation",
        );
      if (receipt.state === "dismissed") {
        this.journal.acknowledge(entry);
        return { cancelled: true };
      }
      if (receipt.state !== "committed")
        throw new ClientError(
          receipt.error?.message || "操作需要核对。",
          receipt.error?.kind || "needs_reconciliation",
          {
            operationRef: entry.request.operation_id,
            currentRevision: receipt.error?.currentRevision ?? undefined,
          },
        );
      this.journal.acknowledge(entry);
      return receipt.result;
    })()
      .then((value) => {
        this.invalidate();
        return value;
      })
      .finally(() => this.commands.delete(key));
    this.commands.set(key, result);
    return result;
  }
  dispose() {
    for (const model of this.cache.values()) model.suspend();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.observed.clear();
    this.cache.clear();
    this.ready = false;
  }
}
