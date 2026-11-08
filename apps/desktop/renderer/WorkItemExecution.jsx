import React, { useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { actionFor } from "./client/actions.mjs";

export const workStates = {
  ready: "可执行",
  blocked: "等待依赖或范围核对",
  running: "进行中",
  waiting: "等待处理",
  reconciliation: "等待执行核对",
  awaiting_acceptance: "待验收",
  completed: "已完成",
  cancelled: "已取消",
  failed: "执行未完成",
};
export default function WorkItemExecution({
  item,
  ready,
  busy,
  dirty,
  act,
  onOpenRun,
}) {
  const [kind, setKind] = useState("agent"),
    [provider, setProvider] = useState(""),
    [engine, setEngine] = useState("codex"),
    [authorization, setAuthorization] = useState(""),
    [toolMode, setToolMode] = useState("native"),
    [plan, setPlan] = useState(null),
    [note, setNote] = useState(""),
    [previewError, setPreviewError] = useState("");
  const providers = useClientModel(
    clientModels.resource("provider.list"),
    ready,
  );
  const engines = useClientModel(clientModels.resource("engines.list"), ready);
  const grants = useClientModel(
    clientModels.resource("authorizations.list", { offset: 0 }),
    ready,
  );
  const historyModel = clientModels.resource("work_items.runs", {
    id: item.id,
  });
  const history = useClientModel(historyModel, ready);
  const current = useClientModel(
    item.current_run_id ? clientModels.run(item.current_run_id) : null,
    ready,
  );
  const startAction = actionFor(item, "start"),
    cancelAction = actionFor(item, "cancel"),
    stopAction = actionFor(current.data, "stop");
  const execution =
    kind === "agent"
      ? {
          kind,
          provider_id: provider || providers.data?.[0]?.id,
          ...(authorization ? { authorization_id: authorization } : {}),
        }
      : {
          kind,
          engine_id: engine,
          authorization_id: authorization,
          tool_mode: toolMode,
          approval_mode: "manual",
        };
  const input = { id: item.id, expected_revision: item.revision, execution };
  const signature = JSON.stringify(input);
  const confirmed = plan?.signature === signature;
  const locked = !ready || busy || dirty;
  return (
    <section className="work-execution" aria-label="工作项执行">
      <h2>执行与验收</h2>
      <p id="work-item-progress" role="status">
        {workStates[item.progress.state] ?? item.progress.state}
      </p>
      {item.progress.reason && <p className="muted">{item.progress.reason}</p>}
      {item.cancelled && item.current_run_id && (
        <p>已封锁后续启动。关联执行的停止与核对情况请查看执行详情。</p>
      )}
      <fieldset disabled={locked}>
        <legend>执行配置</legend>
        <label htmlFor="work-execution-kind">执行方式</label>
        <select
          id="work-execution-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value);
            setAuthorization("");
          }}
        >
          <option value="agent">原生 Agent</option>
          <option value="cli">Coding CLI</option>
        </select>
        {kind === "agent" ? (
          <>
            <label htmlFor="work-execution-provider">模型</label>
            <select
              id="work-execution-provider"
              value={provider || providers.data?.[0]?.id || ""}
              onChange={(event) => setProvider(event.target.value)}
            >
              {providers.data?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.config.name}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label htmlFor="work-execution-engine">CLI</label>
            <select
              id="work-execution-engine"
              value={engine}
              onChange={(event) => {
                setEngine(event.target.value);
                setAuthorization("");
              }}
            >
              {engines.data?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <label htmlFor="work-execution-tools">工具范围</label>
            <select
              id="work-execution-tools"
              value={toolMode}
              onChange={(event) => setToolMode(event.target.value)}
            >
              <option value="native">引擎原生工具</option>
              <option value="disabled">关闭工具</option>
            </select>
          </>
        )}
        <label htmlFor="work-execution-authorization">范围授权 ID</label>
        <input
          id="work-execution-authorization"
          list="work-execution-grants"
          value={authorization}
          placeholder={
            kind === "agent"
              ? "留空沿用人工工具审批"
              : "选择建议或填写 CLI 启动授权 ID"
          }
          onChange={(event) => setAuthorization(event.target.value)}
        />
        <datalist id="work-execution-grants">
          {grants.data?.items
            ?.filter(
              (grant) =>
                grant.engine_id === (kind === "agent" ? "native" : engine) &&
                grant.agent_id === item.owner_agent_id &&
                grant.workspace_id === item.workspace_id,
            )
            .map((grant) => (
              <option key={grant.id} value={grant.id} label={grant.name} />
            ))}
        </datalist>
        {(providers.error || engines.error || grants.error) && (
          <p role="alert">
            {providers.error?.message ||
              engines.error?.message ||
              grants.error?.message}
          </p>
        )}
        {kind === "cli" && (
          <button
            id="work-item-preview"
            type="button"
            disabled={!startAction.allowed || !authorization}
            onClick={async () => {
              setPreviewError("");
              try {
                setPlan({
                  signature,
                  ...(await clientModels.read("work_items.preview", input)),
                });
              } catch (error) {
                setPreviewError(error.message);
              }
            }}
          >
            检查权限计划
          </button>
        )}
        {confirmed && (
          <details open>
            <summary>已检查的权限计划</summary>
            <pre>{JSON.stringify(plan.plan, null, 2)}</pre>
            <p>点击启动即确认本计划。修改配置或工作项后需重新检查。</p>
          </details>
        )}
        {previewError && <p role="alert">{previewError}</p>}
        <button
          id="work-item-start"
          type="button"
          title={startAction.reason ?? undefined}
          disabled={
            !startAction.allowed ||
            (kind === "cli"
              ? !authorization || !confirmed
              : !execution.provider_id)
          }
          onClick={() =>
            void act(() =>
              clientModels.command("work_items.start", {
                ...input,
                execution: {
                  ...execution,
                  ...(confirmed
                    ? { expected_plan_sha256: plan.plan_sha256 }
                    : {}),
                },
              }),
            )
          }
        >
          启动工作项
        </button>
      </fieldset>
      <div className="work-execution-actions">
        {item.current_run_id && (
          <>
            <button
              id="work-item-open-run"
              type="button"
              onClick={() => onOpenRun(item.current_run_id)}
            >
              查看执行、审批与固定证据
            </button>
            <button
              id="work-item-stop"
              type="button"
              disabled={locked || !stopAction.allowed}
              title={stopAction.reason ?? undefined}
              onClick={() =>
                void act(async () => {
                  await clientModels.command("agent.cancel", {
                    id: item.current_run_id,
                  });
                  return clientModels.read("work_items.get", { id: item.id });
                })
              }
            >
              停止当前执行
            </button>
          </>
        )}
        <button
          id="work-item-cancel"
          type="button"
          disabled={locked || !cancelAction.allowed}
          title={cancelAction.reason ?? undefined}
          onClick={() =>
            void act(() =>
              clientModels.command("work_items.cancel", {
                id: item.id,
                expected_revision: item.revision,
              }),
            )
          }
        >
          取消工作项
        </button>
      </div>
      <label htmlFor="work-acceptance-note">验收说明</label>
      <textarea
        id="work-acceptance-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        disabled={locked}
      />
      {history.error && <p role="alert">{history.error.message}</p>}
      {history.data?.items.map((result) => (
        <article className="work-result" key={result.run.id}>
          <h3>
            Run #{result.run.id} · {result.run.state}
          </h3>
          <p>
            目标版本 {result.definition_revision} · 执行修订{" "}
            {result.run.revision}
          </p>
          <pre>{result.text || "尚无结果文本"}</pre>
          {result.text_truncated && <p>此处为摘要，完整内容见执行详情。</p>}
          <p className="muted">证据 {result.evidence_sha256 ?? "等待封存"}</p>
          {result.acceptance && (
            <p>
              已接纳目标版本 {result.acceptance.definition_revision} ·{" "}
              {result.acceptance.note}
            </p>
          )}
          <button type="button" onClick={() => onOpenRun(result.run.id)}>
            打开执行 #{result.run.id}
          </button>
          <button
            className="work-result-accept"
            type="button"
            disabled={
              locked || !note.trim() || !result.allowed_actions.accept.allowed
            }
            title={result.allowed_actions.accept.reason ?? undefined}
            onClick={() =>
              void act(() =>
                clientModels.command("work_items.accept", {
                  id: item.id,
                  expected_revision: item.revision,
                  run_id: result.run.id,
                  expected_run_revision: result.run.revision,
                  evidence_sha256: result.evidence_sha256,
                  note,
                }),
              )
            }
          >
            接纳此版本结果
          </button>
        </article>
      ))}
      {history.data?.next_before && (
        <button disabled={history.loading} onClick={() => historyModel.more()}>
          加载更多执行
        </button>
      )}
    </section>
  );
}
