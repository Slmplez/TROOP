import React, { useEffect, useRef, useState } from "react";
import { call } from "./api";

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
};
const active = (task) =>
  ["queued", "dispatched", "running", "cancelling"].includes(task.state);
const unknown = (task) =>
  ["interrupted", "indeterminate"].includes(task.state) && !task.reviewed;
export default function OwnedTasks({
  tasks,
  ready,
  generation,
  run,
  act,
  choose,
}) {
  const [selected, setSelected] = useState(null),
    [detail, setDetail] = useState(null),
    [error, setError] = useState("");
  const [note, setNote] = useState(""),
    [reviewed, setReviewed] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setError("");
  }, [run.id, generation]);
  useEffect(() => {
    if (!ready || selected === null) return;
    let disposed = false,
      loading = false;
    const serial = ++request.current;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const data = await call(window.troop.getOwnedTask(selected));
        if (!disposed && request.current === serial) {
          setDetail(data);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError(e.message);
      } finally {
        loading = false;
      }
    };
    refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [ready, generation, selected]);
  if (!tasks?.length) return null;
  const current = tasks.find((t) => t.id === selected);
  const reconcile = (source) =>
    act(() =>
      call(
        window.troop.reconcileOwnedTask({
          id: detail.id,
          epoch: detail.epoch,
          source,
          note: source === "reviewed" ? note : "",
        }),
      ),
    );
  return (
    <section className="owned-tasks" aria-label="所属任务树">
      <h2>子代理与后台作业</h2>
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
                  setDetail(null);
                  setNote("");
                  setReviewed(false);
                }}
              >
                #{task.id} · {task.kind === "agent" ? "子代理" : "后台命令"} ·{" "}
                {names[task.state] ?? task.state}
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
                  disabled={!ready || task.state === "cancelling"}
                  onClick={() =>
                    act(() => call(window.troop.stopOwnedTask(task.id)))
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
          <pre aria-label="作业参数">
            {JSON.stringify(detail.arguments, null, 2)}
          </pre>
          <pre aria-label="作业输出">
            {JSON.stringify(
              detail.output ?? detail.result ?? "尚无输出。",
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
          {unknown(current) &&
            ["interrupted", "cancelled", "failed"].includes(run.state) && (
              <div className="agent-reconcile">
                {detail.kind === "background" && (
                  <button
                    disabled={!ready}
                    onClick={() => reconcile("receipt")}
                  >
                    核对后台 Worker 回执
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
                  disabled={!ready || !reviewed || !note.trim()}
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
