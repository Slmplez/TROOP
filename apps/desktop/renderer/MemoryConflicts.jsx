import React, { useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";

export default function MemoryConflicts({ agent, ready }) {
  const [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const state = useClientModel(
    clientModels.resource("memory.conflicts", { agent_id: agent, offset }),
    ready,
  );
  async function resolve(conflict, choice) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await clientModels.command("memory.resolve", {
        agent_id: agent,
        id: conflict.id,
        expected_revision: conflict.revision,
        base_revision: conflict.base.revision,
        candidate_revision: conflict.candidate.revision,
        choice,
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
    <section className="memory-conflicts" aria-label="记忆冲突">
      <h2>记忆冲突与核对</h2>
      {(error || state.error) && (
        <p role="alert">{error || state.error.message}</p>
      )}
      {!state.error &&
        state.data?.items.map((conflict) => (
          <article key={conflict.id}>
            <h3>
              {conflict.state === "resolved" ? "已解决" : "待核对"} ·{" "}
              {conflict.id}
            </h3>
            <p>
              {conflict.scope} {conflict.project}
            </p>
            <p>
              {conflict.state === "resolved" ? "解决前原条目" : "当前原条目"} #
              {conflict.base.memory_id} / 修订 {conflict.base.revision} ·{" "}
              {conflict.base.protected ? "受保护" : "可维护"}
            </p>
            <p className="agent-text">{conflict.base.content}</p>
            <p>
              {conflict.state === "resolved" ? "当时的候选" : "当前候选"} #
              {conflict.candidate.memory_id} / 修订{" "}
              {conflict.candidate.revision}
            </p>
            <p className="agent-text">{conflict.candidate.content}</p>
            <p>{conflict.reason}</p>
            {conflict.evidence_quote && (
              <blockquote className="agent-text">
                {conflict.evidence_quote}
              </blockquote>
            )}
            <p>
              {conflict.evidence_verified
                ? "引文已匹配来源任务输入。"
                : "引文仍需核对来源。"}
            </p>
            {conflict.snapshot_changed && (
              <p>涉及的资料已变化，当前显示最新修订，请重新核对。</p>
            )}
            <div className="memory-actions">
              {[
                ["base", "保留原条目"],
                ["candidate", "采用候选正文"],
                ["both", "保留双方"],
              ].map(([choice, label]) => (
                <button
                  key={choice}
                  disabled={
                    !ready || busy || !conflict.allowed_actions?.resolve.allowed
                  }
                  title={conflict.allowed_actions?.resolve.reason ?? undefined}
                  onClick={() => resolve(conflict, choice)}
                >
                  {label}
                </button>
              ))}
            </div>
            {conflict.resolution?.result && (
              <p className="agent-text">
                解决后的正文 · {conflict.resolution.result.content}
              </p>
            )}
            {conflict.resolution && (
              <pre>{JSON.stringify(conflict.resolution, null, 2)}</pre>
            )}
          </article>
        ))}
      {offset > 0 && (
        <button disabled={busy} onClick={() => setOffset(0)}>
          返回首批冲突
        </button>
      )}
      {state.data?.next_offset != null && (
        <button
          disabled={busy}
          onClick={() => setOffset(state.data.next_offset)}
        >
          更多冲突
        </button>
      )}
    </section>
  );
}
