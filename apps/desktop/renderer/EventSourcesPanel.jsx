import React, { useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { resources } from "./client/resources";
import { call } from "./api";
import { defaultSource, issuesForSource } from "./schema-form.mjs";
import { SourceDefinitionEditor } from "./SchemaForm.jsx";

const initial = (instance, workspaces) =>
  defaultSource({
    consumer_id: instance,
    workspace_id: workspaces[0]?.id ?? 1,
  });
const definition = ({
  id,
  revision,
  has_webhook_secret,
  has_api_token,
  authority,
  ...fields
}) => fields;
export default function EventSourcesPanel({
  ready,
  generation,
  workspaces,
  storageInstance,
  onOpenRun,
}) {
  const [offset, setOffset] = useState(0),
    [after, setAfter] = useState(0),
    [selected, setSelected] = useState(null),
    [id, setId] = useState(() => crypto.randomUUID()),
    [text, setText] = useState(() =>
      JSON.stringify(initial(storageInstance, workspaces), null, 2),
    );
  const [webhook, setWebhook] = useState(""),
    [consumer, setConsumer] = useState(""),
    [api, setApi] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [payload, setPayload] = useState(null);
  const lock = useRef(false),
    current = useRef({ id, generation });
  current.current = { id, generation };
  const list = useClientModel(
    clientModels.resource("events.sources", { offset }),
  );
  const health = useClientModel(clientModels.resource("events.health", {}));
  const records = useClientModel(
    selected
      ? clientModels.resource("events.records", {
          source_id: selected.id,
          after,
        })
      : null,
  );
  function edit(source) {
    setSelected(source);
    setId(source?.id ?? crypto.randomUUID());
    setText(
      JSON.stringify(
        source ? definition(source) : initial(storageInstance, workspaces),
        null,
        2,
      ),
    );
    setAfter(0);
    setWebhook("");
    setConsumer("");
    setApi("");
    setPayload(null);
    setError("");
  }
  async function act(fn) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const identity = current.current;
    try {
      const commit = await fn();
      clientModels.invalidate();
      if (
        identity.id === current.current.id &&
        identity.generation === current.current.generation
      )
        commit?.();
    } catch (e) {
      if (
        identity.id === current.current.id &&
        identity.generation === current.current.generation
      )
        setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const endpoint = selected
    ? `${(selected.mode === "remote" ? selected.receiver_url : health.data?.address)?.replace(/\/$/, "") ?? ""}/webhooks/${selected.id}`
    : "";
  return (
    <div className="models-page">
      <div className="title-row">
        <h1>事件来源</h1>
        <button disabled={!ready || busy} onClick={() => edit(null)}>
          创建来源
        </button>
      </div>
      <p>
        先保存来源，再在规则中绑定 source_id。接收器默认使用本机
        loopback，公开接入通过受控 HTTPS 入口配置。
      </p>
      {(error || list.error || health.error) && (
        <p role="alert" className="error">
          {error || list.error?.message || health.error?.message}
        </p>
      )}
      <div className="models-layout">
        <section className="provider-library" aria-label="事件来源列表">
          {list.data?.items.map((source) => (
            <button
              key={source.id}
              className="provider-choice"
              disabled={busy}
              onClick={() => edit(source)}
            >
              <strong>{source.name}</strong>
              <span>
                {source.kind} · 修订 {source.revision} ·{" "}
                {source.enabled ? "启用" : "暂停"}
              </span>
            </button>
          ))}
          <button
            disabled={!ready || busy}
            onClick={() => {
              setOffset(0);
              clientModels.invalidate();
            }}
          >
            刷新列表
          </button>
          {list.data?.next_offset != null && (
            <button
              disabled={busy}
              onClick={() => setOffset(list.data.next_offset)}
            >
              下一页
            </button>
          )}
        </section>
        <section className="provider-form">
          <p>
            来源标识 <code id="event-source-id">{id}</code>
          </p>
          <SourceDefinitionEditor
            text={text}
            disabled={!ready || busy}
            onText={setText}
          />
          <p>
            GitLab 可选择 standard 签名或旧版 token。remote 模式同时提供
            receiver_url 和 receiver_instance，消费者身份绑定当前 Core
            存储实例。
          </p>
          <label htmlFor="event-webhook-secret">接收密钥，留空保留已有值</label>
          <input
            id="event-webhook-secret"
            type="password"
            autoComplete="new-password"
            disabled={!ready || busy}
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
          />
          <label htmlFor="event-consumer-token">
            独立消费令牌，留空保留已有值
          </label>
          <input
            id="event-consumer-token"
            type="password"
            autoComplete="new-password"
            disabled={!ready || busy}
            value={consumer}
            onChange={(e) => setConsumer(e.target.value)}
          />
          <label htmlFor="event-api-token">平台状态查询令牌，可选</label>
          <input
            id="event-api-token"
            type="password"
            autoComplete="new-password"
            disabled={!ready || busy}
            value={api}
            onChange={(e) => setApi(e.target.value)}
          />
          <button
            id="event-source-save"
            disabled={!ready || busy}
            onClick={() =>
              act(async () => {
                const problems = issuesForSource(text);
                if (problems.length) throw Error(problems.join("\n"));
                const saved = await clientModels.command("events.source.save", {
                  id,
                  expected_revision: selected?.revision ?? 0,
                  definition: JSON.parse(text),
                  secrets: {
                    ...(webhook ? { webhook_secret: webhook } : {}),
                    ...(consumer ? { consumer_token: consumer } : {}),
                    ...(api ? { api_token: api } : {}),
                  },
                });
                return () => edit(saved);
              })
            }
          >
            保存来源
          </button>
          {selected && (
            <>
              <p>
                接收地址 <code>{endpoint}</code>
              </p>
              <button
                id="event-source-toggle"
                disabled={!ready || busy}
                onClick={() =>
                  act(async () => {
                    const saved = await clientModels.command(
                      "events.source.save",
                      {
                        id,
                        expected_revision: selected.revision,
                        definition: {
                          ...definition(selected),
                          enabled: !selected.enabled,
                        },
                      },
                    );
                    return () => edit(saved);
                  })
                }
              >
                {selected.enabled ? "暂停来源" : "启用来源"}
              </button>
              <button
                id="event-recheck"
                disabled={!ready || busy || !selected.enabled}
                onClick={() =>
                  act(() =>
                    clientModels
                      .command("events.recheck", {
                        source_id: id,
                        expected_revision: selected.revision,
                      })
                      .then(() => null),
                  )
                }
              >
                重新复核状态
              </button>
              <h2>接收与复核健康</h2>
              <pre>
                {JSON.stringify(
                  health.data?.sources?.[id] ?? {
                    address: health.data?.address,
                  },
                  null,
                  2,
                )}
              </pre>
              <h2>事件与处置</h2>
              {records.error && <p role="alert">{records.error.message}</p>}
              {records.data?.items.length === 0 && <p>等待事件接纳。</p>}
              {records.data?.items.map((event) => (
                <article key={event.id} className="event-record">
                  <p>
                    #{event.id} · {event.kind} · {event.subject_id} ·{" "}
                    {event.review_state}
                  </p>
                  <p>{event.review_reason}</p>
                  {event.executions?.map((execution, index) => (
                    <p key={index}>
                      规则 {execution.rule_id} · {execution.state} ·{" "}
                      {execution.reason}{" "}
                      {execution.run_id && (
                        <button onClick={() => onOpenRun(execution.run_id)}>
                          查看 Run #{execution.run_id}
                        </button>
                      )}
                    </p>
                  ))}
                  {selected.mode === "local" &&
                    (!event.receiver_instance ||
                      event.receiver_instance === health.data?.instance_id) && (
                      <button
                        disabled={busy || !ready}
                        onClick={() =>
                          act(async () => {
                            const value = await call(
                              resources.eventPayload({
                                source_id: id,
                                id: event.inbox_id,
                                offset: 0,
                              }),
                            );
                            return () =>
                              setPayload({
                                ...value,
                                inbox_id: event.inbox_id,
                              });
                          })
                        }
                      >
                        查看正文
                      </button>
                    )}
                </article>
              ))}
              {records.data?.next_after != null && (
                <button
                  disabled={busy}
                  onClick={() => setAfter(records.data.next_after)}
                >
                  更多事件
                </button>
              )}
              {after > 0 && (
                <button disabled={busy} onClick={() => setAfter(0)}>
                  返回首批事件
                </button>
              )}
              {payload && (
                <>
                  <pre>{payload.content}</pre>
                  {payload.archived && (
                    <p>正文已按保留期归档，事件身份和处置记录仍可查询。</p>
                  )}
                  {payload.next_offset != null && (
                    <button
                      disabled={!ready || busy}
                      onClick={() =>
                        act(async () => {
                          const next = await call(
                            resources.eventPayload({
                              source_id: id,
                              id: payload.inbox_id,
                              offset: payload.next_offset,
                            }),
                          );
                          return () =>
                            setPayload({
                              ...next,
                              inbox_id: payload.inbox_id,
                              content: payload.content + next.content,
                            });
                        })
                      }
                    >
                      继续读取正文
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
