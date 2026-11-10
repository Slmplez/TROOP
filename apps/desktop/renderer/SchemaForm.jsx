import {
  parseDocument,
  resolveSchema,
  ruleSchema,
  sourceSchema,
  updateField,
  validateRule,
  validateSource,
} from "./schema-form.mjs";

const controlStyle = { width: "100%", boxSizing: "border-box" };

function errorFor(errors, path) {
  return errors.find((error) => error.path === path)?.message ?? "";
}

function Fields({ schema, value, onChange, disabled, idPrefix, errors }) {
  return (
    <Node
      schema={schema}
      value={value}
      parentValue={null}
      path=""
      rootSchema={schema}
      rootValue={value}
      onChange={onChange}
      disabled={disabled}
      idPrefix={idPrefix}
      errors={errors}
    />
  );
}

function Node({
  schema,
  value,
  parentValue,
  path,
  rootSchema,
  rootValue,
  onChange,
  disabled,
  idPrefix,
  errors,
}) {
  if (
    schema.type === "variant-object" &&
    !schema.variants?.[parentValue?.[schema.switch]]
  ) {
    return <p>此工具没有结构化参数，请在高级 JSON 中编辑参数。</p>;
  }
  const resolved = resolveSchema(schema, parentValue);
  if (resolved.type === "object") {
    return (
      <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        {path && resolved.title ? <legend>{resolved.title}</legend> : null}
        {Object.entries(resolved.properties).map(([key, child]) => (
          <Node
            key={key}
            schema={child}
            value={value?.[key]}
            parentValue={value}
            path={path ? `${path}.${key}` : key}
            rootSchema={rootSchema}
            rootValue={rootValue}
            onChange={onChange}
            disabled={disabled}
            idPrefix={idPrefix}
            errors={errors}
          />
        ))}
      </fieldset>
    );
  }
  if (resolved.type === "variant-object") {
    const variant = resolveSchema(resolved, parentValue);
    if (!resolved.variants?.[parentValue?.[resolved.switch]]) {
      return <p>此工具没有结构化参数，请在高级 JSON 中编辑参数。</p>;
    }
    return (
      <Node
        schema={variant}
        value={value}
        parentValue={parentValue}
        path={path}
        rootSchema={rootSchema}
        rootValue={rootValue}
        onChange={onChange}
        disabled={disabled}
        idPrefix={idPrefix}
        errors={errors}
      />
    );
  }
  const id = `${idPrefix}-${path.replaceAll(".", "-")}`;
  const message = errorFor(errors, path);
  const describedBy = message ? `${id}-error` : undefined;
  const label = (
    <label htmlFor={id} style={{ display: "block", marginTop: 8 }}>
      {resolved.title}
      {resolved.description ? <span> · {resolved.description}</span> : null}
    </label>
  );
  let control;
  if (resolved.type === "boolean") {
    control = (
      <input
        id={id}
        type="checkbox"
        disabled={disabled}
        checked={value === true}
        aria-invalid={Boolean(message)}
        aria-describedby={describedBy}
        onChange={(event) =>
          onChange(
            updateField(rootSchema, rootValue, path, event.target.checked),
          )
        }
      />
    );
  } else if (resolved.enum || resolved.suggestions) {
    const options = [...(resolved.enum || resolved.suggestions)];
    if (typeof value === "string" && value && !options.includes(value))
      options.unshift(value);
    control = (
      <select
        id={id}
        style={controlStyle}
        disabled={disabled}
        value={value ?? ""}
        aria-invalid={Boolean(message)}
        aria-describedby={describedBy}
        onChange={(event) =>
          onChange(updateField(rootSchema, rootValue, path, event.target.value))
        }
      >
        {resolved.nullable ? <option value="">不设置</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  } else if (resolved.type === "integer") {
    control = (
      <input
        id={id}
        type="number"
        style={controlStyle}
        disabled={disabled}
        value={value ?? ""}
        placeholder={resolved.default ?? ""}
        aria-invalid={Boolean(message)}
        aria-describedby={describedBy}
        onChange={(event) =>
          onChange(updateField(rootSchema, rootValue, path, event.target.value))
        }
      />
    );
  } else if (resolved.type === "array") {
    control = (
      <input
        id={id}
        type="text"
        style={controlStyle}
        disabled={disabled}
        value={Array.isArray(value) ? value.join(", ") : ""}
        placeholder="用逗号分隔"
        aria-invalid={Boolean(message)}
        aria-describedby={describedBy}
        onChange={(event) =>
          onChange(updateField(rootSchema, rootValue, path, event.target.value))
        }
      />
    );
  } else {
    control = (
      <input
        id={id}
        type="text"
        style={controlStyle}
        disabled={disabled}
        value={value ?? ""}
        placeholder={resolved.default ?? ""}
        aria-invalid={Boolean(message)}
        aria-describedby={describedBy}
        onChange={(event) =>
          onChange(updateField(rootSchema, rootValue, path, event.target.value))
        }
      />
    );
  }
  return (
    <div>
      {resolved.type === "boolean" ? (
        <label htmlFor={id} style={{ display: "block", marginTop: 8 }}>
          {control} {resolved.title}
        </label>
      ) : (
        <>
          {label}
          {control}
        </>
      )}
      {message ? (
        <p id={describedBy} role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function JsonFallback({ id, label, text, onText, disabled, rows }) {
  return (
    <details>
      <summary>高级 JSON</summary>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={rows}
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "monospace",
        }}
        disabled={disabled}
        value={text}
        onChange={(event) => onText(event.target.value)}
      />
    </details>
  );
}

function Editor({
  text,
  onText,
  disabled,
  label,
  jsonId,
  schema,
  validateDocument,
  idPrefix,
  rows,
}) {
  const parsed = parseDocument(text, label);
  const errors = parsed.ok ? validateDocument(parsed.value) : [];
  return (
    <>
      {parsed.ok ? (
        <Fields
          schema={schema}
          value={parsed.value}
          disabled={disabled}
          idPrefix={idPrefix}
          errors={errors}
          onChange={(value) => onText(JSON.stringify(value, null, 2))}
        />
      ) : (
        <p role="alert">{parsed.message}</p>
      )}
      <JsonFallback
        id={jsonId}
        label={`${label} JSON`}
        text={text}
        onText={onText}
        disabled={disabled}
        rows={rows}
      />
    </>
  );
}

export function SourceDefinitionEditor(props) {
  return (
    <Editor
      {...props}
      label="来源配置"
      jsonId="event-source-definition"
      schema={sourceSchema}
      validateDocument={validateSource}
      idPrefix="event-source"
      rows={12}
    />
  );
}

export function RuleDefinitionEditor(props) {
  return (
    <Editor
      {...props}
      label="规则配置"
      jsonId="rule-definition"
      schema={ruleSchema}
      validateDocument={validateRule}
      idPrefix="rule"
      rows={12}
    />
  );
}
