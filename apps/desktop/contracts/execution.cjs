// Shared public contract for the migrated session / execution client surface.
// Records allow additive response fields; requests reject unknown fields.
const object = (fields) => ({ fields });
const array = (items) => ({ items });
const oneOf = (...values) => ({ values });
const types = {
  FollowRequest: object({
    resource: oneOf("run", "task", "invocation"),
    id: "id",
    "cursor?": "string|null",
  }),
  FollowChange: object({
    sequence: "id",
    resource: "string",
    resource_id: "id",
    run_id: "id",
    revision: "count",
    "run_revision?": "count",
    "event?": "Event",
  }),
  FollowFrame: object({
    state: oneOf("snapshot", "delta", "reset_required"),
    resource: oneOf("run", "task", "invocation"),
    id: "id",
    instance_id: "string",
    generation: "string",
    from_cursor: "string|null",
    cursor: "string|null",
    has_more: "boolean",
    changes: array("FollowChange"),
    snapshot: "FollowSnapshot|null",
  }),
  FollowSnapshot: object({
    value: "RunSnapshot|Task|Invocation",
    "events?": "EventPage",
  }),
  FollowContent: object({
    id: "id",
    field: oneOf("goal", "output"),
    revision: "count",
    offset: "count",
  }),
  FollowContentPage: object({
    state: oneOf("content", "reset_required"),
    revision: "count",
    text: "string",
    next_offset: "count|null",
  }),
  OperationQuery: object({ operation_id: "string", instance_id: "string" }),
  OperationRequest: object({
    operation_id: "string",
    instance_id: "string",
    method: "string",
    input: "json",
    "expected_revision?": "count|null",
  }),
  OperationReceipt: object({
    operation_id: "string",
    instance_id: "string",
    state: oneOf(
      "not_found",
      "committed",
      "rejected",
      "conflict",
      "needs_reconciliation",
      "dismissed",
    ),
    "method?": "string",
    "result?": "json",
    "error?": "json",
    "execution_ref?": "id|null",
  }),
  Id: object({ id: "id" }),
  Page: object({ "offset?": "count" }),
  Events: object({ id: "id", "before?": "id|null" }),
  Content: object({ id: "id", field: oneOf("goal", "output") }),
  Approval: object({ id: "id", epoch: "id", approved: "boolean" }),
  Reconcile: object({
    id: "id",
    epoch: "id",
    source: oneOf("receipt", "reviewed"),
    note: "string",
  }),
  Start: object({
    client_run_id: "string",
    workspace_id: "id",
    "provider_id?": "string",
    "action?": object({ name: "string", arguments: "json" }),
    goal: "string",
    "agent_id?": "id",
    "workflow_id?": "string|null",
    "authorization_id?": "string|null",
    "project_ids?": array("string"),
    "rule_id?": "string|null",
    "rule_management_authorization_id?": "string|null",
  }),
  Steer: object({ id: "id", client_input_id: "string", text: "string" }),
  Run: object({
    "group_id?":"id|null","group_delivery_id?":"id|null","group_chain_id?":"string|null","group_topic_id?":"id|null",
    "work_item_id?": "id|null",
    "work_definition_revision?": "id|null",
    "kind?": oneOf("agent", "tool_action", "external_cli"),
    "authorization_id?": "string|null",
    "authorization_revision?": "count|null",
    "trigger?": "json",
    "rule_id?": "string|null",
    "chain_id?": "string|null",
    "chain_depth?": "count|null",
    id: "id",
    epoch: "id",
    revision: "count",
    state: "string",
    intent: "string|null",
    title: "string",
    waiting: array("string"),
    "goal?": "string",
    "output?": "string",
  }),
  Invocation: object({
    "permission_plan?": "json",
    id: "id",
    epoch: "id",
    state: "string",
    name: "string",
    approval: "boolean|null",
    "revision?": "count",
    "allowed_actions?": "ExecutionActions",
    "reviewed?": "boolean|null",
  }),
  Task: object({
    id: "id",
    owner_run_id: "id",
    epoch: "id",
    kind: oneOf("agent", "background", "external_cli"),
    "evidence?": "CliEvidence",
    "permission_plan?": "CliPermissionPlan|AuthorizationEvaluation",
    "allowed_actions?": "ExecutionActions",
    state: "string",
    "revision?": "count",
    "child_run_id?": "id|null",
  }),
  Tasks: object({ items: array("Task") }),
  ExecutionActions: object({
    "request_scope_change?": "ActionAvailability",
    "respond?": "ActionAvailability",
    "review?": "ActionAvailability",
    "resume?": "ActionAvailability",
    "stop?": "ActionAvailability",
    "approve?": "ActionAvailability",
    "reconcile?": "ActionAvailability",
    "reconcile_receipt?": "ActionAvailability",
    "compact?": "ActionAvailability",
    "steer?": "ActionAvailability",
  }),
  ActionAvailability: object({ allowed: "boolean", reason: "string|null" }),
  RunSnapshot: object({
    run: "Run",
    invocations: array("Invocation"),
    tasks: array("Task"),
    hooks_unresolved: "boolean",
    mcp_unresolved: "boolean",
    "allowed_actions?": "ExecutionActions",
  }),
  RunPage: object({
    items: array("Run"),
    total: "count",
    next_offset: "count|null",
  }),
  Event: object({ id: "id", kind: "string" }),
  EventPage: object({ items: array("Event"), next_before: "id|null" }),
  Accepted: object({ accepted: "boolean" }),
  Started: object({ run: "Run", duplicate: "boolean" }),
  Text: object({ text: "string" }),
  Session: object({
    id: "id",
    title: "string",
    updated_at: "string",
    provider_id: "string|null",
    active_turn_id: "id|null",
  }),
  SessionPage: object({
    items: array("Session"),
    total: "count",
    next_offset: "count|null",
  }),
  Message: object({
    id: "id",
    turn_id: "id",
    role: "string",
    content: "string",
    status: "string",
  }),
  MessagePage: object({ items: array("Message"), next_before: "id|null" }),
  Messages: object({ conversation_id: "id", "before?": "id|null" }),
  CreateSession: object({ title: "string", "workspace_id?": "id|null" }),
  Send: object({
    conversation_id: "id",
    provider_id: "string",
    client_turn_id: "string",
    text: "string",
  }),
  Turn: object({ turn_id: "id" }),
  Removed: object({ removed: "boolean" }),
  TurnReceipt: object({
    turn_id: "id",
    conversation_id: "id",
    status: "string",
    duplicate: "boolean",
  }),
  CancelledTurn: object({ cancelled: "boolean" }),
  Empty: object({}),
};
// mode describes the existing positional preload facade, never arbitrary IPC.
const method = (
  bridge,
  channel,
  input,
  output,
  mode = "object",
  command = false,
) => ({ bridge, channel, input, output, mode, command });
const methods = {
  "agent.follow": method(
    "followExecution",
    "agent-follow",
    "FollowRequest",
    "FollowFrame",
  ),
  "agent.follow-content": method(
    "getFollowContent",
    "agent-follow-content",
    "FollowContent",
    "FollowContentPage",
  ),
  "operations.execute": method(
    "executeOperation",
    "operations-execute",
    "OperationRequest",
    "OperationReceipt",
    "object",
    true,
  ),
  "operations.get": method(
    "getOperation",
    "operations-get",
    "OperationQuery",
    "OperationReceipt",
  ),
  "agent.list": method("listRuns", "agent-list", "Page", "RunPage", "offset"),
  "agent.get": method("getRun", "agent-get", "Id", "RunSnapshot", "id"),
  "agent.content": method(
    "getRunContent",
    "agent-content",
    "Content",
    "Text",
    "content",
  ),
  "agent.events": method(
    "listRunEvents",
    "agent-events",
    "Events",
    "EventPage",
    "events",
  ),
  "agent.event": method("getRunEvent", "agent-event", "Id", "Event", "id"),
  "agent.invocation": method(
    "getInvocation",
    "agent-invocation",
    "Id",
    "Invocation",
    "id",
  ),
  "agent.start": method(
    "startRun",
    "agent-start",
    "Start",
    "Started",
    "object",
    true,
  ),
  "agent.cancel": method("cancelRun", "agent-cancel", "Id", "Run", "id", true),
  "agent.approve": method(
    "approveInvocation",
    "agent-approve",
    "Approval",
    "Accepted",
    "object",
    true,
  ),
  "agent.steer": method(
    "steerRun",
    "agent-steer",
    "Steer",
    "Accepted",
    "object",
    true,
  ),
  "agent.reconcile": method(
    "reconcileInvocation",
    "agent-reconcile",
    "Reconcile",
    "Accepted",
    "object",
    true,
  ),
  "agent.resume": method("resumeRun", "agent-resume", "Id", "Run", "id", true),
  "agent.tasks": method("listOwnedTasks", "agent-tasks", "Id", "Tasks", "id"),
  "agent.task": method("getOwnedTask", "agent-task", "Id", "Task", "id"),
  "agent.stop-task": method(
    "stopOwnedTask",
    "agent-stop-task",
    "Id",
    "Task",
    "id",
    true,
  ),
  "agent.reconcile-task": method(
    "reconcileOwnedTask",
    "agent-reconcile-task",
    "Reconcile",
    "Task",
    "object",
    true,
  ),
  "agent.compact": method(
    "compactRun",
    "agent-compact",
    "Id",
    "Accepted",
    "id",
    true,
  ),
  "agent.checkpoints": method(
    "listContextCheckpoints",
    "agent-checkpoints",
    "Id",
    array("json"),
    "id",
  ),
  "memory.agents": method(
    "listMemoryAgents",
    "memory-agents",
    "Empty",
    array("json"),
    "none",
  ),
  "chat.list": method(
    "listConversations",
    "conversations",
    "Page",
    "SessionPage",
    "offset",
  ),
  "chat.messages": method(
    "listMessages",
    "messages",
    "Messages",
    "MessagePage",
    "messages",
  ),
  "chat.create": method(
    "createConversation",
    "create-conversation",
    "CreateSession",
    "Id",
    "object",
    true,
  ),
  "chat.send": method(
    "sendMessage",
    "send-message",
    "Send",
    "TurnReceipt",
    "object",
    true,
  ),
  "chat.cancel": method(
    "cancelTurn",
    "cancel-turn",
    "Turn",
    "CancelledTurn",
    "turn",
    true,
  ),
  "chat.remove": method(
    "removeConversation",
    "remove-conversation",
    "Id",
    "Removed",
    "id",
    true,
  ),
};
const resources = require("./resources.cjs")({ object, array, oneOf, method });
Object.assign(types, resources.types);
Object.assign(methods, resources.methods);
function valid(schema, value, strict = false) {
  if (typeof schema === "string") {
    if (schema.includes("|"))
      return schema.split("|").some((s) => valid(s, value, strict));
    if (Object.hasOwn(types, schema))
      return valid(types[schema], value, strict);
    if (schema === "json") return value !== undefined;
    if (schema === "null") return value === null;
    if (schema === "id") return Number.isSafeInteger(value) && value > 0;
    if (schema === "count") return Number.isSafeInteger(value) && value >= 0;
    return typeof value === schema;
  }
  if (schema.record)
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((v) => valid(schema.record, v, strict))
    );
  if (schema.items)
    return (
      Array.isArray(value) && value.every((v) => valid(schema.items, v, strict))
    );
  if (schema.values) return schema.values.includes(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(schema.fields);
  if (
    strict &&
    Object.keys(value).some((k) => !keys.includes(k) && !keys.includes(k + "?"))
  )
    return false;
  return keys.every((key) => {
    const optional = key.endsWith("?"),
      name = optional ? key.slice(0, -1) : key;
    return (
      (optional && value[name] === undefined) ||
      valid(schema.fields[key], value[name], strict)
    );
  });
}
function validate(name, value, response = false) {
  const definition = Object.hasOwn(methods, name) && methods[name];
  if (
    !definition ||
    !valid(definition[response ? "output" : "input"], value, !response)
  ) {
    const error = Error(
      response ? `Core 返回值不符合契约：${name}` : `请求不符合契约：${name}`,
    );
    error.kind = response ? "invalid_response" : "invalid_request";
    throw error;
  }
  return value;
}
function argumentsFor(definition, input) {
  switch (definition.mode) {
    case "id":
      return [input.id];
    case "turn":
      return [input.turn_id];
    case "offset":
      return [input.offset ?? 0];
    case "events":
      return [input.id, input.before ?? null];
    case "content":
      return [input.id, input.field];
    case "messages":
      return [input.conversation_id, input.before ?? null];
    case "none":
      return [];
    default:
      return [input];
  }
}
function ipcInput(method, args) {
  if (!method.startsWith("chat.")) return args[0] ?? {};
  switch (methods[method].mode) {
    case "id":
      return { id: args[0] };
    case "turn":
      return { turn_id: args[0] };
    case "offset":
      return { offset: args[0] ?? 0 };
    case "messages":
      return { conversation_id: args[0], before: args[1] ?? null };
    default:
      return args[0];
  }
}
module.exports = {
  operationCommands: [
    ...Object.entries(resources.methods)
      .filter(([name, d]) => d.command && !name.startsWith("desktop."))
      .map(([name]) => name),
    "agent.start",
    "agent.cancel",
    "agent.approve",
    "agent.steer",
    "agent.reconcile",
    "agent.resume",
    "agent.stop-task",
    "agent.reconcile-task",
    "agent.compact",
  ],
  version: 1,
  protocol: 10,
  types,
  methods,
  valid,
  validate,
  argumentsFor,
  ipcInput,
};
