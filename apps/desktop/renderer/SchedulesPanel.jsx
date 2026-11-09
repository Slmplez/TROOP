import React, { useEffect, useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { actionFor } from "./client/actions.mjs";
import WorkItemExecution from "./WorkItemExecution";

const draftKey = "troop.scheduled-execution.draft";
const definitionKeys = [
  "kind",
  "event",
  "name",
  "enabled",
  "agent_id",
  "workspace_id",
  "project_id",
  "work_item_id",
  "schedule",
  "start",
  "expected_plan_sha256",
];
const definition = (rule) =>
  Object.fromEntries(definitionKeys.map((key) => [key, rule[key]]));
function fresh(workspaces) {
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 86400000));
  const workspace = workspaces[0]?.id ?? 1;
  return {
    id: null,
    revision: 0,
    rule: {
      kind: "scheduled",
      event: "time.due",
      name: "新定时执行",
      enabled: true,
      agent_id: 1,
      workspace_id: workspace,
      project_id: null,
      work_item_id: null,
      schedule: {
        kind: "once",
        timezone: "Asia/Shanghai",
        date,
        time: "09:00",
        weekdays: [],
      },
      start: {
        client_run_id: crypto.randomUUID(),
        agent_id: 1,
        workspace_id: workspace,
        project_ids: [],
        provider_id: "",
        authorization_id: "",
        goal: "",
      },
    },
  };
}
function restore(workspaces) {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey));
    if (
      value?.rule?.kind === "scheduled" &&
      value.rule.start &&
      value.rule.schedule &&
      Array.isArray(value.rule.schedule.weekdays)
    )
      return value;
  } catch {
    /* A fresh form remains available if local draft storage is damaged. */
  }
  return fresh(workspaces);
}
const phaseLabel = {
  active: "已启用",
  paused: "已暂停",
  completed: "时间计划已结束",
  cancelled: "已取消",
};
const slotLabel = (slot) =>
  `${slot.local_date} ${slot.local_time} · ${slot.timezone}${slot.state === "dst_gap" ? " · 缺失时刻，跳过" : ""}`;
export default function SchedulesPanel({
  ready,
  workspaces = [],
  onOpenRun,
  openAutomation,
}) {
  useEffect(() => {
    if (openAutomation?.kind === "scheduled") edit(openAutomation);
  }, [openAutomation]);
  const [draft, setDraft] = useState(() => restore(workspaces)),
    [offset, setOffset] = useState(0),
    [preview, setPreview] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const list = useClientModel(clientModels.resource("rules.list", { offset }));
  const agents = useClientModel(clientModels.agents());
  const providers = useClientModel(clientModels.resource("provider.list", {}));
  const engines = useClientModel(clientModels.resource("engines.list", {}));
  const projects = useClientModel(
    clientModels.resource("memory.projects", { agent_id: draft.rule.agent_id }),
  );
  const live = useClientModel(
    draft.id ? clientModels.resource("schedules.get", { id: draft.id }) : null,
  );
  const historyModel = draft.id
      ? clientModels.resource("schedules.history", { id: draft.id })
      : null,
    history = useClientModel(historyModel);
  const current = live.data?.id === draft.id ? live.data : null;
  const running = useClientModel(
    current?.current_run ? clientModels.run(current.current_run.id) : null,
  );
  const linked = useClientModel(
    draft.rule.work_item_id
      ? clientModels.resource("work_items.get", { id: draft.rule.work_item_id })
      : null,
  );
  const stale = Boolean(
    draft.id && (!current || current.revision !== draft.revision),
  );
  const availability = current?.allowed_actions;
  const editable =
    ready && !busy && !stale && (!draft.id || availability?.save.allowed);
  const cli = typeof draft.rule.start.engine_id === "string";
  const provider =
    draft.rule.start.provider_id || providers.data?.[0]?.id || "";
  const input = {
    ...draft.rule,
    ...(!cli ? { start: { ...draft.rule.start, provider_id: provider } } : {}),
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
  const signature = JSON.stringify({ ...input, expected_plan_sha256: null });
  const confirmed = preview?.signature === signature;
  const stop = actionFor(running.data, "stop");
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      /* The current form remains usable without persisted drafts. */
    }
  }, [draft]);
  function edit(rule) {
    setDraft(
      rule
        ? { id: rule.id, revision: rule.revision, rule: definition(rule) }
        : fresh(workspaces),
    );
    setPreview(null);
    setError("");
  }
  function field(key, value) {
    setDraft((old) => {
      const rule = { ...old.rule, [key]: value };
      if (key === "agent_id" || key === "workspace_id")
        rule.start = { ...rule.start, [key]: value };
      if (key === "project_id")
        rule.start = { ...rule.start, project_ids: value ? [value] : [] };
      return { ...old, rule };
    });
    setPreview(null);
  }
  function startField(key, value) {
    field("start", { ...draft.rule.start, [key]: value });
  }
  function scheduleField(key, value) {
    field("schedule", { ...draft.rule.schedule, [key]: value });
  }
  function switchExecution(kind) {
    const start = {
      client_run_id: draft.rule.start.client_run_id,
      agent_id: draft.rule.agent_id,
      workspace_id: draft.rule.workspace_id,
      project_ids: draft.rule.project_id ? [draft.rule.project_id] : [],
      authorization_id: "",
      goal: draft.rule.start.goal,
    };
    field(
      "start",
      kind === "cli"
        ? {
            ...start,
            engine_id: "codex",
            tool_mode: "native",
            approval_mode: "preauthorized",
          }
        : { ...start, provider_id: provider },
    );
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
  const failure =
    error ||
    list.error?.message ||
    live.error?.message ||
    history.error?.message ||
    projects.error?.message ||
    providers.error?.message ||
    engines.error?.message ||
    agents.error?.message ||
    linked.error?.message ||
    running.error?.message;
  return (
    <div className="models-page scheduled-page">
      <div className="title-row">
        <h1>定时 Agent 执行</h1>
        <button
          id="schedule-new"
          disabled={!ready || busy}
          onClick={() => edit(null)}
        >
          新建定时执行
        </button>
      </div>
      <p>
        每个有效槽位创建独立
        Run。启动前重新核对范围预授权，前次执行未决时记录阻断。退出或休眠错过的槽位跳过，可明确手动补跑。
      </p>
      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}
      <div className="models-layout">
        <section className="provider-library" aria-label="定时执行列表">
          {list.data?.items
            .filter((rule) => rule.kind === "scheduled")
            .map((rule) => (
              <button
                className="provider-choice"
                key={rule.id}
                disabled={busy}
                onClick={() => edit(rule)}
              >
                {rule.name} · 修订 {rule.revision} ·{" "}
                {rule.cancelled ? "已取消" : rule.enabled ? "启用" : "暂停"}
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
        <section className="provider-form" aria-label="定时执行配置">
          {draft.id && (
            <p id="schedule-phase">
              {phaseLabel[current?.phase] || "正在核对"} · 修订 {draft.revision}
              {current?.next_slot && ` · 下次 ${slotLabel(current.next_slot)}`}
            </p>
          )}
          {stale && (
            <p role="status">
              规则已变化或正在核对。
              <button disabled={!current || busy} onClick={() => edit(current)}>
                载入当前定时修订
              </button>
            </p>
          )}
          {current?.current_blocker && (
            <p role="status">{current.current_blocker}</p>
          )}
          <label htmlFor="schedule-name">名称</label>
          <input
            id="schedule-name"
            maxLength={120}
            disabled={!editable}
            value={draft.rule.name}
            onChange={(event) => field("name", event.target.value)}
          />
          <label htmlFor="schedule-agent">负责 Agent</label>
          <select
            id="schedule-agent"
            disabled={!editable}
            value={draft.rule.agent_id}
            onChange={(event) => {
              field("agent_id", Number(event.target.value));
              field("project_id", null);
            }}
          >
            {agents.data?.map((agent) => (
              <option value={agent.id} key={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <label htmlFor="schedule-project">项目</label>
          <select
            id="schedule-project"
            disabled={!editable}
            value={draft.rule.project_id || ""}
            onChange={(event) =>
              field("project_id", event.target.value || null)
            }
          >
            <option value="">个人范围</option>
            {projects.data
              ?.filter((project) => project.joined)
              .map((project) => (
                <option value={project.slug} key={project.slug}>
                  {project.name}
                </option>
              ))}
          </select>
          <label htmlFor="schedule-workspace">工作区</label>
          <select
            id="schedule-workspace"
            disabled={!editable}
            value={draft.rule.workspace_id}
            onChange={(event) =>
              field("workspace_id", Number(event.target.value))
            }
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.path}
              </option>
            ))}
          </select>
          <label htmlFor="schedule-work">关联工作项 ID</label>
          <input
            id="schedule-work"
            type="number"
            min="1"
            disabled={!editable}
            value={draft.rule.work_item_id ?? ""}
            onChange={(event) =>
              field(
                "work_item_id",
                event.target.value ? Number(event.target.value) : null,
              )
            }
          />
          {linked.data && (
            <p>
              #{linked.data.id} · {linked.data.title} · 工作定义修订{" "}
              {linked.data.definition_revision}
            </p>
          )}
          <label htmlFor="schedule-execution">执行方式</label>
          <select
            id="schedule-execution"
            disabled={!editable}
            value={cli ? "cli" : "agent"}
            onChange={(event) => switchExecution(event.target.value)}
          >
            <option value="agent">原生 Agent</option>
            <option value="cli">Coding CLI</option>
          </select>
          {cli ? (
            <>
              <label htmlFor="schedule-engine">CLI</label>
              <select
                id="schedule-engine"
                disabled={!editable}
                value={draft.rule.start.engine_id}
                onChange={(event) =>
                  field("start", {
                    ...draft.rule.start,
                    engine_id: event.target.value,
                    approval_mode: "preauthorized",
                  })
                }
              >
                {engines.data?.map((engine) => (
                  <option value={engine.id} key={engine.id}>
                    {engine.name || engine.id}
                  </option>
                ))}
              </select>
              <label htmlFor="schedule-tools">工具模式</label>
              <select
                id="schedule-tools"
                disabled={!editable}
                value={draft.rule.start.tool_mode || "native"}
                onChange={(event) =>
                  startField("tool_mode", event.target.value)
                }
              >
                <option value="native">原生受限工具</option>
                <option value="disabled">纯文本</option>
              </select>
              <label htmlFor="schedule-approval">运行时审批</label>
              <select
                id="schedule-approval"
                disabled={!editable}
                value={draft.rule.start.approval_mode || "preauthorized"}
                onChange={(event) =>
                  startField("approval_mode", event.target.value)
                }
              >
                <option value="preauthorized">范围预授权</option>
                <option value="manual">逐次人工处理</option>
              </select>
            </>
          ) : (
            <>
              <label htmlFor="schedule-provider">模型服务</label>
              <select
                id="schedule-provider"
                disabled={!editable}
                value={provider}
                onChange={(event) =>
                  startField("provider_id", event.target.value)
                }
              >
                {providers.data?.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.config.name} · {item.config.model}
                  </option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="schedule-authorization">范围预授权 ID</label>
          <input
            id="schedule-authorization"
            disabled={!editable}
            value={draft.rule.start.authorization_id || ""}
            onChange={(event) =>
              startField("authorization_id", event.target.value)
            }
          />
          <p>
            使用授权页创建的对应
            Agent、引擎、工作区及项目授权。预览显示实际生效的权限计划。
          </p>
          <label htmlFor="schedule-goal">本次执行目标</label>
          <textarea
            id="schedule-goal"
            rows={4}
            disabled={!editable}
            value={draft.rule.start.goal}
            onChange={(event) => startField("goal", event.target.value)}
          />
          <label htmlFor="schedule-kind">重复</label>
          <select
            id="schedule-kind"
            disabled={!editable}
            value={draft.rule.schedule.kind}
            onChange={(event) => scheduleField("kind", event.target.value)}
          >
            <option value="once">一次性</option>
            <option value="daily">每日</option>
            <option value="weekly">每周</option>
          </select>
          <label htmlFor="schedule-zone">固定时区</label>
          <input
            id="schedule-zone"
            disabled={!editable}
            value={draft.rule.schedule.timezone}
            onChange={(event) => scheduleField("timezone", event.target.value)}
          />
          {draft.rule.schedule.kind === "once" && (
            <>
              <label htmlFor="schedule-date">日期</label>
              <input
                id="schedule-date"
                type="date"
                disabled={!editable}
                value={draft.rule.schedule.date || ""}
                onChange={(event) => scheduleField("date", event.target.value)}
              />
            </>
          )}
          <label htmlFor="schedule-time">时间</label>
          <input
            id="schedule-time"
            type="time"
            step="1"
            disabled={!editable}
            value={draft.rule.schedule.time}
            onChange={(event) => scheduleField("time", event.target.value)}
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
                        scheduleField(
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
              id="schedule-preview"
              disabled={!editable}
              onClick={() =>
                act(async () =>
                  setPreview({
                    signature,
                    result: await clientModels.read("schedules.preview", {
                      ...(draft.id ? { id: draft.id } : {}),
                      rule: input,
                    }),
                  }),
                )
              }
            >
              预览时间与权限
            </button>
            <button
              id="schedule-save"
              disabled={
                !editable ||
                !confirmed ||
                (input.enabled && !preview?.result.slots.length)
              }
              onClick={() =>
                act(async () =>
                  edit(
                    await clientModels.command("rules.save", {
                      ...(draft.id ? { id: draft.id } : {}),
                      expected_revision: draft.revision,
                      rule: {
                        ...input,
                        expected_plan_sha256: preview.result.plan_sha256,
                      },
                    }),
                  ),
                )
              }
            >
              确认并保存定时执行
            </button>
          </div>
          {confirmed && (
            <div id="schedule-preview-result">
              {!preview.result.slots.length && (
                <p>没有未来触发时间，请修改时间设置。</p>
              )}
              <ul>
                {preview.result.slots.map((slot) => (
                  <li key={slot.slot_key}>{slotLabel(slot)}</li>
                ))}
              </ul>
              <details open>
                <summary>本次确认的权限计划</summary>
                <pre>{JSON.stringify(preview.result.plan, null, 2)}</pre>
              </details>
            </div>
          )}
          {draft.id && (
            <div className="title-row">
              <button
                id="schedule-toggle"
                title={availability?.set_enabled?.reason || ""}
                disabled={
                  !ready || busy || stale || !availability?.set_enabled?.allowed
                }
                onClick={() =>
                  act(async () =>
                    edit(
                      await clientModels.command("schedules.set_enabled", {
                        id: draft.id,
                        expected_revision: draft.revision,
                        enabled: !current.enabled,
                      }),
                    ),
                  )
                }
              >
                {current?.enabled ? "暂停定时规则" : "启用定时规则"}
              </button>
              <button
                id="schedule-run"
                title={availability?.run.reason || ""}
                disabled={!ready || busy || stale || !availability?.run.allowed}
                onClick={() =>
                  act(() =>
                    clientModels.command("schedules.run", {
                      id: draft.id,
                      expected_revision: draft.revision,
                      client_trigger_id: crypto.randomUUID(),
                    }),
                  )
                }
              >
                立即执行一次
              </button>
              <button
                id="schedule-cancel"
                disabled={
                  !ready || busy || stale || !availability?.cancel.allowed
                }
                title={availability?.cancel.reason || ""}
                onClick={() =>
                  act(async () =>
                    edit(
                      await clientModels.command("schedules.cancel", {
                        id: draft.id,
                        expected_revision: draft.revision,
                      }),
                    ),
                  )
                }
              >
                取消定时规则
              </button>
            </div>
          )}
        </section>
      </div>
      {current?.current_run && (
        <section aria-label="当前关联执行">
          <h2>关联执行 #{current.current_run.id}</h2>
          <p>{running.data?.run.state || current.current_run.state}</p>
          <button
            id="schedule-open-run"
            onClick={() => onOpenRun(current.current_run.id)}
          >
            查看执行、核对与结果审核
          </button>
          <button
            id="schedule-stop-run"
            disabled={!ready || busy || !stop.allowed}
            title={stop.reason || ""}
            onClick={() =>
              act(() =>
                clientModels.command("agent.cancel", {
                  id: current.current_run.id,
                }),
              )
            }
          >
            停止关联执行
          </button>
        </section>
      )}
      {draft.id && (
        <section aria-label="定时触发历史">
          <h2>触发与派发历史</h2>
          <div id="schedule-history">
            {history.data?.items.map((item) => (
              <article key={item.id}>
                <p>
                  {slotLabel(item.slot)} ·{" "}
                  {
                    {
                      dispatched: "已派发",
                      skipped: "已跳过",
                      blocked: "已阻断",
                    }[item.state]
                  }{" "}
                  · {item.reason}
                </p>
                <p>
                  规则修订 {item.rule_revision}
                  {item.permission &&
                    ` · 授权修订 ${item.permission.grant_revision}`}
                  {item.source_slot_id && ` · 原触发 #${item.source_slot_id}`}
                </p>
                {item.frozen_definition && (
                  <details>
                    <summary>冻结定义与派发依据</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          definition: item.frozen_definition,
                          permission: item.permission,
                          rule_revision: item.rule_revision,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                )}
                {item.run && (
                  <button onClick={() => onOpenRun(item.run.id)}>
                    执行 #{item.run.id} · {item.run.state}
                  </button>
                )}
                {item.work_item && (
                  <p>
                    工作项 #{item.work_item.id} ·{" "}
                    {item.work_item.progress.state}
                  </p>
                )}
                <button
                  disabled={
                    !ready || busy || stale || !availability?.run.allowed
                  }
                  title={availability?.run.reason || ""}
                  onClick={() =>
                    act(() =>
                      clientModels.command("schedules.run", {
                        id: draft.id,
                        expected_revision: draft.revision,
                        client_trigger_id: crypto.randomUUID(),
                        source_slot_id: item.id,
                      }),
                    )
                  }
                >
                  以此记录手动补跑
                </button>
              </article>
            ))}
          </div>
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
      {linked.data && (
        <WorkItemExecution
          key={linked.data.id}
          item={linked.data}
          ready={ready}
          busy={busy}
          dirty={false}
          act={act}
          onOpenRun={onOpenRun}
        />
      )}
    </div>
  );
}
