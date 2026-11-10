import contract from "../../contracts/execution.cjs";
import { ClientError } from "./troop-client.mjs";
const prefix = "troop.operations.v1:";
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

// Saved before transport. Reload and reconnect only query; retransmission is explicit.
export class OperationJournal {
  constructor(storage, uuid = () => crypto.randomUUID()) {
    this.storage = storage;
    this.uuid = uuid;
    this.instance = null;
    this.rows = Object.freeze([]);
    this.listeners = new Set();
  }
  subscribe = (callback) => {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  };
  getSnapshot = () => this.rows;
  entries(instance = this.instance) {
    const rows = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(prefix + instance + ":")) continue;
      const entry = JSON.parse(this.storage.getItem(key));
      if (
        entry.request.instance_id !== instance ||
        !contract.operationCommands.includes(entry.request.method)
      )
        throw Error("待确认操作记录无效，请保留本地记录并检查。");
      contract.validate("operations.execute", entry.request);
      if (!entry.redacted)
        contract.validate(entry.request.method, entry.request.input);
      rows.push(entry);
    }
    return rows;
  }
  select(instance) {
    this.instance = instance;
    this.publish();
  }
  publish() {
    this.rows = Object.freeze(this.instance ? this.entries() : []);
    for (const fn of this.listeners) fn();
  }
  key(entry) {
    return (
      prefix + entry.request.instance_id + ":" + entry.request.operation_id
    );
  }
  save(entry) {
    this.storage.setItem(this.key(entry), JSON.stringify(entry));
    this.publish();
  }
  acknowledge(entry) {
    this.storage.removeItem(this.key(entry));
    this.publish();
  }
  prepare(instance, method, input) {
    if (!instance)
      throw new ClientError(
        "Core 未提供操作账本身份，请重新连接。",
        "capability_unavailable",
      );
    if (!contract.operationCommands.includes(method))
      throw Error("Unsupported operation command");
    contract.validate(method, input);
    const signature = JSON.stringify(canonical({ method, input }));
    const previous = this.entries(instance).find(
      (entry) => entry.signature === signature,
    );
    if (previous) return previous;
    const entry = {
      signature,
      attempted: false,
      request: {
        instance_id: instance,
        operation_id: this.uuid(),
        method,
        input: structuredClone(input),
      },
      receipt: null,
    };
    this.save(entry); // Failure here prevents dispatch.
    return entry;
  }
  async prepareSensitive(instance, method, input) {
    if (!instance)
      throw new ClientError(
        "Core 未提供操作账本身份。",
        "capability_unavailable",
      );
    contract.validate(method, input);
    const bytes = new TextEncoder().encode(
      JSON.stringify(canonical({ method, input })),
    );
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const signature =
      "sha256:" +
      [...new Uint8Array(hash)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const previous = this.entries(instance).find(
      (e) => e.signature === signature,
    );
    if (previous) return previous;
    const entry = {
      signature,
      attempted: false,
      redacted: true,
      request: {
        instance_id: instance,
        operation_id: this.uuid(),
        method,
        input: {},
      },
      receipt: null,
    };
    this.save(entry);
    return entry;
  }
  accept(entry, receipt) {
    if (
      receipt.operation_id !== entry.request.operation_id ||
      receipt.instance_id !== entry.request.instance_id ||
      (receipt.method && receipt.method !== entry.request.method)
    )
      throw new ClientError("操作回执身份不匹配。", "invalid_response");
    if (receipt.state === "committed")
      contract.validate(entry.request.method, receipt.result, true);
    // A delayed query cannot resurrect an acknowledged entry or regress a known result.
    const saved = this.storage.getItem(this.key(entry));
    if (!saved) return receipt;
    const previous = JSON.parse(saved).receipt;
    if (["committed", "rejected"].includes(previous?.state)) return previous;
    entry.receipt = receipt;
    this.save(entry);
    return receipt;
  }
  async query(client, entry) {
    const receipt = await client.request("operations.get", {
      operation_id: entry.request.operation_id,
      instance_id: entry.request.instance_id,
    });
    return this.receive(client, entry, receipt);
  }
  async receive(client, entry, receipt) {
    const accepted = this.accept(entry, receipt);
    if (accepted.state !== "archived") return accepted;
    const reference = accepted.archive_ref;
    if (
      !reference ||
      reference.operation_id !== entry.request.operation_id ||
      reference.instance_id !== entry.request.instance_id
    )
      throw new ClientError("归档回执身份不匹配。", "invalid_response");
    const original = await client.request(
      "operations.archive.query",
      reference,
    );
    if (!["committed", "rejected", "dismissed"].includes(original.state))
      throw new ClientError("归档回执缺少终态。", "invalid_response");
    return this.accept(entry, original);
  }
  async resolve(client, entry, sensitiveInput) {
    if (entry.attempted) {
      const receipt = await this.query(client, entry);
      if (receipt.state !== "not_found") return receipt;
    }
    if (entry.redacted && sensitiveInput === undefined)
      throw new ClientError(
        "请返回配置页面重新输入凭据；不会从本地记录重放。",
        "requires_input",
      );
    entry.attempted = true;
    this.save(entry);
    return this.receive(
      client,
      entry,
      await client.request(
        "operations.execute",
        entry.redacted
          ? { ...entry.request, input: sensitiveInput }
          : entry.request,
      ),
    );
  }
  async recover(client, instance) {
    for (const entry of this.entries(instance)) {
      // No automatic execute, including not_found: a user must reaffirm this intent.
      try {
        await this.query(client, entry);
      } catch {
        /* Preserve pending evidence for explicit query. */
      }
    }
  }
}
