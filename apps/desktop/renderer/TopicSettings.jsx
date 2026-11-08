import React, { useEffect, useState } from "react";
import { actionFor } from "./client/actions.mjs";

export default function TopicSettings({
  topic,
  ready,
  busy,
  perform,
  prefix,
  onSource,
}) {
  const key = `${prefix}:${topic.id}:topic-settings`;
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      return saved &&
        saved.id === topic.id &&
        Number.isSafeInteger(saved.expected_revision) &&
        typeof saved.name === "string" &&
        (saved.rules_override === null ||
          typeof saved.rules_override === "string") &&
        typeof saved.paused === "boolean"
        ? saved
        : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
      else sessionStorage.removeItem(key);
    } catch {}
  }, [key, draft]);
  const value = draft ?? {
    id: topic.id,
    expected_revision: topic.revision,
    name: topic.name,
    rules_override: topic.rules_override,
    paused: topic.own_paused,
  };
  const stale = value.expected_revision !== topic.revision;
  const locked = !ready || busy;
  const change = (changes) => setDraft({ ...value, ...changes });
  const member = (entry, changes) =>
    void perform("topics.member", {
      id: topic.id,
      expected_revision: topic.revision,
      agent_id: entry.agent_id,
      ...changes,
    });
  return (
    <>
      <button id="topic-source" type="button" onClick={onSource}>
        回到主群源消息 #{topic.source_message_id}
      </button>
      <details className="topic-source">
        <summary>来源消息与参与者</summary>
        <pre>{topic.source_message?.body ?? "正在读取来源…"}</pre>
        <p>
          参与者{" "}
          {(topic.participant_agent_ids ?? [])
            .map(
              (id) =>
                topic.members.find((entry) => entry.agent_id === id)
                  ?.agent_name ?? `Agent #${id}`,
            )
            .join("、") || "尚无话题消息"}
        </p>
        <p className="muted">
          沿用源群执行配置、当前成员及权限。话题与源消息共用协作链。
        </p>
      </details>
      <details className="topic-settings">
        <summary>话题规则与监听</summary>
        {stale && (
          <p role="status">话题已有新修订。草稿保留，请载入最新设置后核对。</p>
        )}
        <button
          id="topic-settings-refresh"
          type="button"
          disabled={locked}
          onClick={() => setDraft(null)}
        >
          载入最新话题设置
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform("topics.save", value, () => setDraft(null));
          }}
        >
          <fieldset disabled={locked || !actionFor(topic, "save").allowed}>
            <label htmlFor="topic-name">话题名称</label>
            <input
              id="topic-name"
              required
              value={value.name}
              onChange={(event) => change({ name: event.target.value })}
            />
            <label className="group-inline">
              <input
                id="topic-rules-inherit"
                type="checkbox"
                checked={value.rules_override === null}
                onChange={(event) =>
                  change({
                    rules_override: event.target.checked ? null : topic.rules,
                  })
                }
              />
              继承主群规则
            </label>
            <label htmlFor="topic-rules">话题规则，留空可明确清空</label>
            <textarea
              id="topic-rules"
              disabled={value.rules_override === null}
              value={value.rules_override ?? topic.rules}
              onChange={(event) =>
                change({ rules_override: event.target.value })
              }
            />
            <label className="group-inline">
              <input
                id="topic-paused"
                type="checkbox"
                checked={value.paused}
                onChange={(event) => change({ paused: event.target.checked })}
              />
              暂停话题响应
            </label>
            <button id="topic-save" type="submit" disabled={!draft || stale}>
              保存话题设置
            </button>
          </fieldset>
        </form>
        <p className="muted">
          当前{topic.paused ? "响应已暂停" : "响应已启用"}
          。源群停收或暂停时，话题受相同限制。
        </p>
        <ul className="group-member-list">
          {topic.members.map((entry) => (
            <li key={entry.agent_id} data-agent-id={entry.agent_id}>
              <strong>{entry.agent_name}</strong>
              <label>
                话题监听
                <select
                  aria-label={`${entry.agent_name} 话题监听`}
                  value={entry.listen_override ?? "inherit"}
                  disabled={locked || !actionFor(topic, "member").allowed}
                  onChange={(event) =>
                    member(
                      entry,
                      event.target.value === "inherit"
                        ? { inherit_listen: true }
                        : { listen_mode: event.target.value },
                    )
                  }
                >
                  <option value="inherit">继承主群</option>
                  <option value="active">主动</option>
                  <option value="passive">被动</option>
                </select>
              </label>
              <label className="group-inline">
                <input
                  type="checkbox"
                  aria-label={`${entry.agent_name} 接收话题消息`}
                  checked={entry.receiving}
                  disabled={locked || !actionFor(topic, "member").allowed}
                  onChange={(event) =>
                    member(entry, { receiving: event.target.checked })
                  }
                />
                接收话题消息
              </label>
              <button
                type="button"
                disabled={locked || !actionFor(topic, "member").allowed}
                onClick={() => member(entry, { inherit: true })}
              >
                恢复继承
              </button>
              {entry.receive_availability.reason && (
                <p>{entry.receive_availability.reason}</p>
              )}
            </li>
          ))}
        </ul>
        <button
          id="topic-archive"
          type="button"
          disabled={
            locked ||
            !actionFor(topic, topic.archived ? "restore" : "archive").allowed
          }
          title={
            actionFor(topic, topic.archived ? "restore" : "archive").reason ??
            undefined
          }
          onClick={() =>
            void perform("topics.archive", {
              id: topic.id,
              expected_revision: topic.revision,
              archived: !topic.archived,
            })
          }
        >
          {topic.archived ? "恢复话题" : "归档话题"}
        </button>
      </details>
    </>
  );
}
