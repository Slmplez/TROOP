import { resources } from "./client/resources";
import React, { useEffect, useRef, useState } from "react";
import { call } from "./api";
const terminal = (s) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(s);
const labels = {
  starting: "正在连接",
  open: "连接已打开",
  closing: "正在关闭",
  closed: "本地连接已关闭",
  indeterminate: "连接效果或停止状态待核对",
  prepared: "等待审批",
  dispatched: "已派发",
  running: "正在调用",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已停止",
};
export default function McpRunPanel({
  runId,
  ready,
  generation,
  visible = true,
  onChange = () => {},
  onTools,
}) {
  const [data, setData] = useState(null),
    [sessions, setSessions] = useState([]),
    [cursor, setCursor] = useState(null),
    [offset, setOffset] = useState(0),
    [detail, setDetail] = useState(null),
    [chosen, setChosen] = useState(null),
    [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [artifact, setArtifact] = useState(null);
  const current = useRef({}),
    lock = useRef(false),
    sequence = useRef(0);
  current.current = { runId, generation, chosen, offset };
  const valid = (s) =>
    s.runId === current.current.runId &&
    s.generation === current.current.generation &&
    s.chosen === current.current.chosen &&
    s.offset === current.current.offset &&
    s.seq === sequence.current;
  async function refresh() {
    if (!ready || !runId) return;
    const expected = { ...current.current, seq: sequence.current };
    const [s, p] = await Promise.all([
      call(resources.getRun(runId)),
      call(
        resources.mcpRunSessions({
          run_id: runId,
          offset,
        }),
      ),
    ]);
    if (!valid(expected)) return;
    setData(s);
    setSessions(p.items);
    setCursor(p.next_offset);
    if (expected.chosen) {
      const d = await call(resources.getInvocation(expected.chosen));
      if (valid(expected) && expected.chosen === current.current.chosen)
        setDetail(d);
    }
  }
  useEffect(() => {
    sequence.current++;
    setData(null);
    setDetail(null);
    setChosen(null);
    setArtifact(null);
    setNote("");
    setConfirmed(false);
    setSessions([]);
    setError("");
    setOffset(0);
    return () => {
      sequence.current++;
    };
  }, [runId, generation]);
  useEffect(() => {
    if (!visible || !ready || !runId) return;
    let live = true;
    const load = () =>
      refresh().catch((e) => {
        if (live) setError(e.message);
      });
    load();
    const timer = setInterval(load, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [visible, ready, runId, generation, chosen, offset]);
  async function act(fn, apply) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const expected = { ...current.current, seq: sequence.current };
    try {
      const result = await fn();
      if (valid(expected)) {
        if (apply) apply(result);
        await refresh();
        onChange();
      }
    } catch (e) {
      if (valid(expected)) setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function choose(id) {
    setChosen(id);
    setDetail(null);
    setArtifact(null);
    setNote("");
    setConfirmed(false);
    // The next refresh loads the selected invocation against the current Run/generation.
  }
  const invocations =
    data?.invocations.filter((i) => i.name.startsWith("mcp_")) ?? [];
  const stopped = data && terminal(data.run.state);
  return (
    <section className="mcp-run" aria-label="MCP 任务连接">
      <div className="mcp-section-title">
        <h2>MCP 任务连接</h2>
        <button
          type="button"
          disabled={!ready || busy || !runId}
          onClick={() => act(() => refresh())}
        >
          刷新连接记录
        </button>
      </div>
      {!runId ? (
        <p>选择任务后查看它拥有的连接和调用记录。</p>
      ) : !data ? (
        <p role="status">正在读取任务连接…</p>
      ) : (
        <>
          <p className="muted">
            任务 #{runId} · {data.run.state}。关闭 HTTP
            连接只表示本地通信结束，远端效果需另行核对。
          </p>
          {sessions.length === 0 ? (
            <p>这个任务尚无 MCP 连接。</p>
          ) : (
            <ul className="mcp-session-list">
              {sessions.map((s) => (
                <li key={s.id} data-session-id={s.id}>
                  <div>
                    <strong>
                      连接 #{s.id} · {labels[s.state] ?? s.state}
                    </strong>
                    <p>
                      {s.transport} · {s.location} · 服务修订{" "}
                      {s.server_revision}
                    </p>
                    <code>{s.server_id}</code>
                    {s.startup_authorization && (
                      <p className="muted">
                        初始化授权 {s.startup_authorization.grant_id} · 修订{" "}
                        {s.startup_authorization.grant_revision} ·
                        {s.startup_authorization.host_access === "sandbox"
                          ? "MXC 范围隔离"
                          : "当前用户宿主权限"}{" "}
                        · 主程序指纹 {s.startup_authorization.program_sha256}
                      </p>
                    )}
                    {s.startup_authorization?.sandbox && (
                      <details>
                        <summary>初始化隔离范围与依据</summary>
                        <pre>
                          {JSON.stringify(
                            s.startup_authorization.sandbox,
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    )}
                    {s.effect_unknown && !s.reviewed && (
                      <p>
                        服务初始化可能已产生效果，请核对实际效果与进程停止状态。
                      </p>
                    )}
                    {s.error && <p>{s.error}</p>}
                    {s.note && <p>核对说明：{s.note}</p>}
                  </div>
                  {s.state === "indeterminate" && !s.reviewed && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = new FormData(e.currentTarget);
                        act(() =>
                          call(
                            resources.mcpRunReconcile({
                              id: s.id,
                              stopped: true,
                              note: form.get("note"),
                            }),
                          ),
                        );
                      }}
                    >
                      <label>
                        连接 #{s.id} 的核对说明
                        <textarea
                          name="note"
                          required
                          maxLength={2000}
                          disabled={!stopped || busy}
                        />
                      </label>
                      <label className="mcp-check">
                        <input
                          type="checkbox"
                          required
                          disabled={!stopped || busy}
                        />
                        已核对初始化效果，并确认该连接的所属进程树全部停止
                      </label>
                      <button
                        className="mcp-session-review"
                        disabled={!ready || busy || !stopped}
                      >
                        保存连接核对
                      </button>
                      {!stopped && (
                        <p>任务结束或中断后可核对；运行中的任务请先停止。</p>
                      )}
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {cursor !== null && (
            <button disabled={busy || !ready} onClick={() => setOffset(cursor)}>
              更多连接
            </button>
          )}
          {offset > 0 && (
            <button
              disabled={busy || !ready}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页连接
            </button>
          )}
          {onTools && (
            <button
              disabled={!ready || busy}
              onClick={() =>
                act(async () => {
                  let offset = 0,
                    list = [];
                  for (let n = 0; n < 128; n++) {
                    const p = await call(
                      resources.mcpRunCatalogue({ run_id: runId, offset }),
                    );
                    list.push(...p.items);
                    if (p.next_offset === null) break;
                    offset = p.next_offset;
                  }
                  return list;
                }, onTools)
              }
            >
              读取本任务工具目录
            </button>
          )}
          <h3>调用与结果</h3>
          {invocations.length === 0 ? (
            <p>这个任务尚无 MCP 工具调用。</p>
          ) : (
            <label>
              工具调用
              <select
                id="mcp-call-select"
                value={chosen ?? ""}
                disabled={busy}
                onChange={(e) => choose(Number(e.target.value))}
              >
                <option value="">选择调用</option>
                {invocations.map((i) => (
                  <option key={i.id} value={i.id}>
                    #{i.id} {i.name} · {labels[i.state] ?? i.state}
                  </option>
                ))}
              </select>
            </label>
          )}
          {detail && (
            <div className="mcp-call-detail">
              <pre aria-label="MCP 调用详情">
                {JSON.stringify(
                  {
                    operation: detail.operation,
                    state: detail.state,
                    result: detail.result,
                  },
                  null,
                  2,
                )}
              </pre>
              {detail.state === "indeterminate" && !detail.reviewed && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(() =>
                      call(
                        resources.reconcileInvocation({
                          id: detail.id,
                          epoch: detail.epoch,
                          source: "reviewed",
                          note,
                        }),
                      ),
                    );
                  }}
                >
                  <label>
                    调用核对说明
                    <textarea
                      id="mcp-review-note"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={2000}
                      required
                    />
                  </label>
                  <label className="mcp-check">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    已核对外部效果，并确认相关操作停止
                  </label>
                  <button
                    id="mcp-call-review"
                    disabled={
                      !ready || busy || !stopped || !confirmed || !note.trim()
                    }
                  >
                    保存调用核对
                  </button>
                </form>
              )}
              {(detail.result?.artifacts ?? []).map((a) => (
                <button
                  key={a.id}
                  disabled={!ready || busy}
                  onClick={() =>
                    act(
                      () =>
                        call(
                          resources.mcpRunArtifact({
                            run_id: runId,
                            id: a.id,
                          }),
                        ),
                      setArtifact,
                    )
                  }
                >
                  {a.label} · {a.mime_type} · {a.bytes} 字节
                </button>
              ))}
              {artifact && (
                <div aria-label="MCP 附件">
                  <p>
                    {artifact.artifact.label} · {artifact.artifact.mime_type} ·
                    SHA-256 {artifact.artifact.sha256}
                  </p>
                  <pre>
                    {artifact.text ??
                      "二进制附件已归档；本页不执行或预览该内容。"}
                  </pre>
                  {artifact.next_offset !== null && (
                    <button
                      disabled={busy || !ready}
                      onClick={() =>
                        act(
                          () =>
                            call(
                              resources.mcpRunArtifact({
                                run_id: runId,
                                id: artifact.artifact.id,
                                offset: artifact.next_offset,
                              }),
                            ),
                          setArtifact,
                        )
                      }
                    >
                      下一页附件
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <p className="muted">
            核对只保存已查明的结果和停止状态。需要继续时，回到任务页手动继续；旧调用不会重放。
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
