import React, { useEffect, useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { actionFor } from "./client/actions.mjs";
import GroupExecution, { GroupChain } from "./GroupExecution";
import TopicSettings from "./TopicSettings";

const deliveryStates = {
  queued: "待调度",
  waiting_resume: "等待继续",
  rejected: "已拒绝",
  cancelled: "已取消",
  blocked: "等待配置核对",
  dispatched: "已派发，待采纳证据",
  adopted: "已采纳",
  awaiting_reconciliation: "等待执行核对",
};
function stored(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
function persist(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
const definition = (group) => ({
  name: group.name,
  rules: group.rules,
  project_id: group.project_id,
  paused: group.paused,
});
function validDefinition(value) {
  return (
    value &&
    typeof value.name === "string" &&
    typeof value.rules === "string" &&
    typeof value.paused === "boolean" &&
    (value.project_id === null || typeof value.project_id === "string")
  );
}

export default function GroupChatPanel({ ready, workspaces, onOpenRun }) {
  const prefix = `troop-groups:${clientModels.instance}`;
  const [selected, setSelected] = useState(() => {
    const id = stored(`${prefix}:selected`);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });
  const [archived, setArchived] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [draft, setDraft] = useState(() => {
    const value = stored(`${prefix}:new`);
    return validDefinition(value)
      ? value
      : { name: "", rules: "", project_id: null, paused: false };
  });
  const lock = useRef(false);
  const listModel = clientModels.resource("groups.list", { archived });
  const list = useClientModel(listModel, ready);
  const detail = useClientModel(
    selected ? clientModels.resource("groups.get", { id: selected }) : null,
    ready,
  );
  const agents = useClientModel(clientModels.agents(), ready);
  const projects = useClientModel(
    clientModels.resource("memory.projects", { agent_id: 1 }),
    ready,
  );
  useEffect(() => persist(`${prefix}:selected`, selected), [prefix, selected]);
  useEffect(() => persist(`${prefix}:new`, draft), [prefix, draft]);
  async function perform(method, input, accept) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await clientModels.command(method, input);
      if (result?.cancelled !== true) accept?.(result);
    } catch (error) {
      setError(error.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="models-page work-board group-chat-page">
      <div className="title-row">
        <h1>Agent 群聊</h1>
        <button
          id="group-new"
          disabled={!ready || busy}
          onClick={() => {
            setSelected(null);
            setError("");
          }}
        >
          新建群聊
        </button>
      </div>
      <p className="muted">
        组织自己的 Agent，使用明确目标发送消息并查看持久投递记录。
      </p>
      {(error || list.error || detail.error) && (
        <p role="alert">
          {error || list.error?.message || detail.error?.message}
        </p>
      )}
      <div className="group-chat-layout">
        <section aria-label="群聊列表">
          <label htmlFor="group-filter-archive">群聊记录</label>
          <select
            id="group-filter-archive"
            value={String(archived)}
            onChange={(event) => setArchived(event.target.value === "true")}
          >
            <option value="false">当前群聊</option>
            <option value="true">已归档群聊</option>
          </select>
          {list.loading && !list.data && <p role="status">正在读取群聊…</p>}
          {list.data?.items.length === 0 && <p className="muted">暂无群聊。</p>}
          <ul className="group-list">
            {list.data?.items.map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={selected === group.id}
                  onClick={() => {
                    setSelected(group.id);
                    setError("");
                  }}
                >
                  <strong>{group.name}</strong>
                  <span>
                    {group.members.length} 位成员 ·{" "}
                    {group.project_id ?? "未绑定项目"}
                  </span>
                  <span>
                    {group.paused ? "响应已暂停" : "响应已启用"} · 修订{" "}
                    {group.revision}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {list.data?.next_before && (
            <button disabled={list.loading} onClick={() => listModel.more()}>
              加载更多群聊
            </button>
          )}
        </section>
        <section aria-label="群聊详情">
          {selected ? (
            detail.data ? (
              <GroupConversation
                key={selected}
                group={detail.data}
                ready={ready}
                busy={busy}
                perform={perform}
                agents={agents.data ?? []}
                projects={projects.data ?? []}
                prefix={prefix}
                workspaces={workspaces}
                onOpenRun={onOpenRun}
              />
            ) : (
              <p>正在读取群聊详情…</p>
            )
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(
                  "groups.save",
                  { expected_revision: 0, group: draft },
                  (group) => {
                    setSelected(group.id);
                    setDraft({
                      name: "",
                      rules: "",
                      project_id: null,
                      paused: false,
                    });
                  },
                );
              }}
            >
              <h2>新建群聊</h2>
              <fieldset disabled={!ready || busy}>
                <label htmlFor="group-create-name">群名称</label>
                <input
                  id="group-create-name"
                  required
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
                <label htmlFor="group-create-project">绑定项目，可选</label>
                <select
                  id="group-create-project"
                  value={draft.project_id ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      project_id: event.target.value || null,
                    })
                  }
                >
                  <option value="">未绑定项目</option>
                  {projects.data?.map((project) => (
                    <option key={project.slug} value={project.slug}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <label htmlFor="group-create-rules">群规则</label>
                <textarea
                  id="group-create-rules"
                  value={draft.rules}
                  onChange={(event) =>
                    setDraft({ ...draft, rules: event.target.value })
                  }
                />
                <button id="group-create" type="submit">
                  创建群聊
                </button>
              </fieldset>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
function GroupConversation(props) {
  const { group, ready, busy, perform, prefix } = props;
  const key = `${prefix}:${group.id}:topic`;
  const [selected, setSelected] = useState(() => {
    const id = stored(key);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });
  const [active, setActive] = useState(() =>
    stored(`${key}:pane`) === "topic" ? "topic" : "main",
  );
  const [focused, setFocused] = useState(null);
  const topicsModel = clientModels.resource("topics.list", {
    group_id: group.id,
  });
  const topics = useClientModel(topicsModel, ready);
  const topic = useClientModel(
    selected ? clientModels.resource("topics.get", { id: selected }) : null,
    ready,
  );
  useEffect(() => persist(key, selected), [key, selected]);
  useEffect(() => persist(`${key}:pane`, active), [key, active]);
  function open(id) {
    setSelected(id);
    setActive("topic");
  }
  function source() {
    setFocused(topic.data.source_message);
    setActive("main");
    requestAnimationFrame(() =>
      document
        .querySelector(
          `#main-group-pane [data-message-id="${topic.data.source_message_id}"]`,
        )
        ?.scrollIntoView({ block: "center" }),
    );
  }
  const current = topic.data?.source_group_id === group.id ? topic.data : null;
  return (
    <div
      className="group-topic-workspace"
      data-active-pane={active}
      data-has-topic={Boolean(selected)}
    >
      <div className="topic-toolbar">
        <button
          id="group-main-tab"
          type="button"
          aria-pressed={active === "main"}
          onClick={() => setActive("main")}
        >
          主群
        </button>
        <label htmlFor="group-topic-select">话题</label>
        <select
          id="group-topic-select"
          value={selected ?? ""}
          onChange={(event) => {
            if (event.target.value) open(Number(event.target.value));
            else {
              setSelected(null);
              setActive("main");
            }
          }}
        >
          <option value="">从消息展开讨论</option>
          {topics.data?.items.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.archived ? "已归档 · " : ""}
              {entry.name}
            </option>
          ))}
          {current &&
            !topics.data?.items.some((entry) => entry.id === current.id) && (
              <option value={current.id}>{current.name}</option>
            )}
        </select>
        {topics.data?.next_before && (
          <button
            type="button"
            disabled={topics.loading}
            onClick={() => topicsModel.more()}
          >
            加载更早话题
          </button>
        )}
        {selected && (
          <>
            <button
              id="group-topic-tab"
              type="button"
              aria-pressed={active === "topic"}
              onClick={() => setActive("topic")}
            >
              话题讨论
            </button>
            <button
              id="group-topic-close"
              type="button"
              onClick={() => {
                setSelected(null);
                setActive("main");
              }}
            >
              关闭话题面板
            </button>
          </>
        )}
      </div>
      {topics.error && <p role="alert">{topics.error.message}</p>}
      <div className="group-topic-streams">
        <section id="main-group-pane" aria-label="主群讨论">
          <GroupDetail
            {...props}
            compact={Boolean(selected)}
            onOpenTopic={open}
            focusedMessage={focused}
          />
        </section>
        {selected && (
          <section id="topic-pane" aria-label="话题讨论">
            {topic.error && <p role="alert">{topic.error.message}</p>}
            {current ? (
              <>
                <TopicSettings
                  key={`settings:${current.id}`}
                  topic={current}
                  ready={ready}
                  busy={busy}
                  perform={perform}
                  prefix={prefix}
                  onSource={source}
                />
                <GroupDetail
                  key={current.id}
                  {...props}
                  group={current}
                  compact
                />
              </>
            ) : (
              <p role="status">正在读取当前群话题…</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function GroupDetail({
  group,
  ready,
  busy,
  perform,
  agents,
  projects,
  prefix,
  workspaces,
  onOpenRun,
  compact = false,
  onOpenTopic,
  focusedMessage,
}) {
  const isTopic = Boolean(group.source_group_id);
  const fieldId = (id) => (isTopic ? `topic-${id}` : id);
  const scroll = useRef(null),
    restored = useRef(false);
  const scrollKey = `${prefix}:${group.id}:scroll`;
  const configKey = `${prefix}:${group.id}:settings`,
    messageKey = `${prefix}:${group.id}:message`;
  const [config, setConfig] = useState(() => {
    const value = stored(configKey);
    return validDefinition(value?.group) &&
      Number.isSafeInteger(value.expected_revision)
      ? value
      : null;
  });
  const freshMessage = () => ({
    client_message_id: crypto.randomUUID(),
    body: "",
    mention_agent_ids: [],
    broadcast: false,
    reply_to: null,
    work_item_id: null,
    execute_work_item: false,
  });
  const [message, setMessage] = useState(() => {
    const value = stored(messageKey);
    return value &&
      typeof value.client_message_id === "string" &&
      typeof value.body === "string" &&
      Array.isArray(value.mention_agent_ids) &&
      value.mention_agent_ids.every(
        (id) => Number.isSafeInteger(id) && id > 0,
      ) &&
      typeof value.broadcast === "boolean" &&
      (value.reply_to === null || Number.isSafeInteger(value.reply_to))
      ? value
      : freshMessage();
  });
  const [newMember, setNewMember] = useState(""),
    [selectedMessage, setSelectedMessage] = useState(null),
    [selectedChain, setSelectedChain] = useState(null);
  const messagesModel = clientModels.resource("groups.messages", {
    group_id: group.id,
  });
  const messages = useClientModel(messagesModel, ready);
  useEffect(() => {
    if (!compact) {
      restored.current = false;
      return;
    }
    if (messages.data && !restored.current && scroll.current) {
      scroll.current.scrollTop = Number(stored(scrollKey)) || 0;
      restored.current = true;
    }
  }, [compact, messages.data, scrollKey]);
  const deliveriesModel = clientModels.resource("groups.deliveries", {
    group_id: group.id,
    ...(selectedMessage ? { message_id: selectedMessage } : {}),
  });
  const deliveries = useClientModel(deliveriesModel, ready);
  const preview = useClientModel(
    clientModels.resource("groups.preview", {
      group_id: group.id,
      expected_revision: group.revision,
      mention_agent_ids: message.mention_agent_ids,
      broadcast: message.broadcast,
      reply_to: message.reply_to,
    }),
    ready,
  );
  useEffect(() => persist(configKey, config), [configKey, config]);
  useEffect(() => persist(messageKey, message), [messageKey, message]);
  const stale = config && config.expected_revision !== group.revision;
  const settings = config?.group ?? definition(group);
  const locked = !ready || busy;
  const agentName = (id) =>
    agents.find((agent) => agent.id === id)?.name ?? `Agent #${id}`;
  function changeConfig(key, value) {
    setConfig((previous) => ({
      expected_revision: previous?.expected_revision ?? group.revision,
      group: { ...(previous?.group ?? definition(group)), [key]: value },
    }));
  }
  function changeMember(member, changes) {
    void perform("groups.member", {
      id: group.id,
      expected_revision: group.revision,
      agent_id: member.agent_id,
      ...changes,
    });
  }
  return (
    <div
      ref={scroll}
      className={compact ? "group-stream-pane" : undefined}
      onScroll={() => {
        if (compact) persist(scrollKey, scroll.current.scrollTop);
      }}
    >
      <h2>{group.name}</h2>
      <p className="muted">
        {isTopic ? "话题" : "群"} #{group.id} · 修订 {group.revision} ·{" "}
        {group.project_id ?? "未绑定项目"}
      </p>
      {!isTopic && (
        <>
          <details open={!compact}>
            <summary>群设置与成员</summary>
            {stale && (
              <p role="status">
                群设置已有新修订。草稿保留，请载入最新设置后核对。
              </p>
            )}
            <button
              id={fieldId("group-config-refresh")}
              type="button"
              disabled={locked}
              onClick={() => setConfig(null)}
            >
              载入最新设置
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(
                  "groups.save",
                  {
                    id: group.id,
                    expected_revision:
                      config?.expected_revision ?? group.revision,
                    group: settings,
                  },
                  () => setConfig(null),
                );
              }}
            >
              <fieldset disabled={locked || !actionFor(group, "save").allowed}>
                <label htmlFor={fieldId("group-name")}>群名称</label>
                <input
                  id={fieldId("group-name")}
                  required
                  value={settings.name}
                  onChange={(event) => changeConfig("name", event.target.value)}
                />
                <label htmlFor={fieldId("group-project")}>绑定项目</label>
                <select
                  id={fieldId("group-project")}
                  value={settings.project_id ?? ""}
                  onChange={(event) =>
                    changeConfig("project_id", event.target.value || null)
                  }
                >
                  <option value="">未绑定项目</option>
                  {projects.map((project) => (
                    <option key={project.slug} value={project.slug}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <label htmlFor={fieldId("group-rules")}>群规则</label>
                <textarea
                  id={fieldId("group-rules")}
                  value={settings.rules}
                  onChange={(event) =>
                    changeConfig("rules", event.target.value)
                  }
                />
                <label className="group-inline">
                  <input
                    id={fieldId("group-paused")}
                    type="checkbox"
                    checked={settings.paused}
                    onChange={(event) =>
                      changeConfig("paused", event.target.checked)
                    }
                  />
                  暂停群响应
                </label>
                <button
                  id={fieldId("group-save")}
                  type="submit"
                  disabled={!config || stale}
                >
                  保存群设置
                </button>
              </fieldset>
            </form>
            <button
              id={fieldId("group-archive")}
              type="button"
              disabled={
                locked ||
                !actionFor(group, group.archived ? "restore" : "archive")
                  .allowed
              }
              title={
                actionFor(group, group.archived ? "restore" : "archive")
                  .reason ?? undefined
              }
              onClick={() =>
                void perform("groups.archive", {
                  id: group.id,
                  expected_revision: group.revision,
                  archived: !group.archived,
                })
              }
            >
              {group.archived ? "恢复群聊" : "归档群聊"}
            </button>
            <div className="group-member-add">
              <label htmlFor={fieldId("group-add-agent")}>
                添加 Agent，默认被动监听
              </label>
              <select
                id={fieldId("group-add-agent")}
                value={newMember}
                disabled={locked || !actionFor(group, "member").allowed}
                onChange={(event) => setNewMember(event.target.value)}
              >
                <option value="">选择 Agent</option>
                {agents
                  .filter(
                    (agent) =>
                      !group.members.some(
                        (member) => member.agent_id === agent.id,
                      ),
                  )
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
              </select>
              <button
                id={fieldId("group-add-member")}
                type="button"
                disabled={
                  locked || !newMember || !actionFor(group, "member").allowed
                }
                onClick={() =>
                  void perform(
                    "groups.member",
                    {
                      id: group.id,
                      expected_revision: group.revision,
                      agent_id: Number(newMember),
                    },
                    () => setNewMember(""),
                  )
                }
              >
                加入群聊
              </button>
            </div>
            <ul className="group-member-list">
              {group.members.map((member) => (
                <li key={member.agent_id} data-agent-id={member.agent_id}>
                  <strong>{member.agent_name}</strong>
                  <label>
                    监听方式
                    <select
                      aria-label={`${member.agent_name} 监听方式`}
                      disabled={locked || !actionFor(group, "member").allowed}
                      value={member.listen_mode}
                      onChange={(event) =>
                        changeMember(member, {
                          listen_mode: event.target.value,
                        })
                      }
                    >
                      <option value="passive">被动，等待点名</option>
                      <option value="active">主动，接收普通消息</option>
                    </select>
                  </label>
                  <label className="group-inline">
                    <input
                      type="checkbox"
                      aria-label={`${member.agent_name} 接收群消息`}
                      checked={member.receiving}
                      disabled={locked || !actionFor(group, "member").allowed}
                      onChange={(event) =>
                        changeMember(member, {
                          receiving: event.target.checked,
                        })
                      }
                    />
                    接收群消息
                  </label>
                  <button
                    type="button"
                    aria-label={`移除 ${member.agent_name}`}
                    disabled={locked || !actionFor(group, "member").allowed}
                    onClick={() => changeMember(member, { remove: true })}
                  >
                    移除
                  </button>
                  {member.receive_availability.reason && (
                    <p className="muted">
                      {member.receive_availability.reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </details>
          <GroupExecution
            group={group}
            ready={ready}
            busy={busy}
            perform={perform}
            workspaces={workspaces}
          />
        </>
      )}
      {selectedChain && (
        <GroupChain
          key={selectedChain}
          id={selectedChain}
          ready={ready}
          busy={busy}
          perform={perform}
        />
      )}
      <section aria-label={isTopic ? "话题消息" : "群消息"}>
        <h2>{isTopic ? "话题消息" : "群消息"}</h2>
        {messages.error && <p role="alert">{messages.error.message}</p>}
        {messages.data?.items.length === 0 && (
          <p className="muted">还没有消息。</p>
        )}
        {[
          ...(messages.data?.items ?? []),
          ...(focusedMessage &&
          !messages.data?.items.some((entry) => entry.id === focusedMessage.id)
            ? [focusedMessage]
            : []),
        ]
          .sort((a, b) => a.id - b.id)
          .map((entry) => (
            <article
              className="group-message"
              key={entry.id}
              data-message-id={entry.id}
            >
              <h3>
                {entry.sender_agent_id
                  ? agentName(entry.sender_agent_id)
                  : "我"}{" "}
                · 消息 #{entry.id}
              </h3>
              {entry.reply_to && <p>回复消息 #{entry.reply_to}</p>}
              {entry.source_topic_id && (
                <p>
                  来自话题 #{entry.source_topic_id} · 话题消息 #
                  {entry.source_topic_message_id}
                </p>
              )}
              {!isTopic && onOpenTopic && (
                <button
                  type="button"
                  className="group-open-topic"
                  disabled={locked || !actionFor(group, "send").allowed}
                  onClick={() =>
                    void perform(
                      "topics.create",
                      {
                        source_group_id: group.id,
                        source_message_id: entry.id,
                        expected_group_revision: group.revision,
                        name:
                          Array.from(entry.body.trim()).slice(0, 60).join("") ||
                          "讨论",
                      },
                      (topic) => onOpenTopic(topic.id),
                    )
                  }
                >
                  在话题中讨论
                </button>
              )}
              {entry.source_run_id && (
                <button
                  type="button"
                  onClick={() => onOpenRun(entry.source_run_id)}
                >
                  查看来源 Run #{entry.source_run_id}
                </button>
              )}
              {entry.work_item_id && (
                <GroupWork
                  id={entry.work_item_id}
                  ready={ready}
                  onOpenRun={onOpenRun}
                />
              )}
              <pre>{entry.body}</pre>
              <p className="muted">
                目标{" "}
                {entry.recipient_agent_ids.map(agentName).join("、") ||
                  "无接收候选"}
              </p>
              <p>
                待调度 {entry.delivery_summary.queued} · 等待继续{" "}
                {entry.delivery_summary.waiting_resume} · 已拒绝{" "}
                {entry.delivery_summary.rejected} · 已取消{" "}
                {entry.delivery_summary.cancelled}
                {" · 已派发 "}
                {entry.delivery_summary.dispatched ?? 0}
                {" · 已采纳 "}
                {entry.delivery_summary.adopted ?? 0}
                {" · 待核对 "}
                {(entry.delivery_summary.blocked ?? 0) +
                  (entry.delivery_summary.awaiting_reconciliation ?? 0)}
              </p>
              {entry.chain_id && (
                <button
                  type="button"
                  onClick={() => setSelectedChain(entry.chain_id)}
                >
                  查看本次协作
                </button>
              )}
              <button
                type="button"
                disabled={locked || !actionFor(group, "send").allowed}
                onClick={() =>
                  setMessage((previous) => ({
                    ...previous,
                    reply_to: entry.id,
                  }))
                }
              >
                回复消息 #{entry.id}
              </button>
              <button
                type="button"
                aria-pressed={selectedMessage === entry.id}
                onClick={() => setSelectedMessage(entry.id)}
              >
                查看消息 #{entry.id} 的投递
              </button>
            </article>
          ))}
        {messages.data?.next_before && (
          <button
            disabled={messages.loading}
            onClick={() => messagesModel.more()}
          >
            加载更早消息
          </button>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            persist(messageKey, message);
            void perform(
              "groups.send",
              {
                ...message,
                group_id: group.id,
                expected_revision: group.revision,
              },
              (entry) => {
                setMessage(freshMessage());
                setSelectedMessage(entry.id);
              },
            );
          }}
        >
          <fieldset disabled={locked || !actionFor(group, "send").allowed}>
            <legend>发送消息</legend>
            <label htmlFor={fieldId("group-message-body")}>正文</label>
            <textarea
              id={fieldId("group-message-body")}
              required
              value={message.body}
              onChange={(event) =>
                setMessage({ ...message, body: event.target.value })
              }
            />
            <div className="group-mentions" aria-label="点名目标">
              {group.members.map((member) => (
                <label className="group-inline" key={member.agent_id}>
                  <input
                    type="checkbox"
                    aria-label={`点名 ${member.agent_name}`}
                    checked={message.mention_agent_ids.includes(
                      member.agent_id,
                    )}
                    onChange={(event) =>
                      setMessage({
                        ...message,
                        mention_agent_ids: event.target.checked
                          ? [...message.mention_agent_ids, member.agent_id]
                          : message.mention_agent_ids.filter(
                              (id) => id !== member.agent_id,
                            ),
                      })
                    }
                  />
                  @{member.agent_name}
                </label>
              ))}
            </div>
            <label className="group-inline">
              <input
                id={fieldId("group-broadcast")}
                type="checkbox"
                checked={message.broadcast}
                onChange={(event) =>
                  setMessage({ ...message, broadcast: event.target.checked })
                }
              />
              显式广播给所有成员
            </label>
            <label htmlFor={fieldId("group-work-item")}>
              关联工作项 ID，可选
            </label>
            <input
              id={fieldId("group-work-item")}
              type="number"
              min="1"
              step="1"
              value={message.work_item_id ?? ""}
              onChange={(event) =>
                setMessage({
                  ...message,
                  work_item_id: event.target.value
                    ? Number(event.target.value)
                    : null,
                  execute_work_item: event.target.value
                    ? message.execute_work_item
                    : false,
                })
              }
            />
            <label className="group-inline">
              <input
                id={fieldId("group-execute-work")}
                type="checkbox"
                disabled={!message.work_item_id}
                checked={message.execute_work_item ?? false}
                onChange={(event) =>
                  setMessage({
                    ...message,
                    execute_work_item: event.target.checked,
                  })
                }
              />
              启动该工作项，需唯一点名当前负责人
            </label>
            <p className="muted">
              {message.broadcast
                ? "广播给当前成员，由 Core 核对接收资格。"
                : message.mention_agent_ids.length
                  ? `已点名 ${message.mention_agent_ids.map(agentName).join("、")}`
                  : "未点名时，只面向主动监听成员。"}{" "}
              正文中的 @名字按普通文本保存。
            </p>
            {message.reply_to && (
              <p>
                回复消息 #{message.reply_to}
                <button
                  type="button"
                  onClick={() => setMessage({ ...message, reply_to: null })}
                >
                  取消回复
                </button>
              </p>
            )}
            <button
              id={fieldId("group-send")}
              type="submit"
              disabled={
                !message.body.trim() || !preview.data || Boolean(preview.error)
              }
            >
              {isTopic ? "发送话题消息" : "发送群消息"}
            </button>
            <div id={fieldId("group-recipient-preview")} role="status">
              {preview.error && <p>{preview.error.message}</p>}
              {preview.loading && !preview.data && <p>正在核对接收目标…</p>}
              {preview.data?.reason && <p>{preview.data.reason}</p>}
              {preview.data?.recipients.map((recipient) => (
                <p key={recipient.agent_id}>
                  {recipient.agent_name} ·{" "}
                  {recipient.availability.allowed
                    ? "可接收"
                    : recipient.availability.reason}
                </p>
              ))}
            </div>
            <button
              id={fieldId("group-message-new")}
              type="button"
              onClick={() => setMessage(freshMessage())}
            >
              新建消息草稿
            </button>
          </fieldset>
        </form>
      </section>
      <section aria-label="消息投递记录">
        <div className="title-row">
          <h2>持久投递记录</h2>
          {selectedMessage && (
            <button type="button" onClick={() => setSelectedMessage(null)}>
              查看全群投递
            </button>
          )}
        </div>
        {deliveries.error && <p role="alert">{deliveries.error.message}</p>}
        {deliveries.data?.items.length === 0 && (
          <p className="muted">暂无投递。</p>
        )}
        {deliveries.data?.items.map((delivery) => (
          <article
            className="group-delivery"
            key={delivery.id}
            data-delivery-id={delivery.id}
          >
            <h3>
              {agentName(delivery.agent_id)} · {deliveryStates[delivery.state]}
            </h3>
            <p>
              消息 #{delivery.message_id} · 投递 #{delivery.id} · 修订{" "}
              {delivery.revision}
            </p>
            {delivery.reason && <p>{delivery.reason}</p>}
            {delivery.run_id && (
              <button type="button" onClick={() => onOpenRun(delivery.run_id)}>
                查看 Run #{delivery.run_id} · {delivery.run_state}
              </button>
            )}
            <p>
              {delivery.adopted ? "已有采纳证据" : "尚无采纳证据"} · 回复状态{" "}
              {delivery.reply_state ?? "等待执行"}
            </p>
            {delivery.adoption_evidence && (
              <details>
                <summary>采纳证据</summary>
                <pre>{JSON.stringify(delivery.adoption_evidence, null, 2)}</pre>
              </details>
            )}
            {delivery.chain_id && (
              <button
                type="button"
                onClick={() => setSelectedChain(delivery.chain_id)}
              >
                查看本次协作
              </button>
            )}
            {delivery.current_blocker &&
              delivery.current_blocker !== delivery.reason && (
                <p>{delivery.current_blocker}</p>
              )}
            <button
              type="button"
              disabled={locked || !delivery.allowed_actions.resume.allowed}
              title={delivery.allowed_actions.resume.reason ?? undefined}
              onClick={() =>
                void perform("groups.resolve_delivery", {
                  id: delivery.id,
                  expected_revision: delivery.revision,
                  action: "resume",
                })
              }
            >
              继续此投递
            </button>
            <button
              type="button"
              disabled={locked || !delivery.allowed_actions.cancel.allowed}
              title={delivery.allowed_actions.cancel.reason ?? undefined}
              onClick={() =>
                void perform("groups.resolve_delivery", {
                  id: delivery.id,
                  expected_revision: delivery.revision,
                  action: "cancel",
                })
              }
            >
              取消此投递
            </button>
          </article>
        ))}
        {deliveries.data?.next_before && (
          <button
            disabled={deliveries.loading}
            onClick={() => deliveriesModel.more()}
          >
            加载更多投递
          </button>
        )}
      </section>
    </div>
  );
}

function GroupWork({ id, ready, onOpenRun }) {
  const state = useClientModel(
    clientModels.resource("work_items.get", { id }),
    ready,
  );
  return (
    <div className="group-work-reference">
      <p>
        工作项 #{id}
        {state.data && ` · ${state.data.title} · ${state.data.progress.state}`}
      </p>
      {state.error && <p role="alert">{state.error.message}</p>}
      {state.data?.current_run_id && (
        <button
          type="button"
          onClick={() => onOpenRun(state.data.current_run_id)}
        >
          查看工作项当前 Run
        </button>
      )}
    </div>
  );
}
