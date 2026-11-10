import React, { useEffect, useRef, useState } from "react";
import { clientModels } from "./client/react";
import OfficeMarkdown from "./OfficeMarkdown";

export default function OfficePanel({
  ready,
  visible,
  workspaces,
  instance,
  onReference,
  onRunReference,
}) {
  const [workspace, setWorkspace] = useState("");
  const [path, setPath] = useState("");
  const [files, setFiles] = useState({ items: [] });
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState({ items: [] });
  const [body, setBody] = useState("");
  const [rows, setRows] = useState([]);
  const [separator, setSeparator] = useState(",");
  const [editing, setEditing] = useState(false);
  const [compatible, setCompatible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const [conflicts, setConflicts] = useState([]);
  const [conflictSha, setConflictSha] = useState(null);
  const [selection, setSelection] = useState({
    start: 0,
    end: 1,
    column_start: 0,
    column_end: 1,
  });
  const [reference, setReference] = useState(null);
  const [pendingContent, setPendingContent] = useState("");
  const actor = useRef(null);
  const draft = useRef(null);
  const pending = useRef(null);
  const writing = useRef(null);
  const csvWriting = useRef(null);
  const csvSequence = useRef(0);
  const lock = useRef(false);
  const active = useRef(null);
  const content = useRef("");
  const document = snapshot?.document;
  useEffect(() => {
    if (!snapshot || editing || draft.current) return;
    const value = snapshot.version.content;
    content.current = value;
    setBody(value);
    setEditorKey((key) => key + 1);
    if (snapshot.document.format === "csv") {
      void read("office.csv.decode", { content: value, delimiter: separator })
        .then((parsed) => {
          setRows(parsed.rows);
          setCompatible(true);
        })
        .catch((e) => {
          setRows([]);
          setCompatible(false);
          setError(e.message);
        });
    } else {
      setCompatible(false);
    }
  }, [document?.id, document?.revision, editing]);
  const cacheKey = (id) => `troop:office:${instance}:${id}:${actor.current}`;
  const read = (method, input) => clientModels.read(method, input);
  const command = (method, input) => clientModels.command(method, input);
  useEffect(() => {
    try {
      actor.current =
        sessionStorage.getItem("troop:office-window") || crypto.randomUUID();
      sessionStorage.setItem("troop:office-window", actor.current);
    } catch (error) {
      setError(`无法保存窗口草稿身份。${error.message}`);
    }
  }, []);
  useEffect(() => {
    if (!workspace && workspaces.length) setWorkspace(String(workspaces[0].id));
  }, [workspaces, workspace]);
  useEffect(() => {
    let active = true;
    setPendingContent("");
    if (document?.pending)
      void read("office.pending", { id: document.id })
        .then((pending) => {
          if (active) setPendingContent(pending?.content ?? "");
        })
        .catch((error) => {
          if (active) setError(error.message);
        });
    return () => {
      active = false;
    };
  }, [document?.id, document?.pending?.effect_id]);
  async function list(before) {
    if (!workspace) return;
    const result = await read("office.list", {
      workspace_id: Number(workspace),
      ...(before ? { before } : {}),
    });
    setFiles((old) =>
      before ? { ...result, items: [...old.items, ...result.items] } : result,
    );
  }
  useEffect(() => {
    if (ready && visible && workspace)
      void list().catch((e) => setError(e.message));
  }, [ready, visible, workspace]);
  async function refresh(id = active.current) {
    if (!id) return;
    const next = await read("office.get", {
      id,
      actor: actor.current,
      delimiter: separator,
    });
    if (active.current === id) setSnapshot(next);
    return next;
  }
  useEffect(() => {
    if (!ready || !visible || !active.current) return;
    const timer = setInterval(() => {
      void refresh().catch((e) => setError(e.message));
    }, 1500);
    return () => clearInterval(timer);
  }, [ready, visible, document?.id, separator]);
  async function action(fn) {
    if (lock.current || !ready) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function load(id) {
    if (csvWriting.current) await csvWriting.current.catch(() => {});
    csvWriting.current = null;
    await flush();
    active.current = id;
    setReference(null);
    setConflicts([]);
    setConflictSha(null);
    const next = await refresh(id);
    setWorkspace(String(next.document.workspace_id));
    setPath(next.document.path);
    const own = await read("office.draft.get", { id, actor: actor.current });
    const value = own?.content ?? next.version.content;
    draft.current = own;
    setEditing(Boolean(own));
    const recovered = [];
    const prefix = `troop:office:${instance}:${id}:`;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const local = JSON.parse(localStorage.getItem(key));
      if (
        typeof local.content === "string" &&
        (local.content !== value || local.csv_rows)
      ) {
        recovered.push({
          actor: `本机缓存 ${key.slice(prefix.length)}`,
          content: local.content,
          base_revision: local.base_revision,
          cached: true,
          csv_rows: local.csv_rows,
          delimiter: local.delimiter,
        });
      }
    }
    if (recovered.length) {
      setConflicts(recovered);
      setError(
        "发现未提交的本机窗口缓存，已保留原稿和缓存内容。请选择要接回的内容。",
      );
      setEditing(false);
    }
    content.current = value;
    setBody(value);
    if (next.document.format === "csv") {
      setRows([]);
      setCompatible(false);
      try {
        const parsed = await read("office.csv.decode", {
          content: value,
          delimiter: separator,
        });
        setRows(parsed.rows);
        setCompatible(true);
      } catch (error) {
        setError(error.message);
      }
    } else {
      setCompatible(false);
    }
    setHistory(await read("office.history", { id }));
    setEditorKey((key) => key + 1);
    setSaved(own ? "已恢复窗口草稿" : "已打开保存版本");
  }
  async function flush() {
    if (writing.current) await writing.current;
    if (!pending.current) return;
    const job = (async () => {
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        const saved = await command("office.draft.save", {
          id: next.id,
          actor: actor.current,
          expected_revision: draft.current?.revision ?? 0,
          base_revision: next.base,
          content: next.content,
        });
        draft.current = saved;
        setSaved("草稿已保存到 Core，文件尚未提交");
      }
    })();
    writing.current = job;
    try {
      await job;
    } finally {
      if (writing.current === job) writing.current = null;
    }
  }
  function change(value) {
    if (!editing || !document) return;
    try {
      const base = draft.current?.base_revision ?? document.revision;
      localStorage.setItem(
        cacheKey(document.id),
        JSON.stringify({ content: value, base_revision: base }),
      );
      content.current = value;
      setBody(value);
      setSaved("正在保存草稿…");
      pending.current = { id: document.id, base, content: value };
      void flush().catch((e) => {
        setError(e.message);
        setSaved("最新草稿仍在本机缓存，尚未提交 Core");
      });
    } catch (e) {
      setError(`草稿缓存不可用，编辑已暂停。${e.message}`);
      setEditing(false);
    }
  }
  async function begin(value = body) {
    if (!actor.current) throw Error("窗口草稿身份不可用。");
    const next = await refresh();
    if (next.document.pending) throw Error("请先核对前次文件写入。");
    if (!draft.current && next.document.revision !== document.revision)
      throw Error("文件已变化，请重新打开并查看当前版本后开始编辑。");
    const base = next.document.revision;
    localStorage.setItem(
      cacheKey(document.id),
      JSON.stringify({ content: value, base_revision: base }),
    );
    draft.current = await command("office.draft.save", {
      id: document.id,
      actor: actor.current,
      expected_revision: draft.current?.revision ?? 0,
      base_revision: base,
      content: value,
    });
    content.current = value;
    setBody(value);
    setEditing(true);
    setConflicts([]);
    if (document.format === "csv")
      setRows(
        (
          await read("office.csv.decode", {
            content: value,
            delimiter: separator,
          })
        ).rows,
      );
    setEditorKey((key) => key + 1);
    setSaved("编辑草稿已登记，Agent 覆盖已受保护");
  }
  async function submit(resolve = false, saveAs = false) {
    if (csvWriting.current) await csvWriting.current;
    await flush();
    const value = draft.current;
    if (!value || value.content !== content.current)
      throw Error("草稿保存尚未完成，请核对后重试。");
    const result = await command(
      saveAs ? "office.save_as" : "office.save",
      saveAs
        ? {
            id: document.id,
            actor: actor.current,
            draft_revision: value.revision,
            path,
          }
        : {
            id: document.id,
            actor: actor.current,
            draft_revision: value.revision,
            expected_revision: value.base_revision,
            ...(resolve ? { resolve_drafts_sha256: conflictSha } : {}),
          },
    );
    localStorage.removeItem(cacheKey(document.id));
    draft.current = null;
    setEditing(false);
    setConflicts([]);
    await load(result.id);
    await list();
  }
  async function csvChange(next, selectedDelimiter = separator) {
    try {
      const cached = JSON.stringify({
        content: content.current,
        base_revision: draft.current?.base_revision ?? document.revision,
        csv_rows: next,
        delimiter: selectedDelimiter,
      });
      if (new TextEncoder().encode(cached).length > 32000)
        throw Error("本机 CSV 草稿已达缓存上限，请缩小内容后继续。");
      localStorage.setItem(cacheKey(document.id), cached);
    } catch (error) {
      setError(error.message);
      return;
    }
    setRows(next);
    const sequence = ++csvSequence.current;
    const work = read("office.csv.encode", {
      rows: next,
      delimiter: selectedDelimiter,
      newline: body.includes("\r\n") ? "crlf" : "lf",
      bom: body.startsWith("\uFEFF"),
      trailing_newline: /\r?\n$/.test(body),
    }).then((encoded) => {
      if (sequence === csvSequence.current) {
        change(encoded.content);
        setCompatible(true);
        setError("");
      }
    });
    csvWriting.current = work;
    try {
      await work;
    } catch (error) {
      setCompatible(false);
      setError(error.message);
    }
  }
  const disabled = !ready || busy;
  const stale = editing && draft.current?.base_revision !== document?.revision;
  return (
    <section className="agent-page office-page" aria-label="文件办公">
      <h1>文件办公</h1>
      <p className="muted">Markdown 与 CSV · 固定版本、窗口草稿与内容引用</p>
      <p className="muted">
        支持 UTF-8 文件，单个文件最多 8000 字节。CSV 最多 200 行、50 列、2000
        个单元格。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <form
        className="office-open"
        onSubmit={(event) => {
          event.preventDefault();
          void action(async () => {
            const opened = await command("office.open", {
              workspace_id: Number(workspace),
              path,
            });
            await load(opened.document.id);
            await list();
          });
        }}
      >
        <label>
          工作区
          <select
            aria-label="办公工作区"
            value={workspace}
            disabled={disabled || editing}
            onChange={(e) => {
              setWorkspace(e.target.value);
              setSnapshot(null);
              active.current = null;
            }}
          >
            <option value="">请选择工作区</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          工作区内文件路径
          <input
            aria-label="办公文件路径"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="notes.md 或 table.csv"
          />
        </label>
        <button disabled={disabled || !workspace || !path}>打开或新建</button>
      </form>
      <div className="office-layout">
        <aside aria-label="办公文件列表">
          <h2>已登记文件</h2>
          {files.items.length === 0 && (
            <p className="muted">输入 Markdown 或 CSV 路径开始。</p>
          )}
          {files.items.map((file) => (
            <button
              className="agent-row"
              key={file.id}
              disabled={disabled}
              onClick={() => void action(() => load(file.id))}
            >
              {file.path}
              <small>版本 {file.revision}</small>
            </button>
          ))}
          {files.next_before && (
            <button onClick={() => void action(() => list(files.next_before))}>
              更多文件
            </button>
          )}
        </aside>
        <div className="office-detail">
          {document && (
            <>
              <header className="office-heading">
                <h2>{document.path}</h2>
                <span>
                  版本 {document.revision} ·{" "}
                  {document.sha256 === "missing"
                    ? "尚未创建文件"
                    : document.sha256.slice(0, 12)}
                </span>
              </header>
              <p role="status">
                {saved}
                {stale ? " · 文件已有新版本，请核对后重新确定草稿基线" : ""}
              </p>
              <div className="office-tools">
                {!editing && (
                  <button
                    disabled={
                      disabled || !compatible || Boolean(document.pending)
                    }
                    onClick={() => void action(() => begin())}
                  >
                    开始编辑
                  </button>
                )}
                {editing && (
                  <>
                    <button
                      disabled={
                        disabled ||
                        !compatible ||
                        stale ||
                        snapshot.external_changed
                      }
                      onClick={() => void action(() => submit())}
                    >
                      保存文件
                    </button>
                    <button
                      disabled={disabled || !path}
                      onClick={() => void action(() => submit(false, true))}
                    >
                      将草稿另存到输入路径
                    </button>
                    <button
                      disabled={disabled}
                      onClick={() =>
                        void action(async () => {
                          if (csvWriting.current)
                            await csvWriting.current.catch(() => {});
                          csvWriting.current = null;
                          await flush();
                          await command("office.draft.discard", {
                            id: document.id,
                            actor: actor.current,
                            expected_revision: draft.current.revision,
                          });
                          draft.current = null;
                          localStorage.removeItem(cacheKey(document.id));
                          setEditing(false);
                          await load(document.id);
                        })
                      }
                    >
                      放弃本窗口草稿
                    </button>
                  </>
                )}
                {stale && (
                  <button
                    disabled={disabled}
                    onClick={() => void action(() => begin(content.current))}
                  >
                    保留此稿并以当前版本继续
                  </button>
                )}
              </div>
              {document.pending && (
                <section className="agent-card">
                  <h3>前次写入等待核对</h3>
                  <pre className="office-original">{pendingContent}</pre>
                  <p>当前落盘摘要 {snapshot.external.sha256}</p>
                  <button
                    disabled={
                      disabled ||
                      snapshot.external.sha256 !== document.pending.sha256
                    }
                    onClick={() =>
                      void action(async () => {
                        await command("office.reconcile", {
                          id: document.id,
                          effect_id: document.pending.effect_id,
                          expected_disk_sha256: snapshot.external.sha256,
                          decision: "accept",
                        });
                        await load(document.id);
                      })
                    }
                  >
                    确认已落盘版本
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void action(async () => {
                        await command("office.reconcile", {
                          id: document.id,
                          effect_id: document.pending.effect_id,
                          expected_disk_sha256: snapshot.external.sha256,
                          decision: "preserve",
                        });
                        await load(document.id);
                      })
                    }
                  >
                    保留提议并解除待核对状态
                  </button>
                </section>
              )}
              {snapshot.external_changed && (
                <section className="agent-card">
                  <h3>检测到外部修改</h3>
                  <div className="office-comparison">
                    <div>
                      <h4>当前稿件</h4>
                      <pre>{body}</pre>
                    </div>
                    <div>
                      <h4>外部文件</h4>
                      <pre>
                        {snapshot.external.sha256 === "missing"
                          ? "文件已被删除"
                          : snapshot.external.content}
                      </pre>
                    </div>
                  </div>
                  <button
                    disabled={disabled || Boolean(document.pending)}
                    onClick={() =>
                      void action(async () => {
                        await command("office.capture_external", {
                          id: document.id,
                          expected_revision: document.revision,
                          expected_sha256: snapshot.external.sha256,
                        });
                        await refresh();
                        setHistory(
                          await read("office.history", { id: document.id }),
                        );
                      })
                    }
                  >
                    登记外部版本并保留草稿
                  </button>
                </section>
              )}
              {document.format === "markdown" ? (
                snapshot.unsupported_features?.length ? (
                  <>
                    <p role="alert">
                      当前编辑器无法保真处理{" "}
                      {snapshot.unsupported_features.join("、")}，原文已保留。
                    </p>
                    <pre className="office-original">{body}</pre>
                  </>
                ) : (
                  <OfficeMarkdown
                    key={editorKey}
                    content={body}
                    editable={editing && !disabled}
                    onChange={change}
                    onCompatible={setCompatible}
                  />
                )
              ) : (
                <>
                  <label>
                    CSV 分隔符
                    <select
                      value={separator}
                      disabled={disabled || editing}
                      onChange={(e) => {
                        const next = e.target.value;
                        setSeparator(next);
                        void action(async () => {
                          const parsed = await read("office.csv.decode", {
                            content: body,
                            delimiter: next,
                          });
                          setRows(parsed.rows);
                          setCompatible(true);
                        });
                      }}
                    >
                      <option value=",">逗号</option>
                      <option value=";">分号</option>
                      <option value="\t">制表符</option>
                    </select>
                  </label>
                  <div className="office-table-scroll">
                    <table className="office-table">
                      <tbody>
                        {rows.map((row, r) => (
                          <tr key={r}>
                            <th scope="row">{r + 1}</th>
                            {row.map((cell, c) => (
                              <td key={c}>
                                <textarea
                                  rows={2}
                                  aria-label={`单元格 ${r + 1},${c + 1}`}
                                  disabled={!editing || disabled}
                                  value={cell}
                                  onChange={(e) => {
                                    const next = rows.map((row) => [...row]);
                                    next[r][c] = cell.includes("\r\n")
                                      ? e.target.value.replace(/\r?\n/g, "\r\n")
                                      : e.target.value;
                                    void csvChange(next);
                                  }}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {editing && (
                    <div className="office-tools">
                      <button
                        disabled={disabled}
                        onClick={() =>
                          void action(() =>
                            csvChange([
                              ...rows,
                              Array(rows[0]?.length ?? 1).fill(""),
                            ]),
                          )
                        }
                      >
                        增加行
                      </button>
                      <button
                        disabled={disabled || !rows.length}
                        onClick={() =>
                          void action(() => csvChange(rows.slice(0, -1)))
                        }
                      >
                        删除末行
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() =>
                          void action(() =>
                            csvChange(
                              rows.length
                                ? rows.map((row) => [...row, ""])
                                : [[""]],
                            ),
                          )
                        }
                      >
                        增加列
                      </button>
                      <button
                        disabled={disabled || !rows[0]?.length}
                        onClick={() =>
                          void action(() =>
                            csvChange(rows.map((row) => row.slice(0, -1))),
                          )
                        }
                      >
                        删除末列
                      </button>
                    </div>
                  )}
                </>
              )}
              <section className="office-secondary">
                <h3>冲突草稿</h3>
                <p>{snapshot.drafts.length} 份窗口草稿</p>
                <button
                  disabled={disabled}
                  onClick={() =>
                    void action(async () => {
                      const observed = await refresh();
                      const values = await Promise.all(
                        observed.drafts
                          .filter((d) => d.actor !== actor.current)
                          .map((d) =>
                            read("office.draft.get", {
                              id: document.id,
                              actor: d.actor,
                            }),
                          ),
                      );
                      setConflicts(values);
                      setConflictSha(observed.foreign_drafts_sha256);
                    })
                  }
                >
                  查看其他窗口内容
                </button>
                {conflicts.map((value) => (
                  <div key={value.actor}>
                    <p>
                      基线版本 {value.base_revision} · {value.actor}
                    </p>
                    <div className="office-comparison">
                      <pre>{body}</pre>
                      <pre>
                        {value.csv_rows
                          ? JSON.stringify(value.csv_rows, null, 2)
                          : value.content}
                      </pre>
                    </div>
                    {value.cached && (
                      <button
                        disabled={disabled}
                        onClick={() =>
                          void action(async () => {
                            if (value.delimiter) setSeparator(value.delimiter);
                            await begin(value.content);
                            if (value.csv_rows)
                              await csvChange(
                                value.csv_rows,
                                value.delimiter ?? separator,
                              );
                          })
                        }
                      >
                        接回本窗口缓存内容
                      </button>
                    )}
                    {!value.cached && value.revision && (
                      <button
                        disabled={disabled}
                        onClick={() =>
                          void action(async () => {
                            await command("office.draft.discard", {
                              id: document.id,
                              actor: value.actor,
                              expected_revision: value.revision,
                            });
                            localStorage.removeItem(
                              `troop:office:${instance}:${document.id}:${value.actor}`,
                            );
                            setConflicts((old) =>
                              old.filter(
                                (draft) => draft.actor !== value.actor,
                              ),
                            );
                            setConflictSha(null);
                            await refresh();
                          })
                        }
                      >
                        确认放弃这份已查看草稿
                      </button>
                    )}
                  </div>
                ))}
                {editing && conflictSha && conflicts.some((d) => !d.cached) && (
                  <button
                    disabled={disabled || stale || snapshot.external_changed}
                    onClick={() => void action(() => submit(true))}
                  >
                    确认保留其他草稿并提交本窗口内容
                  </button>
                )}
              </section>
              <section className="office-secondary">
                <h3>固定内容引用</h3>
                <p>
                  选择已保存版本 {document.revision} 的
                  {document.format === "csv" ? "行列区域" : "内容块"}，编号从 1
                  开始，结束位置包含在内。
                </p>
                <div className="office-tools">
                  {[
                    "start",
                    "end",
                    ...(document.format === "csv"
                      ? ["column_start", "column_end"]
                      : []),
                  ].map((key) => (
                    <label key={key}>
                      {
                        {
                          start: "起始行／块",
                          end: "结束行／块",
                          column_start: "起始列",
                          column_end: "结束列",
                        }[key]
                      }
                      <input
                        type="number"
                        min="1"
                        value={selection[key] + (key.endsWith("start") ? 1 : 0)}
                        onChange={(e) =>
                          setSelection({
                            ...selection,
                            [key]:
                              Number(e.target.value) -
                              (key.endsWith("start") ? 1 : 0),
                          })
                        }
                      />
                    </label>
                  ))}
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void action(async () => {
                        const value = await command("office.reference.create", {
                          id: document.id,
                          revision: document.revision,
                          kind:
                            document.format === "csv" ? "cells" : "paragraphs",
                          start: selection.start,
                          end: selection.end,
                          ...(document.format === "csv"
                            ? {
                                column_start: selection.column_start,
                                column_end: selection.column_end,
                                delimiter: separator,
                              }
                            : {}),
                        });
                        setReference(value);
                      })
                    }
                  >
                    固定所选内容
                  </button>
                </div>
                {reference && (
                  <>
                    <p>
                      引用版本 {reference.revision}
                      {reference.revision !== document.revision ||
                      snapshot.external_changed
                        ? " · 已过期，保留原内容"
                        : " · 当前版本"}
                    </p>
                    <pre className="office-original">{reference.content}</pre>
                    <button onClick={() => onRunReference(reference)}>
                      交给授权执行
                    </button>
                    <button onClick={() => onReference(reference)}>
                      交给对话
                    </button>
                  </>
                )}
              </section>
              <section className="office-secondary">
                <h3>版本历史</h3>
                {history.items.map((version) => (
                  <div className="office-version" key={version.revision}>
                    <span>
                      版本 {version.revision} · {version.reason ?? "首次登记"}
                    </span>
                    <button
                      disabled={disabled}
                      onClick={() =>
                        void action(async () => {
                          const old = await read("office.version", {
                            id: document.id,
                            revision: version.revision,
                          });
                          setConflicts([
                            {
                              actor: `历史版本 ${version.revision}`,
                              content: old.content,
                              base_revision: version.revision,
                            },
                          ]);
                        })
                      }
                    >
                      查看正文
                    </button>
                    <button
                      disabled={disabled || Boolean(document.pending)}
                      onClick={() =>
                        void action(async () => {
                          await flush();
                          await command("office.restore", {
                            id: document.id,
                            expected_revision: document.revision,
                            source_revision: version.revision,
                            actor: actor.current,
                          });
                          await refresh();
                          setHistory(
                            await read("office.history", { id: document.id }),
                          );
                          if (!editing) await load(document.id);
                        })
                      }
                    >
                      恢复为新版本
                    </button>
                  </div>
                ))}
                {history.next_before != null && (
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void action(async () => {
                        const older = await read("office.history", {
                          id: document.id,
                          before: history.next_before,
                        });
                        setHistory({
                          ...older,
                          items: [...history.items, ...older.items],
                        });
                      })
                    }
                  >
                    更早版本
                  </button>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
