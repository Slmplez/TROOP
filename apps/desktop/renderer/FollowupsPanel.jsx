import React, { useEffect, useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { actionFor } from "./client/actions.mjs";
import WorkItemExecution from "./WorkItemExecution";

const fields = [
  "name",
  "enabled",
  "work_item_id",
  "agent_id",
  "workspace_id",
  "project_id",
  "start",
  "expected_plan_sha256",
  "expires_at_ms",
  "min_interval_ms",
  "max_runs",
  "handoff_policy_ids",
];
const definition = (value) =>
  Object.fromEntries(fields.map((key) => [key, value[key]]));
const localInput = (value) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(value))
    .replace(" ", "T");
const fromInput = (value) => new Date(`${value}:00+08:00`).getTime();
const date = (value) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
const phases = {
  pending: "已预约",
  waiting: "等待处理",
  blocked: "已阻断",
  cancelled: "已取消",
  dispatched: "已派发",
};
function fresh() {
  return {
    id: null,
    revision: 0,
    dirty: true,
    policy: {
      name: "新跟进策略",
      enabled: true,
      work_item_id: 0,
      agent_id: 1,
      workspace_id: 0,
      project_id: null,
      start: {
        client_run_id: crypto.randomUUID(),
        agent_id: 1,
        workspace_id: 0,
        project_ids: [],
        provider_id: "",
        authorization_id: "",
        goal: "检查目标的实际变化，保留依据；需要后续检查时提出有期限的预约。",
      },
      expected_plan_sha256: null,
      expires_at_ms: Date.now() + 1800_000,
      min_interval_ms: 60_000,
      max_runs: 4,
      handoff_policy_ids: [],
    },
  };
}
export default function FollowupsPanel(props) {
  return <FollowupsForm key={clientModels.instance ?? "unbound"} {...props} />;
}
function FollowupsForm({ ready, onOpenRun }) {
  const key = `troop.followups.draft:${clientModels.instance}`;
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      if (
        saved?.policy?.start &&
        Number.isSafeInteger(saved.revision) &&
        typeof saved.policy.name === "string" &&
        [
          "work_item_id",
          "agent_id",
          "workspace_id",
          "expires_at_ms",
          "min_interval_ms",
          "max_runs",
        ].every((key) => Number.isSafeInteger(saved.policy[key])) &&
        Number.isFinite(new Date(saved.policy.expires_at_ms).getTime())
      ) {
        saved.policy.handoff_policy_ids ??= [];
        if (
          Array.isArray(saved.policy.handoff_policy_ids) &&
          saved.policy.handoff_policy_ids.every((id) => typeof id === "string")
        )
          return saved;
      }
    } catch {}
    return fresh();
  });
  const [before, setBefore] = useState(null),
    [historyBefore, setHistoryBefore] = useState(null),
    [preview, setPreview] = useState(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [appointment, setAppointment] = useState({
    at: localInput(Date.now() + 120_000),
    reason: "",
    expected_change: "",
  });
  const lock = useRef(false);
  const list = useClientModel(
    clientModels.resource("followups.list", before ? { before } : {}),
  );
  const current = useClientModel(
    draft.id ? clientModels.resource("followups.get", { id: draft.id }) : null,
  );
  const history = useClientModel(
    draft.id
      ? clientModels.resource("followups.history", {
          id: draft.id,
          ...(historyBefore ? { before: historyBefore } : {}),
        })
      : null,
  );
  const work = useClientModel(
    draft.policy.work_item_id
      ? clientModels.resource("work_items.get", {
          id: draft.policy.work_item_id,
        })
      : null,
  );
  const providers = useClientModel(clientModels.resource("provider.list", {}));
  const engines = useClientModel(clientModels.resource("engines.list", {}));
  const live = current.data?.id === draft.id ? current.data : null;
  const stale = Boolean(
    draft.id && (!live || live.revision !== draft.revision),
  );
  const run = useClientModel(
    live?.state.current_run_id
      ? clientModels.resource("agent.get", { id: live.state.current_run_id })
      : null,
  );
  const editable = ready && !busy && (!live || actionFor(live, "save").allowed);
  const cli = Boolean(draft.policy.start.engine_id);
  useEffect(() => {
    sessionStorage.setItem(key, JSON.stringify(draft));
  }, [draft, key]);
  function edit(value) {
    setDraft(
      value
        ? {
            id: value.id,
            revision: value.revision,
            dirty: false,
            policy: definition(value),
          }
        : fresh(),
    );
    setPreview(null);
    setConfirmed(false);
    setHistoryBefore(null);
    setError("");
  }
  function field(name, value) {
    setDraft((old) => ({
      ...old,
      dirty: true,
      policy: { ...old.policy, [name]: value, expected_plan_sha256: null },
    }));
    setPreview(null);
    setConfirmed(false);
  }
  const startField = (name, value) =>
    field("start", { ...draft.policy.start, [name]: value });
  async function act(fn) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      clientModels.invalidate();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  async function scope() {
    const item = await clientModels.read("work_items.get", {
      id: draft.policy.work_item_id,
    });
    setDraft((old) => ({
      ...old,
      dirty: true,
      policy: {
        ...old.policy,
        agent_id: item.owner_agent_id,
        workspace_id: item.workspace_id,
        project_id: item.project_id,
        start: {
          ...old.policy.start,
          agent_id: item.owner_agent_id,
          workspace_id: item.workspace_id,
          project_ids: item.project_id ? [item.project_id] : [],
        },
        expected_plan_sha256: null,
      },
    }));
    setPreview(null);
    setConfirmed(false);
  }
  function engine(value) {
    const identity = {
      client_run_id: crypto.randomUUID(),
      agent_id: draft.policy.agent_id,
      workspace_id: draft.policy.workspace_id,
      project_ids: draft.policy.project_id ? [draft.policy.project_id] : [],
      authorization_id: draft.policy.start.authorization_id,
      goal: draft.policy.start.goal,
    };
    field(
      "start",
      value === "native"
        ? { ...identity, provider_id: providers.data?.[0]?.id ?? "" }
        : {
            ...identity,
            engine_id: value,
            tool_mode: "native",
            approval_mode: "preauthorized",
          },
    );
  }
  async function save() {
    const value = await clientModels.command("followups.save", {
      ...(draft.id ? { id: draft.id } : {}),
      expected_revision: draft.revision,
      policy: { ...draft.policy, expected_plan_sha256: preview.plan_sha256 },
    });
    edit(value);
  }
  async function reserve(manual) {
    await clientModels.command(manual ? "followups.run" : "followups.request", {
      id: draft.id,
      expected_revision: draft.revision,
      client_request_id: crypto.randomUUID(),
      at_ms: manual ? Date.now() : fromInput(appointment.at),
      reason: appointment.reason,
      expected_change: appointment.expected_change,
    });
    setAppointment((old) => ({ ...old, reason: "", expected_change: "" }));
  }
  const failure =
    error ||
    list.error?.message ||
    current.error?.message ||
    history.error?.message ||
    providers.error?.message ||
    engines.error?.message;
  return (
    <div className="models-page followups-page">
      <div className="title-row">
        <h1>持续跟进</h1>
        <button
          id="followup-new"
          disabled={!ready || busy}
          onClick={() => edit(null)}
        >
          新建策略
        </button>
      </div>
      <p>
        为工作约定检查时间、权限和期限。每次执行保留来源与结果，工作完成由验收记录确定。
      </p>
      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}
      <div className="models-layout">
        <section className="provider-library" aria-label="跟进策略列表">
          {!list.data && <p>正在读取策略…</p>}
          {list.data?.items.length === 0 && (
            <p>尚无跟进策略。先选择一个已有工作项。</p>
          )}
          {list.data?.items.map((value) => (
            <button
              className="provider-choice"
              key={value.id}
              disabled={busy}
              onClick={() => edit(value)}
            >
              {value.name}
              <span>
                工作 #{value.work_item_id} ·{" "}
                {value.cancelled
                  ? "已取消"
                  : value.enabled
                    ? "已启用"
                    : "已暂停"}
              </span>
            </button>
          ))}
          <div className="button-row">
            <button disabled={!before || busy} onClick={() => setBefore(null)}>
              最近策略
            </button>
            {list.data?.next_before && (
              <button
                disabled={busy}
                onClick={() => setBefore(list.data.next_before)}
              >
                下一页
              </button>
            )}
          </div>
        </section>
        <section className="provider-form" aria-label="跟进策略配置">
          {draft.id && (
            <p id="followup-phase">
              {live?.cancelled ? "已取消" : live?.enabled ? "已启用" : "已暂停"}{" "}
              · 修订 {draft.revision} · 已启动 {live?.state.wake_count ?? 0} /{" "}
              {live?.max_runs ?? draft.policy.max_runs} 次
            </p>
          )}
          {stale && (
            <p role="status">
              策略已有新修订，当前草稿已保留。
              <button
                id="followup-load-current"
                disabled={!live || busy}
                onClick={() => edit(live)}
              >
                载入当前策略
              </button>
            </p>
          )}
          {live?.current_blocker && <p role="status">{live.current_blocker}</p>}
          <label htmlFor="followup-name">策略名称</label>
          <input
            id="followup-name"
            disabled={!editable}
            value={draft.policy.name}
            maxLength={120}
            onChange={(event) => field("name", event.target.value)}
          />
          <label htmlFor="followup-work">工作项 ID</label>
          <div className="button-row">
            <input
              id="followup-work"
              type="number"
              min="1"
              disabled={!editable || Boolean(draft.id)}
              value={draft.policy.work_item_id || ""}
              onChange={(event) =>
                field("work_item_id", Number(event.target.value))
              }
            />
            <button
              id="followup-scope"
              disabled={!editable || !draft.policy.work_item_id}
              onClick={() => act(scope)}
            >
              读取工作范围
            </button>
          </div>
          {work.data && (
            <p>
              #{work.data.id} · {work.data.title} · Agent{" "}
              {draft.policy.agent_id} · {draft.policy.project_id || "个人范围"}{" "}
              · 工作区 {draft.policy.workspace_id}
            </p>
          )}
          <label htmlFor="followup-engine">执行方式</label>
          <select
            id="followup-engine"
            disabled={!editable}
            value={cli ? draft.policy.start.engine_id : "native"}
            onChange={(event) => engine(event.target.value)}
          >
            <option value="native">原生 Agent</option>
            {engines.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
          {!cli && (
            <>
              <label htmlFor="followup-provider">模型</label>
              <select
                id="followup-provider"
                disabled={!editable}
                value={draft.policy.start.provider_id || ""}
                onChange={(event) =>
                  startField("provider_id", event.target.value)
                }
              >
                <option value="">选择模型</option>
                {providers.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.config.name} · {item.config.model}
                  </option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="followup-authorization">范围预授权 ID</label>
          <input
            id="followup-authorization"
            disabled={!editable}
            value={draft.policy.start.authorization_id}
            onChange={(event) =>
              startField("authorization_id", event.target.value)
            }
          />
          <label htmlFor="followup-goal">每次检查的任务</label>
          <textarea
            id="followup-goal"
            disabled={!editable}
            value={draft.policy.start.goal}
            onChange={(event) => startField("goal", event.target.value)}
          />
          <div className="followup-limits">
            <label>
              截止时间 · Asia/Shanghai
              <input
                id="followup-expiry"
                type="datetime-local"
                disabled={!editable}
                value={localInput(draft.policy.expires_at_ms)}
                onChange={(event) => {
                  if (event.target.value)
                    field("expires_at_ms", fromInput(event.target.value));
                }}
              />
            </label>
            <label>
              最小间隔 · 分钟
              <input
                id="followup-interval"
                type="number"
                min="1"
                max="1440"
                disabled={!editable}
                value={draft.policy.min_interval_ms / 60000}
                onChange={(event) =>
                  field("min_interval_ms", Number(event.target.value) * 60000)
                }
              />
            </label>
            <label>
              最多启动次数
              <input
                id="followup-limit"
                type="number"
                min="1"
                max="16"
                disabled={!editable}
                value={draft.policy.max_runs}
                onChange={(event) =>
                  field("max_runs", Number(event.target.value))
                }
              />
            </label>
          </div>
          <label htmlFor="followup-routes">允许交接的接收策略 ID</label>
          <textarea
            id="followup-routes"
            disabled={!editable}
            value={(draft.policy.handoff_policy_ids ?? []).join("\n")}
            onChange={(event) =>
              field(
                "handoff_policy_ids",
                event.target.value
                  .split(/\r?\n/)
                  .map((id) => id.trim())
                  .filter(Boolean),
              )
            }
          />
          <p>
            每行一条已保存策略，最多八条。交接使用接收方授权，并继承当前链的权限上限与限额。
          </p>
          <div className="button-row">
            <button
              id="followup-preview"
              disabled={!editable || stale}
              onClick={() =>
                act(async () => {
                  setPreview(
                    await clientModels.read("followups.preview", {
                      ...(draft.id ? { id: draft.id } : {}),
                      policy: draft.policy,
                    }),
                  );
                  setConfirmed(false);
                })
              }
            >
              预览权限与范围
            </button>
            <button
              id="followup-save"
              className="primary"
              disabled={!editable || stale || !preview || !confirmed}
              onClick={() => act(save)}
            >
              保存跟进策略
            </button>
          </div>
          {preview && (
            <div className="followup-preview">
              <p>
                工作 #{draft.policy.work_item_id} · 最多 {draft.policy.max_runs}{" "}
                次 · 截止 {date(draft.policy.expires_at_ms)}
              </p>
              <label>
                <input
                  id="followup-confirm"
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                确认当前权限计划和期限
              </label>
            </div>
          )}
          {live && (
            <>
              <p id="followup-chain">
                协作链 {live.chain.id} · 已启动 {live.chain.wake_count} /{" "}
                {live.chain.wake_limit} 次 ·{" "}
                {live.chain.stopped
                  ? "已停止"
                  : `截止 ${date(live.chain.expires_at_ms)}`}
              </p>
              <div className="button-row">
                <button
                  id="followup-stop-chain"
                  disabled={
                    busy || !ready || !actionFor(live, "stop_chain").allowed
                  }
                  onClick={() =>
                    act(async () => {
                      const chain = await clientModels.read("followups.chain", {
                        id: live.chain.id,
                      });
                      await clientModels.command("followups.stop_chain", {
                        id: chain.id,
                        expected_revision: chain.revision,
                      });
                    })
                  }
                >
                  停止整条协作链
                </button>
                <button
                  id="followup-toggle"
                  disabled={
                    busy || stale || !actionFor(live, "set_enabled").allowed
                  }
                  onClick={() =>
                    act(async () =>
                      edit(
                        await clientModels.command("followups.set_enabled", {
                          id: live.id,
                          expected_revision: live.revision,
                          enabled: !live.enabled,
                        }),
                      ),
                    )
                  }
                >
                  {live.enabled ? "暂停跟进" : "恢复跟进"}
                </button>
                <button
                  id="followup-stop-run"
                  disabled={
                    busy || !run.data || !actionFor(run.data, "stop").allowed
                  }
                  onClick={() =>
                    act(() =>
                      clientModels.command("agent.cancel", {
                        id: live.state.current_run_id,
                      }),
                    )
                  }
                >
                  停止当前执行
                </button>
                <button
                  id="followup-cancel"
                  disabled={busy || stale || !actionFor(live, "cancel").allowed}
                  onClick={() =>
                    act(async () =>
                      edit(
                        await clientModels.command("followups.cancel", {
                          id: live.id,
                          expected_revision: live.revision,
                        }),
                      ),
                    )
                  }
                >
                  取消跟进策略
                </button>
              </div>
              <section className="followup-reservation" aria-label="预约检查">
                <h2>下一次检查</h2>
                <label htmlFor="followup-at">检查时间 · Asia/Shanghai</label>
                <input
                  id="followup-at"
                  type="datetime-local"
                  value={appointment.at}
                  onChange={(event) =>
                    setAppointment({ ...appointment, at: event.target.value })
                  }
                />
                <label htmlFor="followup-reason">检查理由</label>
                <input
                  id="followup-reason"
                  value={appointment.reason}
                  onChange={(event) =>
                    setAppointment({
                      ...appointment,
                      reason: event.target.value,
                    })
                  }
                />
                <label htmlFor="followup-change">预期变化</label>
                <input
                  id="followup-change"
                  value={appointment.expected_change}
                  onChange={(event) =>
                    setAppointment({
                      ...appointment,
                      expected_change: event.target.value,
                    })
                  }
                />
                <div className="button-row">
                  <button
                    id="followup-request"
                    disabled={
                      busy ||
                      stale ||
                      draft.dirty ||
                      !actionFor(live, "request").allowed
                    }
                    onClick={() => act(() => reserve(false))}
                  >
                    预约检查
                  </button>
                  <button
                    id="followup-run"
                    disabled={
                      busy ||
                      stale ||
                      draft.dirty ||
                      !actionFor(live, "request").allowed
                    }
                    onClick={() => act(() => reserve(true))}
                  >
                    现在检查
                  </button>
                </div>
              </section>
              <section aria-label="跟进历史">
                <h2>预约与执行记录</h2>
                {history.data?.items.length === 0 && <p>还没有预约或执行。</p>}
                {history.data?.items.map((entry) => (
                  <article className="followup-entry" key={entry.id}>
                    <div className="title-row">
                      <strong>{phases[entry.state]}</strong>
                      <time>{date(entry.at_ms)}</time>
                    </div>
                    <p>
                      {entry.kind === "handoff" && "Agent 交接 · "}
                      {entry.reason} · 预期 {entry.expected_change}
                    </p>
                    {entry.status_reason && <p>{entry.status_reason}</p>}
                    {entry.run?.followup_bridge && (
                      <p role="status">
                        审核后提议 ·{" "}
                        {
                          {
                            pending: "等待校验",
                            applied: "已登记",
                            blocked: "已阻断",
                          }[entry.run.followup_bridge.state]
                        }
                        {entry.run.followup_bridge.error?.message &&
                          ` · ${entry.run.followup_bridge.error.message}`}
                      </p>
                    )}
                    {entry.run_id && (
                      <button onClick={() => onOpenRun?.(entry.run_id)}>
                        查看执行 #{entry.run_id}
                      </button>
                    )}
                  </article>
                ))}
                <div className="button-row">
                  <button
                    disabled={!historyBefore}
                    onClick={() => setHistoryBefore(null)}
                  >
                    最近记录
                  </button>
                  {history.data?.next_before && (
                    <button
                      onClick={() => setHistoryBefore(history.data.next_before)}
                    >
                      更早记录
                    </button>
                  )}
                </div>
              </section>
              {work.data && (
                <WorkItemExecution
                  item={work.data}
                  ready={ready}
                  busy={busy}
                  dirty={draft.dirty}
                  act={act}
                  onOpenRun={onOpenRun}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
