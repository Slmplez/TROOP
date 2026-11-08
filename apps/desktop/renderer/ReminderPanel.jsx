import React, { useEffect, useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";

const draftKey = "troop.reminder.draft";
function empty() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 86400000));
  return {
    kind: "reminder",
    event: "time.due",
    name: "新提醒",
    enabled: true,
    agent_id: 1,
    project_id: null,
    body: "",
    schedule: {
      kind: "once",
      timezone: "Asia/Shanghai",
      date: parts,
      time: "09:00",
      weekdays: [],
    },
  };
}
function restoreDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey));
    if (saved?.rule?.kind === "reminder" && saved.rule.schedule) return saved;
  } catch {
    /* A damaged local draft can be replaced with a fresh form. */
  }
  return { id: null, revision: 0, rule: empty() };
}
const stateLabel = {
  pending: "等待投递",
  dispatching: "投递中",
  shown: "系统显示已回执",
  failed: "显示失败",
  suppressed: "已抑制",
  expired: "已过期",
  indeterminate: "投递结果不明",
  cancelled: "已取消",
  active: "已启用",
  paused: "已暂停",
  completed: "已完成",
};
const stamp = (slot) =>
  `${slot.local_date} ${slot.local_time} · ${slot.timezone}${slot.state === "dst_gap" ? " · 夏令时缺失，跳过" : ""}`;
function definition(value) {
  return Object.fromEntries(
    [
      "kind",
      "event",
      "name",
      "enabled",
      "agent_id",
      "project_id",
      "body",
      "schedule",
    ].map((key) => [key, value[key]]),
  );
}
function normalizedSchedule(schedule) {
  return {
    ...schedule,
    date: schedule.kind === "once" ? schedule.date : null,
    weekdays: schedule.kind === "weekly" ? schedule.weekdays : [],
  };
}
export default function ReminderPanel({ ready }) {
  const [draft, setDraft] = useState(restoreDraft),
    [offset, setOffset] = useState(0),
    [preview, setPreview] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const list = useClientModel(clientModels.resource("rules.list", { offset }));
  const agents = useClientModel(clientModels.agents());
  const projects = useClientModel(
    clientModels.resource("memory.projects", { agent_id: draft.rule.agent_id }),
  );
  const live = useClientModel(
    draft.id ? clientModels.resource("reminders.get", { id: draft.id }) : null,
  );
  const historyModel = draft.id
    ? clientModels.resource("reminders.history", { id: draft.id })
    : null;
  const history = useClientModel(historyModel);
  const notificationsModel = clientModels.resource(
    "notifications.list",
    draft.id ? { rule_id: draft.id } : {},
  );
  const notifications = useClientModel(notificationsModel);
  const preferences = useClientModel(
    clientModels.resource("notifications.preferences", {}),
  );
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      /* Form remains usable if storage is unavailable. */
    }
  }, [draft]);
  const current = live.data?.id === draft.id ? live.data : null;
  const stale = Boolean(
    draft.id && (!current || current.revision !== draft.revision),
  );
  const availability = current?.allowed_actions;
  const editable =
    ready && !busy && !stale && (!draft.id || availability?.save.allowed);
  function edit(rule) {
    setDraft(
      rule
        ? { id: rule.id, revision: rule.revision, rule: definition(rule) }
        : { id: null, revision: 0, rule: empty() },
    );
    setPreview(null);
    setError("");
  }
  function field(key, value) {
    setDraft((old) => ({ ...old, rule: { ...old.rule, [key]: value } }));
    setPreview(null);
  }
  function schedule(key, value) {
    field("schedule", { ...draft.rule.schedule, [key]: value });
  }
  async function act(fn) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      clientModels.invalidate();
    } catch (cause) {
      setError(cause.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function save(enabled = draft.rule.enabled) {
    const rule = {
      ...draft.rule,
      enabled,
      schedule: {
        ...draft.rule.schedule,
        date:
          draft.rule.schedule.kind === "once" ? draft.rule.schedule.date : null,
        weekdays:
          draft.rule.schedule.kind === "weekly"
            ? draft.rule.schedule.weekdays
            : [],
      },
    };
    edit(
      await clientModels.command("rules.save", {
        ...(draft.id ? { id: draft.id } : {}),
        expected_revision: draft.revision,
        rule,
      }),
    );
  }
  const failure =
    error ||
    live.error?.message ||
    list.error?.message ||
    history.error?.message ||
    notifications.error?.message ||
    preferences.error?.message ||
    agents.error?.message ||
    projects.error?.message;
  return (
    <div className="models-page reminder-page">
      <div className="title-row">
        <h1>时间提醒</h1>
        <button
          id="reminder-new"
          disabled={!ready || busy}
          onClick={() => edit(null)}
        >
          新建提醒
        </button>
      </div>
      <p>
        纯提醒使用本地时间调度，零模型调用。时区随规则保存。退出或休眠期间错过的提醒记为跳过，可手动再提醒。
      </p>
      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}
      <div className="models-layout">
        <section className="provider-library" aria-label="提醒列表">
          {list.data?.items
            .filter((item) => item.kind === "reminder")
            .map((item) => (
              <button
                className="provider-choice"
                key={item.id}
                disabled={busy}
                onClick={() => edit(item)}
              >
                {item.name} · 修订 {item.revision} ·{" "}
                {item.cancelled ? "已取消" : item.enabled ? "启用" : "暂停"}
              </button>
            ))}
          <button disabled={busy || offset === 0} onClick={() => setOffset(0)}>
            首页
          </button>
          {list.data?.next_offset != null && (
            <button
              disabled={busy}
              onClick={() => setOffset(list.data.next_offset)}
            >
              下一页
            </button>
          )}
        </section>
        <section className="provider-form" aria-label="提醒配置">
          {draft.id && (
            <p id="reminder-phase">
              {stateLabel[current?.phase] || "正在核对"} · 修订 {draft.revision}
              {current?.next_slot && ` · 下次 ${stamp(current.next_slot)}`}
            </p>
          )}
          {stale && (
            <p role="status">
              规则已变化或正在核对。
              <button disabled={!current || busy} onClick={() => edit(current)}>
                载入当前修订
              </button>
            </p>
          )}
          <label htmlFor="reminder-name">名称</label>
          <input
            id="reminder-name"
            value={draft.rule.name}
            disabled={!editable}
            onChange={(event) => field("name", event.target.value)}
            maxLength={120}
          />
          <label htmlFor="reminder-agent">负责 Agent</label>
          <select
            id="reminder-agent"
            value={draft.rule.agent_id}
            disabled={!editable}
            onChange={(event) =>
              setDraft((old) => ({
                ...old,
                rule: {
                  ...old.rule,
                  agent_id: Number(event.target.value),
                  project_id: null,
                },
              }))
            }
          >
            {agents.data?.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <label htmlFor="reminder-project">项目</label>
          <select
            id="reminder-project"
            value={draft.rule.project_id || ""}
            disabled={!editable}
            onChange={(event) =>
              field("project_id", event.target.value || null)
            }
          >
            <option value="">个人提醒</option>
            {projects.data
              ?.filter((project) => project.joined)
              .map((project) => (
                <option key={project.slug} value={project.slug}>
                  {project.name}
                </option>
              ))}
          </select>
          <label htmlFor="reminder-body">提醒内容</label>
          <textarea
            id="reminder-body"
            rows={3}
            maxLength={4000}
            disabled={!editable}
            value={draft.rule.body}
            onChange={(event) => field("body", event.target.value)}
          />
          <label htmlFor="reminder-kind">重复</label>
          <select
            id="reminder-kind"
            disabled={!editable}
            value={draft.rule.schedule.kind}
            onChange={(event) => schedule("kind", event.target.value)}
          >
            <option value="once">一次性</option>
            <option value="daily">每日</option>
            <option value="weekly">每周</option>
          </select>
          <label htmlFor="reminder-zone">固定时区</label>
          <input
            id="reminder-zone"
            disabled={!editable}
            value={draft.rule.schedule.timezone}
            onChange={(event) => schedule("timezone", event.target.value)}
            placeholder="Asia/Shanghai"
          />
          {draft.rule.schedule.kind === "once" && (
            <>
              <label htmlFor="reminder-date">日期</label>
              <input
                id="reminder-date"
                type="date"
                disabled={!editable}
                value={draft.rule.schedule.date || ""}
                onChange={(event) => schedule("date", event.target.value)}
              />
            </>
          )}
          <label htmlFor="reminder-time">时间</label>
          <input
            id="reminder-time"
            type="time"
            step="1"
            disabled={!editable}
            value={draft.rule.schedule.time}
            onChange={(event) => schedule("time", event.target.value)}
          />
          {draft.rule.schedule.kind === "weekly" && (
            <fieldset disabled={!editable}>
              <legend>每周日期</legend>
              {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(
                (name, index) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      checked={draft.rule.schedule.weekdays.includes(index + 1)}
                      onChange={(event) =>
                        schedule(
                          "weekdays",
                          event.target.checked
                            ? [
                                ...draft.rule.schedule.weekdays,
                                index + 1,
                              ].sort()
                            : draft.rule.schedule.weekdays.filter(
                                (day) => day !== index + 1,
                              ),
                        )
                      }
                    />
                    {name}
                  </label>
                ),
              )}
            </fieldset>
          )}
          <div className="title-row">
            <button
              id="reminder-preview"
              disabled={!ready || busy}
              onClick={() =>
                act(async () =>
                  setPreview(
                    await clientModels.read("reminders.preview", {
                      schedule: normalizedSchedule(draft.rule.schedule),
                    }),
                  ),
                )
              }
            >
              预览触发时间
            </button>
            <button
              id="reminder-save"
              disabled={!editable}
              onClick={() => act(() => save())}
            >
              保存提醒
            </button>
          </div>
          {preview && (
            <ul id="reminder-preview-list">
              {preview.slots.map((slot) => (
                <li key={slot.slot_key}>{stamp(slot)}</li>
              ))}
              {!preview.slots.length && <li>没有未来触发时间</li>}
            </ul>
          )}
          {draft.id && (
            <div className="title-row">
              <button
                id="reminder-toggle"
                title={availability?.save.reason || ""}
                disabled={!editable}
                onClick={() => act(() => save(!draft.rule.enabled))}
              >
                {draft.rule.enabled ? "暂停提醒" : "启用提醒"}
              </button>
              <button
                id="reminder-run"
                title={availability?.run.reason || ""}
                disabled={!ready || busy || stale || !availability?.run.allowed}
                onClick={() =>
                  act(() =>
                    clientModels.command("reminders.run", {
                      id: draft.id,
                      expected_revision: draft.revision,
                      client_trigger_id: crypto.randomUUID(),
                    }),
                  )
                }
              >
                立即提醒一次
              </button>
              <button
                id="reminder-cancel"
                title={availability?.cancel.reason || ""}
                disabled={
                  !ready || busy || stale || !availability?.cancel.allowed
                }
                onClick={() =>
                  act(async () =>
                    edit(
                      await clientModels.command("reminders.cancel", {
                        id: draft.id,
                        expected_revision: draft.revision,
                      }),
                    ),
                  )
                }
              >
                取消提醒
              </button>
            </div>
          )}
        </section>
      </div>
      <section aria-label="通知设置">
        <h2>通知与送达</h2>
        <p>
          “系统显示已回执”表示收到系统显示回调。阅读状态单独记录。前台聚焦、关闭开关或频率限制时仍保留站内记录。
        </p>
        <button
          id="reminder-notifications-toggle"
          disabled={!ready || busy || !preferences.data}
          onClick={() =>
            act(() =>
              clientModels.command("notifications.preferences.save", {
                expected_revision: preferences.data.revision,
                enabled: !preferences.data.enabled,
              }),
            )
          }
        >
          {preferences.data?.enabled ? "关闭系统通知" : "开启系统通知"}
        </button>
        <div id="reminder-notifications">
          {notifications.data?.items.map((item) => (
            <article key={item.id}>
              <h3>
                {item.title} · {stateLabel[item.state]}
              </h3>
              <p>{item.body}</p>
              <p>
                {item.reason} · {item.read_at_ms == null ? "未读" : "已读"}
              </p>
              <button
                disabled={!ready || busy || !item.allowed_actions.read.allowed}
                onClick={() =>
                  act(() =>
                    clientModels.command("notifications.read", {
                      id: item.id,
                      expected_revision: item.revision,
                    }),
                  )
                }
              >
                标为已读
              </button>
            </article>
          ))}
        </div>
        {notifications.data?.next_before != null && (
          <button
            disabled={notifications.loading}
            onClick={() => notificationsModel.more()}
          >
            更早通知
          </button>
        )}
      </section>
      {draft.id && (
        <section aria-label="触发历史">
          <h2>触发历史</h2>
          <ul id="reminder-history">
            {history.data?.items.map((item) => (
              <li key={item.id}>
                {stamp(item.slot)} ·{" "}
                {item.state === "triggered" ? "已触发" : "已跳过"} ·{" "}
                {item.reason}
              </li>
            ))}
          </ul>
          {history.data?.next_before != null && (
            <button
              disabled={history.loading}
              onClick={() => historyModel.more()}
            >
              更早触发
            </button>
          )}
        </section>
      )}
    </div>
  );
}
