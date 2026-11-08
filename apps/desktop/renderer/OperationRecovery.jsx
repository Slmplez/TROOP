import React, { useState, useSyncExternalStore } from "react";
import { operationJournal, troopClient, clientModels } from "./client/react";

const names = {
  "cli.start": "启动外部 CLI",
  "cli.review": "审核 CLI 结果",
  "events.source.save": "保存事件来源",
  "events.recheck": "复核来源状态",
  "memory.maintenance.save": "保存记忆维护模型",
  "rules.save": "保存规则",
  "authorizations.save": "保存授权",
  "authorizations.revoke": "撤销授权",
  "agent.start": "启动任务",
  "agent.cancel": "停止任务",
  "agent.approve": "操作审批",
  "agent.steer": "补充指令",
  "agent.resume": "继续任务",
  "agent.reconcile": "核对工具",
  "agent.stop-task": "停止作业",
  "agent.reconcile-task": "核对作业",
  "agent.compact": "压缩上下文",
  "memory.agent.save": "保存 Agent 设置",
  "memory.membership": "修改项目成员",
  "memory.write": "新增记忆",
  "memory.edit": "编辑或遗忘记忆",
  "memory.restore": "明确恢复记忆",
  "memory.resolve": "解决记忆冲突",
  "memory.job.cancel": "取消记忆维护",
  "memory.job.retry": "重试记忆维护",
  "skills.import": "导入 Skill",
  "skills.enable": "启停 Skill",
  "skills.remove": "删除 Skill",
  "skills.edit": "编辑 Skill",
  "skills.refresh": "刷新 Skill",
  "hooks.save": "保存 Hook",
  "hooks.remove": "删除 Hook",
  "hooks.reconcile": "核对 Hook",
  "mcp.save": "保存 MCP 服务",
  "mcp.remove": "删除 MCP 服务",
  "mcp.import": "导入 MCP 服务",
  "mcp.oauth.begin": "连接 MCP 账号",
  "mcp.oauth.cancel": "取消账号连接",
  "mcp.oauth.refresh": "刷新账号连接",
  "mcp.oauth.disconnect": "断开账号连接",
  "provider.save": "保存模型服务",
  "provider.remove": "删除模型服务",
  "workspace.add": "添加工作区",
  "workspace.rename": "重命名工作区",
  "workspace.remove": "移除工作区",
  "agent.mcp-reconcile": "核对 MCP 连接",
};
const resourcePage = (method) =>
  ({
    authorizations: "authorizations",
    rules: "rules",
    events: "events",
    memory: "memory",
    skills: "skills",
    hooks: "hooks",
    mcp: "mcp",
    provider: "models",
    workspace: "workspaces",
  })[method.split(".")[0]];
export default function OperationRecovery({
  ready,
  onOpenRun,
  onOpenResource,
}) {
  const entries = useSyncExternalStore(
    operationJournal.subscribe,
    operationJournal.getSnapshot,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!entries.length) return null;
  const act = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      clientModels.invalidate();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="agent-resume" aria-label="待确认操作">
      <h2>待确认操作</h2>
      <p>连接中断后先查询原操作。命令已接纳不代表任务已完成。</p>
      {error && <p role="alert">{error}</p>}
      {entries.map((entry) => (
        <div key={entry.request.operation_id}>
          <strong>{names[entry.request.method]}</strong>
          <span>
            {" "}
            ·{" "}
            {{
              committed: "命令已接纳",
              rejected: "命令已拒绝",
              not_found: "尚未找到接纳记录",
              conflict: "操作标识冲突",
              needs_reconciliation: "请核对资源当前状态",
            }[entry.receipt?.state] ?? "结果待查询"}
          </span>
          {entry.receipt?.error?.message && (
            <p>{entry.receipt.error.message}</p>
          )}
          <button
            disabled={!ready || busy}
            onClick={() =>
              act(() => operationJournal.query(troopClient, entry))
            }
          >
            查询原操作结果
          </button>
          {entry.redacted && entry.receipt?.state === "not_found" && (
            <p>凭据未保存在此记录中。请返回配置页面重新输入后提交。</p>
          )}
          {entry.receipt?.state === "not_found" && !entry.redacted && (
            <button
              disabled={!ready || busy}
              onClick={() =>
                act(() => operationJournal.resolve(troopClient, entry))
              }
            >
              按原操作重提
            </button>
          )}
          {entry.receipt?.execution_ref && (
            <button onClick={() => onOpenRun(entry.receipt.execution_ref)}>
              查看关联任务
            </button>
          )}
          {onOpenResource && resourcePage(entry.request.method) && (
            <button
              onClick={() => onOpenResource(resourcePage(entry.request.method))}
            >
              查看资源当前状态
            </button>
          )}
          {[
            "committed",
            "rejected",
            "needs_reconciliation",
            "dismissed",
          ].includes(entry.receipt?.state) && (
            <button
              disabled={busy}
              onClick={() => act(() => operationJournal.acknowledge(entry))}
            >
              已知晓，关闭记录
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
