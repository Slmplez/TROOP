import React, { useEffect, useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";

export default function MaintenanceSettings({ agentId, ready, generation }) {
  const settings = useClientModel(
    clientModels.resource("memory.maintenance.get", { agent_id: agentId }),
  );
  const providers = useClientModel(clientModels.resource("provider.list", {}));
  const projects = useClientModel(
    clientModels.resource("memory.projects", { agent_id: agentId }),
  );
  const [provider, setProvider] = useState(""),
    [targetScope, setTargetScope] = useState("agent"),
    [targetProject, setTargetProject] = useState(""),
    [model, setModel] = useState(""),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    current = useRef({ agentId, generation });
  current.current = { agentId, generation };
  useEffect(() => {
    setProvider(settings.data?.provider_id ?? "");
    setModel(settings.data?.model ?? "");
    setEnabled(settings.data?.enabled ?? false);
    setTargetScope(settings.data?.target_scope ?? "agent");
    setTargetProject(settings.data?.target_project ?? "");
    setError("");
  }, [agentId, generation, settings.data?.revision]);
  async function save(event) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const identity = current.current;
    try {
      await clientModels.command("memory.maintenance.save", {
        agent_id: agentId,
        expected_revision: settings.data.revision,
        enabled,
        provider_id: provider || null,
        model: model || null,
        target_scope: targetScope,
        target_project: targetScope === "project" ? targetProject : "",
      });
      clientModels.invalidate();
    } catch (e) {
      if (
        identity.agentId === current.current.agentId &&
        identity.generation === current.current.generation
      )
        setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <details className="memory-settings">
      <summary>独立记忆维护模型</summary>
      <p>
        授权所选服务处理目标范围的记忆与来源任务证据。项目维护同时受来源任务范围和当前成员资格约束。提取与验证共用冻结模型，关闭或更换范围会停止旧作业。
      </p>
      {(error || settings.error || providers.error) && (
        <p role="alert" className="error">
          {error || settings.error?.message || providers.error?.message}
        </p>
      )}
      <form onSubmit={save}>
        <fieldset disabled={!ready || busy || !settings.data}>
          <label htmlFor="maintenance-provider">维护模型服务</label>
          <select
            id="maintenance-provider"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel(
                providers.data?.find((p) => p.id === e.target.value)?.config
                  .model ?? "",
              );
            }}
          >
            <option value="">请选择服务</option>
            {providers.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.config.name}
              </option>
            ))}
          </select>
          <label htmlFor="maintenance-model">维护模型 ID</label>
          <input
            id="maintenance-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            maxLength={200}
          />
          <label htmlFor="maintenance-scope">维护范围</label>
          <select
            id="maintenance-scope"
            value={targetScope}
            onChange={(event) => setTargetScope(event.target.value)}
          >
            <option value="agent">Agent 私有</option>
            <option value="user">用户共享</option>
            <option value="project">指定项目共享</option>
          </select>
          {targetScope === "project" && (
            <>
              <label htmlFor="maintenance-project">目标项目</label>
              <select
                id="maintenance-project"
                value={targetProject}
                onChange={(event) => setTargetProject(event.target.value)}
              >
                <option value="">请选择已加入的项目</option>
                {projects.data
                  ?.filter((project) => project.joined)
                  .map((project) => (
                    <option key={project.slug} value={project.slug}>
                      {project.name}
                    </option>
                  ))}
              </select>
              {projects.error && <p role="alert">{projects.error.message}</p>}
            </>
          )}
          <label className="check-row">
            <input
              id="maintenance-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            授权独立模型维护
          </label>
          <p className="muted">
            当前配置修订 {settings.data?.revision ?? 0} ·{" "}
            {settings.data?.destination ?? "尚未授权目的地"}
          </p>
          <button
            id="maintenance-save"
            disabled={
              enabled &&
              (!provider ||
                !model.trim() ||
                (targetScope === "project" && !targetProject))
            }
          >
            保存维护模型
          </button>
        </fieldset>
      </form>
    </details>
  );
}
