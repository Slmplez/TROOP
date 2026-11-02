import React, { useEffect, useRef, useState } from "react";
import { call } from "./api";
const empty = () => ({
  name: "",
  event: "preToolUse",
  kind: "command",
  location: "windows-host",
  enabled: false,
  agent_id: null,
  workspace_id: null,
  command: "'{}'",
  prompt: "",
  matcher: "",
  timeout: null,
  loop_limit: null,
  failClosed: false,
  model: null,
});
function writable(row) {
  const value = empty();
  for (const key of Object.keys(value))
    if (row[key] !== undefined) value[key] = row[key];
  if (row.id) value.id = row.id;
  value.expected_revision = row.revision ?? 0;
  return value;
}
export default function HooksPanel({ ready, generation, workspaces }) {
  const [page, setPage] = useState({
      rules: [],
      events: [],
      inactive_events: [],
      total: 0,
      next_offset: null,
    }),
    [offset, setOffset] = useState(0),
    [agents, setAgents] = useState([]),
    [rule, setRule] = useState(empty),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const lock = useRef(false),
    current = useRef({});
  current.current = { generation, offset };
  async function refresh() {
    const expected = { ...current.current };
    const [p, a] = await Promise.all([
      call(window.troop.hookList({ offset: expected.offset })),
      call(window.troop.listMemoryAgents()),
    ]);
    if (
      expected.generation !== current.current.generation ||
      expected.offset !== current.current.offset
    )
      return;
    setPage(p);
    setAgents(a);
  }
  useEffect(() => {
    if (ready) refresh().catch((e) => setError(e.message));
  }, [ready, generation, offset]);
  async function act(fn) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const set = (key, value) => setRule((r) => ({ ...r, [key]: value }));
  const supported = page.events.includes(rule.event),
    legacy = rule.location !== "windows-host";
  return (
    <section className="hooks-page" data-ui="settings">
      <div className="title-row">
        <div>
          <h1>Hooks</h1>
          <p>按任务事件执行本机规则，记录结果、额外模型请求与停止状态。</p>
        </div>
        <button
          id="hook-new"
          disabled={!ready || busy}
          onClick={() => {
            setRule(empty());
            setNotice("");
          }}
        >
          新建规则
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="hook-columns">
        <section>
          <div className="skill-list-heading">
            <h2>规则 · {page.total}</h2>
            <button
              className="quiet"
              disabled={!ready || busy}
              onClick={() => act(refresh)}
            >
              刷新
            </button>
          </div>
          {page.rules.length ? (
            <ul className="hook-rules">
              {page.rules.map((r) => (
                <li key={r.id} data-hook={r.id}>
                  <button
                    className="quiet hook-name"
                    disabled={!ready || busy}
                    onClick={() =>
                      act(async () =>
                        setRule(
                          writable(
                            await call(
                              window.troop.hookDefinition({ id: r.id }),
                            ),
                          ),
                        ),
                      )
                    }
                  >
                    {r.name}
                  </button>
                  <p>
                    {r.event} · {r.kind} · {r.enabled ? "已启用" : "已停用"}
                  </p>
                  <p className="muted">
                    {r.location === "windows-host"
                      ? "Windows 本机"
                      : "旧 Linux 配置 · 不执行"}{" "}
                    · 修订 {r.revision}
                    {r.supported === false ? " · 此事件尚未接入" : ""}
                  </p>
                  <button
                    className="quiet hook-toggle"
                    disabled={
                      !ready ||
                      busy ||
                      r.location !== "windows-host" ||
                      r.supported === false
                    }
                    onClick={() =>
                      act(async () => {
                        const d = await call(
                          window.troop.hookDefinition({ id: r.id }),
                        );
                        await call(
                          window.troop.hookSave({
                            ...writable(d),
                            enabled: !d.enabled,
                          }),
                        );
                      })
                    }
                  >
                    {r.enabled ? "停用" : "启用"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              尚无规则。新建 command 或 prompt Hook，并明确执行范围。
            </p>
          )}
          {(offset > 0 || page.next_offset !== null) && (
            <div className="memory-actions">
              <button
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 8))}
              >
                上一页
              </button>
              <button
                disabled={busy || page.next_offset === null}
                onClick={() => setOffset(page.next_offset)}
              >
                下一页
              </button>
            </div>
          )}
        </section>
        <form
          className="hook-editor"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const saved = await call(
                window.troop.hookSave({
                  ...rule,
                  enabled: !legacy && supported && rule.enabled,
                }),
              );
              setRule(writable(saved));
              setNotice("规则已保存；新任务采用此修订，旧修订不再触发。");
            });
          }}
        >
          <h2>{rule.id ? "编辑规则" : "新建规则"}</h2>
          <label>
            名称
            <input
              id="hook-name"
              value={rule.name}
              maxLength={120}
              disabled={busy}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </label>
          <div className="memory-fields">
            <label>
              事件
              <select
                id="hook-event"
                value={rule.event}
                disabled={busy}
                onChange={(e) =>
                  setRule((r) => ({
                    ...r,
                    event: e.target.value,
                    enabled: page.events.includes(e.target.value) && r.enabled,
                  }))
                }
              >
                {page.events.map((e) => (
                  <option key={e}>{e}</option>
                ))}
                {page.inactive_events.map((e) => (
                  <option key={e} value={e}>
                    {e} · 尚未接入
                  </option>
                ))}
              </select>
            </label>
            <label>
              执行位置
              <select
                id="hook-location"
                value={rule.location}
                disabled={busy}
                onChange={(e) =>
                  setRule((r) => ({
                    ...r,
                    location: e.target.value,
                    enabled: e.target.value === "windows-host" && r.enabled,
                  }))
                }
              >
                <option value="windows-host">Windows 本机</option>
                <option value="legacy-linux">旧 Linux 配置 · 仅保留</option>
              </select>
            </label>
          </div>
          <div className="memory-fields">
            <label>
              Agent 范围
              <select
                id="hook-agent"
                value={rule.agent_id ?? ""}
                disabled={busy}
                onChange={(e) =>
                  set(
                    "agent_id",
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
              >
                <option value="">所有 Agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              工作区范围
              <select
                id="hook-workspace"
                value={rule.workspace_id ?? ""}
                disabled={busy}
                onChange={(e) =>
                  set(
                    "workspace_id",
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
              >
                <option value="">所有工作区</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            类型
            <select
              id="hook-kind"
              value={rule.kind}
              disabled={busy}
              onChange={(e) => set("kind", e.target.value)}
            >
              <option value="command">command · 命令</option>
              <option value="prompt">prompt · 任务所选模型服务</option>
            </select>
          </label>
          {rule.kind === "command" ? (
            <>
              <label>
                {legacy ? "原始命令（仅保留）" : "PowerShell 命令"}
                <textarea
                  id="hook-command"
                  rows={7}
                  value={rule.command}
                  maxLength={4000}
                  disabled={busy}
                  onChange={(e) => set("command", e.target.value)}
                />
              </label>
              <p className="muted">
                启用后会随匹配事件自动运行，以当前 Windows 用户权限执行。通过
                stdin 接收 JSON；输出一个 JSON
                对象，空输出表示无变更。本机命令不是 OS 沙箱；只读子代理不执行
                command Hook。
              </p>
            </>
          ) : (
            <>
              <label>
                Hook 指令
                <textarea
                  id="hook-prompt"
                  rows={7}
                  value={rule.prompt}
                  maxLength={6000}
                  disabled={busy}
                  onChange={(e) => set("prompt", e.target.value)}
                />
              </label>
              <label>
                同服务模型 ID（可选）
                <input
                  id="hook-model"
                  value={rule.model ?? ""}
                  maxLength={200}
                  disabled={busy}
                  onChange={(e) => set("model", e.target.value || null)}
                />
              </label>
              <p className="muted">
                每次触发会产生额外模型请求，使用任务的服务和凭据引用，与对话及任务共享额度。
              </p>
            </>
          )}
          <label>
            工具名称匹配正则（留空或 * 表示全部）
            <input
              id="hook-matcher"
              value={rule.matcher}
              maxLength={256}
              disabled={busy}
              onChange={(e) => set("matcher", e.target.value)}
            />
          </label>
          <div className="memory-fields">
            <label>
              超时（秒，留空使用 60 秒任务期限）
              <input
                id="hook-timeout"
                type="number"
                min="0.01"
                step="0.01"
                max="86400"
                value={rule.timeout ?? ""}
                disabled={busy}
                onChange={(e) =>
                  set("timeout", e.target.value ? Number(e.target.value) : null)
                }
              />
            </label>
            <label>
              每个任务最多触发次数（留空使用总预算）
              <input
                id="hook-loop"
                type="number"
                min="1"
                step="1"
                value={rule.loop_limit ?? ""}
                disabled={busy}
                onChange={(e) =>
                  set(
                    "loop_limit",
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
              />
            </label>
          </div>
          <label className="check-row">
            <input
              id="hook-fail-closed"
              type="checkbox"
              checked={rule.failClosed}
              disabled={busy}
              onChange={(e) => set("failClosed", e.target.checked)}
            />
            failClosed：权限前置 Hook 出错时阻断操作
          </label>
          <p className="muted">
            post Hook 出错会记录并继续；subagentStart/Stop 出错会传播。allow
            不替代工具审批，ask
            会等待你批准具体操作。修改或停用会撤销旧修订；已有作用仍需核对。
          </p>
          <label className="check-row">
            <input
              id="hook-enabled"
              type="checkbox"
              checked={rule.enabled && !legacy && supported}
              disabled={busy || legacy || !supported}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            启用规则
          </label>
          {(legacy || !supported) && (
            <p className="muted">
              此配置只保留，不执行，不自动转换 Linux 命令或未接入的事件。
            </p>
          )}
          <div className="memory-actions">
            <button
              id="hook-save"
              className="primary"
              disabled={!ready || busy || !rule.name.trim()}
            >
              {rule.enabled ? "保存并启用" : "保存规则"}
            </button>
            {rule.id && (
              <button
                id="hook-delete"
                type="button"
                className="quiet"
                disabled={!ready || busy}
                onClick={() =>
                  act(async () => {
                    await call(
                      window.troop.hookRemove({
                        id: rule.id,
                        expected_revision: rule.expected_revision,
                      }),
                    );
                    setRule(empty());
                    setNotice("规则已删除；历史调用记录保留。");
                  })
                }
              >
                删除规则
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
const stateName = {
  queued: "排队",
  dispatched: "准备执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
  indeterminate: "结果不明，待核对",
};
export function HookHistory({ run, ready, generation, visible, onChange }) {
  const [page, setPage] = useState({ items: [], total: 0, next_offset: null }),
    [offset, setOffset] = useState(0),
    [detail, setDetail] = useState(null),
    [note, setNote] = useState(""),
    [stopped, setStopped] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const current = useRef({}),
    lock = useRef(false),
    previous = useRef([]);
  current.current = { id: run?.id, generation, offset };
  async function refresh() {
    const expected = { ...current.current };
    if (!expected.id) return;
    const p = await call(
      window.troop.hookCalls({ run_id: expected.id, offset: expected.offset }),
    );
    if (Object.keys(expected).some((k) => expected[k] !== current.current[k]))
      return;
    setPage(p);
  }
  useEffect(() => {
    setOffset(0);
    setPage({ items: [], total: 0, next_offset: null });
    setDetail(null);
    setNote("");
    setStopped(false);
    previous.current = [];
  }, [run?.id, generation]);
  useEffect(() => {
    if (!ready || !visible || !run) return;
    let ended = false,
      loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        await refresh();
      } catch (e) {
        if (!ended) setError(e.message);
      } finally {
        loading = false;
      }
    };
    load();
    const timer = setInterval(load, 600);
    return () => {
      ended = true;
      clearInterval(timer);
    };
  }, [ready, visible, generation, run?.id, offset]);
  async function act(fn) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!run) return null;
  return (
    <section className="hook-history">
      <h3>Hook 账本 · {page.total}</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page.total === 0 ? (
        <p className="muted">此任务尚无匹配的 Hook 调用。</p>
      ) : (
        <ul className="hook-records">
          {page.items.map((c) => (
            <li key={c.id}>
              <div>
                <strong>{c.name}</strong>
                <p>
                  {c.event} · {c.kind} · {stateName[c.state] ?? c.state}
                </p>
                <p className="muted">
                  规则 #{c.rule_id} 修订 {c.rule_revision}
                  {c.kind === "prompt"
                    ? ` · 额外模型请求 ${c.model_requests ?? 0}`
                    : ""}
                  {c.effect_unknown ? " · 已发生作用需要核对" : ""}
                </p>
                {c.error && <p>{c.error}</p>}
              </div>
              <button
                className="quiet hook-details"
                disabled={!ready || busy}
                onClick={() =>
                  act(async () => {
                    const expected = { ...current.current };
                    const result = await call(
                      window.troop.hookCall({ id: c.id }),
                    );
                    if (
                      expected.id !== current.current.id ||
                      expected.generation !== current.current.generation
                    )
                      return;
                    setDetail(result);
                    setNote("");
                    setStopped(false);
                  })
                }
              >
                详情
              </button>
            </li>
          ))}
        </ul>
      )}
      {(offset > 0 || page.next_offset !== null) && (
        <div className="memory-actions">
          <button
            disabled={busy || !offset}
            onClick={() => setOffset(previous.current.pop() ?? 0)}
          >
            上一页
          </button>
          <button
            disabled={busy || page.next_offset === null}
            onClick={() => {
              previous.current.push(offset);
              setOffset(page.next_offset);
            }}
          >
            下一页
          </button>
        </div>
      )}
      {detail && (
        <div className="hook-detail">
          <div className="skill-list-heading">
            <h3>
              {detail.event} · #{detail.id}
            </h3>
            <button className="quiet" onClick={() => setDetail(null)}>
              关闭详情
            </button>
          </div>
          <pre>{JSON.stringify(detail, null, 2)}</pre>
          {detail.state === "indeterminate" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  const expected = { ...current.current };
                  await call(
                    window.troop.hookReconcile({
                      id: detail.id,
                      note,
                      stopped,
                    }),
                  );
                  const result = await call(
                    window.troop.hookCall({ id: detail.id }),
                  );
                  if (
                    expected.id === current.current.id &&
                    expected.generation === current.current.generation
                  )
                    setDetail(result);
                  onChange?.();
                });
              }}
            >
              <label>
                核对说明
                <textarea
                  id="hook-reconcile-note"
                  rows={3}
                  value={note}
                  maxLength={2000}
                  disabled={busy}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <label className="check-row">
                <input
                  id="hook-reconcile-stopped"
                  type="checkbox"
                  checked={stopped}
                  disabled={busy}
                  onChange={(e) => setStopped(e.target.checked)}
                />
                已核对实际作用，并确认整个进程树停止
              </label>
              <button
                id="hook-reconcile"
                disabled={
                  busy ||
                  !stopped ||
                  !note.trim() ||
                  !["interrupted", "cancelled", "failed"].includes(run.state)
                }
              >
                保存核对，不重放此调用
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
