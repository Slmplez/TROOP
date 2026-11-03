import React, { useEffect, useRef, useState } from "react";
import { call } from "./api";
import McpRunPanel from "./McpRunPanel";
import "./mcp.css";
const blank = () => ({
  name: "",
  source_kind: "manual",
  transport: "http",
  location: "remote",
  enabled: false,
  command: "",
  args: [],
  cwd: "",
  url: "",
  env_keys: [],
  header_keys: [],
  agent_ids: [],
  disabled_tools: [],
  auth_mode: "automatic",
  startup_timeout_seconds: 30,
  timeout_seconds: 180,
});
const lines = (s) =>
  s
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
const authNames = {
  disconnected: "未登录",
  authorizing: "等待浏览器授权",
  connected: "已授权",
  refreshing: "正在刷新",
  revoking: "正在撤销",
  revoked: "已撤销",
  stale: "配置已变化，需重新登录",
  error: "登录失败",
  interrupted: "登录已中断",
  refresh_uncertain: "刷新结果待确认",
  revocation_unknown: "本机已断开，远端撤销未确认",
  cancelled: "已取消",
};
export default function McpPanel({ ready, generation, onRun }) {
  const [rows, setRows] = useState([]),
    [next, setNext] = useState(null),
    [selected, setSelected] = useState(null),
    [revision, setRevision] = useState(0),
    [definition, setDefinition] = useState(blank),
    [agents, setAgents] = useState([]),
    [tab, setTab] = useState("config"),
    [loading, setLoading] = useState(false),
    [listing, setListing] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [secrets, setSecrets] = useState({}),
    [savedKeys, setSavedKeys] = useState([]),
    [args, setArgs] = useState("[]"),
    [disabled, setDisabled] = useState(""),
    [auth, setAuth] = useState(null),
    [client, setClient] = useState(""),
    [clientSecret, setClientSecret] = useState(""),
    [issuer, setIssuer] = useState(""),
    [scopes, setScopes] = useState(""),
    [register, setRegister] = useState(false),
    [versions, setVersions] = useState(null),
    [runs, setRuns] = useState([]),
    [runCursor, setRunCursor] = useState(null),
    [runId, setRunId] = useState(null),
    [tools, setTools] = useState([]),
    [importing, setImporting] = useState(false),
    [raw, setRaw] = useState(""),
    [location, setLocation] = useState("windows-host"),
    [cwd, setCwd] = useState(""),
    [preview, setPreview] = useState(null),
    [importTarget, setImportTarget] = useState("new"),
    [dirty, setDirty] = useState(false);
  const lock = useRef(false),
    ticket = useRef(0),
    current = useRef({});
  current.current = { selected, generation };
  const scope = () => ({ ...current.current, ticket: ticket.current });
  const valid = (e) =>
    e.ticket === ticket.current &&
    e.selected === current.current.selected &&
    e.generation === current.current.generation;
  const update = (key, value) => {
    setDirty(true);
    setDefinition((d) => ({ ...d, [key]: value }));
  };
  function reset() {
    ticket.current++;
    setSelected(null);
    setLoading(false);
    setRevision(0);
    setDefinition(blank());
    setArgs("[]");
    setDisabled("");
    setSecrets({});
    setSavedKeys([]);
    setAuth(null);
    setVersions(null);
    setError("");
    setNotice("");
    setDirty(false);
    setTools([]);
    setTab("config");
    setImporting(false);
    setPreview(null);
    setRaw("");
    setClientSecret("");
    setClient("");
    setIssuer("");
    setScopes("");
    setRegister(false);
    setImportTarget("new");
  }
  async function refresh(append = false) {
    const expected = scope();
    const [p, a, r] = await Promise.all([
      call(window.troop.mcpList({ offset: append ? next : 0 })),
      call(window.troop.listMemoryAgents()),
      call(window.troop.listRuns()),
    ]);
    if (expected.generation !== current.current.generation) return;
    setRows((old) => (append ? [...old, ...p.items] : p.items));
    setNext(p.next_offset);
    setAgents(a);
    setRuns(r.items);
    setRunCursor(r.next_offset);
    setListing(false);
    if (p.credential_cleanup_pending)
      setNotice("部分系统凭据仍在等待清理，可刷新后核对。");
  }
  useEffect(() => {
    reset();
    setListing(true);
    if (ready)
      refresh().catch((e) => {
        setError(e.message);
        setListing(false);
      });
    return () => {
      ticket.current++;
    };
  }, [ready, generation]);
  async function select(id) {
    const seq = ++ticket.current;
    setSelected(id);
    setDirty(false);
    setSecrets({});
    setSavedKeys([]);
    setClientSecret("");
    setClient("");
    setIssuer("");
    setScopes("");
    setRegister(false);
    setRaw("");
    setPreview(null);
    setAuth(null);
    setVersions(null);
    setError("");
    setTools([]);
    setTab("config");
    setImporting(false);
    setLoading(true);
    try {
      const d = await call(window.troop.mcpGet({ id }));
      if (seq !== ticket.current) return;
      setDefinition({ ...blank(), ...d.config });
      setRevision(d.revision);
      setArgs(JSON.stringify(d.config.args));
      setDisabled(d.config.disabled_tools.join("\n"));
      setSavedKeys(d.secret_keys);
      setNotice("");
    } catch (e) {
      if (seq === ticket.current) {
        reset();
        setError(e.message);
      }
    } finally {
      if (seq === ticket.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!selected || !ready) return;
    let live = true;
    const expected = scope();
    async function poll() {
      try {
        const d = await call(window.troop.mcpAuthStatus({ id: selected }));
        if (live && valid(expected)) acceptAuth(d);
      } catch (e) {
        if (live && valid(expected)) setError(e.message);
      }
    }
    poll();
    const timer = setInterval(poll, 1200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected, generation, ready, revision]);
  async function act(fn, apply, refreshLibrary = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const expected = scope();
    try {
      const result = await fn();
      if (valid(expected)) {
        if (apply) apply(result);
        if (apply === saved || refreshLibrary) await refresh();
      }
    } catch (e) {
      if (valid(expected)) setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function saved(d) {
    if (d.cancelled) {
      setNotice("已取消保存。");
      return;
    }
    setSelected(d.id);
    setRevision(d.revision);
    setDefinition({ ...blank(), ...d.config });
    setArgs(JSON.stringify(d.config.args));
    setDisabled(d.config.disabled_tools.join("\n"));
    setSecrets({});
    setSavedKeys(d.secret_keys);
    setDirty(false);
    setPreview(null);
    setRaw("");
    setImporting(false);
    setNotice("已保存。新配置用于新任务，已有任务的旧计划会失效。");
  }
  function transport(value) {
    update("transport", value);
    setDefinition((d) => ({
      ...d,
      transport: value,
      location: value === "stdio" ? "windows-host" : "remote",
      command: "",
      cwd: "",
      url: "",
      args: [],
      env_keys: [],
      header_keys: [],
      auth_mode: "automatic",
    }));
    setArgs("[]");
    setSecrets({});
  }
  const authBusy = ["authorizing", "refreshing", "revoking"].includes(
    auth?.state,
  );
  const authOperation = (method) =>
    act(
      () =>
        call(
          window.troop[method]({ id: selected, auth_revision: auth.revision }),
        ),
      method === "mcpAuthOpen" ? undefined : acceptAuth,
    );
  function acceptAuth(d) {
    setAuth((old) => (!old || d.revision >= old.revision ? d : old));
  }
  const fields =
    definition.transport === "stdio"
      ? definition.env_keys.map((k) => "env:" + k)
      : definition.header_keys.map((k) => "header:" + k);
  return (
    <div className="mcp-page">
      <header className="title-row">
        <div>
          <h1>MCP 服务</h1>
          <p>管理 Agent 的工具来源、认证和任务连接。</p>
        </div>
        <div className="mcp-actions">
          <button
            disabled={!ready || busy}
            onClick={() => {
              reset();
              setImporting(true);
            }}
          >
            导入配置
          </button>
          <button id="mcp-new" disabled={!ready || busy} onClick={reset}>
            添加服务
          </button>
        </div>
      </header>
      {!ready && <p role="status">Core 未连接，恢复连接后可管理 MCP 服务。</p>}
      {error && (
        <p className="mcp-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="mcp-layout">
        <aside aria-label="MCP 服务资料库">
          <div className="mcp-section-title">
            <h2>服务资料库</h2>
            <button
              disabled={!ready || busy}
              onClick={() => act(() => refresh())}
            >
              刷新
            </button>
          </div>
          {rows.length === 0 ? (
            <p>
              {listing
                ? "正在读取…"
                : "还没有 MCP 服务。添加服务或导入已有配置。"}
            </p>
          ) : (
            <ul className="mcp-library">
              {rows.map((s) => (
                <li key={s.id}>
                  <button
                    disabled={busy}
                    aria-pressed={selected === s.id}
                    onClick={() => select(s.id)}
                  >
                    <strong>{s.config.name}</strong>
                    <span>
                      {s.config.enabled ? "已启用" : "已停用"} ·{" "}
                      {s.config.location === "windows-host"
                        ? "Windows 本机"
                        : s.config.location === "legacy-linux"
                          ? "旧 Linux（停用）"
                          : "远程"}
                    </span>
                    <small>
                      {s.config.transport} · 修订 {s.revision} ·{" "}
                      {s.config.source_kind === "json-import" ? "导入" : "手动"}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {next !== null && (
            <button
              disabled={!ready || busy}
              onClick={() => act(() => refresh(true))}
            >
              更多服务
            </button>
          )}
        </aside>
        <div className="mcp-content">
          {importing ? (
            <section>
              <h2>导入 MCP 配置</h2>
              <p>
                预览不会连接或执行。导入后保持停用，启用和 Agent 分配另行保存。
              </p>
              <label>
                配置 JSON
                <textarea
                  id="mcp-import-json"
                  value={raw}
                  maxLength={32000}
                  onChange={(e) => {
                    setRaw(e.target.value);
                    setPreview(null);
                  }}
                  rows={7}
                />
              </label>
              <div className="mcp-form-grid">
                <label>
                  执行位置
                  <select
                    value={location}
                    onChange={(e) => {
                      setLocation(e.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="windows-host">
                      Windows 本机（HTTP 自动识别为远程）
                    </option>
                    <option value="legacy-linux">旧 Linux（保留且停用）</option>
                  </select>
                </label>
                <label>
                  本机命令默认工作目录
                  <input
                    value={cwd}
                    onChange={(e) => {
                      setCwd(e.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
              </div>
              <button
                id="mcp-import-preview"
                disabled={!ready || busy || !raw.trim()}
                onClick={() =>
                  act(
                    () =>
                      call(
                        window.troop.mcpPreview({ json: raw, location, cwd }),
                      ),
                    setPreview,
                  )
                }
              >
                预览导入
              </button>
              {preview && (
                <>
                  <label>
                    导入目标
                    <select
                      value={importTarget}
                      onChange={(e) => setImportTarget(e.target.value)}
                    >
                      <option value="new">新建独立服务</option>
                      {rows.map((s) => (
                        <option key={s.id} value={s.id}>
                          更新 {s.config.name} · 修订 {s.revision}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ul className="mcp-preview">
                    {preview.items.map((p) => (
                      <li key={p.index}>
                        <h3>{p.definition.name}</h3>
                        <pre>{JSON.stringify(p.definition, null, 2)}</pre>
                        <p>
                          凭据字段：{p.secret_keys.join("、") || "无"}
                          （值不回显）
                        </p>
                        <button
                          className="mcp-import-apply"
                          disabled={!ready || busy}
                          onClick={() =>
                            act(
                              () =>
                                call(
                                  window.troop.mcpImport({
                                    source: { json: raw, location, cwd },
                                    digest: preview.digest,
                                    index: p.index,
                                    id:
                                      importTarget === "new"
                                        ? null
                                        : importTarget,
                                    expected_revision:
                                      rows.find((s) => s.id === importTarget)
                                        ?.revision ?? 0,
                                  }),
                                ),
                              saved,
                            )
                          }
                        >
                          {importTarget === "new"
                            ? "导入为停用服务"
                            : "确认更新选中服务"}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {preview.next_offset !== null && (
                    <button
                      disabled={busy || !ready}
                      onClick={() =>
                        act(
                          () =>
                            call(
                              window.troop.mcpPreview({
                                json: raw,
                                location,
                                cwd,
                                offset: preview.next_offset,
                              }),
                            ),
                          setPreview,
                        )
                      }
                    >
                      下一页预览
                    </button>
                  )}
                </>
              )}
            </section>
          ) : (
            <>
              <nav className="mcp-tabs" aria-label="服务设置">
                {[
                  ["config", "配置"],
                  ["auth", "认证"],
                  ["runs", "任务连接"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    aria-pressed={tab === key}
                    onClick={() => setTab(key)}
                    disabled={busy || loading}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              {loading ? (
                <p role="status">正在读取服务…</p>
              ) : tab === "config" ? (
                <form
                  id="mcp-config"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(
                      () =>
                        call(
                          window.troop.mcpSave({
                            id: selected,
                            expected_revision: revision,
                            definition: {
                              ...definition,
                              args: JSON.parse(args),
                              disabled_tools: lines(disabled),
                            },
                            secrets: Object.fromEntries(
                              Object.entries(secrets).filter(
                                ([k, v]) => fields.includes(k) && v !== "",
                              ),
                            ),
                          }),
                        ),
                      saved,
                    );
                  }}
                >
                  <fieldset
                    className="mcp-edit-fields"
                    disabled={busy || !ready}
                  >
                    <div className="mcp-section-title">
                      <h2>
                        {selected ? definition.name || "编辑服务" : "新建服务"}
                      </h2>
                      {selected && (
                        <span>
                          修订 {revision} ·{" "}
                          {definition.source_kind === "json-import"
                            ? "导入"
                            : "手动配置"}
                        </span>
                      )}
                    </div>
                    <div className="mcp-form-grid">
                      <label>
                        服务名称
                        <input
                          id="mcp-name"
                          required
                          maxLength={160}
                          value={definition.name}
                          onChange={(e) => update("name", e.target.value)}
                        />
                      </label>
                      <label>
                        传输方式
                        <select
                          id="mcp-transport"
                          value={definition.transport}
                          onChange={(e) => transport(e.target.value)}
                        >
                          <option value="http">Streamable HTTP</option>
                          <option value="sse">旧 HTTP + SSE</option>
                          <option value="stdio">stdio</option>
                        </select>
                      </label>
                    </div>
                    {definition.transport === "stdio" ? (
                      <>
                        <label>
                          执行位置
                          <select
                            id="mcp-location"
                            value={definition.location}
                            onChange={(e) => {
                              update("location", e.target.value);
                              if (e.target.value === "legacy-linux")
                                update("enabled", false);
                            }}
                          >
                            <option value="windows-host">Windows 本机</option>
                            <option value="legacy-linux">
                              旧 Linux（只能停用保存）
                            </option>
                          </select>
                        </label>
                        <label>
                          可执行文件绝对路径
                          <input
                            id="mcp-command"
                            required
                            value={definition.command}
                            onChange={(e) => update("command", e.target.value)}
                          />
                        </label>
                        <label>
                          参数（JSON 字符串数组）
                          <textarea
                            id="mcp-args"
                            value={args}
                            onChange={(e) => {
                              setDirty(true);
                              setArgs(e.target.value);
                            }}
                            rows={2}
                          />
                        </label>
                        <label>
                          工作目录绝对路径
                          <input
                            id="mcp-cwd"
                            required={definition.location === "windows-host"}
                            value={definition.cwd}
                            onChange={(e) => update("cwd", e.target.value)}
                          />
                        </label>
                        <p className="muted">
                          {definition.location === "legacy-linux"
                            ? "保留旧 Linux 配置，当前不会执行；转换为 Windows 命令需要明确编辑。"
                            : "以当前 Windows 用户权限运行，具备宿主访问能力。启用保存时会确认命令；工具调用仍需审批。"}
                        </p>
                      </>
                    ) : (
                      <label>
                        服务地址
                        <input
                          id="mcp-url"
                          type="url"
                          required
                          value={definition.url}
                          onChange={(e) => update("url", e.target.value)}
                        />
                      </label>
                    )}
                    <div className="mcp-form-grid">
                      <label>
                        启动时限（1–180 秒）
                        <input
                          type="number"
                          min={1}
                          max={180}
                          value={definition.startup_timeout_seconds}
                          onChange={(e) =>
                            update(
                              "startup_timeout_seconds",
                              Number(e.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        调用时限（1–3600 秒）
                        <input
                          id="mcp-timeout"
                          type="number"
                          min={1}
                          max={3600}
                          value={definition.timeout_seconds}
                          onChange={(e) =>
                            update("timeout_seconds", Number(e.target.value))
                          }
                        />
                      </label>
                    </div>
                    <label>
                      认证方式
                      <select
                        id="mcp-auth-mode"
                        value={definition.auth_mode}
                        onChange={(e) => update("auth_mode", e.target.value)}
                      >
                        <option value="automatic">
                          自动（已有 OAuth 时使用该身份）
                        </option>
                        <option value="none">配置方式，不使用 OAuth</option>
                        <option value="headers">
                          配置请求头，不使用 OAuth
                        </option>
                        {definition.transport !== "stdio" && (
                          <option value="oauth">OAuth</option>
                        )}
                      </select>
                    </label>
                    <details>
                      <summary>环境变量与请求头凭据</summary>
                      <label>
                        {definition.transport === "stdio"
                          ? "环境变量名，每行一个"
                          : "请求头名，每行一个（小写）"}
                        <textarea
                          id="mcp-secret-keys"
                          value={(definition.transport === "stdio"
                            ? definition.env_keys
                            : definition.header_keys
                          ).join("\n")}
                          onChange={(e) =>
                            update(
                              definition.transport === "stdio"
                                ? "env_keys"
                                : "header_keys",
                              lines(e.target.value),
                            )
                          }
                        />
                      </label>
                      <p className="muted">
                        值保存到系统凭据存储，不回显。已有字段留空保留，删除字段名会移除它的保存值。
                      </p>
                      {fields.map((k) => (
                        <label key={k}>
                          {k}{" "}
                          {savedKeys.includes(k)
                            ? "（已保存）"
                            : "（需要填写）"}
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={secrets[k] ?? ""}
                            onChange={(e) => {
                              setDirty(true);
                              setSecrets((s) => ({
                                ...s,
                                [k]: e.target.value,
                              }));
                            }}
                          />
                        </label>
                      ))}
                    </details>
                    <fieldset>
                      <legend>分配给 Agent</legend>
                      {agents.map((a) => (
                        <label className="mcp-check" key={a.id}>
                          <input
                            type="checkbox"
                            data-agent-id={a.id}
                            checked={definition.agent_ids.includes(a.id)}
                            onChange={(e) =>
                              update(
                                "agent_ids",
                                e.target.checked
                                  ? [...definition.agent_ids, a.id]
                                  : definition.agent_ids.filter(
                                      (id) => id !== a.id,
                                    ),
                              )
                            }
                          />
                          {a.name}
                        </label>
                      ))}
                    </fieldset>
                    <label className="mcp-check">
                      <input
                        id="mcp-enabled"
                        type="checkbox"
                        checked={definition.enabled}
                        disabled={definition.location === "legacy-linux"}
                        onChange={(e) => update("enabled", e.target.checked)}
                      />
                      启用服务，允许分配的 Agent 在新任务中发现工具
                    </label>
                    <details>
                      <summary>工具开关</summary>
                      <label>
                        禁用的原始工具名，每行一个
                        <textarea
                          id="mcp-disabled-tools"
                          value={disabled}
                          onChange={(e) => {
                            setDirty(true);
                            setDisabled(e.target.value);
                          }}
                        />
                      </label>
                      <p>
                        首次任务发现目录后，可在“任务连接”读取工具目录，再切回这里按名称开关。
                      </p>
                      {tools
                        .filter((t) => t.server_id === selected)
                        .map((t) => (
                          <label key={t.name} className="mcp-check">
                            <input
                              type="checkbox"
                              checked={
                                !lines(disabled).includes(t.original_name)
                              }
                              onChange={(e) => {
                                setDirty(true);
                                setDisabled(
                                  e.target.checked
                                    ? lines(disabled)
                                        .filter((n) => n !== t.original_name)
                                        .join("\n")
                                    : [
                                        ...lines(disabled),
                                        t.original_name,
                                      ].join("\n"),
                                );
                              }}
                            />
                            {t.original_name}
                          </label>
                        ))}
                    </details>
                    <p className="muted">
                      保存不建立连接。修改配置会撤销现有任务的旧修订；已有 OAuth
                      授权需断开后重新登录。
                    </p>
                    <div className="mcp-actions">
                      <button
                        id="mcp-save"
                        className="primary"
                        disabled={!ready || busy}
                      >
                        {busy ? "处理中…" : "保存服务"}
                      </button>
                      {dirty && <span role="status">有未保存的修改</span>}
                    </div>
                    {selected && (
                      <details>
                        <summary>来源、修订与删除</summary>
                        <p>
                          服务 ID：<code>{selected}</code>
                        </p>
                        <p>来源：{definition.source_kind}</p>
                        <button
                          type="button"
                          disabled={busy || !ready}
                          onClick={() =>
                            act(
                              () =>
                                call(
                                  window.troop.mcpRevisions({ id: selected }),
                                ),
                              setVersions,
                            )
                          }
                        >
                          查看保存修订
                        </button>
                        {versions && (
                          <>
                            <pre>{JSON.stringify(versions.items, null, 2)}</pre>
                            {versions.next_offset !== null && (
                              <button
                                type="button"
                                disabled={busy || !ready}
                                onClick={() =>
                                  act(
                                    () =>
                                      call(
                                        window.troop.mcpRevisions({
                                          id: selected,
                                          offset: versions.next_offset,
                                        }),
                                      ),
                                    setVersions,
                                  )
                                }
                              >
                                更早修订
                              </button>
                            )}
                          </>
                        )}
                        <button
                          type="button"
                          className="danger"
                          id="mcp-remove"
                          disabled={!ready || busy}
                          onClick={() =>
                            act(
                              () =>
                                call(
                                  window.troop.mcpRemove({
                                    id: selected,
                                    expected_revision: revision,
                                  }),
                                ),
                              (r) => {
                                if (!r.cancelled) {
                                  reset();
                                  setNotice(
                                    "服务已删除，调用历史保留。远端撤销结果可在授权服务核对。",
                                  );
                                }
                              },
                              true,
                            )
                          }
                        >
                          删除服务与凭据
                        </button>
                      </details>
                    )}
                  </fieldset>
                </form>
              ) : tab === "auth" ? (
                <section aria-label="MCP 认证">
                  <h2>服务认证</h2>
                  {!selected ? (
                    <p>先保存服务，再配置 OAuth 登录。</p>
                  ) : definition.transport === "stdio" ? (
                    <p>stdio 使用配置的环境变量，不通过浏览器登录。</p>
                  ) : (
                    <>
                      <p id="mcp-auth-status">
                        {authNames[auth?.state] ??
                          auth?.state ??
                          "正在读取认证状态…"}
                      </p>
                      {auth?.error && <p role="alert">{auth.error}</p>}
                      {auth?.expires_at != null && (
                        <p>
                          到期时间：
                          {new Date(auth.expires_at * 1000).toLocaleString()}
                        </p>
                      )}
                      {auth?.credential_cleanup_pending && (
                        <p>本机凭据清理尚未完成，请刷新后核对。</p>
                      )}
                      {dirty && (
                        <p>
                          配置存在未保存修改。先保存，再使用与当前修订绑定的认证。
                        </p>
                      )}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          act(
                            () =>
                              call(
                                window.troop.mcpAuthBegin({
                                  id: selected,
                                  expected_revision: revision,
                                  auth_revision: auth.revision,
                                  client_id: client || null,
                                  client_secret: clientSecret || null,
                                  issuer: issuer || null,
                                  scopes: scopes.split(/\s+/).filter(Boolean),
                                  register,
                                }),
                              ),
                            (d) => {
                              acceptAuth(d);
                              setClientSecret("");
                            },
                          );
                        }}
                      >
                        <label>
                          Client ID
                          <input
                            id="mcp-client-id"
                            value={client}
                            onChange={(e) => setClient(e.target.value)}
                            autoComplete="off"
                          />
                        </label>
                        <label className="mcp-check">
                          <input
                            type="checkbox"
                            checked={register}
                            onChange={(e) => setRegister(e.target.checked)}
                          />
                          没有 Client ID，明确请求动态注册公开客户端
                        </label>
                        <details>
                          <summary>高级认证设置</summary>
                          <label>
                            Client Secret（仅有需要时填写）
                            <input
                              type="password"
                              value={clientSecret}
                              onChange={(e) => setClientSecret(e.target.value)}
                              autoComplete="new-password"
                            />
                          </label>
                          <label>
                            授权服务器 issuer（元数据提供多个时指定）
                            <input
                              value={issuer}
                              onChange={(e) => setIssuer(e.target.value)}
                              type="url"
                            />
                          </label>
                          <label>
                            Scopes（空格分隔）
                            <input
                              id="mcp-scopes"
                              value={scopes}
                              onChange={(e) => setScopes(e.target.value)}
                            />
                          </label>
                        </details>
                        <button
                          id="mcp-auth-begin"
                          disabled={
                            !ready ||
                            busy ||
                            dirty ||
                            !auth ||
                            authBusy ||
                            ["none", "headers"].includes(definition.auth_mode)
                          }
                        >
                          准备浏览器登录
                        </button>
                      </form>
                      {auth?.authorization_url && (
                        <div>
                          <p>
                            授权页面将在系统默认浏览器打开，请自行登录并确认授权。
                          </p>
                          <button
                            id="mcp-auth-open"
                            disabled={!ready || busy || dirty}
                            onClick={() => authOperation("mcpAuthOpen")}
                          >
                            在浏览器中登录
                          </button>
                        </div>
                      )}
                      <div className="mcp-actions">
                        {authBusy && (
                          <button
                            id="mcp-auth-cancel"
                            disabled={!ready || busy}
                            onClick={() => authOperation("mcpAuthCancel")}
                          >
                            取消当前认证操作
                          </button>
                        )}
                        {auth?.state === "connected" &&
                          auth.has_refresh_token && (
                            <button
                              id="mcp-auth-refresh"
                              disabled={!ready || busy || dirty}
                              onClick={() => authOperation("mcpAuthRefresh")}
                            >
                              刷新授权
                            </button>
                          )}
                        {auth && auth.revision > 0 && (
                          <button
                            id="mcp-auth-disconnect"
                            disabled={!ready || busy}
                            onClick={() => authOperation("mcpAuthDisconnect")}
                          >
                            断开并请求撤销授权
                          </button>
                        )}
                      </div>
                      <p className="muted">
                        断开后立即停用本机凭据；远端撤销失败会保留未确认状态，不会称为已撤销。
                      </p>
                    </>
                  )}
                </section>
              ) : (
                <section>
                  <h2>所属任务</h2>
                  <label>
                    查看任务
                    <select
                      id="mcp-run-select"
                      value={runId ?? ""}
                      onChange={(e) => setRunId(Number(e.target.value) || null)}
                    >
                      <option value="">选择任务</option>
                      {runs.map((r) => (
                        <option key={r.id} value={r.id}>
                          #{r.id} {r.goal} · {r.state}
                        </option>
                      ))}
                    </select>
                  </label>
                  {runCursor !== null && (
                    <button
                      disabled={!ready || busy}
                      onClick={() =>
                        act(
                          () => call(window.troop.listRuns(runCursor)),
                          (p) => {
                            setRuns((r) => [...r, ...p.items]);
                            setRunCursor(p.next_offset);
                          },
                        )
                      }
                    >
                      更早任务
                    </button>
                  )}
                  {runId && (
                    <button onClick={() => onRun(runId)}>
                      前往任务审批与继续
                    </button>
                  )}
                  <McpRunPanel
                    key={`${generation}:${runId}`}
                    runId={runId}
                    ready={ready}
                    generation={generation}
                    onTools={setTools}
                  />
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
