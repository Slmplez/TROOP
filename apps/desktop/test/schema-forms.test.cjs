const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  defaultRule,
  defaultSource,
  issuesForRule,
  issuesForSource,
  updateField,
  ruleSchema,
} = require("../renderer/schema-form.mjs");

const consumer = "0123456789abcdef0123456789abcdef";
const sourceId = "11111111-1111-4111-8111-111111111111";

function bundle() {
  const outfile = path.join(__dirname, ".schema-form-bundle.cjs");
  require("esbuild").buildSync({
    entryPoints: [path.resolve(__dirname, "../renderer/SchemaForm.jsx")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    jsx: "automatic",
    external: ["react", "react-dom"],
  });
  try {
    return require(outfile);
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}

test("source and action schemas supply defaults, typed edits and helpful errors", () => {
  const source = defaultSource({ workspace_id: 3, consumer_id: consumer });
  assert.equal(source.kind, "github");
  assert.equal(source.ttl_seconds, 86400);
  assert.equal(source.enabled, false);
  assert.deepEqual(issuesForSource(JSON.stringify(source)), []);
  assert.match(issuesForSource("{")[0], /^来源配置不是合法 JSON：/);
  const unnamed = { ...source, name: "  " };
  assert.ok(
    issuesForSource(JSON.stringify(unnamed)).some((message) =>
      message.includes("名称"),
    ),
  );
  const platform = { ...source, kind: "svn" };
  assert.ok(
    issuesForSource(JSON.stringify(platform)).some((message) =>
      message.includes("平台"),
    ),
  );
  const ttl = { ...source, ttl_seconds: 0 };
  assert.ok(
    issuesForSource(JSON.stringify(ttl)).some((message) =>
      message.includes("1–86400"),
    ),
  );
  const projects = {
    ...source,
    project_ids: Array.from({ length: 17 }, (_, index) => `item${index}`),
  };
  assert.ok(
    issuesForSource(JSON.stringify(projects)).some((message) =>
      message.includes("最多 16"),
    ),
  );
  assert.ok(
    issuesForSource(
      JSON.stringify({ ...source, project_ids: ["bad/slug"] }),
    ).some((message) => message.includes("项目范围")),
  );
  assert.ok(
    issuesForSource(
      JSON.stringify({
        ...source,
        mode: "remote",
        api_base_url: "http://example.com",
      }),
    ).some((message) => message.includes("HTTPS")),
  );
  assert.ok(
    issuesForSource(JSON.stringify({ ...source, mode: "remote" })).some(
      (message) => message.includes("接收器地址"),
    ),
  );
  assert.deepEqual(
    issuesForSource(
      JSON.stringify({
        ...source,
        mode: "remote",
        api_base_url: "https://example.com",
        receiver_url: "https://example.com/hook",
        receiver_instance: sourceId,
      }),
    ),
    [],
  );
  assert.ok(
    issuesForSource(JSON.stringify({ ...source, extra: true })).some(
      (message) => message.includes("未定义字段「extra」"),
    ),
  );
  const loopback = {
    name: "UI mock GitHub",
    kind: "github",
    project: "owner/repo",
    workspace_id: 3,
    project_ids: [],
    enabled: true,
    mode: "local",
    api_base_url: "http://127.0.0.1:9",
    consumer_id: sourceId,
  };
  assert.deepEqual(issuesForSource(JSON.stringify(loopback)), []);

  const rule = defaultRule();
  assert.equal(rule.start.action.name, "read_file");
  assert.equal(rule.start.action.arguments.path, "input.txt");
  assert.deepEqual(issuesForRule(JSON.stringify(rule)), []);
  const renamed = updateField(ruleSchema, rule, "start.goal", "核对文件");
  assert.equal(renamed.start.goal, "核对文件");
  assert.equal(renamed.start.action.arguments.path, "input.txt");
  const preserved = updateField(
    ruleSchema,
    { ...rule, start: { ...rule.start, provider_id: "provider-1" } },
    "start.goal",
    "保留扩展字段",
  );
  assert.equal(preserved.start.provider_id, "provider-1");
  const switched = updateField(
    ruleSchema,
    rule,
    "start.action.name",
    "write_file",
  );
  assert.deepEqual(Object.keys(switched.start.action.arguments).sort(), [
    "content",
    "expected_hash",
    "path",
  ]);
  delete switched.start.action.arguments.content;
  assert.ok(
    issuesForRule(JSON.stringify(switched)).some((message) =>
      message.includes("内容"),
    ),
  );
  switched.start.action.arguments = {
    path: "webhook-result.txt",
    content: "verified event",
    expected_hash: "missing",
  };
  assert.deepEqual(issuesForRule(JSON.stringify(switched)), []);
  const workflow = {
    name: "UI failed workflow",
    enabled: true,
    event: "github.workflow.completed",
    source_id: sourceId,
    event_state: "failure",
    source_run_id: null,
    workspace_id: 3,
    expires_at: 1_900_000_000,
    start: {
      client_run_id: sourceId,
      workspace_id: 3,
      agent_id: 1,
      authorization_id: sourceId,
      goal: "Webhook file action",
      action: {
        name: "write_file",
        arguments: {
          path: "webhook-result.txt",
          content: "verified event",
          expected_hash: "missing",
        },
      },
    },
  };
  assert.deepEqual(issuesForRule(JSON.stringify(workflow)), []);
  const work = {
    name: "接纳后推进",
    enabled: true,
    event: "work.accepted",
    workspace_id: 3,
    source_run_id: null,
    source_work_item_id: 4,
    work_item_id: 5,
    expires_at: 1_900_000_000,
    start: {
      client_run_id: sourceId,
      agent_id: 1,
      workspace_id: 3,
      project_ids: [],
      provider_id: "provider-1",
      authorization_id: sourceId,
      goal: "推进后续工作",
    },
  };
  assert.deepEqual(issuesForRule(JSON.stringify(work)), []);
  const read = {
    name: "Completion rule",
    enabled: false,
    event: "run.completed",
    workspace_id: 3,
    source_run_id: null,
    expires_at: 1_900_000_000,
    start: {
      client_run_id: sourceId,
      agent_id: 1,
      workspace_id: 3,
      goal: "Rule read",
      authorization_id: sourceId,
      action: { name: "read_file", arguments: { path: "input.txt" } },
    },
  };
  assert.deepEqual(issuesForRule(JSON.stringify(read)), []);
});

test("schema form renders typed controls and keeps the raw JSON fallback", () => {
  const { SourceDefinitionEditor, RuleDefinitionEditor } = bundle();
  const source = defaultSource({ workspace_id: 3, consumer_id: consumer });
  const sourceHtml = renderToStaticMarkup(
    React.createElement(SourceDefinitionEditor, {
      text: JSON.stringify(source, null, 2),
      onText() {},
      disabled: false,
    }),
  );
  assert.match(sourceHtml, /id="event-source-name"/);
  assert.match(sourceHtml, /id="event-source-kind"/);
  assert.match(sourceHtml, /id="event-source-ttl_seconds"/);
  assert.match(sourceHtml, /id="event-source-definition"/);
  assert.match(sourceHtml, /高级 JSON/);
  assert.match(sourceHtml, /value="github"/);
  const invalid = renderToStaticMarkup(
    React.createElement(SourceDefinitionEditor, {
      text: "{",
      onText() {},
      disabled: false,
    }),
  );
  assert.match(invalid, /不是合法 JSON/);
  assert.match(invalid, /id="event-source-definition"/);
  assert.doesNotMatch(invalid, /id="event-source-name"/);
  const named = { ...source, name: "" };
  const errorHtml = renderToStaticMarkup(
    React.createElement(SourceDefinitionEditor, {
      text: JSON.stringify(named),
      onText() {},
      disabled: false,
    }),
  );
  assert.match(errorHtml, /请填写名称/);
  assert.match(errorHtml, /aria-invalid="true"/);

  const rule = defaultRule();
  rule.start.action = {
    name: "write_file",
    arguments: { path: "a.txt", expected_hash: "missing" },
  };
  const ruleHtml = renderToStaticMarkup(
    React.createElement(RuleDefinitionEditor, {
      text: JSON.stringify(rule),
      onText() {},
      disabled: false,
    }),
  );
  assert.match(ruleHtml, /id="rule-start-action-name"/);
  assert.match(ruleHtml, /id="rule-start-action-arguments-path"/);
  assert.match(ruleHtml, /id="rule-start-action-arguments-content"/);
  assert.match(ruleHtml, /请填写内容/);
  assert.match(ruleHtml, /id="rule-definition"/);
  assert.match(ruleHtml, /高级 JSON/);
  const custom = {
    ...rule,
    start: {
      ...rule.start,
      action: { name: "custom_tool", arguments: { keep: true } },
    },
  };
  const customHtml = renderToStaticMarkup(
    React.createElement(RuleDefinitionEditor, {
      text: JSON.stringify(custom),
      onText() {},
      disabled: false,
    }),
  );
  assert.match(customHtml, /没有结构化参数/);
  assert.match(customHtml, /custom_tool/);
});
