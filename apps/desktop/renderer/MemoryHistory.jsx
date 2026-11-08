import React, { useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";

export default function MemoryHistory({ agent, id, onClose }) {
  const [offset, setOffset] = useState(0),
    [previousOffsets, setPreviousOffsets] = useState([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const history = useClientModel(
    clientModels.resource("memory.history", { agent_id: agent, id, offset }),
  );
  const data = history.error ? null : history.data;
  async function restore(revision_id) {
    if (lock.current || !data) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await clientModels.command("memory.restore", {
        agent_id: agent,
        id,
        expected_revision: data.current_revision,
        ...(revision_id ? { revision_id } : {}),
      });
      clientModels.invalidate();
    } catch (error) {
      setError(error.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="memory-history" aria-label="记忆修订历史">
      <h2>记忆 #{id} 的修订历史</h2>
      <button onClick={onClose}>关闭历史</button>
      {history.error && <p role="alert">{history.error.message}</p>}
      {error && <p role="alert">{error}</p>}
      <p>
        {data?.forgetting.active
          ? "当前作用域的遗忘保护已生效。"
          : "当前记忆没有生效中的遗忘保护。"}
      </p>
      <button
        disabled={
          busy || !!history.error || !data?.allowed_actions.restore.allowed
        }
        title={
          data?.allowed_actions.restore.reason ??
          "恢复这条记忆并解除对应遗忘保护"
        }
        onClick={() => restore()}
      >
        明确恢复这条记忆
      </button>
      {data?.items.map((revision) => (
        <article key={revision.revision_id}>
          <h3>
            修订 {revision.revision} · Revision #{revision.revision_id}
          </h3>
          <p className="agent-text">{revision.content}</p>
          <p>
            {revision.deleted ? "已遗忘" : "已保存"} ·{" "}
            {revision.protected ? "受保护" : "允许维护"} · {revision.created_at}
          </p>
          {revision.history_completeness === "baseline_only" && (
            <p>旧数据仅能证明迁移基线，较早的变更记录不可恢复。</p>
          )}
          <pre>{JSON.stringify(revision.source, null, 2)}</pre>
          {revision.revision < data.current_revision && (
            <button
              disabled={busy || !data.allowed_actions.restore_revision?.allowed}
              title={data.allowed_actions.restore_revision?.reason ?? undefined}
              onClick={() => restore(revision.revision_id)}
            >
              恢复此修订
            </button>
          )}
        </article>
      ))}
      {offset > 0 && (
        <button
          onClick={() => {
            setOffset(previousOffsets.at(-1) ?? 0);
            setPreviousOffsets(previousOffsets.slice(0, -1));
          }}
        >
          较新修订
        </button>
      )}
      {data?.next_offset != null && (
        <button
          onClick={() => {
            setPreviousOffsets([...previousOffsets, offset]);
            setOffset(data.next_offset);
          }}
        >
          较早修订
        </button>
      )}
    </section>
  );
}
