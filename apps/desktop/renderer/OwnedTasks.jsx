import CliInteractions from "./CliInteractions";
import React, { useEffect, useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { actionFor } from "./client/actions.mjs";

const names = {
  queued: "排队中",
  dispatched: "已派发",
  running: "运行中",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "等待核对",
  indeterminate: "结果不明",
  awaiting_review: "等待结果审核",
};
const active = (task) =>
  ["queued", "dispatched", "running", "cancelling"].includes(task.state);
const unknown = (task) =>
  ["interrupted", "indeterminate"].includes(task.state) && !task.reviewed;
export default function OwnedTasks({
  tasks,
  visible,
  ready,
  generation,
  run,
  act,
  choose,
}) {
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState(""),
    [reviewed, setReviewed] = useState(false);
  const model = selected === null ? null : clientModels.task(selected);
  const state = useClientModel(model, ready && visible);
  const detail = state.data,
    error = state.error?.message;
  useEffect(() => {
    setSelected(null);
    setNote("");
    setReviewed(false);
  }, [run.id, generation]);
  useEffect(() => {
    setNote("");
    setReviewed(false);
  }, [detail?.evidence?.sha256]);
  if (!tasks?.length) return null;
  const current = tasks.find((t) => t.id === selected);
  const reviewAction = actionFor(
    detail,
    "reconcile",
    current &&
      unknown(current) &&
      ["interrupted", "cancelled", "failed"].includes(run.state),
  );
  const receiptAction = actionFor(
    detail,
    "reconcile_receipt",
    ["background", "external_cli"].includes(detail?.kind) &&
      reviewAction.allowed,
  );
  const reconcile = (source) =>
    act(() =>
      clientModels.command("agent.reconcile-task", {
        id: detail.id,
        epoch: detail.epoch,
        source,
        note: source === "reviewed" ? note : "",
      }),
    );
  return (
    <section className="owned-tasks" aria-label="所属任务树">
      <h2>所属作业</h2>
      <p className="muted">
        每项作业均有归属；停止父任务会停止所属任务树，已产生的文件与结果保留。
      </p>
      <ul className="owned-task-list">
        {tasks.map((task) => (
          <li key={task.id} data-task-id={task.id}>
            <div>
              <button
                className="quiet"
                aria-pressed={selected === task.id}
                onClick={() => {
                  setSelected(task.id);
                  setNote("");
                  setReviewed(false);
                }}
              >
                #{task.id} ·{" "}
                {task.kind === "agent"
                  ? "子代理"
                  : task.kind === "external_cli"
                    ? "外部 CLI"
                    : "后台命令"}{" "}
                · {names[task.state] ?? task.state}
              </button>
              <span className="muted">
                归属任务 #{task.owner_run_id}
                {task.parent_task_id
                  ? ` · 上级作业 #${task.parent_task_id}`
                  : ""}
              </span>
              <p className="agent-text">{task.title}</p>
            </div>
            <div className="owned-task-actions">
              {task.child_run_id && (
                <button
                  disabled={!ready}
                  onClick={() => choose(task.child_run_id)}
                >
                  查看子代理 #{task.child_run_id}
                </button>
              )}
              {active(task) && (
                <button
                  disabled={
                    !ready ||
                    !actionFor(task, "stop", task.state !== "cancelling")
                      .allowed
                  }
                  title={actionFor(task, "stop").reason ?? undefined}
                  onClick={() =>
                    act(() =>
                      clientModels.command("agent.stop-task", { id: task.id }),
                    )
                  }
                >
                  停止此作业及子任务
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="message-problem">
          {error}
        </p>
      )}
      {selected !== null && !detail && <p role="status">读取作业记录…</p>}
      {detail && current && (
        <div className="owned-task-detail">
          <h3>作业 #{detail.id}</h3>
          {detail.kind === "external_cli" && (
            <CliInteractions
              taskId={detail.id}
              ready={ready}
              visible={visible}
              act={act}
            />
          )}
          {detail.continuation_of && (
            <details>
              <summary>关联执行与权限差异</summary>
              <pre>{JSON.stringify(detail.continuation_of, null, 2)}</pre>
            </details>
          )}
          <pre aria-label="作业参数">
            {JSON.stringify(
              detail.arguments ??
                detail.permission_plan ??
                detail.evidence?.permission_plan,
              null,
              2,
            )}
          </pre>
          <pre aria-label="作业输出">
            {JSON.stringify(
              detail.evidence?.result ??
                detail.output ??
                detail.result ??
                "尚无输出。",
              null,
              2,
            )}
          </pre>
          {detail.output && detail.result && (
            <pre aria-label="作业最终结果">
              {JSON.stringify(detail.result, null, 2)}
            </pre>
          )}
          <p className="muted">
            {detail.consumed ? "父任务已接纳结果。" : "结果尚待父任务接纳。"}
            {detail.stopped
              ? "受管执行已停止或尚未派发。"
              : "受管进程树尚未确认停止。"}
          </p>
          {detail.evidence && (
            <section aria-label="CLI 固定结果证据">
              <h3>结果证据</h3>
              {detail.evidence.context_delivery && (
                <details>
                  <summary>本次交付的记忆来源</summary>
                  <p>
                    记录交付前选入的修订与内容摘要。模型采纳情况需结合输出和产物核对。
                  </p>
                  <pre>
                    {JSON.stringify(detail.evidence.context_delivery, null, 2)}
                  </pre>
                </details>
              )}
              <p className="muted">SHA-256 {detail.evidence.sha256}</p>
              <p>
                {detail.evidence.coverage === "explicit_text_only"
                  ? "本次已封存文本结果。原生工具已关闭，上下文仅包含传入目标。"
                  : detail.evidence.coverage_complete
                    ? "工作区小文件证据已封存。"
                    : "证据覆盖不完整，请结合实际产物审核。"}
              </p>
              {detail.evidence.result.text_truncated && (
                <p role="alert">
                  文本超过封存上限，当前证据为截断文本。请核对缺失内容后决定是否接受。
                </p>
              )}
              {detail.evidence.snapshot_source ===
                "current_workspace_after_receipt_reconciliation" && (
                <p>产物取自回执核对时的工作区快照。</p>
              )}
              {detail.evidence.sealing_error && (
                <p role="alert">{detail.evidence.sealing_error}</p>
              )}
              {!!detail.evidence.result.text && (
                <pre aria-label="CLI 固定文本">
                  {detail.evidence.result.text}
                </pre>
              )}
              <pre aria-label="CLI 产物快照">
                {JSON.stringify(detail.evidence.artifacts, null, 2)}
              </pre>
              {!!detail.evidence.deleted_files?.length && (
                <pre aria-label="CLI 删除文件">
                  {JSON.stringify(detail.evidence.deleted_files, null, 2)}
                </pre>
              )}
              {detail.state === "awaiting_review" && (
                <div className="agent-reconcile">
                  <label>
                    审核说明
                    <textarea
                      id="cli-review-note"
                      value={note}
                      maxLength={2000}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </label>
                  <label>
                    <input
                      id="cli-review-confirm"
                      type="checkbox"
                      checked={reviewed}
                      onChange={(event) => setReviewed(event.target.checked)}
                    />
                    已查看本次固定证据及覆盖范围
                  </label>
                  {[true, false].map((accepted) => (
                    <button
                      key={String(accepted)}
                      id={accepted ? "cli-review-accept" : "cli-review-reject"}
                      disabled={
                        !ready ||
                        !reviewed ||
                        !note.trim() ||
                        !actionFor(detail, "review").allowed ||
                        current.revision !== detail.revision
                      }
                      title={actionFor(detail, "review").reason ?? undefined}
                      onClick={() =>
                        act(() =>
                          clientModels.command("cli.review", {
                            id: detail.id,
                            epoch: detail.epoch,
                            expected_task_revision: detail.revision,
                            evidence_sha256: detail.evidence.sha256,
                            accepted,
                            note,
                          }),
                        )
                      }
                    >
                      {accepted ? "接受结果" : "拒绝结果"}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          {unknown(current) && (
            <div className="agent-reconcile">
              {["background", "external_cli"].includes(detail.kind) && (
                <button
                  disabled={!ready || !receiptAction.allowed}
                  title={receiptAction.reason ?? undefined}
                  onClick={() => reconcile("receipt")}
                >
                  核对 Worker 回执
                </button>
              )}
              <label>
                核对说明
                <textarea
                  value={note}
                  maxLength={2000}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                已核对实际效果与所属进程停止；此旧作业不再执行
              </label>
              <button
                disabled={
                  !ready || !reviewed || !note.trim() || !reviewAction.allowed
                }
                title={reviewAction.reason ?? undefined}
                onClick={() => reconcile("reviewed")}
              >
                记录作业核对结论
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
