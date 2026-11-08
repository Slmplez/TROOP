import MaintenanceSettings from "./MaintenanceSettings";
import MemoryHistory from "./MemoryHistory";
import MemoryConflicts from "./MemoryConflicts";
import { resources } from "./client/resources";
import React, { useEffect, useRef, useState } from "react";
import { call } from "./api";
import { clientModels, useClientModel } from "./client/react";
const states = {
  queued: "等待维护",
  waiting_configuration: "等待维护模型配置",
  running: "正在提取",
  validating: "正在验证提案",
  waiting_review: "遗忘核对待判定",
  completed: "已完成",
  failed: "维护失败",
  interrupted: "已中断",
  cancelled: "已停止",
};
const kinds = {
  extraction: "自动提取",
  episode: "阶段记录",
  synthesis: "高级合成",
  guard: "写入遗忘核对",
};
export default function MemoryPanel({ ready, generation }) {
  const [historyId, setHistoryId] = useState(null);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [agents, setAgents] = useState([]),
    [agent, setAgent] = useState(1),
    [projects, setProjects] = useState([]),
    [records, setRecords] = useState([]),
    [jobs, setJobs] = useState([]),
    [page, setPage] = useState({ total: 0, next_offset: null }),
    [offset, setOffset] = useState(0);
  const [name, setName] = useState(""),
    [automatic, setAutomatic] = useState(true),
    [dreaming, setDreaming] = useState(false),
    [newName, setNewName] = useState(""),
    [project, setProject] = useState(""),
    [scope, setScope] = useState("agent"),
    [tier, setTier] = useState("profile"),
    [content, setContent] = useState(""),
    [editing, setEditing] = useState(null),
    [slug, setSlug] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [detailId, setDetailId] = useState(null);
  const actionLock = useRef(false);
  useEffect(() => setHistoryId(null), [agent, generation]);
  const current = useRef({ agent, generation, offset, includeDeleted });
  current.current = { agent, generation, offset, includeDeleted };
  const selected = agents.find((a) => a.id === agent);
  useEffect(() => {
    setName(selected?.name ?? "");
    setAutomatic(selected?.automatic ?? true);
    setDreaming(selected?.dreaming ?? false);
  }, [agent, selected?.revision]);
  async function refresh(all = false) {
    const expected = { ...current.current };
    const valid = () =>
      expected.agent === current.current.agent &&
      expected.offset === current.current.offset &&
      expected.includeDeleted === current.current.includeDeleted &&
      expected.generation === current.current.generation;
    const [list, members, history] = await Promise.all([
      call(
        resources.listMemories(
          expected.agent,
          expected.offset,
          expected.includeDeleted,
        ),
      ),
      call(resources.listMemoryProjects(expected.agent)),
      call(resources.listMemoryJobs(expected.agent)),
    ]);
    if (valid()) {
      setRecords(list.items);
      setPage(list);
      setProjects(members);
      setJobs(history);
    }
    if (all) {
      const a = await call(resources.listMemoryAgents());
      if (valid()) setAgents(a);
    }
  }
  useEffect(() => {
    if (!ready) return;
    let stopped = false,
      loading = false;
    const run = async () => {
      if (loading) return;
      loading = true;
      try {
        await refresh(true);
      } catch (e) {
        if (!stopped) setError(e.message);
      } finally {
        loading = false;
      }
    };
    run();
    const timer = setInterval(() => {
      if (!loading) {
        loading = true;
        refresh()
          .catch((e) => !stopped && setError(e.message))
          .finally(() => {
            loading = false;
          });
      }
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [ready, generation, agent, offset, includeDeleted]);
  async function act(fn) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh(true);
    } catch (e) {
      setError(e.message);
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  function choose(value) {
    setAgent(Number(value));
    setRecords([]);
    setProjects([]);
    setJobs([]);
    setProject("");
    setPage({ total: 0, next_offset: null });
    setOffset(0);
    setEditing(null);
    setContent("");
    setDetailId(null);
    setError("");
  }
  return (
    <section className="memory-page" data-ui="settings">
      <div className="title-row">
        <div>
          <h1>记忆</h1>
          <p>按 Agent 管理长期事实与共享范围；原始任务历史独立保留。</p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        当前 Agent
        <select
          id="memory-agent"
          value={agent}
          disabled={!ready || busy}
          onChange={(e) => choose(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <MaintenanceSettings
        agentId={agent}
        ready={ready}
        generation={generation}
      />
      <details className="memory-settings">
        <summary>Agent 设置与项目成员关系</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(() =>
              call(
                resources.saveMemoryAgent({
                  id: agent,
                  name,
                  automatic,
                  dreaming,
                  expected_revision: selected.revision,
                }),
              ),
            );
          }}
        >
          <label>
            名称
            <input
              id="memory-agent-name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="check-row">
            <input
              id="memory-automatic"
              type="checkbox"
              checked={automatic}
              onChange={(e) => setAutomatic(e.target.checked)}
            />
            自动维护长期记忆
          </label>
          <p className="muted">
            合适的任务完成后，使用已授权的独立维护模型提取记忆。请同时配置维护模型服务；维护失败保留任务结果。
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={dreaming}
              onChange={(e) => setDreaming(e.target.checked)}
            />
            高级合成：根据证据提出修改，并验证后再应用
          </label>
          <button
            id="memory-save-agent"
            disabled={!ready || busy || !selected || !name.trim()}
          >
            保存设置
          </button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const a = await call(
                resources.saveMemoryAgent({
                  name: newName,
                  automatic: true,
                  dreaming: false,
                  expected_revision: 0,
                }),
              );
              setNewName("");
              choose(a.id);
            });
          }}
        >
          <label>
            新建 Agent
            <input
              value={newName}
              maxLength={120}
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <button disabled={!ready || busy || !newName.trim()}>
            创建 Agent
          </button>
        </form>
        <h2>项目成员关系</h2>
        {projects.length ? (
          <ul className="memory-projects">
            {projects.map((p) => (
              <li key={p.slug}>
                <span>
                  {p.name} · {p.joined ? "已加入" : "尚未加入"}
                </span>
                <button
                  disabled={!ready || busy}
                  onClick={() =>
                    act(() =>
                      call(
                        resources.changeMemoryMembership({
                          agent_id: agent,
                          project: p.slug,
                          action: p.joined ? "leave" : "join",
                        }),
                      ),
                    )
                  }
                >
                  {p.joined ? "离开项目" : "加入项目"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">尚未创建项目。</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              await call(
                resources.changeMemoryMembership({
                  agent_id: agent,
                  project: slug,
                  action: "create",
                }),
              );
              setSlug("");
            });
          }}
        >
          <label>
            项目标识
            <input
              value={slug}
              maxLength={80}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="例如 troop-core"
            />
          </label>
          <button disabled={!ready || busy || !slug.trim()}>创建并加入</button>
        </form>
      </details>
      <h2>{editing ? "编辑已保存的事实" : "保存一条事实"}</h2>
      <form
        className="memory-compose"
        onSubmit={(e) => {
          e.preventDefault();
          act(async () => {
            if (editing)
              await call(
                resources.editMemory({
                  agent_id: agent,
                  id: editing.id,
                  expected_revision: editing.revision,
                  content,
                }),
              );
            else
              await call(
                resources.writeMemory({
                  agent_id: agent,
                  scope,
                  project: scope === "project" ? project : "",
                  tier,
                  content,
                }),
              );
            setEditing(null);
            setContent("");
          });
        }}
      >
        {!editing && (
          <div className="memory-fields">
            <label>
              作用域
              <select
                id="memory-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="agent">Agent 私有</option>
                <option value="user">用户共享</option>
                <option value="project">项目共享</option>
              </select>
            </label>
            <label>
              类别
              <select value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="profile">长期偏好与事实</option>
                <option value="log">有日期的记录</option>
                <option value="note">轻量笔记</option>
              </select>
            </label>
            {scope === "project" && (
              <label>
                项目
                <select
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">选择已加入的项目</option>
                  {projects
                    .filter((p) => p.joined)
                    .map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
        )}
        <label>
          内容
          <textarea
            id="memory-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={500}
            rows={3}
          />
        </label>
        <button
          id="memory-save"
          disabled={
            !ready ||
            busy ||
            !content.trim() ||
            (!editing && scope === "project" && !project)
          }
        >
          保存事实
        </button>
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setContent("");
            }}
          >
            取消编辑
          </button>
        )}
      </form>
      <h2>可见记忆 · {page.total} 条</h2>
      <label>
        <input
          id="memory-include-deleted"
          type="checkbox"
          checked={includeDeleted}
          onChange={(event) => {
            setIncludeDeleted(event.target.checked);
            setOffset(0);
          }}
        />
        包含已遗忘记录
      </label>
      <p className="muted">
        用户与项目共享记忆保留写入 Agent
        的来源。遗忘影响后续检索，不删除已有任务历史或备份。
      </p>
      {records.length ? (
        <ul className="memory-records">
          {records.map((r) => (
            <li key={r.id} data-memory-id={r.id}>
              <div>
                <p className="agent-text">
                  {r.deleted ? "已遗忘 · " : ""}
                  {r.content}
                </p>
                <span className="muted">
                  {
                    { agent: "私有", user: "用户共享", project: "项目共享" }[
                      r.scope
                    ]
                  }
                  {r.project ? " / " + r.project : ""} · {r.agent_name} ·{" "}
                  {r.kind === "profile" ? "长期事实" : "月度记录"} ·{" "}
                  {r.created_at.slice(0, 10)} ·{" "}
                  {r.source?.kind === "conflict_candidate"
                    ? "待核对候选"
                    : r.origin === "explicit"
                      ? "显式保存"
                      : "自动维护"}
                </span>
              </div>
              <div className="memory-actions">
                <button
                  disabled={!ready || busy || r.deleted}
                  onClick={() => {
                    setEditing(r);
                    setContent(r.content);
                  }}
                >
                  编辑
                </button>
                <button
                  disabled={!ready || busy || r.deleted}
                  onClick={() =>
                    act(() =>
                      call(
                        resources.editMemory({
                          agent_id: agent,
                          id: r.id,
                          expected_revision: r.revision,
                          content: null,
                        }),
                      ),
                    )
                  }
                >
                  遗忘
                </button>
                <button
                  disabled={!ready || busy}
                  onClick={() => setHistoryId(r.id)}
                >
                  查看历史
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">当前 Agent 尚无可见记忆。</p>
      )}
      <div className="memory-actions">
        {offset > 0 && (
          <button
            disabled={busy}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页
          </button>
        )}
        {page.next_offset !== null && (
          <button disabled={busy} onClick={() => setOffset(page.next_offset)}>
            下一页
          </button>
        )}
      </div>
      {historyId && (
        <MemoryHistory
          key={`${agent}:${historyId}`}
          agent={agent}
          id={historyId}
          onClose={() => setHistoryId(null)}
        />
      )}
      <MemoryConflicts key={agent} agent={agent} ready={ready} />
      <h2>自动维护记录</h2>
      {jobs.length ? (
        <ul className="memory-jobs">
          {jobs.map((j) => (
            <li key={j.id}>
              <div>
                <strong>
                  {kinds[j.kind] ?? j.kind} · {states[j.state] ?? j.state}
                </strong>
                <span className="muted">
                  任务 #{j.source_run_id} · 尝试 {j.attempt} · 模型请求{" "}
                  {j.model_requests ?? 0} 次 ·{" "}
                  {j.created_at.slice(0, 16).replace("T", " ")} UTC
                </span>
                {j.error && <p className="message-problem">{j.error}</p>}
              </div>
              <div className="memory-actions">
                <button onClick={() => setDetailId(j.id)}>查看提案</button>
                {[
                  "queued",
                  "waiting_configuration",
                  "running",
                  "validating",
                  "waiting_review",
                ].includes(j.state) && (
                  <button
                    onClick={() =>
                      act(() => call(resources.cancelMemoryJob(j.id)))
                    }
                  >
                    停止维护
                  </button>
                )}
                {[
                  "failed",
                  "interrupted",
                  "cancelled",
                  "waiting_review",
                ].includes(j.state) && (
                  <button
                    onClick={() =>
                      act(() => call(resources.retryMemoryJob(j.id)))
                    }
                  >
                    手动重试
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">暂无维护记录；普通寒暄不触发提取。</p>
      )}
      {detailId !== null && (
        <MemoryJobDetail
          key={`${agent}-${detailId}`}
          id={detailId}
          ready={ready}
        />
      )}
    </section>
  );
}

function MemoryJobDetail({ id, ready }) {
  const state = useClientModel(
    clientModels.resource("memory.job", { id }),
    ready,
  );
  const detail = state.error ? null : state.data;
  return (
    <details open className="memory-job-detail">
      <summary>维护 #{id}</summary>
      {state.error && <p role="alert">{state.error.message}</p>}
      {!detail && !state.error && <p role="status">读取维护提案…</p>}
      {detail?.state === "waiting_review" && (
        <p>
          提案已保留。需要恢复旧知识时，可在已遗忘记忆的历史中明确恢复。确认是新事实时，可通过上方表单保存，然后停止本作业。
        </p>
      )}
      {detail && <pre>{JSON.stringify(detail, null, 2)}</pre>}
    </details>
  );
}
