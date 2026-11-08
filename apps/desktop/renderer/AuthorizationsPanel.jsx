import React, { useEffect, useRef, useState } from "react";
import { resources } from "./client/resources";
import { clientModels, useClientModel } from "./client/react";
import { call } from "./api";

const purposes = {
  tool_call: "工具调用",
  rule_management: "规则管理",
  cli_start: "CLI 启动",
  mcp_call: "MCP 服务操作",
};
const operations = {
  tool_call: [
    "read_file",
    "group_reply",
    "list_directory",
    "search_text",
    "write_file",
    "run_command",
    "git_status",
    "start_background",
  ],
  rule_management: ["create_rule", "edit_rule", "toggle_rule"],
  cli_start: ["start"],
  mcp_call: ["call_mcp"],
};
const engines = ["native", "claude", "codex", "pi", "opencode"];
const lines = (value) =>
  value
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
const dateInput = (seconds) => {
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const initial = () => ({
  name: "",
  purpose: "tool_call",
  agent_id: 1,
  engine_id: "native",
  workspace_id: 0,
  project_ids: [],
  read_roots: [],
  write_roots: [],
  operations: ["read_file"],
  network: "none",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  rule_id: null,
  read_all: false,
  program: null,
  credential_env_keys: [],
  model_settings: null,
});
export default function AuthorizationsPanel({
  ready,
  generation,
  workspaces,
  onOpenRun,
}) {
  const [actionArguments, setActionArguments] = useState(
    '{"path":"input.txt"}',
  );
  const [cliGoal, setCliGoal] = useState("");
  const [cliToolMode, setCliToolMode] = useState("native");
  const [collaborationMode, setCollaborationMode] = useState("default");
  const [approvalMode, setApprovalMode] = useState("preauthorized");
  const [nativeTransport, setNativeTransport] = useState("acp");
  const [continuationTask, setContinuationTask] = useState("");
  const [continuationPreview, setContinuationPreview] = useState(null);
  const [planConfirmed, setPlanConfirmed] = useState(false);

  const [promptBindings, setPromptBindings] = useState("[]");
  const [mcpBindings, setMcpBindings] = useState("[]");
  const [commandBindings, setCommandBindings] = useState("[]");
  const [agentProvider, setAgentProvider] = useState("");
  const [agentGoal, setAgentGoal] = useState("");
  const agentPending = useRef(null);
  const cliPending = useRef(null);
  const [selected, setSelected] = useState(null),
    [draft, setDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [evaluation, setEvaluation] = useState(null),
    [action, setAction] = useState("read_file"),
    [target, setTarget] = useState("");
  const lock = useRef(false),
    scope = useRef({});
  scope.current = { generation, selected };
  const [offset, setOffset] = useState(0);
  const model = clientModels.resource("authorizations.list", { offset }),
    list = useClientModel(model, ready);
  const agents = useClientModel(clientModels.agents(), ready);
  const cliEngines = useClientModel(
    clientModels.resource("engines.list"),
    ready && Boolean(clientModels.capabilities?.includes("engines.list")),
  );
  const engineInteractions = cliEngines.data?.find(
    (engine) => engine.id === draft.engine_id,
  )?.interactions;
  const supportsInteractions = Boolean(
    clientModels.capabilities?.includes("cli.respond"),
  );
  const supportsPlanPreview = Boolean(
    clientModels.capabilities?.includes("cli.preview"),
  );

  const providers = useClientModel(
    clientModels.resource("provider.list"),
    ready,
  );
  const history = useClientModel(
    selected
      ? clientModels.resource("authorizations.history", { id: selected })
      : null,
    ready && !!selected,
  );
  const current = list.data?.items.find((row) => row.id === selected);
  useEffect(() => {
    setContinuationPreview(null);
    setPlanConfirmed(false);
  }, [
    continuationTask,
    cliGoal,
    cliToolMode,
    collaborationMode,
    approvalMode,
    nativeTransport,
    generation,
    selected,
    current?.revision,
  ]);
  const cliInput = (saved) => ({
    workspace_id: saved.workspace_id,
    agent_id: saved.agent_id,
    engine_id: saved.engine_id,
    tool_mode: cliToolMode,
    ...(supportsInteractions &&
    saved.engine_id === "copilot" &&
    cliToolMode === "native"
      ? { native_transport: nativeTransport }
      : {}),
    ...(supportsInteractions &&
    ["copilot", "claude", "pi", "oh-my-pi", "opencode"].includes(
      saved.engine_id,
    ) &&
    cliToolMode === "native" &&
    !(saved.engine_id === "copilot" && nativeTransport === "sdk_questions")
      ? { approval_mode: approvalMode }
      : {}),
    ...(supportsInteractions && saved.engine_id === "codex"
      ? { collaboration_mode: collaborationMode }
      : {}),
    authorization_id: saved.id,
    project_ids: saved.project_ids,
    rule_id: saved.rule_id,
    goal: cliGoal,
  });
  const change = (key, value) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setEvaluation(null);
    setNotice("");
  };
  useEffect(() => {
    setEvaluation(null);
  }, [generation, current?.revision]);
  const edit = (record) => {
    setSelected(record?.id ?? null);
    setDraft(record ? { ...record } : initial());
    setError("");
    setNotice("");
    setEvaluation(null);
    setTarget("");
    setAction(record?.operations[0] ?? "read_file");
    setPromptBindings(JSON.stringify(record?.prompt_hooks ?? [], null, 2));
    setCommandBindings(JSON.stringify(record?.command_hooks ?? [], null, 2));
    setMcpBindings(JSON.stringify(record?.mcp_calls ?? [], null, 2));
    if (record?.purpose === "mcp_call" && record.mcp_calls?.[0]) {
      const { server_id, tool, arguments: parameters } = record.mcp_calls[0];
      setActionArguments(
        JSON.stringify({ server_id, tool, arguments: parameters }, null, 2),
      );
    }
  };
  async function act(work) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const expected = scope.current;
    try {
      const apply = await work();
      if (
        scope.current.generation === expected.generation &&
        scope.current.selected === expected.selected
      )
        apply?.();
    } catch (e) {
      if (
        scope.current.generation === expected.generation &&
        scope.current.selected === expected.selected
      ) {
        setError(e.message);
        void model.refresh();
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function save(event) {
    event.preventDefault();
    return act(async () => {
      const {
        name,
        purpose,
        agent_id,
        engine_id,
        workspace_id,
        project_ids,
        read_roots,
        write_roots,
        operations,
        network,
        expires_at,
        rule_id,
        read_all,
        program,
        shell,
        credential_env_keys,
        model_settings,
      } = draft;
      const saved = await call(
        resources.authorizationSave({
          ...(selected ? { id: selected } : {}),
          expected_revision: draft.revision ?? 0,
          grant: {
            name,
            purpose,
            agent_id,
            engine_id,
            workspace_id,
            project_ids,
            read_roots,
            write_roots,
            operations,
            network,
            expires_at,
            rule_id,
            read_all: purpose === "cli_start" && !!read_all,
            ...(purpose === "cli_start" &&
            ["claude", "opencode"].includes(engine_id) &&
            model_settings?.file
              ? { model_settings: { file: model_settings.file } }
              : {}),
            ...(purpose === "cli_start" &&
            ["pi", "oh-my-pi", "copilot", "grok", "opencode"].includes(
              engine_id,
            )
              ? { credential_env_keys: credential_env_keys ?? [] }
              : {}),
            ...(["tool_call", "mcp_call"].includes(purpose) &&
            engine_id === "native" &&
            shell
              ? { shell }
              : {}),
            ...(["tool_call", "mcp_call"].includes(purpose) &&
            engine_id === "native"
              ? {
                  prompt_hooks: JSON.parse(promptBindings),
                  command_hooks: JSON.parse(commandBindings),
                }
              : {}),
            ...(purpose === "mcp_call"
              ? { mcp_calls: JSON.parse(mcpBindings) }
              : {}),
            ...(program ? { program } : {}),
          },
        }),
      );
      return () => {
        edit(saved);
        setNotice("授权已保存。");
      };
    });
  }
  const revoke = () =>
    act(async () => {
      const saved = await call(
        resources.authorizationRevoke({
          id: selected,
          expected_revision: draft.revision,
        }),
      );
      return () => {
        edit(saved);
        setNotice("授权已撤销。");
      };
    });
  const evaluate = () =>
    act(async () => {
      const saved = await call(resources.authorizationGet({ id: selected }));
      const result = await call(
        resources.authorizationEvaluate({
          id: selected,
          agent_id: saved.agent_id,
          engine_id: saved.engine_id,
          workspace_id: saved.workspace_id,
          project_ids: saved.project_ids,
          rule_id: saved.rule_id,
          operation: action,
          ...(saved.purpose === "mcp_call"
            ? { mcp: JSON.parse(actionArguments) }
            : target
              ? { path: target }
              : {}),
          network: saved.purpose === "mcp_call" ? saved.network : "none",
        }),
      );
      return () => setEvaluation(result);
    });
  return (
    <div className="models-page">
      <div className="title-row">
        <div>
          <h1>授权</h1>
          <p>管理 Agent 的操作范围，预检拟执行动作。</p>
        </div>
        <button
          id="authorization-new"
          disabled={!ready || busy}
          onClick={() => edit(null)}
        >
          创建授权
        </button>
      </div>
      {(error || list.error) && (
        <p role="alert" className="error">
          {error || list.error.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="models-layout">
        <section className="provider-library" aria-label="授权列表">
          <h2>已保存的授权</h2>
          {list.loading && !list.data && <p>正在读取…</p>}
          {list.data?.items.length === 0 && (
            <p>创建授权后可在这里查看和评估。</p>
          )}
          <ul>
            {list.data?.items.map((record) => (
              <li
                key={record.id}
                className={selected === record.id ? "chosen" : ""}
              >
                <button
                  className="provider-choice"
                  disabled={busy}
                  onClick={() => edit(record)}
                >
                  <strong>{record.name}</strong>
                  <span>
                    {purposes[record.purpose]} · 修订 {record.revision}
                  </span>
                  <small>
                    {record.revoked
                      ? "已撤销"
                      : record.expires_at * 1000 <= Date.now()
                        ? "已过期"
                        : "有效"}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {offset > 0 && (
            <button disabled={!ready || busy} onClick={() => setOffset(0)}>
              返回最新授权
            </button>
          )}
          {list.data?.next_offset != null && (
            <button
              disabled={!ready || busy}
              onClick={() => setOffset(list.data.next_offset)}
            >
              下一页授权
            </button>
          )}
          <button disabled={!ready || busy} onClick={() => model.refresh()}>
            刷新列表
          </button>
        </section>
        <form className="provider-form" onSubmit={save}>
          <fieldset disabled={!ready || busy || draft.revoked}>
            <legend>{selected ? "编辑授权" : "创建授权"}</legend>
            <label htmlFor="authorization-name">名称</label>
            <input
              id="authorization-name"
              value={draft.name}
              maxLength={120}
              required
              onChange={(e) => change("name", e.target.value)}
            />
            <label htmlFor="authorization-purpose">授权类别</label>
            <select
              id="authorization-purpose"
              value={draft.purpose}
              onChange={(e) => {
                change("purpose", e.target.value);
                change("operations", [operations[e.target.value][0]]);
                if (e.target.value !== "cli_start") {
                  change("read_all", false);
                  change("program", null);
                }
                if (e.target.value === "mcp_call") {
                  change("engine_id", "native");
                  change("read_roots", []);
                  change("write_roots", []);
                  change("network", "any");
                }
                setAction(operations[e.target.value][0]);
              }}
            >
              {Object.entries(purposes).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="authorization-agent">Agent</label>
            <select
              id="authorization-agent"
              value={draft.agent_id}
              onChange={(e) => change("agent_id", Number(e.target.value))}
            >
              {agents.data?.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <label htmlFor="authorization-engine">执行引擎</label>
            <select
              id="authorization-engine"
              disabled={draft.purpose === "mcp_call"}
              value={draft.engine_id}
              onChange={(e) => change("engine_id", e.target.value)}
            >
              {!engines.includes(draft.engine_id) && (
                <option value={draft.engine_id} disabled>
                  {draft.engine_id}（当前已停用）
                </option>
              )}
              {engines.map((engine) => (
                <option key={engine} value={engine}>
                  {engine === "native" ? "原生 Agent" : engine}
                </option>
              ))}
            </select>
            <label htmlFor="authorization-workspace">工作目录</label>
            <select
              id="authorization-workspace"
              required
              value={draft.workspace_id}
              onChange={(e) => {
                const id = Number(e.target.value),
                  workspace = workspaces.find((w) => w.id === id);
                setDraft((old) => {
                  const roots =
                    workspace && old.purpose !== "mcp_call"
                      ? [workspace.path]
                      : [];
                  return {
                    ...old,
                    workspace_id: id,
                    read_roots: roots,
                    write_roots: roots,
                  };
                });
                setEvaluation(null);
              }}
            >
              <option value={0}>选择工作区</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <label htmlFor="authorization-projects">项目标识，每行一个</label>
            <textarea
              id="authorization-projects"
              value={draft.project_ids.join("\n")}
              onChange={(e) => change("project_ids", lines(e.target.value))}
            />
            {draft.purpose === "cli_start" &&
              ["pi", "oh-my-pi", "copilot", "grok", "opencode"].includes(
                draft.engine_id,
              ) && (
                <>
                  <label htmlFor="authorization-credential-env">
                    模型凭据环境变量名称，每行一个
                  </label>
                  <textarea
                    id="authorization-credential-env"
                    value={(draft.credential_env_keys ?? []).join("\n")}
                    onChange={(e) =>
                      change("credential_env_keys", lines(e.target.value))
                    }
                  />
                  <p>
                    原生隔离模式仅传入明确选择的 API_KEY／TOKEN
                    环境变量。引擎及其原生工具可读取这些值，授权字段与权限计划保存名称。
                  </p>
                </>
              )}
            {draft.purpose === "cli_start" &&
              ["claude", "opencode"].includes(draft.engine_id) && (
                <>
                  <label htmlFor="authorization-model-settings">
                    现有 {draft.engine_id === "claude" ? "Claude" : "OpenCode"}{" "}
                    模型配置文件
                  </label>
                  <input
                    id="authorization-model-settings"
                    maxLength={4000}
                    value={draft.model_settings?.file ?? ""}
                    onChange={(event) =>
                      change(
                        "model_settings",
                        event.target.value
                          ? { file: event.target.value }
                          : null,
                      )
                    }
                  />
                  {draft.engine_id === "claude" ? (
                    <p>
                      可选择 CC Switch 配置的 settings.json。Core
                      在内存中提取模型地址、模型及 ANTHROPIC
                      凭据参数，保存时固定文件指纹。配置变更后重新保存授权。引擎及原生工具可访问这些凭据环境值。
                    </p>
                  ) : (
                    <p>
                      选择已配置模型的 JSON 文件。当前接入 openai-compatible
                      提供方，读取明确的模型、目的地、API
                      值及上下文与输出容量。可用 {"{env:KEY}"}{" "}
                      引用已在上方明确授权的环境名称。凭据仅在内存传递，源文件变化后重新保存授权。上级目录存在额外项目配置且未获读取授权时，启动预检提供具体原因。
                    </p>
                  )}
                </>
              )}
            <label htmlFor="authorization-read">可读取的根目录，每行一个</label>
            <textarea
              id="authorization-read"
              value={draft.read_roots.join("\n")}
              onChange={(e) => change("read_roots", lines(e.target.value))}
            />
            {draft.purpose === "cli_start" && (
              <>
                <label className="check-row">
                  <input
                    id="authorization-read-all"
                    type="checkbox"
                    checked={!!draft.read_all}
                    onChange={(event) =>
                      change("read_all", event.target.checked)
                    }
                  />
                  明确授权 CLI 读取整个文件系统
                </label>
                <p className="muted">
                  写入仍受下列目录限制。仅在引擎实际能力需要且你确认时启用。
                </p>
                <label htmlFor="authorization-program">
                  CLI 原生程序路径，可选
                </label>
                <input
                  id="authorization-program"
                  value={draft.program ?? ""}
                  onChange={(event) =>
                    change("program", event.target.value || null)
                  }
                />
              </>
            )}
            <label htmlFor="authorization-write">
              可写入的根目录，每行一个
            </label>
            <textarea
              id="authorization-write"
              value={draft.write_roots.join("\n")}
              onChange={(e) => change("write_roots", lines(e.target.value))}
            />
            <label htmlFor="authorization-operations">允许的操作</label>
            <select
              id="authorization-operations"
              multiple
              value={draft.operations}
              onChange={(e) =>
                change(
                  "operations",
                  [...e.target.selectedOptions].map((option) => option.value),
                )
              }
            >
              {operations[draft.purpose].map((operation) => (
                <option key={operation} value={operation}>
                  {operation}
                </option>
              ))}
            </select>
            {["tool_call", "mcp_call"].includes(draft.purpose) &&
              draft.engine_id === "native" && (
                <>
                  <label className="check-row">
                    <input
                      id="authorization-shell"
                      type="checkbox"
                      checked={!!draft.shell}
                      onChange={(event) =>
                        change("shell", event.target.checked ? {} : null)
                      }
                    />
                    使用 MXC 隔离执行 Shell
                  </label>
                  <p className="muted">
                    run_command 和 start_background 使用上方目录及下方网络范围。
                    Windows 系统运行库额外只读。保存时固定隔离程序和 PowerShell
                    指纹，
                    宿主剪贴板、输入注入及跨进程窗口访问受限。程序更新后重新勾选以确认身份。
                    写入树启动前检查，最多 20,000
                    个条目，存在硬链接文件时拒绝执行。
                  </p>
                </>
              )}
            {["tool_call", "mcp_call"].includes(draft.purpose) &&
              draft.engine_id === "native" && (
                <>
                  <label htmlFor="authorization-prompt-hooks">
                    提示 Hook 绑定
                  </label>
                  <textarea
                    id="authorization-prompt-hooks"
                    value={promptBindings}
                    onChange={(event) => {
                      setPromptBindings(event.target.value);
                      setEvaluation(null);
                      setNotice("");
                    }}
                    aria-describedby="authorization-prompt-hooks-help"
                  />
                  <p id="authorization-prompt-hooks-help" className="muted">
                    以 JSON 数组填写 Hook 的 ID 与修订，例如{" "}
                    {`[{"id":1,"revision":2}]`}。
                    配置变化后需要重新确认授权。提示 Hook 使用本次 Agent
                    的模型配置。
                  </p>
                  <label htmlFor="authorization-command-hooks">
                    命令 Hook 绑定
                  </label>
                  <textarea
                    id="authorization-command-hooks"
                    value={commandBindings}
                    onChange={(event) => {
                      setCommandBindings(event.target.value);
                      setEvaluation(null);
                      setNotice("");
                    }}
                    aria-describedby="authorization-command-hooks-help"
                  />
                  <p id="authorization-command-hooks-help" className="muted">
                    {`[{"id":1,"revision":2,"host_access":"sandbox"}]`}
                    需勾选 Shell 隔离，脚本使用本授权的目录和网络范围。
                    full_host 明确授予当前 Windows 用户的文件及网络权限，
                    网络须选择允许任意联网。保存时固定 PowerShell 与脚本指纹。
                    命令 Hook 可随直接动作执行，提示 Hook 需要有模型配置的
                    Agent。 确认更新后的配置时，删除旧 program_sha256 和
                    command_sha256，再保存以捕获新指纹。
                  </p>
                </>
              )}
            {draft.purpose === "mcp_call" && (
              <>
                <label htmlFor="authorization-mcp-calls">
                  MCP 固定操作绑定
                </label>
                <textarea
                  id="authorization-mcp-calls"
                  value={mcpBindings}
                  onChange={(event) => {
                    setMcpBindings(event.target.value);
                    setEvaluation(null);
                    setNotice("");
                  }}
                  aria-describedby="authorization-mcp-help"
                />
                <p id="authorization-mcp-help" className="muted">
                  JSON 数组固定 server_id、revision、tool 与完整
                  arguments。首次保存记录当前认证身份， 更换身份时，删除
                  auth_binding 字段后重新保存以确认当前身份。HTTP／SSE
                  服务按其权限执行，文件根目录留空，网络选择允许任意联网。 stdio
                  使用 host_access 为 sandbox
                  时，初始化及调用均受上方目录和网络范围限制。 Windows
                  运行库和服务主程序额外只读，程序、工作目录及授权根目录的祖先目录额外允许属性查询和名称枚举。
                  full_host 明确允许初始化和运行使用当前 Windows
                  用户的文件及网络权限，文件根目录留空，网络选择允许任意联网。
                  stdio 隔离使用内置 Rust SDK。命令 Hook 的 sandbox 模式还需勾选
                  Shell 隔离。
                  保存时固定主程序指纹。配置变化需重新授权，程序更新需删除旧
                  program_sha256 后确认新指纹。
                </p>
              </>
            )}
            <label htmlFor="authorization-network">网络范围</label>
            <select
              id="authorization-network"
              disabled={draft.purpose === "mcp_call"}
              value={draft.network}
              onChange={(e) => change("network", e.target.value)}
            >
              <option value="none">禁止网络访问</option>
              <option value="any">允许网络访问</option>
            </select>
            <label htmlFor="authorization-expires">有效期至</label>
            <input
              id="authorization-expires"
              type="datetime-local"
              required
              value={dateInput(draft.expires_at)}
              onChange={(e) => {
                if (e.target.value)
                  change(
                    "expires_at",
                    Math.floor(new Date(e.target.value).getTime() / 1000),
                  );
              }}
            />
            <label htmlFor="authorization-rule">关联规则标识，可留空</label>
            <input
              id="authorization-rule"
              value={draft.rule_id ?? ""}
              onChange={(e) => change("rule_id", e.target.value || null)}
            />
            <button id="authorization-save" className="primary" type="submit">
              保存授权
            </button>
            {selected && (
              <button id="authorization-revoke" type="button" onClick={revoke}>
                撤销授权
              </button>
            )}
          </fieldset>
          {current && current.revision > draft.revision && (
            <p role="status">授权已变化，请从列表重新打开后编辑。</p>
          )}
          {selected && (
            <section aria-label="动作评估">
              {draft.purpose === "cli_start" && (
                <div aria-label="CLI 作业启动">
                  <h2>外部 CLI 作业</h2>
                  <p>
                    当前接入 Claude Code、Codex、Pi 和 OpenCode。 Claude Code
                    使用明确绑定的现有配置，支持原生问答和一次性工具审批。 Codex
                    支持计划与选项问答，范围变更通过停止、核对与新授权创建关联执行。
                    Pi 使用内置回调扩展承接问答和审批。 OpenCode
                    的审批缺少参数时由后端阻断批准。
                    每次执行的模型、目录、网络、工具范围与实际能力以权限计划为准。
                  </p>
                  {!engines.includes(draft.engine_id) && (
                    <p role="status">
                      此引擎当前已停用，请选择 Claude Code、Codex、Pi 或
                      OpenCode 创建执行。
                    </p>
                  )}
                  {engineInteractions && (
                    <details>
                      <summary>引擎交互能力及限制</summary>
                      <pre>{JSON.stringify(engineInteractions, null, 2)}</pre>
                    </details>
                  )}
                  <label htmlFor="authorization-cli-tool-mode">执行能力</label>
                  <select
                    id="authorization-cli-tool-mode"
                    value={cliToolMode}
                    disabled={!ready || busy}
                    onChange={(event) => setCliToolMode(event.target.value)}
                  >
                    <option value="native">原生工具</option>
                    <option value="disabled">禁用工具，仅传入文本</option>
                  </select>
                  {supportsInteractions &&
                    draft.engine_id === "copilot" &&
                    cliToolMode === "native" && (
                      <>
                        <label htmlFor="authorization-cli-transport">
                          Copilot 原生通道
                        </label>
                        <select
                          id="authorization-cli-transport"
                          value={nativeTransport}
                          disabled={!ready || busy}
                          onChange={(event) =>
                            setNativeTransport(event.target.value)
                          }
                        >
                          <option value="acp">ACP 工具执行与审批</option>
                          <option value="sdk_questions">
                            原生 RPC 问答，仅开放 ask_user
                          </option>
                        </select>
                        {nativeTransport === "sdk_questions" && (
                          <p>
                            此通道仅提供问题工具，文件与命令工具关闭。问答使用同一持久接口和隔离环境。
                          </p>
                        )}
                      </>
                    )}
                  {supportsInteractions && draft.engine_id === "codex" && (
                    <>
                      <label htmlFor="authorization-cli-collaboration">
                        Codex 协作模式
                      </label>
                      <select
                        id="authorization-cli-collaboration"
                        disabled={!ready || busy}
                        value={collaborationMode}
                        onChange={(event) =>
                          setCollaborationMode(event.target.value)
                        }
                      >
                        <option value="default">默认执行</option>
                        <option value="plan">计划与问答</option>
                      </select>
                    </>
                  )}
                  {supportsInteractions &&
                    [
                      "copilot",
                      "claude",
                      "pi",
                      "oh-my-pi",
                      "opencode",
                    ].includes(draft.engine_id) &&
                    cliToolMode === "native" &&
                    !(
                      draft.engine_id === "copilot" &&
                      nativeTransport === "sdk_questions"
                    ) && (
                      <>
                        <label htmlFor="authorization-cli-approval-mode">
                          工具审批
                        </label>
                        <select
                          id="authorization-cli-approval-mode"
                          disabled={!ready || busy}
                          value={approvalMode}
                          onChange={(event) =>
                            setApprovalMode(event.target.value)
                          }
                        >
                          <option value="preauthorized">
                            按预授权范围自动判定
                          </option>
                          <option value="manual">逐次人工确认</option>
                        </select>
                      </>
                    )}
                  <label htmlFor="authorization-cli-goal">作业目标</label>
                  <textarea
                    id="authorization-cli-goal"
                    value={cliGoal}
                    maxLength={12000}
                    disabled={!ready || busy}
                    onChange={(event) => setCliGoal(event.target.value)}
                  />
                  <label htmlFor="authorization-cli-continuation">
                    关联的旧 Task ID，可选
                  </label>
                  <input
                    id="authorization-cli-continuation"
                    type="number"
                    min="1"
                    disabled={!ready || busy || !supportsPlanPreview}
                    value={continuationTask}
                    onChange={(event) =>
                      setContinuationTask(event.target.value)
                    }
                  />
                  {continuationTask && (
                    <>
                      <p>
                        先在执行详情停止并核对旧作业。选择新授权后检查差异，再确认创建关联执行。
                      </p>
                      <button
                        type="button"
                        disabled={
                          !ready ||
                          busy ||
                          !engines.includes(draft.engine_id) ||
                          !cliGoal.trim()
                        }
                        onClick={() =>
                          act(async () => {
                            const saved = await call(
                              resources.authorizationGet({ id: selected }),
                            );
                            const task = await clientModels.client.request(
                              "agent.task",
                              { id: Number(continuationTask) },
                            );
                            const input = {
                              ...cliInput(saved),
                              client_run_id: crypto.randomUUID(),
                              continuation_of: {
                                task_id: task.id,
                                task_epoch: task.epoch,
                                expected_task_revision: task.revision,
                                ...(task.scope_change_interaction_id
                                  ? {
                                      interaction_id:
                                        task.scope_change_interaction_id,
                                    }
                                  : {}),
                                ...(task.evidence?.sha256
                                  ? { evidence_sha256: task.evidence.sha256 }
                                  : {}),
                              },
                            };
                            const preview = await clientModels.client.request(
                              "cli.preview",
                              input,
                            );
                            return () => {
                              setContinuationPreview({ ...preview, input });
                              setPlanConfirmed(false);
                            };
                          })
                        }
                      >
                        检查关联执行与权限差异
                      </button>
                      {continuationPreview && (
                        <>
                          <pre aria-label="关联执行权限差异">
                            {JSON.stringify(
                              continuationPreview.continuation_of,
                              null,
                              2,
                            )}
                          </pre>
                          <details>
                            <summary>待确认权限计划</summary>
                            <pre>
                              {JSON.stringify(
                                continuationPreview.plan,
                                null,
                                2,
                              )}
                            </pre>
                          </details>
                          <label className="check-row">
                            <input
                              type="checkbox"
                              checked={planConfirmed}
                              onChange={(event) =>
                                setPlanConfirmed(event.target.checked)
                              }
                            />
                            已核对旧效果与权限差异，明确授权这份计划
                          </label>
                        </>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    id="authorization-cli-start"
                    disabled={
                      !ready ||
                      busy ||
                      draft.revoked ||
                      !engines.includes(draft.engine_id) ||
                      !cliGoal.trim() ||
                      (Boolean(continuationTask) && !planConfirmed)
                    }
                    onClick={() =>
                      act(async () => {
                        const saved = await call(
                          resources.authorizationGet({ id: selected }),
                        );
                        const input = cliInput(saved);
                        if (continuationTask) {
                          if (!planConfirmed || !continuationPreview)
                            throw new Error("请核对权限差异并确认计划。");
                          const result = await clientModels.command(
                            "cli.start",
                            {
                              ...continuationPreview.input,
                              expected_plan_sha256:
                                continuationPreview.plan_sha256,
                            },
                          );
                          return () => onOpenRun?.(result.run.id);
                        }
                        const signature = JSON.stringify(input);
                        if (cliPending.current?.signature !== signature)
                          cliPending.current = {
                            signature,
                            id: crypto.randomUUID(),
                          };
                        const result = await clientModels.command("cli.start", {
                          ...input,
                          client_run_id: cliPending.current.id,
                        });
                        cliPending.current = null;
                        return () => onOpenRun?.(result.run.id);
                      })
                    }
                  >
                    启动已授权 CLI
                  </button>
                </div>
              )}
              {["tool_call", "mcp_call"].includes(draft.purpose) && (
                <>
                  <h2>已授权的模型 Agent</h2>
                  <label htmlFor="authorization-agent-provider">模型服务</label>
                  <select
                    id="authorization-agent-provider"
                    value={agentProvider}
                    disabled={!ready || busy}
                    onChange={(event) => setAgentProvider(event.target.value)}
                  >
                    <option value="">选择模型服务</option>
                    {providers.data?.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.config.name} · {provider.config.model}
                      </option>
                    ))}
                  </select>
                  {providers.error && (
                    <p role="alert">{providers.error.message}</p>
                  )}
                  <label htmlFor="authorization-agent-goal">任务目标</label>
                  <textarea
                    id="authorization-agent-goal"
                    value={agentGoal}
                    maxLength={12000}
                    disabled={!ready || busy}
                    onChange={(event) => setAgentGoal(event.target.value)}
                  />
                  <button
                    id="authorization-agent-start"
                    type="button"
                    disabled={
                      !ready ||
                      busy ||
                      draft.revoked ||
                      !agentProvider ||
                      !agentGoal.trim()
                    }
                    onClick={() =>
                      act(async () => {
                        const saved = await call(
                          resources.authorizationGet({ id: selected }),
                        );
                        const input = {
                          workspace_id: saved.workspace_id,
                          agent_id: saved.agent_id,
                          provider_id: agentProvider,
                          authorization_id: saved.id,
                          project_ids: saved.project_ids,
                          rule_id: saved.rule_id,
                          goal: agentGoal,
                        };
                        const signature = JSON.stringify(input);
                        if (agentPending.current?.signature !== signature)
                          agentPending.current = {
                            signature,
                            id: crypto.randomUUID(),
                          };
                        const result = await clientModels.command(
                          "agent.start",
                          { ...input, client_run_id: agentPending.current.id },
                        );
                        agentPending.current = null;
                        return () => onOpenRun?.(result.run.id);
                      })
                    }
                  >
                    启动已授权 Agent
                  </button>
                  <h2>直接工具动作</h2>
                  <label htmlFor="authorization-arguments">
                    完整参数 JSON，操作沿用下方选择
                  </label>
                  <textarea
                    id="authorization-arguments"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      fontFamily: "monospace",
                    }}
                    disabled={!ready || busy}
                    value={actionArguments}
                    onChange={(e) => setActionArguments(e.target.value)}
                  />
                  <button
                    type="button"
                    id="authorization-execute"
                    disabled={!ready || busy || draft.revoked}
                    onClick={() =>
                      act(async () => {
                        const saved = await call(
                          resources.authorizationGet({ id: selected }),
                        );
                        const result = await clientModels.command(
                          "agent.start",
                          {
                            client_run_id: crypto.randomUUID(),
                            workspace_id: saved.workspace_id,
                            agent_id: saved.agent_id,
                            authorization_id: saved.id,
                            project_ids: saved.project_ids,
                            rule_id: saved.rule_id,
                            goal: `直接工具动作 ${action}`,
                            action: {
                              name: action,
                              arguments: JSON.parse(actionArguments),
                            },
                          },
                        );
                        return () => onOpenRun?.(result.run.id);
                      })
                    }
                  >
                    执行已授权动作
                  </button>
                </>
              )}
              <h2>评估已保存的授权</h2>
              <p>
                预检动作是否符合范围。实际执行前还会校验当前授权及权限计划。
              </p>
              <label htmlFor="authorization-action">拟执行操作</label>
              <select
                disabled={!ready || busy}
                id="authorization-action"
                value={action}
                onChange={(e) => {
                  setAction(e.target.value);
                  setEvaluation(null);
                }}
              >
                {Object.values(operations)
                  .flat()
                  .map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
              </select>
              <label htmlFor="authorization-target">实际目标路径</label>
              <input
                disabled={!ready || busy || draft.purpose === "mcp_call"}
                id="authorization-target"
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setEvaluation(null);
                }}
              />
              <button
                id="authorization-evaluate"
                type="button"
                disabled={!ready || busy}
                onClick={evaluate}
              >
                评估动作
              </button>
              {evaluation && (
                <div role="status" id="authorization-result">
                  <strong>
                    {
                      {
                        allow: "范围符合",
                        deny: "范围不符",
                        needs_user: "需要处理",
                      }[evaluation.decision]
                    }
                  </strong>
                  <p>{evaluation.reason}</p>
                  <p>依据授权修订 {evaluation.grant_revision}</p>
                  {evaluation.missing_capabilities.length > 0 && (
                    <p>待验证执行能力和权限强制机制。</p>
                  )}
                </div>
              )}
            </section>
          )}
          {history.data && (
            <details>
              <summary>授权变更历史</summary>
              <ul>
                {history.data.items.map((record) => (
                  <li key={record.revision}>
                    修订 {record.revision} · {record.revoked ? "撤销" : "保存"}{" "}
                    · {new Date(record.updated_at * 1000).toLocaleString()}
                    {record.last_evaluation && (
                      <p>
                        最近评估 · {record.last_evaluation.reason} ·{" "}
                        {record.last_evaluation.action.operation} ·{" "}
                        {record.last_evaluation.normalized_target ??
                          record.last_evaluation.action.path ??
                          "无文件目标"}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </form>
      </div>
    </div>
  );
}
