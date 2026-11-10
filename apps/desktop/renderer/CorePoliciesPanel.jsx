import React, { useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import SchemaForm from "./SchemaForm";

export default function CorePoliciesPanel({ ready, storageInstance }) {
  const [kind, setKind] = useState("global"),
    [workspace, setWorkspace] = useState("1"),
    [source, setSource] = useState(""),
    [subject, setSubject] = useState("");
  const [draft, setDraft] = useState(null),
    [archiveDraft, setArchiveDraft] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [operation, setOperation] = useState(""),
    [receipt, setReceipt] = useState(null);
  const lock = useRef(false);
  const scope = {
    kind,
    ...(kind === "workspace" ? { workspace_id: Number(workspace) } : {}),
    ...(["source", "object"].includes(kind) ? { source_id: source } : {}),
    ...(kind === "object" ? { subject_id: subject } : {}),
  };
  const key = JSON.stringify(scope),
    current = useRef(key);
  current.current = key;
  const valid =
    kind === "global" ||
    (kind === "workspace" &&
      Number.isSafeInteger(Number(workspace)) &&
      Number(workspace) > 0) ||
    (kind === "source" && !!source) ||
    (kind === "object" && !!source && !!subject);
  const catalogue = useClientModel(
    clientModels.resource("configuration.schemas", {}),
  );
  const global = useClientModel(
    clientModels.resource("rules.limits.get", { scope: { kind: "global" } }),
  );
  const policy = useClientModel(
    valid ? clientModels.resource("rules.limits.get", { scope }) : null,
  );
  const history = useClientModel(
    valid ? clientModels.resource("rules.limits.history", { scope }) : null,
  );
  const archive = useClientModel(
    clientModels.resource("operations.archive.settings", {}),
  );
  const values =
    draft?.key === key
      ? draft.values
      : (policy.data?.limits ?? global.data?.limits);
  const archiveValues =
    archiveDraft?.values ??
    (archive.data
      ? {
          enabled: archive.data.enabled,
          retention_seconds: archive.data.retention_seconds,
        }
      : null);
  async function act(action) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      clientModels.invalidate();
    } catch (error) {
      setError(error.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function changeScope(update) {
    update();
    setDraft(null);
    setError("");
    setNotice("");
  }
  return (
    <div className="models-page core-policies">
      <h1>Core 策略</h1>
      <p>
        回流写动作按来源与对象累计，规则修订、Agent
        更换和事件重投共用计数。对象策略优先于来源、工作区和全局策略。
      </p>
      {(error ||
        catalogue.error ||
        policy.error ||
        archive.error ||
        history.error) && (
        <p role="alert" className="error">
          {error ||
            catalogue.error?.message ||
            policy.error?.message ||
            archive.error?.message ||
            history.error?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <section className="provider-form" aria-label="回流写动作限额">
        <h2>回流写动作限额</h2>
        <label htmlFor="causal-scope-kind">配置范围</label>
        <select
          id="causal-scope-kind"
          value={kind}
          disabled={busy}
          onChange={(event) => changeScope(() => setKind(event.target.value))}
        >
          <option value="global">全局默认</option>
          <option value="workspace">工作区</option>
          <option value="source">事件来源</option>
          <option value="object">来源对象</option>
        </select>
        {kind === "workspace" && (
          <>
            <label htmlFor="causal-workspace">工作区 ID</label>
            <input
              id="causal-workspace"
              type="number"
              min="1"
              value={workspace}
              disabled={busy}
              onChange={(event) =>
                changeScope(() => setWorkspace(event.target.value))
              }
            />
          </>
        )}
        {["source", "object"].includes(kind) && (
          <>
            <label htmlFor="causal-source">来源 ID</label>
            <input
              id="causal-source"
              value={source}
              disabled={busy}
              onChange={(event) =>
                changeScope(() => setSource(event.target.value))
              }
            />
          </>
        )}
        {kind === "object" && (
          <>
            <label htmlFor="causal-subject">对象键</label>
            <input
              id="causal-subject"
              value={subject}
              disabled={busy}
              onChange={(event) =>
                changeScope(() => setSubject(event.target.value))
              }
            />
            <p className="field-hint">
              采用执行记录中的 causal_scope.subject_id，例如 github.issue:123。
            </p>
          </>
        )}
        {policy.data && (
          <p>
            当前修订 {policy.data.revision}
            {policy.data.revision === 0 ? "，保存后建立此范围的覆盖策略。" : ""}
          </p>
        )}
        {values && catalogue.data?.causal_limits ? (
          <SchemaForm
            id="causal-limits"
            label="写动作限额"
            schema={catalogue.data.causal_limits}
            value={values}
            disabled={!ready || busy || !policy.data}
            onChange={(values) =>
              setDraft({
                key,
                revision:
                  draft?.key === key ? draft.revision : policy.data.revision,
                values,
              })
            }
          />
        ) : (
          <p role="status">
            {valid ? "正在读取回流策略…" : "请先填写配置范围。"}
          </p>
        )}
        <p className="field-hint">
          每个已接纳写入尝试计一次，包括结果不明和后续失败的尝试。相同效果 ID
          重投不重复计数；同一对象的不同动作共用每小时总额。
        </p>
        <button
          id="causal-limits-save"
          disabled={!ready || busy || !policy.data || !values}
          onClick={() =>
            act(async () => {
              const identity = key;
              await clientModels.command("rules.limits.save", {
                scope,
                expected_revision:
                  draft?.key === key ? draft.revision : policy.data.revision,
                limits: values,
              });
              if (current.current === identity) {
                setDraft(null);
                setNotice(
                  "回流限额已保存，后续动作按当前策略核验，已有计数保留。",
                );
              }
            })
          }
        >
          保存限额修订
        </button>
        <details>
          <summary>配置历史</summary>
          {history.data?.items.map((item) => (
            <p key={item.revision}>
              修订 {item.revision} · 深度 {item.limits.max_depth} · 每小时{" "}
              {item.limits.max_writes_per_hour} 次 · 冷却{" "}
              {item.limits.cooldown_seconds} 秒
            </p>
          ))}
        </details>
      </section>
      <section className="provider-form" aria-label="操作回执归档">
        <h2>操作回执归档</h2>
        <p>
          默认关闭，默认在线保留期为 30
          天。归档保存原结果、操作身份、指纹及终态，未决副作用保留在线核对。
        </p>
        {archiveValues && catalogue.data?.archive_settings ? (
          <SchemaForm
            id="archive-settings"
            label="归档设置"
            schema={catalogue.data.archive_settings}
            value={archiveValues}
            disabled={!ready || busy}
            onChange={(values) =>
              setArchiveDraft({
                revision: archiveDraft?.revision ?? archive.data.revision,
                values,
              })
            }
          />
        ) : (
          <p role="status">正在读取归档设置…</p>
        )}
        {archive.data && <p>配置修订 {archive.data.revision}</p>}
        <button
          id="archive-settings-save"
          disabled={!ready || busy || !archiveValues}
          onClick={() =>
            act(async () => {
              await clientModels.command("operations.archive.configure", {
                expected_revision:
                  archiveDraft?.revision ?? archive.data.revision,
                ...archiveValues,
              });
              setArchiveDraft(null);
              setNotice("归档配置已保存。");
            })
          }
        >
          保存归档配置
        </button>
        <button
          id="archive-run"
          disabled={!ready || busy || !archive.data?.enabled}
          onClick={() =>
            act(async () => {
              const result = await clientModels.command(
                "operations.archive.run",
                {},
              );
              setNotice(
                `本批已归档 ${result.archived} 份终态回执，每批最多 100 份。`,
              );
            })
          }
        >
          归档到期回执
        </button>
        <label htmlFor="archive-operation-id">查询原操作 ID</label>
        <input
          id="archive-operation-id"
          value={operation}
          disabled={busy}
          onChange={(event) => {
            setOperation(event.target.value);
            setReceipt(null);
          }}
        />
        <button
          id="archive-query"
          disabled={!ready || busy || !operation || !storageInstance}
          onClick={() =>
            act(async () => {
              const found = await clientModels.read("operations.get", {
                instance_id: storageInstance,
                operation_id: operation,
              });
              const archived = found.state === "archived";
              const original = archived
                ? await clientModels.read(
                    "operations.archive.query",
                    found.archive_ref,
                  )
                : found;
              setReceipt({ archived, original });
            })
          }
        >
          查询回执
        </button>
        {receipt && (
          <div id="archive-result">
            <p>
              {receipt.archived ? "已归档，已读取原结果" : "在线回执"} ·{" "}
              {receipt.original.state}
            </p>
            <pre>{JSON.stringify(receipt.original, null, 2)}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
