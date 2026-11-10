import { resources } from "./client/resources";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { call } from "./api";
import { clientModels } from "./client/react";
import ChatPanel from "./ChatPanel";
import OfficePanel from "./OfficePanel";
import ModelSettings from "./ModelSettings";
import AgentPanel from "./AgentPanel";
import OperationRecovery from "./OperationRecovery";
import MemoryPanel from "./MemoryPanel";
import SkillsPanel from "./SkillsPanel";
import HooksPanel from "./HooksPanel";
import McpPanel from "./McpPanel";
import AuthorizationsPanel from "./AuthorizationsPanel";
import RulesPanel from "./RulesPanel";
import WorkItemsPanel from "./WorkItemsPanel";
import GroupChatPanel from "./GroupChatPanel";
import EventSourcesPanel from "./EventSourcesPanel";
import { version } from "../package.json";

const labels = {
  starting: "正在连接",
  ready: "已连接",
  faulted: "连接中断",
  stopping: "正在退出",
  stopped: "未连接",
};
function App() {
  const [page, setPage] = useState("chat");
  const [openRun, setOpenRun] = useState(null);
  const [openAutomation, setOpenAutomation] = useState(null);
  const [officeReference, setOfficeReference] = useState(null);
  const [providers, setProviders] = useState([]);
  const [status, setStatus] = useState({ state: "starting" });
  const [rows, setRows] = useState([]);
  const [pageInfo, setPageInfo] = useState({ total: 0, next_offset: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState("");
  const generation = useRef(null);
  const statusRevision = useRef(-1);
  const ready = status.state === "ready";
  async function refreshProviders() {
    const expected = generation.current;
    const list = await call(resources.listProviders());
    if (generation.current === expected) setProviders(list);
  }
  function applyPage(value, append = false) {
    setRows((old) => (append ? [...old, ...value.items] : value.items));
    setPageInfo({ total: value.total, next_offset: value.next_offset });
  }
  async function refresh() {
    const current = generation.current;
    setLoading(true);
    try {
      const value = await call(resources.listWorkspaces());
      if (generation.current === current) {
        applyPage(value);
        setError("");
      }
    } catch (e) {
      if (generation.current === current) setError(e.message);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }
  useEffect(() => {
    const accept = (value) => {
      if (
        !Number.isSafeInteger(value.revision) ||
        value.revision < statusRevision.current
      )
        return;
      statusRevision.current = value.revision;
      generation.current = value.generation;
      clientModels.connect(value);
      setStatus(value);
      if (value.state === "ready") {
        refresh();
        refreshProviders().catch((e) => setError(e.message));
      } else {
        setLoading(false);
        if (value.error) setError(value.error);
      }
    };
    const unsubscribe = resources.onStatus(accept);
    call(resources.status())
      .then(accept)
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
    return unsubscribe;
  }, []);
  async function action(fn) {
    setBusy(true);
    setError("");
    try {
      const value = await fn();
      if (value && Array.isArray(value.items)) applyPage(value);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const add = () => action(() => call(resources.chooseWorkspace()));
  const rename = (event) => {
    event.preventDefault();
    action(async () => {
      const result = await call(resources.renameWorkspace(editing, name));
      setEditing(null);
      return result;
    });
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <svg viewBox="0 0 28 28" aria-hidden="true">
            <path d="M4 6h20M14 6v18M6 12h16" />
          </svg>
          <span>TROOP</span>
        </div>
        <div className="scope">本机工作空间</div>
        <nav aria-label="主导航">
          <button
            disabled={!status.capabilities?.includes("office.get")}
            className={page === "office" ? "selected" : ""}
            aria-current={page === "office" ? "page" : undefined}
            onClick={() => setPage("office")}
          >
            文件办公
          </button>
          <button
            disabled={!status.capabilities?.includes("groups.list")}
            className={page === "groups" ? "selected" : ""}
            aria-current={page === "groups" ? "page" : undefined}
            onClick={() => setPage("groups")}
          >
            Agent 群聊
          </button>
          <button
            disabled={!status.capabilities?.includes("work_items.list")}
            className={page === "work_items" ? "selected" : ""}
            aria-current={page === "work_items" ? "page" : undefined}
            onClick={() => setPage("work_items")}
          >
            工作看板
          </button>
          <button
            disabled={!status.capabilities?.includes("events.sources")}
            className={page === "events" ? "selected" : ""}
            aria-current={page === "events" ? "page" : undefined}
            onClick={() => setPage("events")}
          >
            事件来源
          </button>
          <button
            disabled={!status.capabilities?.includes("rules.list")}
            className={page === "rules" ? "selected" : ""}
            aria-current={page === "rules" ? "page" : undefined}
            onClick={() => setPage("rules")}
          >
            规则
          </button>
          <button
            className={page === "authorizations" ? "selected" : ""}
            aria-current={page === "authorizations" ? "page" : undefined}
            disabled={!status.capabilities?.includes("authorizations.list")}
            title={
              !status.capabilities?.includes("authorizations.list")
                ? "当前核心未提供授权管理"
                : undefined
            }
            onClick={() => setPage("authorizations")}
          >
            授权
          </button>
          <button
            className={page === "mcp" ? "selected" : ""}
            aria-current={page === "mcp" ? "page" : undefined}
            onClick={() => setPage("mcp")}
          >
            MCP
          </button>
          <button
            className={page === "hooks" ? "selected" : ""}
            onClick={() => setPage("hooks")}
            aria-current={page === "hooks" ? "page" : undefined}
          >
            Hooks
          </button>
          <button
            className={page === "skills" ? "selected" : ""}
            onClick={() => setPage("skills")}
            aria-current={page === "skills" ? "page" : undefined}
          >
            技能
          </button>
          <button
            className={page === "memory" ? "selected" : ""}
            onClick={() => setPage("memory")}
            aria-current={page === "memory" ? "page" : undefined}
          >
            记忆
          </button>
          <button
            className={page === "agent" ? "selected" : ""}
            onClick={() => setPage("agent")}
            aria-current={page === "agent" ? "page" : undefined}
          >
            任务
          </button>
          <button
            className={page === "chat" ? "selected" : ""}
            onClick={() => setPage("chat")}
            aria-current={page === "chat" ? "page" : undefined}
          >
            对话
          </button>
          <button
            className={page === "models" ? "selected" : ""}
            onClick={() => setPage("models")}
            aria-current={page === "models" ? "page" : undefined}
          >
            模型
          </button>
          <button
            className={page === "workspaces" ? "selected" : ""}
            onClick={() => setPage("workspaces")}
            aria-current={page === "workspaces" ? "page" : undefined}
          >
            工作区
          </button>
          <button
            className={page === "connection" ? "selected" : ""}
            onClick={() => setPage("connection")}
            aria-current={page === "connection" ? "page" : undefined}
          >
            连接
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-line">
            <i
              className={
                "signal " +
                (ready ? "online" : status.state === "faulted" ? "offline" : "")
              }
              aria-hidden="true"
            />
            <span>{labels[status.state] || "未连接"}</span>
          </div>
          <span className="local-note">数据保存在这台电脑上</span>
          <button
            id="desktop-new-window"
            className="quiet"
            onClick={() => action(() => call(resources.openDesktopWindow()))}
          >
            新窗口
          </button>
          <button className="quiet exit" onClick={() => resources.quit()}>
            退出 TROOP
          </button>
        </div>
      </aside>
      <div className="topbar">
        <span>
          TROOP <span className="version">{version}</span>
        </span>
        <span>Windows · 本机</span>
      </div>
      <main className={"sheet " + (page === "chat" ? "chat-sheet" : "")}>
        {(page === "workspaces" || page === "connection") && (
          <div className="title-row">
            <div>
              <h1>{page === "workspaces" ? "工作区" : "连接"}</h1>
              <p>
                {page === "workspaces"
                  ? "集中管理这台电脑上的项目文件夹。"
                  : "查看桌面应用与本地核心的连接。"}
              </p>
            </div>
            {page === "workspaces" && (
              <button
                className="primary"
                disabled={!ready || busy}
                onClick={add}
              >
                添加工作区
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            <div>
              <strong>操作未完成</strong>
              <p>{error}</p>
            </div>
            {status.state === "faulted" && (
              <button
                disabled={busy}
                onClick={() => action(() => call(resources.restartCore()))}
              >
                重新连接
              </button>
            )}
          </div>
        )}
        <OperationRecovery
          ready={ready}
          onOpenResource={setPage}
          onOpenRun={(id) => {
            setOpenRun(id);
            setPage("agent");
          }}
        />
        <div className="chat-mount" hidden={page !== "chat"}>
          <ChatPanel
            officeReference={officeReference}
            onReferenceConsumed={() => setOfficeReference(null)}
            onManageAutomation={(rule) => {
              setOpenAutomation(rule);
              setPage("rules");
            }}
            onOpenRun={(id) => {
              setOpenRun(id);
              setPage("agent");
            }}
            onOpenAuthorizations={() => setPage("authorizations")}
            ready={ready}
            generation={status.generation}
            providers={providers}
            workspaces={rows}
            onOpenModels={() => setPage("models")}
            visible={page === "chat"}
          />
        </div>
        <div hidden={page !== "office"}>
          <OfficePanel
            key={status.storage_instance ?? "starting"}
            ready={ready}
            visible={page === "office"}
            instance={status.storage_instance}
            workspaces={rows}
            onRunReference={(reference) => {
              setOfficeReference(reference);
              setPage("authorizations");
            }}
            onReference={(reference) => {
              setOfficeReference(reference);
              setPage("chat");
            }}
          />
        </div>
        <div hidden={page !== "agent"}>
          <AgentPanel
            openRun={openRun}
            ready={ready}
            generation={status.generation}
            providers={providers}
            workspaces={rows}
            visible={page === "agent"}
          />
        </div>
        {page === "events" && (
          <EventSourcesPanel
            ready={ready}
            generation={status.generation}
            workspaces={rows}
            storageInstance={status.storage_instance}
            onOpenRun={(id) => {
              setOpenRun(id);
              setPage("agent");
            }}
          />
        )}
        {page === "work_items" && (
          <WorkItemsPanel
            key={status.storage_instance}
            ready={ready}
            workspaces={rows}
            onOpenRun={(id) => {
              setOpenRun(id);
              setPage("agent");
            }}
          />
        )}
        {page === "groups" && (
          <GroupChatPanel
            key={status.storage_instance}
            ready={ready}
            workspaces={rows}
            onOpenRun={(id) => {
              setOpenRun(id);
              setPage("agent");
            }}
          />
        )}
        {page === "rules" && (
          <RulesPanel
            openAutomation={openAutomation}
            ready={ready}
            workspaces={rows}
            onOpenRun={(id) => {
              setOpenRun(id);
              setPage("agent");
            }}
          />
        )}
        {page === "authorizations" && (
          <AuthorizationsPanel
            officeReference={officeReference}
            onReferenceConsumed={() => setOfficeReference(null)}
            onOpenRun={(id) => {
              setOpenRun(id);
              setPage("agent");
            }}
            ready={ready}
            generation={status.generation}
            workspaces={rows}
          />
        )}
        {page === "hooks" && (
          <HooksPanel
            ready={ready}
            generation={status.generation}
            workspaces={rows}
          />
        )}
        {page === "mcp" && (
          <McpPanel
            ready={ready}
            generation={status.generation}
            onRun={(id) => {
              setOpenRun(id);
              setPage("agent");
            }}
          />
        )}
        {page === "models" && (
          <ModelSettings
            ready={ready}
            providers={providers}
            onSaved={refreshProviders}
          />
        )}
        {page === "memory" && (
          <MemoryPanel ready={ready} generation={status.generation} />
        )}
        {page === "skills" && (
          <SkillsPanel
            ready={ready}
            generation={status.generation}
            providers={providers}
            workspaces={rows}
            onRun={(id) => {
              setOpenRun(id);
              setPage("agent");
            }}
          />
        )}
        {page === "workspaces" ? (
          <>
            <div className="list-heading">
              <span>已登记的文件夹</span>
              <span>{loading ? "读取中…" : `${pageInfo.total} 个工作区`}</span>
            </div>
            {loading ? (
              <div className="empty" role="status">
                <h2>正在读取工作区</h2>
                <p>连接就绪后，已保存的项目会显示在这里。</p>
              </div>
            ) : rows.length === 0 ? (
              <div className="empty">
                <div className="folder-mark" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <h2>从一个项目文件夹开始</h2>
                <p>
                  选择已有文件夹，加入工作区列表。
                  <br />
                  移除登记时，原文件始终保留。
                </p>
                <button disabled={!ready || busy} onClick={add}>
                  选择文件夹
                </button>
              </div>
            ) : (
              <ul className="workspace-list">
                {rows.map((row) => (
                  <li key={row.id}>
                    <div className="folder-icon" aria-hidden="true" />
                    <div className="workspace-info">
                      {editing === row.id ? (
                        <form onSubmit={rename}>
                          <label className="sr-only" htmlFor={"name-" + row.id}>
                            工作区名称
                          </label>
                          <input
                            id={"name-" + row.id}
                            autoFocus
                            maxLength={120}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            disabled={busy}
                          />
                          <button type="submit" disabled={busy || !name.trim()}>
                            保存
                          </button>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => setEditing(null)}
                            disabled={busy}
                          >
                            取消
                          </button>
                        </form>
                      ) : (
                        <>
                          <h2>{row.name}</h2>
                          <p title={row.path}>
                            {row.path.replace(/^\\\\\?\\/, "")}
                          </p>
                        </>
                      )}
                    </div>
                    {editing !== row.id && (
                      <div className="row-actions">
                        <button
                          className="quiet"
                          disabled={!ready || busy}
                          onClick={() => {
                            setEditing(row.id);
                            setName(row.name);
                          }}
                        >
                          重命名
                        </button>
                        <button
                          className="quiet"
                          disabled={!ready || busy}
                          onClick={() =>
                            action(() =>
                              call(resources.removeWorkspace(row.id)),
                            )
                          }
                        >
                          移除登记
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {pageInfo.next_offset !== null && (
              <button
                disabled={!ready || busy}
                onClick={() =>
                  action(async () => {
                    const value = await call(
                      resources.listWorkspaces(pageInfo.next_offset),
                    );
                    applyPage(value, true);
                    return null;
                  })
                }
              >
                加载更多工作区
              </button>
            )}
            <div className="footnote">
              工作区登记仅保存名称和位置，不会移动你的文件。
            </div>
          </>
        ) : page === "connection" ? (
          <section className="settings" aria-label="连接详情">
            <div>
              <span>本地核心</span>
              <strong className={ready ? "positive" : ""}>
                {labels[status.state]}
              </strong>
            </div>
            <div>
              <span>Core 版本</span>
              <span>{status.version ?? "—"}</span>
            </div>
            <div>
              <span>核心通信版本</span>
              <span>{status.protocol ?? "—"}</span>
            </div>
            <div className="setting-action">
              <div>
                <strong>重新连接</strong>
                <p>连接中断后可在这里重新启动本地核心。</p>
              </div>
              <button
                disabled={
                  busy ||
                  status.state === "starting" ||
                  status.state === "stopping"
                }
                onClick={() => action(() => call(resources.restartCore()))}
              >
                重新连接
              </button>
            </div>
            <div className="setting-action">
              <div>
                <strong>后台驻留</strong>
                <p>关闭窗口后留在托盘；选择“退出 TROOP”结束应用。</p>
              </div>
            </div>
          </section>
        ) : null}
        <footer hidden={page === "chat"}>
          <span>TROOP · 本机优先</span>
          <span>
            {page === "models"
              ? "模型配置"
              : page === "workspaces"
                ? "工作区管理"
                : "本地核心"}
          </span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
