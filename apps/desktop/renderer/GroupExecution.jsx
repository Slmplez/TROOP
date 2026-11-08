import React, { useState } from "react";
import { clientModels, useClientModel } from "./client/react";

export function GroupChain({ id, ready, busy, perform }) {
  const state = useClientModel(
    clientModels.resource("groups.chain", { id }),
    ready,
  );
  if (!state.data)
    return state.error ? (
      <p role="alert">{state.error.message}</p>
    ) : (
      <p>正在读取协作链…</p>
    );
  const chain = state.data;
  return (
    <div className="group-chain">
      <p>
        协作链 <code>{chain.id}</code> · 已启动 {chain.wake_count}/
        {chain.wake_limit} 次 · 并发上限 {chain.parallel_limit} ·{" "}
        {chain.stopped ? "已停止" : "已建立"}
      </p>
      <p className="muted">
        截止 {new Date(chain.expires_at * 1000).toLocaleString()}
        。停止会封锁后续交接，并停止链内 Run 与所属作业。进程停止证据请查看
        Run。
      </p>
      <button
        type="button"
        disabled={!ready || busy || !chain.allowed_actions.stop.allowed}
        title={chain.allowed_actions.stop.reason ?? undefined}
        onClick={() =>
          void perform("groups.stop_chain", {
            id,
            expected_revision: chain.revision,
          })
        }
      >
        停止本次协作
      </button>
    </div>
  );
}

export default function GroupExecution({
  group,
  ready,
  busy,
  perform,
  workspaces,
}) {
  const [agent, setAgent] = useState("");
  const member = Number(agent || group.members[0]?.agent_id || 0);
  return (
    <details className="group-execution">
      <summary>成员执行与预授权</summary>
      <p className="muted">
        每次投递创建独立
        Run。同群同成员依次处理，跨成员可并行。配置启用后会处理当前排队消息。
      </p>
      <label htmlFor="group-executor-agent">执行成员</label>
      <select
        id="group-executor-agent"
        value={member || ""}
        onChange={(event) => setAgent(event.target.value)}
        disabled={busy}
      >
        {!group.members.length && <option value="">请先添加成员</option>}
        {group.members.map((entry) => (
          <option key={entry.agent_id} value={entry.agent_id}>
            {entry.agent_name}
          </option>
        ))}
      </select>
      {member > 0 && (
        <Executor
          key={`${group.id}:${member}`}
          group={group}
          agent={member}
          ready={ready}
          busy={busy}
          perform={perform}
          workspaces={workspaces}
        />
      )}
    </details>
  );
}

function Executor({ group, agent, ready, busy, perform, workspaces }) {
  const snapshot = useClientModel(
    clientModels.resource("groups.executor.get", {
      group_id: group.id,
      agent_id: agent,
    }),
    ready,
  );
  const providers = useClientModel(
    clientModels.resource("provider.list"),
    ready,
  );
  const engines = useClientModel(clientModels.resource("engines.list"), ready);
  const grants = useClientModel(
    clientModels.resource("authorizations.list", { offset: 0 }),
    ready,
  );
  const [draft, setDraft] = useState(null),
    [plan, setPlan] = useState(null),
    [error, setError] = useState("");
  const current = snapshot.data;
  if (!current)
    return (
      <p role={snapshot.error ? "alert" : "status"}>
        {snapshot.error?.message ?? "正在读取执行配置…"}
      </p>
    );
  const value = draft ?? {
    expected_revision: current.revision,
    enabled: current.enabled,
    workspace_id: current.workspace_id ?? workspaces[0]?.id ?? 0,
    execution: current.execution ?? {
      kind: "agent",
      provider_id: providers.data?.[0]?.id ?? "",
      authorization_id: "",
    },
  };
  const execution = value.execution;
  const launchInput = { ...execution };
  delete launchInput.expected_plan_sha256;
  const input = {
    group_id: group.id,
    agent_id: agent,
    ...value,
    execution: launchInput,
  };
  const signature = JSON.stringify(input);
  const stale = value.expected_revision !== current.revision;
  const confirmed = plan?.signature === signature;
  function change(changes) {
    setDraft({ ...value, ...changes });
  }
  function launch(changes) {
    change({ execution: { ...execution, ...changes } });
  }
  const locked = !ready || busy || group.archived;
  return (
    <>
      <p role="status">
        {current.enabled ? "自动处理已启用" : "自动处理未启用"} · 修订{" "}
        {current.revision}
      </p>
      {current.current_blocker && <p>{current.current_blocker}</p>}
      {stale && (
        <p role="status">执行配置已变化。草稿保留，请载入最新配置后核对。</p>
      )}
      {(error || providers.error || engines.error || grants.error) && (
        <p role="alert">
          {error ||
            providers.error?.message ||
            engines.error?.message ||
            grants.error?.message}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setDraft(null);
          setPlan(null);
        }}
      >
        载入最新执行配置
      </button>
      <fieldset disabled={locked}>
        <label htmlFor="group-executor-workspace">工作区</label>
        <select
          id="group-executor-workspace"
          value={value.workspace_id}
          onChange={(event) =>
            change({ workspace_id: Number(event.target.value) })
          }
        >
          {!workspaces.length && <option value="0">请先添加工作区</option>}
          {workspaces.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name ?? entry.path}
            </option>
          ))}
        </select>
        <label htmlFor="group-executor-kind">执行方式</label>
        <select
          id="group-executor-kind"
          value={execution.kind}
          onChange={(event) =>
            change({
              execution:
                event.target.value === "agent"
                  ? {
                      kind: "agent",
                      provider_id: providers.data?.[0]?.id ?? "",
                      authorization_id: "",
                    }
                  : {
                      kind: "cli",
                      engine_id: "codex",
                      authorization_id: "",
                      tool_mode: "native",
                      approval_mode: "manual",
                    },
            })
          }
        >
          <option value="agent">原生 Agent</option>
          <option value="cli">Coding CLI</option>
        </select>
        {execution.kind === "agent" ? (
          <>
            <label htmlFor="group-executor-provider">模型</label>
            <select
              id="group-executor-provider"
              value={execution.provider_id}
              onChange={(event) => launch({ provider_id: event.target.value })}
            >
              {!providers.data?.length && (
                <option value="">请先配置模型</option>
              )}
              {providers.data?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.config.name}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label htmlFor="group-executor-engine">CLI</label>
            <select
              id="group-executor-engine"
              value={execution.engine_id}
              onChange={(event) =>
                launch({
                  engine_id: event.target.value,
                  authorization_id: "",
                  expected_plan_sha256: null,
                })
              }
            >
              {engines.data?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <label htmlFor="group-executor-tools">工具模式</label>
            <select
              id="group-executor-tools"
              value={execution.tool_mode}
              onChange={(event) =>
                launch({
                  tool_mode: event.target.value,
                  expected_plan_sha256: null,
                })
              }
            >
              <option value="native">原生工具</option>
              <option value="disabled">关闭工具</option>
            </select>
            <label htmlFor="group-executor-approval">审批方式</label>
            <select
              id="group-executor-approval"
              value={execution.approval_mode ?? "manual"}
              onChange={(event) =>
                launch({
                  approval_mode: event.target.value,
                  expected_plan_sha256: null,
                })
              }
            >
              <option value="manual">运行时人工审批</option>
              <option value="preauthorized">按范围预授权</option>
            </select>
          </>
        )}
        <label htmlFor="group-executor-grant">范围授权 ID</label>
        <input
          id="group-executor-grant"
          list="group-executor-grants"
          value={execution.authorization_id}
          onChange={(event) =>
            launch({
              authorization_id: event.target.value,
              ...(execution.kind === "cli"
                ? { expected_plan_sha256: null }
                : {}),
            })
          }
        />
        <datalist id="group-executor-grants">
          {grants.data?.items
            ?.filter(
              (entry) =>
                entry.agent_id === agent &&
                entry.workspace_id === value.workspace_id &&
                entry.engine_id ===
                  (execution.kind === "agent" ? "native" : execution.engine_id),
            )
            .map((entry) => (
              <option key={entry.id} value={entry.id} label={entry.name} />
            ))}
        </datalist>
        <p className="muted">
          在授权页面创建匹配成员、项目和工作区的有效授权。原生 Agent
          发送群回复需要 group_reply 操作。CLI 回复经固定证据审核后发布。
        </p>
        <label className="group-inline">
          <input
            id="group-executor-enabled"
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => change({ enabled: event.target.checked })}
          />
          自动处理新投递
        </label>
        <button
          id="group-executor-preview"
          type="button"
          disabled={stale || !execution.authorization_id || !value.workspace_id}
          onClick={async () => {
            setError("");
            try {
              setPlan({
                signature,
                ...(await clientModels.read("groups.executor.preview", input)),
              });
            } catch (error) {
              setError(error.message);
            }
          }}
        >
          检查权限计划
        </button>
        {confirmed && (
          <details open>
            <summary>已检查的权限计划</summary>
            <pre>{JSON.stringify(plan.plan, null, 2)}</pre>
            <p>保存即确认本计划。更改配置后需重新检查。</p>
          </details>
        )}
        <button
          id="group-executor-save"
          type="button"
          disabled={
            stale ||
            !value.workspace_id ||
            (value.enabled && (!execution.authorization_id || !confirmed))
          }
          onClick={() =>
            void perform(
              "groups.executor.save",
              {
                ...input,
                execution: {
                  ...launchInput,
                  ...(execution.kind === "cli" && confirmed
                    ? { expected_plan_sha256: plan.plan_sha256 }
                    : {}),
                },
              },
              () => {
                setDraft(null);
                setPlan(null);
              },
            )
          }
        >
          保存执行配置
        </button>
      </fieldset>
    </>
  );
}
