import React, { useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import MemoryHistory from "./MemoryHistory";

export default function MemoryUsage({ run, ready, visible }) {
  const [offset, setOffset] = useState(0),
    [previousOffsets, setPreviousOffsets] = useState([]),
    [requestId, setRequestId] = useState(null),
    [before, setBefore] = useState(null),
    [selected, setSelected] = useState(null);
  const usage = useClientModel(
    clientModels.resource("memory.usage", {
      run_id: run.id,
      offset,
      ...(requestId ? { request_id: requestId } : {}),
      ...(before ? { before } : {}),
    }),
    ready && visible,
  );
  return (
    <details>
      <summary>本次上下文的记忆来源</summary>
      <p>
        {run.kind === "external_cli"
          ? "按 CLI 作业保存交付前选入的记忆修订。实际接收与采纳情况需结合执行事件和产物核对。"
          : "按模型请求保存选入的记忆修订。记录在请求派发前提交，模型是否收到、采纳需结合执行事件与产物核对。"}
      </p>
      {usage.data?.requests.length > 0 && (
        <label>
          {run.kind === "external_cli" ? "CLI 上下文交付" : "模型请求"}
          <select
            aria-label="记忆来源模型请求"
            value={requestId ?? usage.data.request_id ?? ""}
            onChange={(event) => {
              setRequestId(Number(event.target.value));
              setOffset(0);
              setPreviousOffsets([]);
            }}
          >
            {usage.data.requests.map((request) => (
              <option key={request.id} value={request.id}>
                第 {request.step} 步 · 代次 {request.epoch} ·{" "}
                {request.created_at}
              </option>
            ))}
          </select>
        </label>
      )}
      {usage.data?.evidence === "historical_sources_unavailable" && (
        <p>此请求尚无可证明的记忆来源记录。</p>
      )}
      {before && (
        <button
          onClick={() => {
            setBefore(null);
            setRequestId(null);
            setOffset(0);
            setPreviousOffsets([]);
          }}
        >
          最近请求
        </button>
      )}
      {usage.data?.next_before != null && (
        <button
          onClick={() => {
            setBefore(usage.data.next_before);
            setRequestId(null);
            setOffset(0);
            setPreviousOffsets([]);
          }}
        >
          更早请求
        </button>
      )}
      {usage.error && <p role="alert">{usage.error.message}</p>}
      {!usage.error &&
        usage.data?.items.map((item) => (
          <p key={`${item.memory_id}:${item.revision_id}`}>
            Memory #{item.memory_id} · Revision #{item.revision_id} ·{" "}
            {item.scope} {item.project} · {item.selection_reason}
            <button onClick={() => setSelected(item.memory_id)}>
              查看修订历史
            </button>
          </p>
        ))}
      {offset > 0 && (
        <button
          onClick={() => {
            setOffset(previousOffsets.at(-1) ?? 0);
            setPreviousOffsets(previousOffsets.slice(0, -1));
          }}
        >
          上一页
        </button>
      )}
      {usage.data?.next_offset != null && (
        <button
          onClick={() => {
            setPreviousOffsets([...previousOffsets, offset]);
            setOffset(usage.data.next_offset);
          }}
        >
          下一页
        </button>
      )}
      {selected && (
        <MemoryHistory
          key={selected}
          agent={run.agent_id ?? 1}
          id={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </details>
  );
}
