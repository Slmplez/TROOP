import React from "react";
import { clientModels, useClientModel } from "./client/react";

export default function OfficeReference({
  reference,
  ready,
  onRemove,
  label = "待交付固定引用",
}) {
  const state = useClientModel(
    clientModels.resource("office.reference.get", { id: reference.id }),
    ready,
  );
  const value = state.data ?? reference;
  return (
    <section className="agent-card" aria-label={label}>
      <p>
        {value.path} · 版本 {value.revision} · 工作区 {value.workspace_id}
      </p>
      <p>{value.stale ? "已过期，交付仍使用原版本内容" : "固定版本内容"}</p>
      {state.error && <p role="alert">{state.error.message}</p>}
      {state.loading && !state.data && (
        <p role="status">正在读取固定版本正文…</p>
      )}
      <pre className="office-original">{value.content}</pre>
      {onRemove && (
        <button type="button" onClick={onRemove}>
          移除此引用
        </button>
      )}
    </section>
  );
}
