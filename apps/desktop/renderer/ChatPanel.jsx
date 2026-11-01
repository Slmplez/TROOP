import React, { useEffect, useRef, useState } from "react";
import { call } from "./api";
const statuses = {
  streaming: "正在生成",
  completed: "已完成",
  cancelled: "已停止",
  interrupted: "已中断",
  incomplete: "达到输出限制或未完成",
  failed: "生成失败",
};
export default function ChatPanel({
  ready,
  generation,
  providers,
  workspaces,
  onOpenModels,
  visible,
}) {
  const [sessions, setSessions] = useState([]),
    [sessionPage, setSessionPage] = useState(null),
    [selected, setSelected] = useState(null),
    [messages, setMessages] = useState([]),
    [before, setBefore] = useState(null),
    [provider, setProvider] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [drafts, setDrafts] = useState({}),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const view = useRef({}),
    sequence = useRef(0),
    applied = useRef(0),
    sendLock = useRef(false),
    pendingSend = useRef(null),
    olderLoaded = useRef(false),
    scroll = useRef(null),
    pinned = useRef(true),
    refreshTimer = useRef(null);
  const sessionsExpanded = useRef(false);
  view.current = { selected, generation, ready };
  const current = sessions.find((s) => s.id === selected),
    draft = drafts[selected ?? "new"] ?? "";
  const active = messages.find(
    (m) => m.role === "assistant" && m.status === "streaming",
  );
  function setDraft(text) {
    setDrafts((old) => ({ ...old, [selected ?? "new"]: text }));
  }
  async function loadSessions(append = false) {
    const expected = generation;
    try {
      const page = await call(
        window.troop.listConversations(append ? sessionPage : 0),
      );
      if (view.current.generation !== expected) return;
      if (append) sessionsExpanded.current = true;
      setSessions((old) =>
        append || sessionsExpanded.current
          ? [
              ...page.items,
              ...old.filter(
                (item) => !page.items.some((s) => s.id === item.id),
              ),
            ].sort(
              (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id,
            )
          : page.items,
      );
      if (append || !sessionsExpanded.current) setSessionPage(page.next_offset);
    } catch (e) {
      if (view.current.generation === expected) setError(e.message);
    }
  }
  async function loadMessages(id = selected, older = false) {
    if (id === null || !view.current.ready) return;
    const expected = generation,
      request = ++sequence.current;
    try {
      const page = await call(
        window.troop.listMessages(id, older ? before : null),
      );
      if (
        view.current.selected !== id ||
        view.current.generation !== expected ||
        (!older && request < applied.current)
      )
        return;
      if (!older) applied.current = request;
      if (older) olderLoaded.current = true;
      setMessages((old) => {
        const map = new Map(
          (older || olderLoaded.current ? old : []).map((m) => [m.id, m]),
        );
        for (const message of page.items) map.set(message.id, message);
        return [...map.values()].sort((a, b) => a.id - b.id);
      });
      if (older || !olderLoaded.current) setBefore(page.next_before);
    } catch (e) {
      if (view.current.selected === id && view.current.generation === expected)
        setError(e.message);
    } finally {
      if (view.current.selected === id) setLoading(false);
    }
  }
  const loaders = useRef({});
  loaders.current = { loadSessions, loadMessages };
  useEffect(() => {
    if (ready) {
      loadSessions();
      if (selected !== null) loadMessages();
    }
  }, [ready, generation]);
  useEffect(() => {
    setMessages([]);
    setBefore(null);
    olderLoaded.current = false;
    pinned.current = true;
    setError("");
    setLoading(selected !== null && ready);
    if (selected !== null && ready) loadMessages(selected);
  }, [selected]);
  useEffect(
    () =>
      window.troop.onChatEvent((event) => {
        if (event.generation !== view.current.generation) return;
        if (refreshTimer.current) return;
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          loaders.current.loadSessions();
          if (view.current.selected !== null)
            loaders.current.loadMessages(view.current.selected);
        }, 80);
      }),
    [],
  );
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  useEffect(() => {
    if (pinned.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (provider && !providers.some((p) => p.id === provider)) setProvider("");
  }, [providers]);
  function choose(id) {
    setSelected(id);
    setProvider(sessions.find((s) => s.id === id)?.provider_id ?? "");
    pendingSend.current = null;
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const chat = await call(
        window.troop.createConversation({
          title: "新对话",
          workspace_id: workspace ? Number(workspace) : null,
        }),
      );
      await loadSessions();
      setSelected(chat.id);
      pendingSend.current = null;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function send(event) {
    event?.preventDefault();
    if (sendLock.current || !ready || active || !draft.trim() || !provider)
      return;
    sendLock.current = true;
    setBusy(true);
    setError("");
    const text = draft;
    const expected = generation;
    let id = selected;
    try {
      if (id === null) {
        const chat = await call(
          window.troop.createConversation({
            title: "新对话",
            workspace_id: workspace ? Number(workspace) : null,
          }),
        );
        id = chat.id;
        setDrafts((old) => ({ ...old, [id]: text }));
        setSelected(id);
      }
      const last = pendingSend.current;
      const client =
        last &&
        last.id === id &&
        last.text === text &&
        last.provider === provider
          ? last.client
          : crypto.randomUUID();
      pendingSend.current = { id, text, provider, client };
      await call(
        window.troop.sendMessage({
          conversation_id: id,
          provider_id: provider,
          client_turn_id: client,
          text,
        }),
      );
      if (view.current.generation !== expected) return;
      setDrafts((old) => ({ ...old, [selected ?? "new"]: "", [id]: "" }));
      pendingSend.current = null;
      pinned.current = true;
      await loadSessions();
      await loadMessages(id);
    } catch (e) {
      setError(e.message + " 发送结果不明时，请重连后先核对对话记录。");
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  }
  async function stop() {
    if (!active) return;
    setBusy(true);
    setError("");
    try {
      await call(window.troop.cancelTurn(active.turn_id));
      await loadMessages();
      await loadSessions();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (selected === null) return;
    setBusy(true);
    setError("");
    try {
      const result = await call(window.troop.removeConversation(selected));
      if (!result.removed) return;
      setSessions((old) => old.filter((s) => s.id !== selected));
      await loadSessions();
      setSelected(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function repeat(message) {
    const expected = { ...view.current };
    let question = messages.find(
      (m) => m.turn_id === message.turn_id && m.role === "user",
    );
    if (!question) {
      setBusy(true);
      setError("");
      try {
        const page = await call(
          window.troop.listMessages(selected, message.id),
        );
        question = page.items.find(
          (m) => m.turn_id === message.turn_id && m.role === "user",
        );
      } catch (e) {
        setError(e.message);
        return;
      } finally {
        setBusy(false);
      }
    }
    if (
      view.current.selected !== expected.selected ||
      view.current.generation !== expected.generation
    )
      return;
    if (question) {
      pendingSend.current = null;
      setDraft(question.content);
    }
  }
  return (
    <div className="chat-page">
      <div className="title-row">
        <div>
          {visible ? <h1>对话</h1> : <h2>对话</h2>}
          <p>连接你选择的模型，记录保存在本机。</p>
        </div>
        <button disabled={!ready || busy} onClick={create}>
          新建对话
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="chat-layout">
        <aside className="conversation-list" aria-label="对话历史">
          <h2>最近对话</h2>
          {sessions.length === 0 ? (
            <p className="muted">还没有对话记录。</p>
          ) : (
            sessions.map((session) => (
              <button
                className={
                  selected === session.id
                    ? "conversation chosen"
                    : "conversation"
                }
                key={session.id}
                onClick={() => choose(session.id)}
              >
                <span>{session.title}</span>
                {session.active_turn_id && <small>生成中</small>}
              </button>
            ))
          )}
          {sessionPage !== null && (
            <button
              className="quiet"
              onClick={() => loadSessions(true)}
              disabled={!ready}
            >
              更多对话
            </button>
          )}
        </aside>
        <section className="conversation-body" aria-label="当前对话">
          <div className="conversation-toolbar">
            <select
              aria-label="选择对话"
              className="compact-conversation"
              value={selected ?? ""}
              onChange={(e) =>
                choose(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">新对话</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <strong className="conversation-title">
              {current?.title ?? "新的开始"}
            </strong>
            {selected !== null && (
              <button
                className="quiet"
                disabled={!ready || busy || Boolean(active)}
                onClick={remove}
              >
                删除对话
              </button>
            )}
          </div>
          <div
            className="chat-messages"
            ref={scroll}
            onScroll={() => {
              const el = scroll.current;
              if (el)
                pinned.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
            aria-label="消息记录"
            aria-busy={loading}
          >
            {before !== null && (
              <button
                className="quiet earlier"
                disabled={!ready || busy || Boolean(active)}
                onClick={() => {
                  pinned.current = false;
                  loadMessages(selected, true);
                }}
              >
                加载更早的消息
              </button>
            )}
            {loading ? (
              <p role="status" className="muted">
                正在读取对话…
              </p>
            ) : messages.length === 0 ? (
              <div className="chat-empty">
                <h2>
                  {providers.length ? "从一个问题开始" : "先连接一个模型服务"}
                </h2>
                <p>
                  {providers.length
                    ? "选择下方的模型服务，写下你想讨论的内容。"
                    : "填写服务地址、模型 ID 和密钥后，就可以开始对话。"}
                </p>
                {!providers.length && (
                  <button onClick={onOpenModels}>配置模型服务</button>
                )}
              </div>
            ) : (
              messages.map((message) => (
                <article
                  className={"chat-message " + message.role}
                  key={message.id}
                  data-message-id={message.id}
                  data-state={message.status}
                >
                  <div className="message-byline">
                    <strong>
                      {message.role === "user" ? "你" : message.provider_name}
                    </strong>
                    {message.role === "assistant" && (
                      <span>
                        {message.model} ·{" "}
                        {statuses[message.status] ?? message.status}
                      </span>
                    )}
                  </div>
                  <div className="message-text">
                    {message.content ||
                      (message.role === "assistant" &&
                      message.status === "streaming"
                        ? "正在等待模型响应…"
                        : "尚未收到文本。")}
                  </div>
                  {message.error_message && (
                    <p className="message-problem">{message.error_message}</p>
                  )}
                  {message.role === "assistant" && message.usage && (
                    <p className="message-usage">
                      输入 {message.usage.input_tokens ?? "—"} / 输出{" "}
                      {message.usage.output_tokens ?? "—"} token
                    </p>
                  )}
                  {message.role === "assistant" &&
                    [
                      "failed",
                      "cancelled",
                      "interrupted",
                      "incomplete",
                    ].includes(message.status) && (
                      <button
                        className="quiet repeat-question"
                        disabled={Boolean(active) || busy}
                        onClick={() => repeat(message)}
                      >
                        重新提问
                      </button>
                    )}
                </article>
              ))
            )}
          </div>
          <form className="composer" onSubmit={send}>
            <div className="composer-options">
              <label className="sr-only" htmlFor="chat-provider">
                模型服务
              </label>
              <select
                id="chat-provider"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  pendingSend.current = null;
                }}
                disabled={!ready || busy || Boolean(active)}
              >
                <option value="">请选择模型服务</option>
                {providers.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.config.name} · {p.config.model}
                  </option>
                ))}
              </select>
              {selected === null && workspaces.length > 0 && (
                <select
                  aria-label="关联工作区"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  disabled={busy}
                >
                  <option value="">不关联工作区</option>
                  {workspaces.map((w) => (
                    <option value={w.id} key={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <label className="sr-only" htmlFor="chat-input">
              消息
            </label>
            <textarea
              id="chat-input"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={12000}
              placeholder="写下你的问题…"
              disabled={!ready || busy}
              onKeyDown={(e) => {
                if (
                  !e.nativeEvent.isComposing &&
                  e.key === "Enter" &&
                  (e.ctrlKey || e.metaKey)
                ) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="composer-bottom">
              <span>
                {!ready
                  ? "Core 尚未连接"
                  : active
                    ? "回复正在生成，可随时停止"
                    : "Ctrl + Enter 发送"}
              </span>
              {active ? (
                <button
                  type="button"
                  className="stop-button"
                  onClick={stop}
                  disabled={!ready || busy}
                >
                  停止生成
                </button>
              ) : (
                <button
                  type="submit"
                  className="primary"
                  disabled={!ready || busy || !draft.trim() || !provider}
                >
                  {busy ? "正在发送…" : "发送消息"}
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
