import React, { useEffect, useRef, useState } from "react";
import { schemaBranch, schemaDefault } from "./schema-values.mjs";

const labels = {
  server_id: "MCP 服务 ID",
  tool: "MCP 工具名",
  name: "名称",
  kind: "平台类型",
  project: "平台项目",
  workspace_id: "工作区 ID",
  project_ids: "项目范围",
  enabled: "启用",
  mode: "接收方式",
  api_base_url: "平台 API 地址",
  consumer_id: "Core 消费者身份",
  receiver_url: "独立接收器地址",
  receiver_instance: "独立接收器身份",
  auth_mode: "接收认证方式",
  ttl_seconds: "事件有效期（秒）",
  event: "触发事件",
  source_run_id: "限定来源 Run ID",
  source_id: "来源 ID",
  event_state: "事件状态条件",
  source_work_item_id: "前置工作项 ID",
  work_item_id: "后续工作项 ID",
  work_definition_revision: "工作定义修订",
  expires_at: "有效期限（Unix 秒）",
  start: "执行目标",
  client_run_id: "执行幂等身份",
  agent_id: "Agent ID",
  provider_id: "模型配置 ID",
  goal: "执行目标",
  authorization_id: "授权 ID",
  action: "直接工具动作",
  arguments: "动作参数",
  engine_id: "CLI 引擎",
  tool_mode: "工具模式",
  approval_mode: "审批模式",
  timeout_seconds: "执行时限（秒）",
  human_wait_seconds: "人工等待时限（秒）",
  startup_timeout_seconds: "初始化时限（秒）",
  workflow_id: "工作流 ID",
  rule_id: "授权绑定规则 ID",
  rule_management_authorization_id: "规则管理授权 ID",
  office_reference_ids: "固定办公引用 ID",
  path: "文件路径",
  content: "内容",
  expected_hash: "预期文件摘要",
  native_transport: "接入协议",
  collaboration_mode: "协作方式",
  expected_plan_sha256: "预期权限计划摘要",
  continuation_of: "延续来源",
  max_depth: "自动链深度",
  max_writes_per_hour: "同一对象每小时写动作上限",
  cooldown_seconds: "同类动作冷却（秒）",
  retention_seconds: "在线回执保留期（秒）",
};

function JsonField({ value, onChange, id, label, disabled, schema }) {
  const serialized = JSON.stringify(value ?? {});
  const last = useRef(serialized),
    field = useRef(null);
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  useEffect(() => {
    if (last.current !== serialized) {
      last.current = serialized;
      setText(JSON.stringify(value ?? {}, null, 2));
      field.current?.setCustomValidity("");
    }
  }, [serialized, value]);
  return (
    <div className="schema-field">
      <label htmlFor={id}>{label} JSON</label>
      <textarea
        data-schema-json
        ref={field}
        id={id}
        rows={6}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          try {
            const parsed = JSON.parse(event.target.value);
            last.current = JSON.stringify(parsed);
            event.target.setCustomValidity("");
            onChange(parsed);
          } catch {
            event.target.setCustomValidity(
              "请输入有效的 JSON；未保存的文本已保留。",
            );
          }
        }}
      />
      <p className="field-hint">{schema.description}</p>
    </div>
  );
}

export function validateSchemaFields(id) {
  const fields = [
    ...document.getElementById(id).querySelectorAll("input,select,textarea"),
  ];
  const invalid = fields.find((field) => !field.checkValidity());
  if (invalid) {
    invalid.reportValidity();
    return false;
  }
  return true;
}

function Field({ schema, value, onChange, id, label, disabled }) {
  if (schema["x-editor"] === "json")
    return (
      <JsonField
        schema={schema}
        value={value}
        onChange={onChange}
        id={id}
        label={label}
        disabled={disabled}
      />
    );
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const selected = schemaBranch(schema, value);
    const index = branches.indexOf(selected);
    return (
      <div className="schema-field">
        <label htmlFor={`${id}-type`}>{label} 类型</label>
        <select
          id={`${id}-type`}
          disabled={disabled}
          value={index}
          onChange={(event) =>
            onChange(schemaDefault(branches[Number(event.target.value)], value))
          }
        >
          {branches.map((branch, index) => (
            <option key={index} value={index}>
              {branch.title === "Start"
                ? "原生 Agent / 直接工具"
                : branch.title === "CliStart"
                  ? "外部 CLI"
                  : branch.type === "null"
                    ? "不限定"
                    : (branch.title ?? branch.type ?? `类型 ${index + 1}`)}
            </option>
          ))}
        </select>
        {selected.type !== "null" && (
          <Field
            schema={selected}
            value={value}
            onChange={onChange}
            id={id}
            label={label}
            disabled={disabled}
          />
        )}
      </div>
    );
  }
  if (schema.enum)
    return (
      <div className="schema-field">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          disabled={disabled}
          value={value ?? ""}
          onChange={(event) =>
            onChange(
              schema.enum.find((value) => String(value) === event.target.value),
            )
          }
        >
          {!schema.enum.includes(value) && (
            <option value={value ?? ""}>{value ?? "请选择"}</option>
          )}
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </div>
    );
  if (schema.type === "object") {
    const object =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const unknown = Object.keys(object).filter(
      (key) => !schema.properties?.[key],
    );
    return (
      <fieldset
        className="schema-object"
        data-schema-path={id}
        disabled={disabled}
      >
        <legend>{label}</legend>
        {Object.entries(schema.properties ?? {}).map(([key, field]) => {
          const optional = !schema.required?.includes(key);
          const present = object[key] !== undefined;
          return (
            <div key={key} className="schema-field">
              {optional && (
                <label className="schema-option">
                  <input
                    id={`${id}.${key}-enabled`}
                    type="checkbox"
                    checked={present}
                    disabled={field.readOnly}
                    onChange={(event) => {
                      const next = { ...object };
                      if (event.target.checked)
                        next[key] = schemaDefault(field);
                      else delete next[key];
                      onChange(next);
                    }}
                  />
                  {labels[key] ?? key}（可选）
                </label>
              )}
              {(!optional || present) && (
                <Field
                  schema={field}
                  value={object[key]}
                  id={`${id}.${key}`}
                  label={labels[key] ?? key}
                  disabled={disabled || field.readOnly}
                  onChange={(next) => onChange({ ...object, [key]: next })}
                />
              )}
            </div>
          );
        })}
        {unknown.length > 0 && (
          <details>
            <summary>保留的扩展字段（{unknown.length}）</summary>
            <pre>
              {JSON.stringify(
                Object.fromEntries(unknown.map((key) => [key, object[key]])),
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </fieldset>
    );
  }
  if (schema.type === "array") {
    const rows = Array.isArray(value) ? value : [];
    return (
      <fieldset
        className="schema-array"
        data-schema-path={id}
        disabled={disabled}
      >
        <legend>{label}</legend>
        {rows.map((item, index) => (
          <div className="schema-array-row" key={index}>
            <Field
              schema={schema.items}
              value={item}
              id={`${id}.${index}`}
              label={`${label} ${index + 1}`}
              disabled={disabled}
              onChange={(item) =>
                onChange(
                  rows.map((old, position) =>
                    position === index ? item : old,
                  ),
                )
              }
            />
            <button
              type="button"
              onClick={() =>
                onChange(rows.filter((_, position) => position !== index))
              }
            >
              移除
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...rows, schemaDefault(schema.items)])}
        >
          添加{label}
        </button>
      </fieldset>
    );
  }
  if (schema.type === "boolean")
    return (
      <label className="schema-option" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    );
  if (schema.type === "null") return null;
  const numeric = schema.type === "number" || schema.type === "integer";
  if (!schema.type && value && typeof value === "object")
    return (
      <div>
        <p>{label}的扩展内容已保留。</p>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </div>
    );
  return (
    <div className="schema-field">
      <label htmlFor={id}>{label}</label>
      {!numeric && (label === "内容" || label === "执行目标") ? (
        <textarea
          id={id}
          rows={3}
          disabled={disabled}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          disabled={disabled}
          type={numeric ? "number" : "text"}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.type === "integer" ? 1 : undefined}
          value={value ?? ""}
          onChange={(event) =>
            onChange(
              numeric && event.target.value !== ""
                ? Number(event.target.value)
                : event.target.value,
            )
          }
        />
      )}
    </div>
  );
}

export default function SchemaForm({
  schema,
  value,
  onChange,
  id,
  disabled,
  label = "配置",
}) {
  return (
    <div id={id} className="schema-form">
      <Field
        schema={schema}
        value={value}
        onChange={onChange}
        id={id}
        label={label}
        disabled={disabled}
      />
    </div>
  );
}
