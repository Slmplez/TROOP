import contract from "../../contracts/execution.cjs";

export class ClientError extends Error {
  constructor(message, kind, details = {}) {
    super(message);
    this.name = "ClientError";
    this.kind = kind;
    Object.assign(this, details);
  }
}

// Only named facade methods cross this adapter. No renderer-selected IPC channel.
export class TroopClient {
  constructor(bridge) {
    this.bridge = bridge;
  }
  async request(method, input) {
    contract.validate(method, input);
    const definition = contract.methods[method];
    const fn = this.bridge[definition.bridge];
    if (typeof fn !== "function")
      throw new ClientError("当前版本不支持此操作。", "capability_unavailable");
    let response;
    try {
      response = await fn(...contract.argumentsFor(definition, input));
    } catch (cause) {
      throw new ClientError(cause.message || "连接中断", "transport_error", {
        retryability: definition.command ? "reconcile" : "safe",
        cause,
      });
    }
    if (!response || typeof response.ok !== "boolean")
      throw new ClientError("IPC 返回值无效", "invalid_response");
    if (!response.ok)
      throw new ClientError(
        response.error || "操作未完成",
        response.details?.kind || "operation_failed",
        response.details,
      );
    const value = contract.validate(method, response.value, true);
    const returnedId = method === "agent.get" ? value.run.id : value?.id;
    if (
      [
        "agent.get",
        "agent.event",
        "agent.invocation",
        "agent.task",
        "agent.cancel",
        "agent.resume",
        "agent.stop-task",
        "agent.reconcile-task",
      ].includes(method) &&
      returnedId !== input.id
    ) {
      throw new ClientError("Core 返回了其他资源的记录。", "invalid_response");
    }
    return value;
  }
  onChatEvent(callback) {
    return this.bridge.onChatEvent?.(callback) ?? (() => {});
  }
}
