import React, { useEffect, useRef, useState } from "react";
import { call } from "./api";

const sourceStates = {
  snapshot: "已保存副本",
  ready: "来源一致",
  changed: "来源已变化",
  unavailable: "来源不可用",
};
export default function SkillsPanel({
  ready,
  generation,
  providers,
  workspaces,
  onRun,
}) {
  const [agents, setAgents] = useState([]),
    [agent, setAgent] = useState(1);
  const [rows, setRows] = useState([]),
    [offset, setOffset] = useState(0),
    [paging, setPaging] = useState({ total: 0 });
  const [path, setPath] = useState(""),
    [mode, setMode] = useState("copy"),
    [kind, setKind] = useState("local"),
    [id, setId] = useState("");
  const [preview, setPreview] = useState(null),
    [confirmed, setConfirmed] = useState(false);
  const [detail, setDetail] = useState(null),
    [raw, setRaw] = useState(""),
    [versions, setVersions] = useState(null),
    [removing, setRemoving] = useState(null);
  const [provider, setProvider] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  const current = useRef({});
  current.current = { agent, generation, offset };
  const sending = useRef(false),
    pending = useRef(null);
  const previousPages = useRef([]);
  async function refresh() {
    const expected = { ...current.current };
    const [list, profiles] = await Promise.all([
      call(
        window.troop.skillList({
          agent_id: expected.agent,
          offset: expected.offset,
        }),
      ),
      call(window.troop.listMemoryAgents()),
    ]);
    if (Object.keys(expected).some((k) => expected[k] !== current.current[k]))
      return;
    setRows(list.items);
    setPaging(list);
    setAgents(profiles);
    setLoaded(true);
  }
  useEffect(() => {
    if (!ready) return;
    let ended = false;
    refresh().catch((e) => !ended && setError(e.message));
    return () => {
      ended = true;
    };
  }, [ready, generation, agent, offset]);
  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
  }, [path, mode, kind, id, generation]);
  async function act(fn) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function open(skill) {
    const expected = { ...current.current };
    const doc = await call(window.troop.skillGet({ id: skill.id }));
    let text = doc.content.text;
    while (doc.content.next_offset !== null && text.length <= 48000) {
      const next = await call(
        window.troop.skillGet({
          id: skill.id,
          version_id: doc.version_id,
          offset: doc.content.next_offset,
        }),
      );
      text += next.content.text;
      doc.content.next_offset = next.content.next_offset;
    }
    if (Object.keys(expected).some((k) => expected[k] !== current.current[k]))
      return;
    setDetail({ ...doc, readOnly: doc.content.bytes > 48000 });
    setRaw(text);
    setVersions(null);
    setRemoving(null);
  }
  function run(skill) {
    act(async () => {
      const input = {
        agent_id: agent,
        provider_id: provider,
        workspace_id: Number(workspace),
        workflow_id: skill.id,
        goal: goal.trim() || "@" + skill.id,
      };
      const signature = JSON.stringify(input);
      if (pending.current?.signature !== signature)
        pending.current = { signature, id: crypto.randomUUID() };
      const result = await call(
        window.troop.startRun({ ...input, client_run_id: pending.current.id }),
      );
      pending.current = null;
      onRun(result.run.id);
    });
  }
  return (
    <section className="skills-page" data-ui="settings">
      <div className="title-row">
        <div>
          <h1>技能与工作流</h1>
          <p>共用一份本地资料库，按 Agent 启用；每次任务保存使用的版本。</p>
        </div>
        <div className="memory-actions">
          <button
            id="skill-new"
            disabled={!ready || busy}
            onClick={() => {
              setDetail({ id: "", revision: 0, name: "新技能", isNew: true });
              setRaw("---\nname: \n---\n");
              setVersions(null);
              setRemoving(null);
            }}
          >
            新建技能
          </button>
          <button disabled={!ready || busy} onClick={() => act(refresh)}>
            刷新资料库
          </button>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="skill-scope">
        <label>
          Agent
          <select
            id="skill-agent"
            value={agent}
            disabled={!ready || busy}
            onChange={(e) => {
              setAgent(Number(e.target.value));
              previousPages.current = [];
              setOffset(0);
              setRows([]);
              setLoaded(false);
              setDetail(null);
              setRemoving(null);
            }}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          新导入技能默认对所有 Agent
          启用。关闭后，后续发现和加载立即受限；已进入任务历史的文字保留。
        </p>
      </div>
      <details className="skill-import" open={!loaded || paging.total === 0}>
        <summary>导入本地技能</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(async () =>
              setPreview(
                await call(
                  window.troop.skillPreview({
                    path,
                    mode,
                    source_kind: kind,
                    id,
                  }),
                ),
              ),
            );
          }}
        >
          <label>
            来源文件或技能目录
            <input
              id="skill-path"
              value={path}
              disabled={!ready || busy}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() =>
              act(async () => {
                const selected = await call(window.troop.chooseSkill());
                if (selected) setPath(selected);
              })
            }
          >
            选择目录
          </button>
          <div className="memory-fields">
            <label>
              保存方式
              <select
                id="skill-mode"
                value={mode}
                disabled={busy}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="copy">导入副本</option>
                <option value="live">Live source · 新任务读取最新内容</option>
              </select>
            </label>
            <label>
              原始来源
              <select
                id="skill-kind"
                value={kind}
                disabled={busy}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="local">本地文件</option>
                <option value="managed">已有托管技能</option>
                <option value="plugin">已有插件技能</option>
              </select>
            </label>
            <label>
              技能 ID（留空自动生成）
              <input
                id="skill-import-id"
                value={id}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setId(e.target.value)}
              />
            </label>
          </div>
          <p className="muted">
            副本保存指令和辅助文件。Live source
            仅关联明确选定的本机来源；不移动、回写或执行来源文件。
          </p>
          <button
            id="skill-preview"
            type="submit"
            disabled={!ready || busy || !path.trim()}
          >
            预览导入
          </button>
        </form>
        {preview && (
          <div className="skill-preview" aria-live="polite">
            <h2>{preview.skill.name}</h2>
            <p>
              <code>{preview.id}</code> · {preview.files.length} 个文件 ·{" "}
              {preview.skill.automation
                ? "自动化定义（暂不调度）"
                : "技能 / 工作流"}
            </p>
            <p className="muted">{preview.skill.source_path}</p>
            <details>
              <summary>文件与内容指纹</summary>
              <ul>
                {preview.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code> · {f.bytes.toLocaleString()} 字节 ·{" "}
                    <code>{f.sha256}</code>
                  </li>
                ))}
              </ul>
            </details>
            {preview.existing && (
              <label className="check-row">
                <input
                  id="skill-conflict-confirm"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {preview.id} 已存在，确认保存为新版本并保留旧版本
                {preview.existing.locally_modified
                  ? "（现有版本含本地编辑）"
                  : ""}
              </label>
            )}
            <button
              id="skill-import-confirm"
              disabled={busy || !ready || (!!preview.existing && !confirmed)}
              onClick={() =>
                act(async () => {
                  await call(
                    window.troop.skillImport({
                      source: { path, mode, source_kind: kind, id },
                      preview_hash: preview.preview_hash,
                      expected_revision: preview.expected_revision,
                    }),
                  );
                  setPreview(null);
                  setConfirmed(false);
                  setOffset(0);
                })
              }
            >
              确认导入{preview.existing ? "新版本" : ""}
            </button>
          </div>
        )}
      </details>
      <details className="skill-run-options">
        <summary>Run Now · 本次运行配置</summary>
        <div className="memory-fields">
          <label>
            模型服务
            <select
              id="skill-provider"
              value={provider}
              disabled={busy}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="">选择模型服务</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.config.name} · {p.config.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            工作区
            <select
              id="skill-workspace"
              value={workspace}
              disabled={busy}
              onChange={(e) => setWorkspace(e.target.value)}
            >
              <option value="">选择工作区</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          本次补充目标（可选）
          <textarea
            id="skill-goal"
            value={goal}
            maxLength={12000}
            disabled={busy}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
        <p className="muted">
          先选择模型服务和工作区，再点击对应技能的 Run Now。也可在任务目标中输入
          @技能ID。
        </p>
      </details>
      <div className="skill-list-heading">
        <h2>本地资料库</h2>
        <span className="muted">{paging.total} 个技能</span>
      </div>
      {!loaded ? (
        <p className="muted" role="status">
          {ready ? "正在读取资料库…" : "等待核心连接"}
        </p>
      ) : rows.length === 0 ? (
        <p className="empty">
          尚未导入技能。选择一个包含 SKILL.md 的目录开始。
        </p>
      ) : (
        <ul className="skill-list">
          {rows.map((skill) => (
            <li key={skill.id} data-skill={skill.id}>
              <div>
                <button
                  className="quiet skill-name"
                  disabled={!ready || busy}
                  onClick={() => act(() => open(skill))}
                >
                  {skill.name}
                </button>
                <p>{skill.description || "未填写说明"}</p>
                <p className="muted">
                  <code>@{skill.id}</code> · v{skill.version_id} ·{" "}
                  {sourceStates[skill.source_status]}
                  {skill.automation ? " · 自动化，暂不调度" : ""}
                  {skill.disable_model_invocation ? " · 仅显式调用" : ""}
                </p>
                <p className="muted">{skill.source_path}</p>
              </div>
              <div className="skill-actions">
                <label className="check-row">
                  <input
                    type="checkbox"
                    aria-label={"为当前 Agent 启用 " + skill.name}
                    checked={skill.enabled}
                    disabled={!ready || busy}
                    onChange={(e) =>
                      act(() =>
                        call(
                          window.troop.skillEnable({
                            id: skill.id,
                            agent_id: agent,
                            enabled: e.target.checked,
                          }),
                        ),
                      )
                    }
                  />
                  启用
                </label>
                <button
                  className="quiet skill-run"
                  disabled={
                    !ready ||
                    busy ||
                    !skill.enabled ||
                    skill.automation ||
                    !provider ||
                    !workspace ||
                    skill.source_status === "unavailable"
                  }
                  onClick={() => run(skill)}
                >
                  Run Now
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(offset > 0 ||
        (paging.next_offset !== null && paging.next_offset !== undefined)) && (
        <div className="memory-actions">
          <button
            disabled={busy || offset === 0}
            onClick={() => setOffset(previousPages.current.pop() ?? 0)}
          >
            上一页
          </button>
          <span>
            {offset + 1}–{offset + rows.length} / {paging.total}
          </span>
          <button
            disabled={busy || paging.next_offset == null}
            onClick={() => {
              previousPages.current.push(offset);
              setOffset(paging.next_offset);
            }}
          >
            下一页
          </button>
        </div>
      )}
      {detail && (
        <section className="skill-editor">
          <div className="skill-list-heading">
            <h2>
              {detail.name} · v{detail.version_id}
            </h2>
            <button className="quiet" onClick={() => setDetail(null)}>
              关闭详情
            </button>
          </div>
          {detail.isNew && (
            <label>
              技能 ID
              <input
                id="skill-new-id"
                value={detail.id}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setDetail({ ...detail, id: e.target.value })}
              />
            </label>
          )}
          <p className="muted">
            编辑会保存新副本版本；来源文件与旧任务保持原样。
          </p>
          <label>
            SKILL.md
            <textarea
              id="skill-editor"
              value={raw}
              rows={14}
              readOnly={detail.readOnly}
              disabled={busy}
              onChange={(e) => setRaw(e.target.value)}
            />
          </label>
          {detail.readOnly && (
            <p className="muted">
              此文件超过 48KB 编辑限制。可查看摘录，修改后通过文件重新导入。
            </p>
          )}
          <div className="memory-actions">
            <button
              id="skill-save"
              disabled={
                !ready || busy || !detail.id || detail.readOnly || !raw.trim()
              }
              onClick={() =>
                act(async () => {
                  await call(
                    window.troop.skillEdit({
                      id: detail.id,
                      expected_revision: detail.revision,
                      raw,
                    }),
                  );
                  await open(detail);
                })
              }
            >
              {detail.isNew ? "创建技能" : "保存新版本"}
            </button>
            <button
              id="skill-versions"
              disabled={!ready || busy || detail.isNew}
              onClick={() =>
                act(async () =>
                  setVersions(
                    await call(window.troop.skillVersions({ id: detail.id })),
                  ),
                )
              }
            >
              历史版本
            </button>
            {detail.mode === "live" && (
              <button
                disabled={!ready || busy}
                onClick={() =>
                  act(async () => {
                    await call(window.troop.skillRefresh({ id: detail.id }));
                    await open(detail);
                  })
                }
              >
                读取来源更新
              </button>
            )}
            <button
              className="quiet"
              id="skill-delete"
              disabled={!ready || busy || detail.isNew}
              onClick={() => setRemoving(detail)}
            >
              删除技能
            </button>
          </div>
          {versions && (
            <div className="skill-versions">
              <ul>
                {versions.items.map((v) => (
                  <li key={v.version_id}>
                    v{v.version_id} · {v.created_at} · {v.mode} ·{" "}
                    <code>{v.digest.slice(0, 16)}</code>
                  </li>
                ))}
              </ul>
              {versions.next_offset != null && (
                <button
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      const next = await call(
                        window.troop.skillVersions({
                          id: detail.id,
                          offset: versions.next_offset,
                        }),
                      );
                      setVersions({
                        ...next,
                        items: [...versions.items, ...next.items],
                      });
                    })
                  }
                >
                  更多历史版本
                </button>
              )}
            </div>
          )}
          {removing && (
            <div className="skill-delete-confirm">
              <p>
                删除“{removing.name}”后，所有 Agent
                都不能再加载它；旧版本和任务历史保留。
              </p>
              <button
                id="skill-delete-confirm"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await call(
                      window.troop.skillRemove({
                        id: removing.id,
                        expected_revision: removing.revision,
                      }),
                    );
                    setRemoving(null);
                    setDetail(null);
                  })
                }
              >
                确认删除 {removing.name}
              </button>
              <button className="quiet" onClick={() => setRemoving(null)}>
                取消
              </button>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
