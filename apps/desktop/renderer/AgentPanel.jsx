import React, { useEffect, useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { actionFor } from "./client/actions.mjs";
import OwnedTasks from "./OwnedTasks";
import { HookHistory } from "./HooksPanel";
import McpRunPanel from "./McpRunPanel";
import MemoryUsage from "./MemoryUsage";
import OfficeReference from "./OfficeReference";
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
  external_cli: "外部 CLI 执行中",
  review: "等待固定结果审核",
  approval: "等待批准具体操作",
  resource: "等待本机执行资源",
  tool: "工具正在执行",
  background: "等待所属子代理或后台作业",
  context: "正在压缩已提交的上下文",
  hook: "正在执行 Hook 规则",
  host_resource: "等待宿主执行资源",
  authentication: "等待 MCP 认证刷新",
  mcp_discovery: "正在读取 MCP 工具目录",
  mcp_cleanup: "正在关闭 MCP 所属连接",
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
  openRun,
}) {
  const [selected, setSelected] = useState(null),
    [invId, setInvId] = useState(null);
  const [agentProfile, setAgentProfile] = useState(1),
    [showCheckpoints, setShowCheckpoints] = useState(false);
  const [creating, setCreating] = useState(true),
    [eventId, setEventId] = useState(null);
  const [provider, setProvider] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [goal, setGoal] = useState(""),
    [supplement, setSupplement] = useState(""),
    [note, setNote] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [actionError, setError] = useState("");
  const manualInvocation = useRef(false),
    sending = useRef(false),
    pending = useRef(null);
  const current = useRef({});
  current.current = { selected, generation };
  const enabled = ready && visible;
  const historyModel = clientModels.runs();
  const runModel = selected === null ? null : clientModels.run(selected);
  const eventModel = selected === null ? null : clientModels.events(selected);
  const history = useClientModel(historyModel, enabled);
  const detail = useClientModel(runModel, enabled);
  const ledger = useClientModel(eventModel, enabled);
  const profiles = useClientModel(clientModels.agents(), enabled);
  const eventState = useClientModel(
    eventId === null ? null : clientModels.event(eventId),
    enabled,
  );
  const checkpointState = useClientModel(
    selected === null ? null : clientModels.checkpoints(selected),
    enabled && showCheckpoints,
  );
  const eventDetail = eventState.data,
    checkpoints = checkpointState.data;
  const snapshot = detail.data;
  const runs = history.data?.items ?? [],
    nextOffset = history.data?.next_offset ?? null;
  const events = ledger.data?.items ?? [],
    eventCursor = ledger.data?.next_before ?? null;
  const agents = profiles.data ?? [];
  const invocationModel = invId == null ? null : clientModels.invocation(invId);
  const invocationState = useClientModel(invocationModel, enabled);
  const invocation = invocationState.data;
  const error =
    actionError ||
    [
      history,
      detail,
      ledger,
      profiles,
      invocationState,
      eventState,
      checkpointState,
    ].find((s) => s.error)?.error.message;
  useEffect(() => {
    if (openRun != null) choose(openRun);
  }, [openRun]);
  useEffect(() => {
    if (!snapshot) return;
    const actionable = snapshot.invocations.find(
      (i) =>
        i.allowed_actions?.approve?.allowed ||
        i.allowed_actions?.reconcile?.allowed ||
        (!i.allowed_actions &&
          ((i.state === "indeterminate" && !i.reviewed) ||
            (i.state === "prepared" &&
              i.approval === null &&
              (i.hook_ask ||
                i.name.startsWith("mcp_") ||
                [
                  "write_file",
                  "run_command",
                  "git_status",
                  "start_background",
                ].includes(i.name))))),
    );
    const chosen =
      !manualInvocation.current && actionable
        ? actionable.id
        : snapshot.invocations.some((i) => i.id === invId)
          ? invId
          : ((
              snapshot.invocations.find(
                (i) => i.state === "prepared" && i.approval === null,
              ) ?? snapshot.invocations.at(-1)
            )?.id ?? null);
    setInvId(chosen);
  }, [snapshot, invId]);
  const refreshRef = useRef(() => clientModels.invalidate());
  async function act(fn) {
    if (sending.current) return;
    sending.current = true;
    const expected = { ...current.current };
    manualInvocation.current = false;
    setBusy(true);
    setError("");
    try {
      await fn();
      clientModels.invalidate();
    } catch (e) {
      if (
        current.current.selected === expected.selected &&
        current.current.generation === expected.generation
      )
        setError(e.message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  function choose(id) {
    setEventId(null);
    setCreating(false);
    manualInvocation.current = false;
    setSelected(id);
    setInvId(null);
    setError("");
    setNote("");
    setReviewed(false);
    setShowCheckpoints(false);
  }
  function start(event) {
    event.preventDefault();
    act(async () => {
      const input = {
        agent_id: agentProfile,
        workspace_id: Number(workspace),
        provider_id: provider,
        goal,
      };
      const signature = JSON.stringify(input);
      if (pending.current?.signature !== signature)
        pending.current = { signature, id: crypto.randomUUID() };
      const result = await clientModels.command("agent.start", {
        ...input,
        client_run_id: pending.current.id,
      });
      pending.current = null;
      choose(result.run.id);
      setGoal("");
    });
  }
  const run = snapshot?.run;
  const active = run && !stopped(run.state);
  const legacyApproval =
    invocation?.state === "prepared" &&
    invocation.approval === null &&
    (invocation.hook_ask ||
      invocation.name.startsWith("mcp_") ||
      [
        "write_file",
        "office_edit",
        "run_command",
        "git_status",
        "start_background",
      ].includes(invocation.name)) &&
    active;
  const unresolved =
    snapshot?.mcp_unresolved ||
    snapshot?.hooks_unresolved ||
    snapshot?.tasks?.some(
      (t) => ["interrupted", "indeterminate"].includes(t.state) && !t.reviewed,
    ) ||
    snapshot?.invocations.some(
      (i) => i.state === "indeterminate" && !i.reviewed,
    );
  const resumeAction = snapshot?.allowed_actions?.resume;
  const selectedInvocation = snapshot?.invocations.find((i) => i.id === invId);
  const invocationCurrent =
    selectedInvocation &&
    invocation &&
    (selectedInvocation.revision === undefined ||
      selectedInvocation.revision === invocation.revision);
  const approveAction = actionFor(
    selectedInvocation,
    "approve",
    legacyApproval,
  );
  const approval = approveAction.allowed && invocationCurrent;
  const reviewAction = actionFor(
    selectedInvocation,
    "reconcile",
    invocation?.state === "indeterminate" && !active && !invocation.reviewed,
  );
  const receiptAction = actionFor(
    selectedInvocation,
    "reconcile_receipt",
    !invocation?.name.startsWith("mcp_"),
  );
  const stopAction = actionFor(
    snapshot,
    "stop",
    active && run.state !== "cancelling",
  );
  const compactAction = actionFor(
    snapshot,
    "compact",
    active && !run.waiting?.includes("context"),
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
          Agent
          <select
            id="agent-profile"
            value={agentProfile}
            disabled={!ready || busy}
            onChange={(e) => setAgentProfile(Number(e.target.value))}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.automatic ? " · 自动记忆" : ""}
              </option>
            ))}
          </select>
        </label>
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
                  await historyModel.more();
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
              {run.trigger && (
                <details>
                  <summary>事件来源与因果链</summary>
                  <pre>
                    {pretty({
                      trigger: run.trigger,
                      chain_id: run.chain_id,
                      chain_depth: run.chain_depth,
                    })}
                  </pre>
                </details>
              )}
              <div className="agent-status">
                <strong>
                  #{run.id} ·{" "}
                  {run.kind === "tool_action" ? "直接工具动作 · " : ""}
                  {states[run.state] ?? run.state}
                </strong>
                <span>
                  第 {run.step} 步 · 恢复版本 {run.epoch}
                  {run.authorization_id &&
                    ` · 授权 ${run.authorization_id} 修订 ${run.authorization_revision}`}
                </span>
                {active && (
                  <button
                    id="agent-stop"
                    disabled={!ready || busy || !stopAction.allowed}
                    title={stopAction.reason ?? undefined}
                    onClick={() =>
                      act(() =>
                        clientModels.command("agent.cancel", { id: run.id }),
                      )
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
              <div className="memory-actions">
                {active && (
                  <button
                    id="agent-compact"
                    disabled={!ready || busy || !compactAction.allowed}
                    title={compactAction.reason ?? undefined}
                    onClick={() =>
                      act(() =>
                        clientModels.command("agent.compact", { id: run.id }),
                      )
                    }
                  >
                    在安全边界压缩上下文
                  </button>
                )}
                <button
                  disabled={!ready || busy}
                  onClick={() => setShowCheckpoints(true)}
                >
                  查看摘要检查点 · {run.compaction_epoch ?? 0}
                </button>
              </div>
              {checkpoints && (
                <details open className="memory-job-detail">
                  <summary>摘要覆盖已提交历史；完整工具账本保留</summary>
                  <pre>{JSON.stringify(checkpoints, null, 2)}</pre>
                </details>
              )}
              <h2>任务目标</h2>
              <p className="muted agent-text">
                工作区：
                {workspaces.find((w) => w.id === run.workspace_id)?.path ??
                  `#${run.workspace_id}`}{" "}
                · {run.provider_name} / {run.model}
              </p>
              <p className="agent-text">{run.goal}</p>
              {run.goal_truncated && (
                <p className="muted">当前显示部分目标，完整内容正在同步。</p>
              )}
              {run.owner_task_id && (
                <p className="muted">
                  所属作业 #{run.owner_task_id} ·{" "}
                  {run.read_only
                    ? "只读子代理"
                    : "继承父任务能力，写入仍需逐次批准"}
                </p>
              )}
              <OwnedTasks
                tasks={snapshot.tasks}
                visible={visible}
                ready={ready}
                generation={generation}
                run={run}
                act={act}
                choose={choose}
              />
              <h2>模型输出</h2>
              {run.followup_bridge && (
                <p role="status">
                  审核后提议 ·{" "}
                  {
                    {
                      pending: "等待校验",
                      applied: "已登记预约或交接",
                      blocked: "已阻断",
                    }[run.followup_bridge.state]
                  }
                  {run.followup_bridge.error?.message &&
                    ` · ${run.followup_bridge.error.message}`}
                </p>
              )}
              <pre className="agent-output">
                {run.output ||
                  (active ? "等待模型与工具结果…" : "没有文本输出。")}
              </pre>
              {run.output_truncated && (
                <p className="muted">当前显示部分输出，完整内容正在同步。</p>
              )}
              <details className="agent-ledger">
                <summary>执行账本 · 模型步骤、审批与工具记录</summary>
                <ol>
                  {events.map((event) => (
                    <li key={event.id}>
                      <button
                        className="quiet"
                        onClick={() => setEventId(event.id)}
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
                        await eventModel.more();
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
                      {invocation.permission_plan && (
                        <details>
                          <summary>权限计划与执行依据</summary>
                          <pre>{pretty(invocation.permission_plan)}</pre>
                        </details>
                      )}
                      <pre aria-label="工具参数">
                        {pretty(invocation.operation ?? invocation.arguments)}
                      </pre>
                      {approval && (
                        <div className="agent-approval">
                          <p>
                            {invocation.name.startsWith("mcp_")
                              ? "请核对 MCP 服务、运行位置、工具和完整参数。该服务可能产生外部效果；批准仅适用于本次调用。"
                              : invocation.name === "git_status"
                                ? "将运行 Git 状态命令，可能执行仓库配置中的过滤器。请核对工作区；批准只适用于本次查询。"
                                : ["run_command", "start_background"].includes(
                                      invocation.name,
                                    )
                                  ? "此命令可访问工作区以外的宿主资源。请核对完整命令后决定。"
                                  : "请核对路径、内容和旧文件版本。批准仅适用于本次操作。"}
                          </p>
                          <button
                            id="agent-deny"
                            disabled={!ready || busy}
                            onClick={() =>
                              act(() =>
                                clientModels.command("agent.approve", {
                                  id: invocation.id,
                                  epoch: invocation.epoch,
                                  approved: false,
                                }),
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
                                clientModels.command("agent.approve", {
                                  id: invocation.id,
                                  epoch: invocation.epoch,
                                  approved: true,
                                }),
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
                        !invocation.reviewed && (
                          <div className="agent-reconcile">
                            {!invocation.name.startsWith("mcp_") && (
                              <button
                                disabled={
                                  !ready ||
                                  busy ||
                                  !receiptAction.allowed ||
                                  !invocationCurrent
                                }
                                title={receiptAction.reason ?? undefined}
                                onClick={() =>
                                  act(() =>
                                    clientModels.command("agent.reconcile", {
                                      id: invocation.id,
                                      epoch: invocation.epoch,
                                      source: "receipt",
                                      note: "",
                                    }),
                                  )
                                }
                              >
                                核对 Worker 回执
                              </button>
                            )}
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
                                !ready ||
                                busy ||
                                !reviewed ||
                                !note.trim() ||
                                !reviewAction.allowed ||
                                !invocationCurrent
                              }
                              title={reviewAction.reason ?? undefined}
                              onClick={() =>
                                act(() =>
                                  clientModels.command("agent.reconcile", {
                                    id: invocation.id,
                                    epoch: invocation.epoch,
                                    source: "reviewed",
                                    note,
                                  }),
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
                    {resumeAction?.reason ||
                      (unresolved
                        ? "先核对结果不明的工具，再手动继续。"
                        : "继续时重新评估后续步骤，旧工具调用不会自动重放。")}
                  </p>
                  <button
                    id="agent-resume"
                    disabled={
                      !ready ||
                      busy ||
                      (resumeAction ? !resumeAction.allowed : unresolved)
                    }
                    onClick={() =>
                      act(() =>
                        clientModels.command("agent.resume", { id: run.id }),
                      )
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
                    disabled={!ready || busy || !stopAction.allowed}
                    title={stopAction.reason ?? undefined}
                    onClick={() =>
                      act(() =>
                        clientModels.command("agent.cancel", { id: run.id }),
                      )
                    }
                  >
                    {run.intent === "cancel"
                      ? "核对后确认结束"
                      : "放弃后续步骤"}
                  </button>
                </div>
              )}
              {run.office_references?.length > 0 && (
                <section>
                  <h3>本次固定文件引用</h3>
                  {run.office_references.map((reference) => (
                    <OfficeReference
                      key={reference.id}
                      reference={reference}
                      ready={ready && visible}
                      label="执行固定文件引用"
                    />
                  ))}
                </section>
              )}
              <MemoryUsage
                key={run.id}
                run={run}
                ready={ready}
                visible={visible}
              />
              <HookHistory
                run={run}
                ready={ready}
                generation={generation}
                visible={visible}
                onChange={() => refreshRef.current()}
              />
              {visible && (
                <McpRunPanel
                  runId={run.id}
                  ready={ready}
                  generation={generation}
                  visible={visible}
                  onChange={() => refreshRef.current()}
                />
              )}
              {active && (
                <form
                  className="agent-steer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(async () => {
                      await clientModels.command("agent.steer", {
                        id: run.id,
                        client_input_id: crypto.randomUUID(),
                        text: supplement,
                      });
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
