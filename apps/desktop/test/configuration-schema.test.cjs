const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");

test("Core exposes generated configuration schemas and actual native action parameters", async (t) => {
  const h = await setup(t);
  const schemas = await h.core.request("configuration.schemas", {});
  contract.validate("configuration.schemas", schemas, true);
  assert.ok(JSON.stringify(schemas).length < 64000);
  assert.deepEqual(schemas.source.properties.kind.enum, [
    "github",
    "gitlab",
    "webhook",
  ]);
  assert.deepEqual(schemas.engines, ["claude", "codex", "pi", "opencode"]);
  assert.ok(
    schemas.actions.find((action) => action.name === "write_file").parameters
      .properties.expected_hash,
  );
  const { ruleFormSchema, schemaDefault, schemaBranch } = await import(
    "../renderer/schema-values.mjs"
  );
  const native = {
    name: "Legacy",
    enabled: false,
    event: "run.completed",
    workspace_id: h.wid,
    source_run_id: null,
    expires_at: 10000000000,
    start: {
      client_run_id: "fixed",
      workspace_id: h.wid,
      goal: "Review",
      authorization_id: "grant",
      action: {
        name: "write_file",
        arguments: {
          path: "a.csv",
          content: "001\n",
          expected_hash: "missing",
        },
      },
    },
  };
  const form = ruleFormSchema(schemas, native);
  assert.equal(
    form.properties.start.anyOf[0].properties.action.properties.arguments
      .properties.path.type,
    "string",
  );
  assert.deepEqual(schemaDefault(form, native), native);
  const cli = {
    ...native,
    start: {
      client_run_id: "fixed",
      workspace_id: h.wid,
      goal: "CLI",
      authorization_id: "grant",
      engine_id: "pi",
      tool_mode: "disabled",
      project_ids: [],
      office_reference_ids: ["fixed-reference"],
    },
  };
  assert.equal(
    schemaBranch(form.properties.start, cli.start).title,
    "CliStart",
  );
  assert.deepEqual(schemaDefault(form, cli), cli);
  assert.deepEqual(
    schemaDefault({ type: "array", items: { type: "string" } }, ["001", "α"]),
    ["001", "α"],
  );
  await assert.rejects(
    h.core.request("configuration.schemas", { unknown: true }),
  );
});
