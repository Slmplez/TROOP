import React, { useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";

export default function ConversationAutomation({
  turnId,
  ready,
  onManage,
  onOpenRun,
  onOpenAuthorizations,
  onContinue,
}) {
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [grant, setGrant] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const grants = useClientModel(
    clientModels.resource("authorizations.list", { offset: 0 }),
    ready,
  );
  const registered = saved ?? draft?.registered;
  const kind = registered?.kind === "scheduled" ? "schedules" : "reminders";
  const live = useClientModel(
    registered
      ? clientModels.resource(`${kind}.get`, { id: registered.id })
      : null,
    ready,
  );
  const history = useClientModel(
    registered
      ? clientModels.resource(`${kind}.history`, { id: registered.id })
      : null,
    ready,
  );
  const current = live.data ?? registered;
  async function act(confirm) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const input = { turn_id: turnId, authorization_id: grant || null };
      if (typeof confirm === "number") {
        onContinue(
          await clientModels.read("automations.result", {
            turn_id: turnId,
            run_id: confirm,
          }),
        );
      } else if (confirm) {
        const value = await clientModels.command("automations.confirm", {
          ...input,
          source_sha256: draft.source_sha256,
          expected_plan_sha256: draft.preview?.plan_sha256 ?? null,
        });
        setSaved(value);
        clientModels.invalidate();
      } else {
        setDraft(await clientModels.read("automations.preview", input));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-label="对话自动化确认" className="agent-card">
      <h3>自动化草稿</h3>
      {error && <p role="alert">{error}</p>}
      {!registered && (
        <>
          <label>
            定时执行授权
            <select
              value={grant}
              disabled={busy}
              onChange={(e) => {
                setGrant(e.target.value);
                setDraft(null);
              }}
            >
              <option value="">纯提醒无需执行授权</option>
              {(grants.data?.items ?? [])
                .filter((item) => !item.revoked)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name ?? item.id}
                  </option>
                ))}
            </select>
          </label>
          <button disabled={!ready || busy} onClick={() => act(false)}>
            预览时间与范围
          </button>
          <button onClick={onOpenAuthorizations}>管理执行授权</button>
        </>
      )}
      {draft?.rule && (
        <>
          <p>
            {draft.rule.kind === "reminder" ? "纯提醒" : "原生 Agent 定时执行"}{" "}
            · {draft.rule.name}
          </p>
          <p>
            Agent {draft.rule.agent_id} · 项目{" "}
            {draft.rule.project_id ?? "个人范围"} ·{" "}
            {draft.rule.schedule.timezone} ·{" "}
            {
              { once: "一次性", daily: "每天", weekly: "每周" }[
                draft.rule.schedule.kind
              ]
            }
          </p>
          <p>{draft.rule.body ?? draft.rule.start.goal}</p>
          {draft.preview.plan && (
            <details>
              <summary>执行权限与资料范围</summary>
              <pre>{JSON.stringify(draft.preview.plan, null, 2)}</pre>
              {(grants.data?.items ?? []).find((item) => item.id === grant)
                ?.expires_at && (
                <p>
                  授权有效期{" "}
                  {new Date(
                    grants.data.items.find((item) => item.id === grant)
                      .expires_at * 1000,
                  ).toISOString()}
                </p>
              )}
            </details>
          )}
          <p>重复时刻触发一次，夏令时缺失或错过的触发跳过并保留记录。</p>
          <ul>
            {draft.preview.slots.map((slot) => (
              <li key={slot.slot_key}>
                {slot.local_date} {slot.local_time} · {slot.timezone}
                {slot.state === "dst_gap" && " · 该时刻不存在，将跳过"}
              </li>
            ))}
          </ul>
          {!registered && (
            <button disabled={!ready || busy} onClick={() => act(true)}>
              确认登记自动化
            </button>
          )}
        </>
      )}
      {current && (
        <>
          <p role="status">
            已登记 · {current.name} ·{" "}
            {current.cancelled
              ? "已取消"
              : current.enabled
                ? "已启用"
                : "已暂停"}{" "}
            · 修订 {current.revision}
          </p>
          <button disabled={!ready || busy} onClick={() => onManage(current)}>
            修改、暂停或取消
          </button>
          <ul>
            {(history.data?.items ?? []).map((item) => (
              <li key={item.id}>
                {{
                  dispatched: "已派发",
                  triggered: "已触发",
                  skipped: "已跳过",
                  blocked: "已阻断",
                }[item.state] ??
                  item.reason ??
                  item.state}{" "}
                {item.run_id && (
                  <>
                    <button onClick={() => onOpenRun(item.run_id)}>
                      打开执行 #{item.run_id}
                    </button>
                    <button
                      disabled={
                        !ready || busy || item.run?.state !== "completed"
                      }
                      onClick={() => act(item.run_id)}
                    >
                      引用结果继续对话
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
