import React, { useEffect, useRef, useState } from "react";
import { call } from "./api";
const states = {
  queued: "排队中",
  running: "正在执行",
  waiting: "等待处理",
  cancelling: "正在停止",
  interrupted: "已中断，等待核对",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  prepared: "已准备",
  dispatched: "已派发",
  succeeded: "成功",
  indeterminate: "结果不明",
};
const waits = {
  approval: "等待批准具体操作",
  resource: "等待本机执行资源",
  tool: "工具正在执行",
};
const stopped = (state) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(state);
const pretty = (value) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
export default function AgentPanel({
  ready,
  generation,
  providers,
  workspaces,
  visible,
}) {
  const [runs, setRuns] = useState([]),
    [selected, setSelected] = useState(null),
    [snapshot, setSnapshot] = useState(null),
    [invId, setInvId] = useState(null),
    [invocation, setInvocation] = useState(null);
  const [nextOffset, setNextOffset] = useState(null);
  const [creating, setCreating] = useState(true);
  const [events, setEvents] = useState([]),
    [eventCursor, setEventCursor] = useState(null),
    [eventDetail, setEventDetail] = useState(null);
  const eventsExpanded = useRef(false);
  const manualInvocation = useRef(false);
  const expandedHistory = useRef(false);
  const [provider, setProvider] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [goal, setGoal] = useState(""),
    [supplement, setSupplement] = useState(""),
    [note, setNote] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const current = useRef({});
  current.current = { ready, generation, selected, invId };
  const refreshing = useRef(false),
    sending = useRef(false),
    pending = useRef(null);
  async function refresh() {
    if (!current.current.ready || refreshing.current) return;
    refreshing.current = true;
    const expected = { ...current.current };
    const valid = () =>
      current.current.generation === expected.generation &&
      current.current.selected === expected.selected;
    try {
      const list = await call(window.troop.listRuns());
      if (!valid()) return;
      setRuns((old) =>
        expandedHistory.current
          ? [
              ...list.items,
              ...old.filter((r) => !list.items.some((i) => i.id === r.id)),
            ]
          : list.items,
      );
      if (!expandedHistory.current) setNextOffset(list.next_offset);
      if (expected.selected !== null) {
        const data = await call(window.troop.getRun(expected.selected));
        for (const field of ["goal", "output"]) {
          if (data.run[field + "_truncated"])
            data.run[field] = (
              await call(window.troop.getRunContent(expected.selected, field))
            ).text;
        }
        if (!valid()) return;
        setSnapshot(data);
        const log = await call(window.troop.listRunEvents(expected.selected));
        if (!valid()) return;
        setEvents((old) =>
          eventsExpanded.current
            ? [
                ...log.items,
                ...old.filter((i) => !log.items.some((e) => e.id === i.id)),
              ]
            : log.items,
        );
        if (!eventsExpanded.current) setEventCursor(log.next_before);
        const actionable = data.invocations.find(
          (i) =>
            (i.state === "indeterminate" && !i.reviewed) ||
            (i.state === "prepared" &&
              i.approval === null &&
              ["write_file", "run_command", "git_status"].includes(i.name)),
        );
        const id =
          !manualInvocation.current && actionable
            ? actionable.id
            : data.invocations.some((i) => i.id === expected.invId)
              ? expected.invId
              : (
                  data.invocations.find(
                    (i) => i.state === "prepared" && i.approval === null,
                  ) ?? data.invocations.at(-1)
                )?.id;
        if (id) {
          const inv = await call(window.troop.getInvocation(id));
          if (valid() && current.current.invId === expected.invId) {
            setInvId(id);
            setInvocation(inv);
          }
        } else {
          setInvId(null);
          setInvocation(null);
        }
      }
    } catch (e) {
      if (valid()) setError(e.message);
    } finally {
      refreshing.current = false;
    }
  }
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!ready || !visible) return;
    refreshRef.current();
    const timer = setInterval(() => refreshRef.current(), 350);
    return () => clearInterval(timer);
  }, [ready, generation, selected, invId, visible]);
  async function act(fn) {
    if (sending.current) return;
    sending.current = true;
    manualInvocation.current = false;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refreshRef.current();
    } catch (e) {
      setError(e.message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  function choose(id) {
    setEvents([]);
    setEventDetail(null);
    setEventCursor(null);
    eventsExpanded.current = false;
    setCreating(false);
    manualInvocation.current = false;
    setSelected(id);
    setSnapshot(null);
    setInvId(null);
    setInvocation(null);
    setError("");
    setNote("");
    setReviewed(false);
  }
  function start(event) {
    event.preventDefault();
    act(async () => {
      const input = {
        workspace_id: Number(workspace),
        provider_id: provider,
        goal,
      };
      const signature = JSON.stringify(input);
      if (pending.current?.signature !== signature)
        pending.current = { signature, id: crypto.randomUUID() };
      const result = await call(
        window.troop.startRun({ ...input, client_run_id: pending.current.id }),
      );
      pending.current = null;
      choose(result.run.id);
      setGoal("");
    });
  }
  const run = snapshot?.run;
  const active = run && !stopped(run.state);
  const approval =
    invocation?.state === "prepared" &&
    invocation.approval === null &&
    ["write_file", "run_command", "git_status"].includes(invocation.name) &&
    active;
  const unresolved = snapshot?.invocations.some(
    (i) => i.state === "indeterminate" && !i.reviewed,
  );
  return (
    <section className="agent-page" data-ui="builder">
      <div className="title-row">
        <div>
          {visible ? <h1>任务</h1> : <h2>任务</h2>}
          <p>在指定工作区执行任务，操作和结果保存在本机。</p>
        </div>
        <button id="agent-new" onClick={() => setCreating(true)}>
          新建任务
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form className="agent-start" onSubmit={start} hidden={!creating}>
        <label>
          模型服务
          <select
            id="agent-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={!ready || busy}
          >
            <option value="">选择模型服务</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.config.name} · {p.config.model}
              </option>
            ))}
          </select>
        </label>
        <label>
          工作区
          <select
            id="agent-workspace"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            disabled={!ready || busy}
          >
            <option value="">选择已登记工作区</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="agent-goal">
          任务目标
          <textarea
            id="agent-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            maxLength={12000}
            placeholder="描述需要完成的文件或命令任务"
            disabled={!ready || busy}
          />
        </label>
        <p className="muted">
          启动后允许读取所选工作区；写文件和宿主命令逐次确认。命令以当前 Windows
          用户权限运行。
        </p>
        <button
          id="agent-start"
          className="primary"
          disabled={!ready || busy || !goal.trim() || !workspace || !provider}
        >
          开始任务
        </button>
      </form>
      <div className="agent-layout">
        <aside aria-label="任务历史">
          <h2>最近任务</h2>
          {runs.length ? (
            runs.map((r) => (
              <button
                key={r.id}
                className={selected === r.id ? "agent-row chosen" : "agent-row"}
                onClick={() => choose(r.id)}
              >
                <span>
                  #{r.id} {r.title}
                </span>
                <small>{states[r.state] ?? r.state}</small>
              </button>
            ))
          ) : (
            <p className="muted">尚未开始任务。</p>
          )}
          {nextOffset !== null && (
            <button
              disabled={!ready || busy}
              onClick={() =>
                act(async () => {
                  const page = await call(window.troop.listRuns(nextOffset));
                  expandedHistory.current = true;
                  setRuns((old) => [
                    ...old,
                    ...page.items.filter(
                      (r) => !old.some((i) => i.id === r.id),
                    ),
                  ]);
                  setNextOffset(page.next_offset);
                })
              }
            >
              更多任务
            </button>
          )}
        </aside>
        <div className="agent-detail" aria-label="任务执行记录">
          {run ? (
            <>
              <div className="agent-status">
                <strong>
                  #{run.id} · {states[run.state] ?? run.state}
                </strong>
                <span>
                  第 {run.step} 步 · 恢复版本 {run.epoch}
                </span>
                {active && (
                  <button
                    id="agent-stop"
                    disabled={!ready || busy || run.state === "cancelling"}
                    onClick={() =>
                      act(() => call(window.troop.cancelRun(run.id)))
                    }
                  >
                    停止任务
                  </button>
                )}
              </div>
              {run.waiting?.length > 0 && (
                <p role="status">
                  {run.waiting.map((w) => waits[w] ?? w).join("；")}
                </p>
              )}
              {run.error && (
                <p className="message-problem">{pretty(run.error)}</p>
              )}
              <h2>任务目标</h2>
              <p className="muted agent-text">
                工作区：
                {workspaces.find((w) => w.id === run.workspace_id)?.path ??
                  `#${run.workspace_id}`}{" "}
                · {run.provider_name} / {run.model}
              </p>
              <p className="agent-text">{run.goal}</p>
              <h2>模型输出</h2>
              <pre className="agent-output">
                {run.output ||
                  (active ? "等待模型与工具结果…" : "没有文本输出。")}
              </pre>
              <details className="agent-ledger">
                <summary>执行账本 · 模型步骤、审批与工具记录</summary>
                <ol>
                  {events.map((event) => (
                    <li key={event.id}>
                      <button
                        className="quiet"
                        onClick={() =>
                          act(async () => {
                            const detail = await call(
                              window.troop.getRunEvent(event.id),
                            );
                            if (current.current.selected === run.id)
                              setEventDetail(detail);
                          })
                        }
                      >
                        {event.created_at.slice(11, 19)} · 第 {event.step ?? 0}{" "}
                        步 ·{" "}
                        {{
                          accepted: "接收任务",
                          model_started: "请求模型",
                          model_finished: "模型回复",
                          approval_decided: "审批决定",
                          tool_dispatched: "派发工具",
                          worker_accepted: "工具开始",
                          tool_result: "工具结果",
                          tool_rejected: "拒绝操作",
                          recovered: "恢复核对",
                          manual_resume: "手动继续",
                          reconciled: "核对结论",
                          stopped: "停止记录",
                          input_received: "收到补充",
                          input_applied: "采纳补充",
                        }[event.kind] ?? event.kind}
                      </button>
                    </li>
                  ))}
                </ol>
                {eventCursor !== null && (
                  <button
                    disabled={!ready || busy}
                    onClick={() =>
                      act(async () => {
                        const page = await call(
                          window.troop.listRunEvents(run.id, eventCursor),
                        );
                        eventsExpanded.current = true;
                        setEvents((old) => [
                          ...old,
                          ...page.items.filter(
                            (i) => !old.some((e) => e.id === i.id),
                          ),
                        ]);
                        setEventCursor(page.next_before);
                      })
                    }
                  >
                    更早的执行记录
                  </button>
                )}
                {eventDetail && (
                  <pre aria-label="执行事件详情">{pretty(eventDetail)}</pre>
                )}
              </details>
              {snapshot.invocations.length > 0 && (
                <>
                  <label>
                    工具记录
                    <select
                      id="agent-invocation"
                      value={invId ?? ""}
                      onChange={(e) => {
                        manualInvocation.current = true;
                        setInvId(Number(e.target.value));
                        setInvocation(null);
                        setNote("");
                        setReviewed(false);
                      }}
                    >
                      {snapshot.invocations.map((i) => (
                        <option key={i.id} value={i.id}>
                          #{i.id} {i.name} · {states[i.state] ?? i.state}
                        </option>
                      ))}
                    </select>
                  </label>
                  {invocation && (
                    <div className="agent-tool" data-state={invocation.state}>
                      <h2>
                        {invocation.name} ·{" "}
                        {states[invocation.state] ?? invocation.state}
                      </h2>
                      <pre aria-label="工具参数">
                        {pretty(invocation.operation ?? invocation.arguments)}
                      </pre>
                      {approval && (
                        <div className="agent-approval">
                          <p>
                            {invocation.name === "git_status"
                              ? "将运行 Git 状态命令，可能执行仓库配置中的过滤器。请核对工作区；批准只适用于本次查询。"
                              : invocation.name === "run_command"
                                ? "此命令可访问工作区以外的宿主资源。请核对完整命令后决定。"
                                : "请核对路径、内容和旧文件版本。批准仅适用于本次操作。"}
                          </p>
                          <button
                            id="agent-deny"
                            disabled={!ready || busy}
                            onClick={() =>
                              act(() =>
                                call(
                                  window.troop.approveInvocation({
                                    id: invocation.id,
                                    epoch: invocation.epoch,
                                    approved: false,
                                  }),
                                ),
                              )
                            }
                          >
                            拒绝此操作
                          </button>
                          <button
                            id="agent-approve"
                            disabled={!ready || busy}
                            onClick={() =>
                              act(() =>
                                call(
                                  window.troop.approveInvocation({
                                    id: invocation.id,
                                    epoch: invocation.epoch,
                                    approved: true,
                                  }),
                                ),
                              )
                            }
                          >
                            批准此操作
                          </button>
                        </div>
                      )}
                      {invocation.result && (
                        <pre aria-label="工具结果">
                          {pretty(invocation.result)}
                        </pre>
                      )}
                      {invocation.state === "indeterminate" &&
                        !active &&
                        !invocation.reviewed && (
                          <div className="agent-reconcile">
                            <button
                              disabled={!ready || busy}
                              onClick={() =>
                                act(() =>
                                  call(
                                    window.troop.reconcileInvocation({
                                      id: invocation.id,
                                      epoch: invocation.epoch,
                                      source: "receipt",
                                      note: "",
                                    }),
                                  ),
                                )
                              }
                            >
                              核对 Worker 回执
                            </button>
                            <label>
                              核对说明
                              <textarea
                                id="agent-review-note"
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                maxLength={2000}
                              />
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={reviewed}
                                onChange={(e) => setReviewed(e.target.checked)}
                              />
                              已核对实际效果，并确认相关命令已停止
                            </label>
                            <button
                              disabled={
                                !ready || busy || !reviewed || !note.trim()
                              }
                              onClick={() =>
                                act(() =>
                                  call(
                                    window.troop.reconcileInvocation({
                                      id: invocation.id,
                                      epoch: invocation.epoch,
                                      source: "reviewed",
                                      note,
                                    }),
                                  ),
                                )
                              }
                            >
                              记录核对结论
                            </button>
                          </div>
                        )}
                    </div>
                  )}
                </>
              )}
              {run.state === "interrupted" && !run.intent && (
                <div className="agent-resume">
                  <p>
                    {unresolved
                      ? "先核对结果不明的工具，再手动继续。"
                      : "继续时重新评估后续步骤，旧工具调用不会自动重放。"}
                  </p>
                  <button
                    id="agent-resume"
                    disabled={!ready || busy || unresolved}
                    onClick={() =>
                      act(() => call(window.troop.resumeRun(run.id)))
                    }
                  >
                    核对后继续任务
                  </button>
                </div>
              )}
              {run.state === "interrupted" && (
                <div className="agent-resume">
                  <p>
                    结束任务会保留已有文件与结果；尚未确认停止的操作仍需核对。
                  </p>
                  <button
                    id="agent-end"
                    disabled={
                      !ready || busy || (run.intent === "cancel" && unresolved)
                    }
                    onClick={() =>
                      act(() => call(window.troop.cancelRun(run.id)))
                    }
                  >
                    {run.intent === "cancel"
                      ? "核对后确认结束"
                      : "放弃后续步骤"}
                  </button>
                </div>
              )}
              {active && (
                <form
                  className="agent-steer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(async () => {
                      await call(
                        window.troop.steerRun({
                          id: run.id,
                          client_input_id: crypto.randomUUID(),
                          text: supplement,
                        }),
                      );
                      setSupplement("");
                    });
                  }}
                >
                  <label>
                    补充指令
                    <textarea
                      id="agent-supplement"
                      value={supplement}
                      onChange={(e) => setSupplement(e.target.value)}
                      maxLength={12000}
                      placeholder="将在下一个安全边界处理"
                    />
                  </label>
                  <button disabled={!ready || busy || !supplement.trim()}>
                    发送补充指令
                  </button>
                </form>
              )}
            </>
          ) : (
            <p className="muted">
              {selected
                ? "正在读取执行记录…"
                : "选择任务查看执行步骤、待审批操作和结果。"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
