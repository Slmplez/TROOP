import { TroopClient } from "../renderer/client/troop-client.mjs";
import { ClientModels } from "../renderer/client/models.mjs";
const client = new TroopClient({});
const models = new ClientModels(client);
const observedRevision: number | undefined = models.run(1).getSnapshot().data
  ?.run.revision;
void observedRevision;
// @ts-expect-error Resource model keys use numeric IDs.
models.task("other-task");
const run = await client.request("agent.get", { id: 1 });
const revision: number = run.run.revision;
void revision;
const providers = await models.fetchResource("provider.list", {});
const modelName: string | undefined = providers[0]?.config.model;
void modelName;
const authorization = await models.fetchResource("authorizations.get", {
  id: "grant",
});
const evaluatedRevision: number | undefined =
  authorization.last_evaluation?.grant_revision;
void evaluatedRevision;
const evaluated = await models.fetchResource("authorizations.evaluate", {
  id: "grant",
  agent_id: 1,
  engine_id: "native",
  workspace_id: 1,
  project_ids: [],
  rule_id: null,
  operation: "read_file",
  network: "none",
});
const decision: "allow" | "deny" | "needs_user" = evaluated.decision;
void decision;
// @ts-expect-error Revoking an authorization requires an exact revision.
models.command("authorizations.revoke", { id: "grant" });
models.command("memory.edit", {
  agent_id: 1,
  id: 2,
  expected_revision: 3,
  content: "updated",
});
// @ts-expect-error Editing memory must use an exact revision.
models.command("memory.edit", { agent_id: 1, id: 2, content: "updated" });
client.request("mcp.save", {
  expected_revision: 0,
  // @ts-expect-error MCP transport must use a supported discriminator.
  definition: { name: "service", transport: "shell", location: "remote" },
});
const followed = await client.request("agent.follow", {
  resource: "run",
  id: 1,
  cursor: null,
});
const followCursor: string | null = followed.cursor;
void followCursor;
// @ts-expect-error Follow only accepts the declared execution resources.
client.request("agent.follow", { resource: "shell", id: 1 });
// @ts-expect-error Content references require a revision.
client.request("agent.follow-content", { id: 1, field: "output", offset: 0 });
// @ts-expect-error IDs are numbers, not paths or strings.
client.request("agent.get", { id: "1" });
// @ts-expect-error No arbitrary transport method.
client.request("shell.execute", {});
// @ts-expect-error Exact invocation epoch is required for approval.
client.request("agent.approve", { id: 1, approved: true });
client.request("agent.reconcile", {
  id: 1,
  epoch: 1,
  // @ts-expect-error Reconciliation is an explicit source, not automatic replay.
  source: "replay",
  note: "",
});

const workItem = await client.request("work_items.get", { id: 1 });
const group = await client.request("groups.get", { id: 1 });
const groupCanSend: boolean = group.allowed_actions.send.allowed;
void groupCanSend;
models.command("groups.send", {
  group_id: 1,
  expected_revision: 1,
  client_message_id: "id",
  body: "hello",
  // @ts-expect-error Group mentions use numeric Agent identities.
  mention_agent_ids: ["Beta"],
});
models.command("groups.send", {
  group_id: 1,
  expected_revision: 1,
  client_message_id: "id",
  body: "hello",
  // @ts-expect-error Sender identity cannot be supplied by the renderer.
  sender_agent_id: 1,
});
const canSaveWorkItem: boolean = workItem.allowed_actions.save.allowed;
void canSaveWorkItem;
const workHistory = await client.request("work_items.runs", { id: 1 });
const canAcceptWorkResult: boolean | undefined =
  workHistory.items[0]?.allowed_actions.accept.allowed;
void canAcceptWorkResult;
models.command("work_items.start", {
  id: 1,
  expected_revision: 1,
  // @ts-expect-error Native work execution requires a model provider.
  execution: { kind: "agent" },
});
// @ts-expect-error Work acceptance requires fixed evidence and a Run revision.
models.command("work_items.accept", {
  id: 1,
  expected_revision: 1,
  run_id: 1,
  note: "accept",
});
models.command("work_items.save", {
  expected_revision: 0,
  item: {
    title: "检查",
    goal: "检查",
    acceptance: "报告",
    // @ts-expect-error Work item ownership uses a registered Agent ID.
    owner_agent_id: "one",
    workspace_id: 1,
  },
});
const reminderPreview = await models.read("reminders.preview", {
  schedule: { kind: "daily", timezone: "Asia/Shanghai", time: "09:00" },
});
const previewSlotKey: string | undefined = reminderPreview.slots[0]?.slot_key;
void previewSlotKey;
const reminderSnapshot = await models.fetchResource("reminders.get", {
  id: "reminder",
});
const reminderEnabled: boolean = reminderSnapshot.enabled;
void reminderEnabled;
// @ts-expect-error Native notification claim belongs only to the trusted main process.
models.command("notifications.claim", {
  consumer_id: "consumer",
  focused: false,
});
// @ts-expect-error Cancelling a reminder requires its exact current revision.
models.command("reminders.cancel", { id: "reminder" });
const scheduled = await models.fetchResource("schedules.get", {
  id: "time-rule",
});
const canEnable: boolean | undefined =
  scheduled.allowed_actions?.set_enabled.allowed;
void canEnable;
const scheduledHistory = models.resource("schedules.history", {
  id: "time-rule",
});
const scheduledState: "dispatched" | "blocked" | "skipped" | undefined =
  scheduledHistory.getSnapshot().data?.items[0]?.state;
void scheduledState;
// @ts-expect-error Enabling a scheduled rule requires a concrete boolean state.
models.command("schedules.set_enabled", {
  id: "time-rule",
  expected_revision: 1,
});
