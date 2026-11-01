import React, { useState } from "react";
import { call } from "./api";
const labels = {
  chat_completions: "OpenAI 兼容 · Chat Completions",
  responses: "OpenAI Responses",
  anthropic: "Anthropic Messages",
};
const empty = {
  name: "",
  protocol: "chat_completions",
  base_url: "",
  model: "",
  max_output_tokens: 1024,
  idle_timeout_secs: 60,
  legacy_max_tokens: false,
};
export default function ModelSettings({ ready, providers, onSaved }) {
  const [editing, setEditing] = useState(null),
    [config, setConfig] = useState({ ...empty }),
    [key, setKey] = useState(""),
    [clearKey, setClearKey] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const change = (field, value) =>
    setConfig((old) => ({ ...old, [field]: value }));
  function edit(provider) {
    setEditing(provider);
    setConfig(provider ? { ...provider.config } : { ...empty });
    setKey("");
    setClearKey(false);
    setError("");
    setNotice("");
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await call(
        window.troop.saveProvider({
          id: editing?.id ?? null,
          config,
          api_key: key ? key : null,
          clear_key: clearKey,
        }),
      );
      setKey("");
      setClearKey(false);
      setEditing(saved);
      setNotice("模型服务已保存。");
      await onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id) {
    setBusy(true);
    setError("");
    try {
      const result = await call(window.troop.removeProvider(id));
      if (!result.removed) return;
      await onSaved();
      if (editing?.id === id) edit(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const suffix = {
    chat_completions: "chat/completions",
    responses: "responses",
    anthropic: "messages",
  }[config.protocol];
  return (
    <div className="models-page">
      <div className="title-row">
        <div>
          <h1>模型服务</h1>
          <p>选择对话使用的服务地址和模型。</p>
        </div>
        <button disabled={!ready || busy} onClick={() => edit(null)}>
          添加服务
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="save-notice" role="status">
          {notice}
        </p>
      )}
      <div className="models-layout">
        <section className="provider-library" aria-label="已保存的模型服务">
          <h2>已保存的服务</h2>
          {providers.length === 0 ? (
            <p className="muted">
              尚未配置模型。先填写右侧信息，保存后即可开始对话。
            </p>
          ) : (
            <ul>
              {providers.map((provider) => (
                <li
                  key={provider.id}
                  className={editing?.id === provider.id ? "chosen" : ""}
                >
                  <button
                    className="provider-choice"
                    onClick={() => edit(provider)}
                    disabled={busy}
                  >
                    <strong>{provider.config.name}</strong>
                    <span>{provider.config.model}</span>
                    <small>{labels[provider.config.protocol]}</small>
                  </button>
                  <button
                    className="quiet"
                    disabled={!ready || busy}
                    onClick={() => remove(provider.id)}
                    aria-label={"删除服务 " + provider.config.name}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="provider-explanation">
            可接入兼容服务或你已运行的
            Magpie。仅在发送消息后连接所选服务，不自动切换提供方。
          </p>
        </section>
        <form className="provider-form" onSubmit={save}>
          <fieldset disabled={!ready || busy}>
            <legend>{editing ? "编辑模型服务" : "添加模型服务"}</legend>
            <label htmlFor="provider-name">服务名称</label>
            <input
              id="provider-name"
              value={config.name}
              onChange={(e) => change("name", e.target.value)}
              maxLength={80}
              required
              placeholder="为这个服务取一个名称"
            />
            <label htmlFor="provider-protocol">服务协议</label>
            <select
              id="provider-protocol"
              value={config.protocol}
              onChange={(e) => change("protocol", e.target.value)}
            >
              {Object.entries(labels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="provider-url">基础地址</label>
            <input
              id="provider-url"
              type="url"
              value={config.base_url}
              onChange={(e) => change("base_url", e.target.value)}
              maxLength={2000}
              required
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
            />
            <p className="field-hint endpoint-preview">
              {config.base_url
                ? `${config.base_url.replace(/\/+$/, "")}/${suffix}`
                : "填写服务提供方给出的基础地址，通常以 /v1 结尾。"}
            </p>
            <label htmlFor="provider-model">模型 ID</label>
            <input
              id="provider-model"
              value={config.model}
              onChange={(e) => change("model", e.target.value)}
              maxLength={200}
              required
              placeholder="填写此服务可用的模型 ID"
              spellCheck={false}
            />
            <label htmlFor="provider-key">API 密钥</label>
            <input
              id="provider-key"
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setClearKey(false);
              }}
              maxLength={2500}
              autoComplete="off"
              placeholder={
                editing?.has_key
                  ? "已保存；留空保留原密钥"
                  : "本机免密服务可以留空"
              }
            />
            <p className="field-hint">
              密钥保存到 Windows 凭据存储，保存后不回显。
            </p>
            {editing?.has_key && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(e) => {
                    setClearKey(e.target.checked);
                    if (e.target.checked) setKey("");
                  }}
                />
                移除已保存的密钥
              </label>
            )}
            <details>
              <summary>更多选项</summary>
              {config.protocol === "chat_completions" && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={Boolean(config.legacy_max_tokens)}
                    onChange={(e) =>
                      change("legacy_max_tokens", e.target.checked)
                    }
                  />
                  兼容旧版输出参数（max_tokens）
                </label>
              )}
              <label htmlFor="provider-output">最大输出 token</label>
              <input
                id="provider-output"
                type="number"
                min={64}
                max={8192}
                value={config.max_output_tokens}
                onChange={(e) =>
                  change("max_output_tokens", Number(e.target.value))
                }
              />
              <label htmlFor="provider-timeout">无数据等待时限（秒）</label>
              <input
                id="provider-timeout"
                type="number"
                min={5}
                max={300}
                value={config.idle_timeout_secs}
                onChange={(e) =>
                  change("idle_timeout_secs", Number(e.target.value))
                }
              />
            </details>
            <button className="primary" type="submit">
              {busy ? "正在保存…" : "保存模型服务"}
            </button>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
