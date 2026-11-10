// Schemas mirror Core's event-source and rule-action contracts. The form is
// generated from these objects; advanced JSON remains available beside them.

const EVENTS = [
  "work.accepted",
  "run.completed",
  "run.failed",
  "github.workflow.completed",
  "github.issue.changed",
  "github.pull_request.changed",
  "gitlab.pipeline.changed",
  "gitlab.issue.changed",
  "gitlab.merge_request.changed",
  "webhook.changed",
];

const stringArg = (title) => ({
  type: "string",
  title,
  minLength: 1,
});

export const toolArgumentSchemas = {
  read_file: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: stringArg("路径") },
  },
  write_file: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content", "expected_hash"],
    properties: {
      path: stringArg("路径"),
      content: { type: "string", title: "内容" },
      expected_hash: stringArg("预期哈希"),
    },
  },
  list_directory: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: stringArg("路径") },
  },
  search_text: {
    type: "object",
    additionalProperties: false,
    required: ["path", "text"],
    properties: { path: stringArg("路径"), text: stringArg("文本") },
  },
  office_read: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: stringArg("路径") },
  },
  office_edit: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content", "expected_hash", "expected_revision"],
    properties: {
      path: stringArg("路径"),
      content: { type: "string", title: "内容" },
      expected_hash: stringArg("预期哈希"),
      expected_revision: stringArg("预期修订"),
    },
  },
  run_command: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: { command: stringArg("命令") },
  },
  git_status: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {},
  },
};

const toolNames = Object.keys(toolArgumentSchemas);

export const sourceSchema = {
  type: "object",
  title: "事件来源",
  additionalProperties: false,
  required: [
    "name",
    "kind",
    "project",
    "workspace_id",
    "enabled",
    "mode",
    "api_base_url",
    "consumer_id",
  ],
  properties: {
    name: { type: "string", title: "名称", minLength: 1, maxLength: 120 },
    kind: {
      type: "string",
      title: "平台",
      enum: ["github", "gitlab", "webhook"],
      default: "github",
    },
    project: {
      type: "string",
      title: "项目",
      minLength: 1,
      maxLength: 200,
      control: false,
    },
    workspace_id: { type: "integer", title: "工作区", minimum: 1, default: 1 },
    project_ids: {
      type: "array",
      title: "项目范围",
      maxItems: 16,
      items: { type: "string", format: "slug" },
      default: [],
    },
    enabled: { type: "boolean", title: "启用", default: false },
    mode: {
      type: "string",
      title: "接收模式",
      enum: ["local", "remote"],
      default: "local",
      description: "remote 需要接收器地址和身份。",
    },
    api_base_url: {
      type: "string",
      title: "平台 API",
      format: "event-url",
      default: "https://api.github.com",
    },
    consumer_id: {
      type: "string",
      title: "消费者标识",
      format: "identity",
      minLength: 1,
    },
    receiver_url: {
      type: "string",
      title: "远端接收器地址",
      format: "event-url",
      nullable: true,
    },
    receiver_instance: {
      type: "string",
      title: "远端接收器身份",
      format: "identity",
      nullable: true,
    },
    auth_mode: {
      type: "string",
      title: "签名方式",
      enum: ["standard", "token"],
      nullable: true,
      default: "standard",
    },
    ttl_seconds: {
      type: "integer",
      title: "事件有效期（秒）",
      minimum: 1,
      maximum: 86400,
      nullable: true,
      default: 86400,
      description: "留空时 Core 使用 86400 秒。",
    },
  },
};

export const ruleSchema = {
  type: "object",
  title: "事件规则",
  additionalProperties: false,
  required: ["name", "enabled", "event", "workspace_id", "expires_at", "start"],
  properties: {
    name: { type: "string", title: "名称", minLength: 1, maxLength: 120 },
    enabled: { type: "boolean", title: "启用", default: false },
    event: {
      type: "string",
      title: "事件",
      enum: EVENTS,
      default: "run.completed",
    },
    workspace_id: { type: "integer", title: "工作区", minimum: 1, default: 1 },
    source_run_id: {
      type: "integer",
      title: "来源 Run",
      minimum: 1,
      nullable: true,
    },
    source_work_item_id: {
      type: "integer",
      title: "前置工作项",
      minimum: 1,
      nullable: true,
    },
    work_item_id: {
      type: "integer",
      title: "后续工作项",
      minimum: 1,
      nullable: true,
    },
    work_definition_revision: {
      type: "integer",
      title: "工作定义修订",
      minimum: 0,
      nullable: true,
    },
    source_id: {
      type: "string",
      title: "外部来源",
      format: "identity",
      nullable: true,
    },
    event_state: {
      type: "string",
      title: "事件状态",
      minLength: 1,
      maxLength: 64,
      nullable: true,
    },
    expires_at: { type: "integer", title: "到期时间", minimum: 1 },
    start: {
      type: "object",
      title: "动作",
      additionalProperties: true,
      required: ["client_run_id", "workspace_id", "goal", "authorization_id"],
      properties: {
        client_run_id: {
          type: "string",
          title: "动作标识",
          format: "identity",
        },
        agent_id: { type: "integer", title: "执行者", minimum: 1, default: 1 },
        workspace_id: { type: "integer", title: "动作工作区", minimum: 1 },
        provider_id: { type: "string", title: "模型服务", nullable: true },
        goal: { type: "string", title: "目标", minLength: 1 },
        authorization_id: { type: "string", title: "授权", minLength: 1 },
        project_ids: {
          type: "array",
          title: "动作项目",
          maxItems: 16,
          items: { type: "string", format: "slug" },
          default: [],
        },
        engine_id: { type: "string", title: "CLI 引擎", nullable: true },
        tool_mode: {
          type: "string",
          title: "工具模式",
          enum: ["native", "disabled"],
          nullable: true,
        },
        timeout_seconds: {
          type: "integer",
          title: "执行时限（秒）",
          minimum: 1,
          maximum: 3600,
          nullable: true,
        },
        action: {
          type: "object",
          title: "工具动作",
          nullable: true,
          additionalProperties: false,
          required: ["name", "arguments"],
          properties: {
            name: {
              type: "string",
              title: "工具",
              suggestions: toolNames,
              minLength: 1,
              maxLength: 80,
              default: "read_file",
            },
            arguments: {
              type: "variant-object",
              title: "参数",
              switch: "name",
              variants: toolArgumentSchemas,
            },
          },
        },
      },
    },
  },
};

export function defaultSource({ workspace_id = 1, consumer_id = "" } = {}) {
  return {
    name: "事件来源",
    kind: "github",
    project: "owner/repo",
    workspace_id,
    project_ids: [],
    enabled: false,
    mode: "local",
    api_base_url: "https://api.github.com",
    consumer_id,
    auth_mode: "standard",
    ttl_seconds: 86400,
  };
}

export function defaultRule() {
  return {
    name: "完成后执行",
    enabled: false,
    event: "run.completed",
    workspace_id: 1,
    source_run_id: null,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    start: {
      client_run_id: crypto.randomUUID(),
      agent_id: 1,
      workspace_id: 1,
      goal: "规则直接动作",
      authorization_id: "请选择已创建的授权",
      action: { name: "read_file", arguments: { path: "input.txt" } },
    },
  };
}

function join(path, key) {
  return path ? `${path}.${key}` : key;
}

function isIdentity(value) {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ) || /^[0-9a-f]{32}$/i.test(value)
  );
}

function eventUrlError(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048)
    return "事件服务地址无效。";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "事件服务地址无效。";
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!loopback && url.protocol !== "https:")
  ) {
    return "事件服务需要 HTTPS，loopback 可用 HTTP。";
  }
  return "";
}

export function resolveSchema(schema, parentValue) {
  if (schema?.type !== "variant-object") return schema;
  const name = parentValue?.[schema.switch];
  return (
    schema.variants?.[name] || {
      type: "object",
      title: schema.title,
      additionalProperties: true,
      properties: {},
    }
  );
}

export function fieldAt(schema, value, path) {
  let node = schema;
  let parentValue = null;
  let currentValue = value;
  for (const key of path.split(".")) {
    node = resolveSchema(node, parentValue);
    if (node?.type !== "object" || !node.properties?.[key]) return null;
    parentValue = currentValue;
    currentValue = currentValue?.[key];
    node = node.properties[key];
  }
  return resolveSchema(node, parentValue);
}

export function writePath(value, path, next) {
  const clone = structuredClone(value ?? {});
  const parts = path.split(".");
  let cursor = clone;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (
      !cursor[key] ||
      typeof cursor[key] !== "object" ||
      Array.isArray(cursor[key])
    ) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  const last = parts[parts.length - 1];
  if (next === undefined) delete cursor[last];
  else cursor[last] = next;
  return clone;
}

export function coerce(field, raw) {
  if (!field) return raw;
  if (field.type === "boolean") return raw === true || raw === "true";
  if (field.type === "integer") {
    if (raw === "" || raw === null || raw === undefined)
      return field.nullable ? null : "";
    const number = typeof raw === "number" ? raw : Number(raw);
    return Number.isInteger(number) ? number : raw;
  }
  if (field.type === "array") {
    if (Array.isArray(raw)) return raw;
    return String(raw)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (field.type === "string") {
    if ((raw === "" || raw === null) && field.nullable) return null;
    return raw == null ? "" : String(raw);
  }
  return raw;
}

export function updateField(schema, value, path, raw) {
  const field = fieldAt(schema, value, path);
  let next = writePath(value, path, coerce(field, raw));
  if (path === "start.action.name") {
    const name = coerce(field, raw);
    const variant = toolArgumentSchemas[name];
    const args = {};
    if (variant) {
      for (const [key, child] of Object.entries(variant.properties)) {
        if (variant.required?.includes(key)) args[key] = child.default ?? "";
      }
    }
    next = writePath(next, "start.action.arguments", args);
  }
  return next;
}

function walk(schema, value, path, parent, errors) {
  if (schema.type === "variant-object") {
    const known = schema.variants?.[parent?.[schema.switch]];
    if (!known) {
      if (
        value != null &&
        (typeof value !== "object" || Array.isArray(value))
      ) {
        errors.push({ path, message: `${schema.title || "参数"}需要是对象。` });
      }
      return;
    }
    walk(known, value ?? {}, path, parent, errors);
    return;
  }
  if (value === null || value === undefined) return;
  if (schema.type === "object") {
    walkObject(schema, value, path, errors);
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push({ path, message: `${schema.title}需要是字符串。` });
      return;
    }
    if (schema.minLength != null && value.trim().length < schema.minLength) {
      errors.push({ path, message: `请填写${schema.title}。` });
    } else if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push({
        path,
        message: `${schema.title}不能超过 ${schema.maxLength} 个字符。`,
      });
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({
        path,
        message: `${schema.title}只能是 ${schema.enum.join("、")}。`,
      });
    }
    if (schema.format === "identity" && value !== "" && !isIdentity(value)) {
      errors.push({ path, message: `${schema.title}需要是 UUID。` });
    }
    if (schema.format === "event-url") {
      const urlError = eventUrlError(value);
      if (urlError) errors.push({ path, message: urlError });
    }
    if (schema.control === false && /[\u0000-\u001f\u007f]/.test(value)) {
      errors.push({ path, message: `${schema.title}不能包含控制字符。` });
    }
    return;
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push({ path, message: `${schema.title}需要是整数。` });
      return;
    }
    if (
      (schema.minimum != null && value < schema.minimum) ||
      (schema.maximum != null && value > schema.maximum)
    ) {
      errors.push({
        path,
        message:
          schema.minimum != null && schema.maximum != null
            ? `${schema.title}需要在 ${schema.minimum}–${schema.maximum} 之间。`
            : `${schema.title}不能小于 ${schema.minimum}。`,
      });
    }
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean")
      errors.push({ path, message: `${schema.title}需要是布尔值。` });
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `${schema.title}需要是列表。` });
      return;
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push({
        path,
        message: `${schema.title}最多 ${schema.maxItems} 项。`,
      });
    }
    value.forEach((item, index) => {
      if (
        schema.items?.format === "slug" &&
        !/^[A-Za-z0-9_-]{1,80}$/.test(item)
      ) {
        errors.push({
          path: `${path}.${index}`,
          message: `${schema.title}第 ${index + 1} 项需要是 1–80 位的字母、数字、短横或下划线。`,
        });
      }
    });
  }
}

function walkObject(schema, value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({ path, message: `${schema.title || "配置"}需要是对象。` });
    return;
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!schema.properties[key]) {
        errors.push({
          path: join(path, key),
          message: `不能包含未定义字段「${key}」。`,
        });
      }
    }
  }
  for (const [key, child] of Object.entries(schema.properties)) {
    const childPath = join(path, key);
    const missing = value[key] === undefined || value[key] === null;
    if (schema.required?.includes(key) && missing && !child.nullable) {
      errors.push({
        path: childPath,
        message: `请填写${child.title || key}。`,
      });
      continue;
    }
    if (value[key] === undefined || (value[key] === null && child.nullable))
      continue;
    walk(child, value[key], childPath, value, errors);
  }
}

export function validate(schema, value) {
  const errors = [];
  walk(schema, value, "", null, errors);
  return errors;
}

export function validateSource(value) {
  const errors = validate(sourceSchema, value);
  if (value?.mode === "remote") {
    if (!value.receiver_url) {
      errors.push({
        path: "receiver_url",
        message: "远端模式需要填写接收器地址。",
      });
    }
    if (!value.receiver_instance) {
      errors.push({
        path: "receiver_instance",
        message: "远端模式需要填写接收器身份。",
      });
    }
  }
  return errors;
}

export function validateRule(value) {
  return validate(ruleSchema, value);
}

export function parseDocument(text, label) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, message: `${label}需要是 JSON 对象。` };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: `${label}不是合法 JSON：${error.message}` };
  }
}

export function issuesForSource(text) {
  const parsed = parseDocument(text, "来源配置");
  if (!parsed.ok) return [parsed.message];
  return validateSource(parsed.value).map((error) => error.message);
}

export function issuesForRule(text) {
  const parsed = parseDocument(text, "规则配置");
  if (!parsed.ok) return [parsed.message];
  return validateRule(parsed.value).map((error) => error.message);
}
