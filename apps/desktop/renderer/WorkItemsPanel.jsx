import React, { useEffect, useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { actionFor } from "./client/actions.mjs";
import WorkItemExecution, { workStates } from "./WorkItemExecution";

export default function WorkItemsPanel({ ready, workspaces, onOpenRun }) {
  const draftKey = `troop-work-item-draft:${clientModels.instance}`;
  const empty = () => ({
    id: null,
    expected_revision: 0,
    item: {
      title: "",
      goal: "",
      acceptance: "",
      owner_agent_id: 1,
      workspace_id: workspaces[0]?.id ?? 0,
      project_id: null,
      dependency_ids: [],
    },
  });
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? "null");
      if (
        saved?.item &&
        ["title", "goal", "acceptance"].every(
          (key) => typeof saved.item[key] === "string",
        ) &&
        Number.isSafeInteger(saved.item.owner_agent_id) &&
        Number.isSafeInteger(saved.item.workspace_id) &&
        Number.isSafeInteger(saved.expected_revision)
      )
        return saved;
    } catch {}
    return empty();
  });
  const [dirty, setDirty] = useState(() => {
    try {
      return Boolean(sessionStorage.getItem(draftKey));
    } catch {
      return false;
    }
  });
  const [owner, setOwner] = useState("");
  const [project, setProject] = useState("");
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const listModel = clientModels.resource("work_items.list", {
    ...(owner ? { owner_agent_id: Number(owner) } : {}),
    ...(project ? { project_id: project } : {}),
    archived,
  });
  const list = useClientModel(listModel, ready);
  const agents = useClientModel(clientModels.agents(), ready);
  const projects = useClientModel(
    clientModels.resource("memory.projects", {
      agent_id: draft.item.owner_agent_id,
    }),
    ready,
  );
  const detailModel = draft.id
    ? clientModels.resource("work_items.get", { id: draft.id })
    : null;
  const detail = useClientModel(detailModel, ready);
  const stale = Boolean(
    draft.id && detail.data && detail.data.revision !== draft.expected_revision,
  );
  const saveAction = draft.id
    ? actionFor(detail.data, "save")
    : { allowed: true, reason: null };
  const archiveAction = actionFor(
    detail.data,
    detail.data?.archived ? "restore" : "archive",
  );
  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify(draft));
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, draft, dirty]);
  function edit(item) {
    const {
      id,
      revision,
      title,
      goal,
      acceptance,
      owner_agent_id,
      workspace_id,
      project_id,
      dependency_ids,
    } = item;
    setDraft({
      id,
      expected_revision: revision,
      dependencies_text: (dependency_ids ?? []).join(","),
      item: {
        title,
        goal,
        acceptance,
        owner_agent_id,
        workspace_id,
        project_id: project_id ?? null,
        dependency_ids: dependency_ids ?? [],
      },
    });
    setDirty(false);
    setError("");
    setNotice("");
  }
  function change(key, value) {
    setDraft((previous) => ({
      ...previous,
      item: { ...previous.item, [key]: value },
    }));
    setDirty(true);
    setNotice("");
  }
  async function act(action) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      edit(await action());
      setNotice("工作项已保存。");
    } catch (error) {
      setError(error.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const projectChoices = projects.data ?? [];
  return (
    <div className="models-page work-board">
      <div className="title-row">
        <h1>共享任务看板</h1>
        <button
          id="work-item-new"
          disabled={!ready || busy}
          onClick={() => {
            setDraft(empty());
            setDirty(false);
            setError("");
            setNotice("");
          }}
        >
          新建工作项
        </button>
      </div>
      <p className="muted">按项目和负责 Agent 查看工作，保存目标与验收条件。</p>
      <div className="work-board-filters" aria-label="工作项筛选">
        <label>
          负责 Agent
          <select
            id="work-filter-owner"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
          >
            <option value="">全部 Agent</option>
            {agents.data?.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          项目
          <select
            id="work-filter-project"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">全部项目</option>
            {projectChoices.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          记录
          <select
            id="work-filter-archive"
            value={String(archived)}
            onChange={(event) => setArchived(event.target.value === "true")}
          >
            <option value="false">当前工作</option>
            <option value="true">已归档</option>
          </select>
        </label>
      </div>
      {(error || list.error || detail.error) && (
        <p role="alert">
          {error || list.error?.message || detail.error?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="work-board-layout">
        <section aria-label="工作项列表">
          <h2>{archived ? "已归档工作" : "当前工作"}</h2>
          {list.loading && !list.data && <p role="status">正在读取工作项…</p>}
          {list.data?.items.length === 0 && (
            <p className="muted">暂无符合筛选条件的工作项。</p>
          )}
          <ul className="work-item-list">
            {list.data?.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={draft.id === item.id}
                  onClick={() => edit(item)}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {agents.data?.find(
                      (agent) => agent.id === item.owner_agent_id,
                    )?.name ?? `Agent ${item.owner_agent_id}`}{" "}
                    · {item.project_id ?? "未指定项目"}
                  </span>
                  <span>{item.goal}</span>
                  <span>
                    {workStates[item.progress.state] ?? item.progress.state}
                  </span>
                  <span className="muted">
                    工作项 #{item.id} · 修订 {item.revision}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {list.data?.next_before && (
            <button disabled={list.loading} onClick={() => listModel.more()}>
              加载更多工作项
            </button>
          )}
        </section>
        <section aria-label="工作项详情">
          <h2>{draft.id ? `工作项 #${draft.id}` : "新建工作项"}</h2>
          {stale && (
            <p role="status">
              工作项已有新修订。当前草稿保留，请载入最新记录后核对。
            </p>
          )}
          {draft.id && (
            <button
              id="work-item-refresh"
              disabled={!ready || busy || !detail.data}
              onClick={() => edit(detail.data)}
            >
              载入最新记录
            </button>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(() =>
                clientModels.command("work_items.save", {
                  ...(draft.id ? { id: draft.id } : {}),
                  expected_revision: draft.expected_revision,
                  item: {
                    ...draft.item,
                    dependency_ids: (
                      draft.dependencies_text ??
                      draft.item.dependency_ids?.join(",") ??
                      ""
                    )
                      .split(",")
                      .filter((value) => value.trim())
                      .map((value) => Number(value.trim())),
                  },
                }),
              );
            }}
          >
            <fieldset
              disabled={!ready || busy || Boolean(detail.data?.archived)}
            >
              <label htmlFor="work-item-title">标题</label>
              <input
                id="work-item-title"
                value={draft.item.title}
                required
                maxLength={120}
                onChange={(event) => change("title", event.target.value)}
              />
              <label htmlFor="work-item-goal">目标</label>
              <textarea
                id="work-item-goal"
                value={draft.item.goal}
                required
                maxLength={4000}
                onChange={(event) => change("goal", event.target.value)}
              />
              <label htmlFor="work-item-acceptance">验收条件</label>
              <textarea
                id="work-item-acceptance"
                value={draft.item.acceptance}
                required
                maxLength={4000}
                onChange={(event) => change("acceptance", event.target.value)}
              />
              <label htmlFor="work-item-owner">负责 Agent</label>
              <select
                id="work-item-owner"
                value={draft.item.owner_agent_id}
                onChange={(event) =>
                  change("owner_agent_id", Number(event.target.value))
                }
              >
                {agents.data?.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <label htmlFor="work-item-workspace">工作目录</label>
              <select
                id="work-item-workspace"
                required
                value={draft.item.workspace_id}
                onChange={(event) =>
                  change("workspace_id", Number(event.target.value))
                }
              >
                <option value="0" disabled>
                  请选择工作目录
                </option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
              <p id="work-item-workspace-path" className="muted">
                {workspaces.find(
                  (workspace) => workspace.id === draft.item.workspace_id,
                )?.path ?? "尚未选择可用工作目录"}
              </p>
              <label htmlFor="work-item-project">项目，可选</label>
              <select
                id="work-item-project"
                value={draft.item.project_id ?? ""}
                onChange={(event) =>
                  change("project_id", event.target.value || null)
                }
              >
                <option value="">未指定项目</option>
                {projectChoices.map((item) => (
                  <option
                    key={item.slug}
                    value={item.slug}
                    disabled={!item.joined}
                  >
                    {item.name}
                    {item.joined ? "" : "（负责 Agent 尚未加入）"}
                  </option>
                ))}
              </select>
              <label htmlFor="work-item-dependencies">
                前置工作项 ID，逗号分隔
              </label>
              <input
                id="work-item-dependencies"
                value={
                  draft.dependencies_text ??
                  draft.item.dependency_ids?.join(",") ??
                  ""
                }
                onChange={(event) => {
                  setDraft((previous) => ({
                    ...previous,
                    dependencies_text: event.target.value,
                  }));
                  setDirty(true);
                }}
              />
              <button
                id="work-item-save"
                type="submit"
                disabled={
                  !dirty ||
                  stale ||
                  !saveAction.allowed ||
                  draft.item.workspace_id <= 0
                }
                title={saveAction.reason ?? undefined}
              >
                保存工作项
              </button>
            </fieldset>
          </form>
          {draft.id && (
            <button
              id="work-item-archive"
              disabled={!ready || busy || stale || !archiveAction.allowed}
              title={archiveAction.reason ?? undefined}
              onClick={() =>
                void act(() =>
                  clientModels.command("work_items.archive", {
                    id: draft.id,
                    expected_revision: draft.expected_revision,
                    archived: !detail.data.archived,
                  }),
                )
              }
            >
              {detail.data?.archived ? "恢复工作项" : "归档工作项"}
            </button>
          )}
          {draft.id && detail.data && (
            <WorkItemExecution
              key={draft.id}
              item={detail.data}
              ready={ready}
              busy={busy}
              dirty={dirty || stale}
              act={act}
              onOpenRun={onOpenRun}
            />
          )}
        </section>
      </div>
    </div>
  );
}
