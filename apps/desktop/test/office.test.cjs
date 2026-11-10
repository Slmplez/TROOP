const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { setup } = require("./fixtures/hooks-fixture.cjs");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const execute = (h, method, input, operation = crypto.randomUUID()) =>
  h.core.request("operations.execute", {
    operation_id: operation,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
async function command(h, method, input, key) {
  const value = await execute(h, method, input, key);
  assert.equal(value.state, "committed", JSON.stringify(value.error));
  return value.result;
}
async function fixture(t, name = "notes.md", content = "# 标题\n\n原始段落\n") {
  const h = await setup(t, {
    executable: path.resolve(
      __dirname,
      "../../../target/debug",
      process.platform === "win32" ? "troop-core.exe" : "troop-core",
    ),
  });
  fs.writeFileSync(path.join(h.workspace, name), content);
  const opened = await command(h, "office.open", {
    workspace_id: h.wid,
    path: name,
  });
  return {
    ...h,
    document: opened.document,
    actor: crypto.randomUUID(),
    filename: path.join(h.workspace, name),
  };
}
async function draft(
  h,
  content,
  actor = h.actor,
  base = h.document.revision,
  revision = 0,
) {
  return command(h, "office.draft.save", {
    id: h.document.id,
    actor,
    expected_revision: revision,
    base_revision: base,
    content,
  });
}
async function save(h, value, extra = {}, key) {
  return execute(
    h,
    "office.save",
    {
      id: h.document.id,
      expected_revision: value.base_revision,
      actor: value.actor,
      draft_revision: value.revision,
      ...extra,
    },
    key,
  );
}
test("office saves one immutable version with a receipt and restores previous content as a new version", async (t) => {
  const h = await fixture(t);
  const original = fs.readFileSync(h.filename, "utf8");
  const value = await draft(h, "# 新标题\n\n新段落\n");
  const key = crypto.randomUUID();
  const saved = await save(h, value, {}, key);
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  assert.equal(saved.result.revision, 2);
  assert.equal(fs.readFileSync(h.filename, "utf8"), "# 新标题\n\n新段落\n");
  assert.deepEqual(await save(h, value, {}, key), saved);
  assert.equal(
    (await h.core.request("office.version", { id: h.document.id, revision: 1 }))
      .content,
    original,
  );
  const restored = await command(h, "office.restore", {
    id: h.document.id,
    expected_revision: 2,
    source_revision: 1,
  });
  assert.equal(restored.revision, 3);
  assert.equal(fs.readFileSync(h.filename, "utf8"), original);
  assert.equal(
    (await h.core.request("office.history", { id: h.document.id })).items
      .length,
    3,
  );
});
test("cross-window drafts block overwrite and explicit conflict resolution preserves the other draft", async (t) => {
  const h = await fixture(t);
  const one = await draft(h, "第一窗口");
  const two = await draft(h, "第二窗口", crypto.randomUUID());
  assert.equal((await save(h, one)).state, "rejected");
  assert.match(fs.readFileSync(h.filename, "utf8"), /原始段落/);
  const snapshot = await h.core.request("office.get", {
    id: h.document.id,
    actor: h.actor,
  });
  const saved = await save(h, one, {
    resolve_drafts_sha256: snapshot.foreign_drafts_sha256,
  });
  assert.equal(saved.state, "committed", JSON.stringify(saved.error));
  assert.equal(fs.readFileSync(h.filename, "utf8"), "第一窗口");
  assert.equal(
    (
      await h.core.request("office.draft.get", {
        id: h.document.id,
        actor: two.actor,
      })
    ).content,
    "第二窗口",
  );
  assert.equal((await save(h, two)).state, "rejected");
});
test("external edits are captured as a distinct version and old drafts and references survive restart", async (t) => {
  const h = await fixture(t);
  const value = await draft(h, "尚未保存的修改");
  const reference = await command(h, "office.reference.create", {
    id: h.document.id,
    revision: 1,
    kind: "paragraphs",
    start: 1,
    end: 2,
  });
  fs.writeFileSync(h.filename, "外部修改\n");
  assert.equal((await save(h, value)).state, "rejected");
  const external = await h.core.request("office.get", { id: h.document.id });
  assert.equal(external.external_changed, true);
  assert.equal(
    (await h.core.request("office.reference.get", { id: reference.id })).stale,
    true,
  );
  await command(h, "office.capture_external", {
    id: h.document.id,
    expected_revision: 1,
    expected_sha256: hash("外部修改\n"),
  });
  await h.core.stop();
  await h.core.start();
  assert.equal(
    (
      await h.core.request("office.draft.get", {
        id: h.document.id,
        actor: h.actor,
      })
    ).content,
    "尚未保存的修改",
  );
  assert.equal(
    (await h.core.request("office.reference.get", { id: reference.id }))
      .content,
    "原始段落\n",
  );
  assert.equal(
    (await h.core.request("office.version", { id: h.document.id, revision: 2 }))
      .content,
    "外部修改\n",
  );
});
test("a file written before version-commit failure stays fenced and explicit reconciliation closes the original operation", async (t) => {
  const h = await fixture(t);
  const value = await draft(h, "已落盘但尚未核对");
  const db = new DatabaseSync(path.join(h.directory, "data/troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_office_version BEFORE INSERT ON office_versions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'owned office version fault'); END",
  );
  const key = crypto.randomUUID();
  const receipt = await save(h, value, {}, key);
  assert.equal(receipt.state, "needs_reconciliation");
  assert.equal(fs.readFileSync(h.filename, "utf8"), "已落盘但尚未核对");
  const pending = (await h.core.request("office.get", { id: h.document.id }))
    .document.pending;
  assert.ok(pending.effect_id);
  await h.core.stop();
  await h.core.start();
  assert.equal((await save(h, value)).state, "rejected");
  db.exec("DROP TRIGGER fail_office_version");
  const resolved = await command(h, "office.reconcile", {
    id: h.document.id,
    effect_id: pending.effect_id,
    expected_disk_sha256: hash("已落盘但尚未核对"),
    decision: "accept",
  });
  assert.equal(resolved.revision, 2);
  assert.equal((await save(h, value, {}, key)).state, "committed");
  const repeated = await command(h, "office.reconcile", {
    id: h.document.id,
    effect_id: pending.effect_id,
    expected_disk_sha256: hash("已落盘但尚未核对"),
    decision: "accept",
  });
  assert.equal(repeated.revision, 2);
  assert.equal(
    (await h.core.request("office.history", { id: h.document.id })).items
      .length,
    2,
  );
});
test("CSV cells keep leading zeros, BOM, separators, quotes and embedded line endings", async (t) => {
  const text = '\uFEFF编号;备注\r\n001;"含;分号及""引号""\r\n下一行"\r\n';
  const h = await fixture(t, "table.csv", text);
  const snapshot = await h.core.request("office.get", {
    id: h.document.id,
    delimiter: ";",
  });
  assert.equal(snapshot.rows[1][0], "001");
  assert.equal(snapshot.rows[1][1], '含;分号及"引号"\r\n下一行');
  const encoded = await h.core.request("office.csv.encode", {
    rows: snapshot.rows,
    delimiter: ";",
    newline: "crlf",
    bom: true,
  });
  assert.equal(encoded.content, text);
  const reference = await command(h, "office.reference.create", {
    id: h.document.id,
    revision: 1,
    kind: "cells",
    start: 1,
    end: 2,
    column_start: 0,
    column_end: 2,
    delimiter: ";",
  });
  assert.deepEqual(JSON.parse(reference.content), [snapshot.rows[1]]);
});
test("office paths and save-as cannot escape the workspace or overwrite an existing file", async (t) => {
  const h = await fixture(t);
  const value = await draft(h, "另存正文");
  const saved = await command(h, "office.save_as", {
    id: h.document.id,
    actor: h.actor,
    draft_revision: value.revision,
    path: "copy.md",
  });
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "copy.md"), "utf8"),
    "另存正文",
  );
  assert.notEqual(saved.id, h.document.id);
  assert.match(fs.readFileSync(h.filename, "utf8"), /原始段落/);
  const refused = await execute(h, "office.save_as", {
    id: h.document.id,
    actor: h.actor,
    draft_revision: value.revision,
    path: "copy.md",
  });
  assert.equal(refused.state, "rejected");
  const outside = await execute(h, "office.open", {
    workspace_id: h.wid,
    path: "../outside.md",
  });
  assert.equal(outside.state, "rejected");
  await assert.rejects(
    h.core.request("office.save", { id: h.document.id }),
    /读取接口/,
  );
});

test("managed Agent edits retain version provenance and regular write_file respects window drafts", async (t) => {
  const h = await fixture(t);
  const startAction = async (extra) =>
    (
      await command(h, "agent.start", {
        client_run_id: crypto.randomUUID(),
        workspace_id: h.wid,
        goal: "Office write",
        ...extra,
      })
    ).run.id;
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Office Agent grant",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [h.workspace],
      operations: ["read_file", "write_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const value = await draft(h, "unsaved window draft");
  const run = await startAction({
    authorization_id: grant.id,
    action: {
      name: "write_file",
      arguments: {
        path: "notes.md",
        content: "blocked",
        expected_hash: h.document.sha256,
      },
    },
  });
  const blocked = await h.done(run);
  assert.equal(blocked.run.state, "failed", JSON.stringify(blocked));
  assert.match(fs.readFileSync(h.filename, "utf8"), /原始段落/);
  await command(h, "office.draft.discard", {
    id: h.document.id,
    actor: h.actor,
    expected_revision: value.revision,
  });
  const edited = await startAction({
    authorization_id: grant.id,
    action: {
      name: "office_edit",
      arguments: {
        path: "notes.md",
        content: "Agent version",
        expected_hash: h.document.sha256,
        expected_revision: "1",
      },
    },
  });
  const completed = await h.done(edited);
  assert.equal(completed.run.state, "completed", JSON.stringify(completed));
  const version = await h.core.request("office.version", {
    id: h.document.id,
    revision: 2,
  });
  assert.equal(version.source_run_id, edited);
  assert.equal(version.content, "Agent version");
  assert.equal(version.reason, "agent_edit");
  const stale = await startAction({
    authorization_id: grant.id,
    action: {
      name: "office_edit",
      arguments: {
        path: "notes.md",
        content: "stale",
        expected_hash: hash("Agent version"),
        expected_revision: "1",
      },
    },
  });
  assert.equal((await h.done(stale)).run.state, "failed");
  assert.equal(fs.readFileSync(h.filename, "utf8"), "Agent version");
});
test("external deletion records absence and restoring an earlier file creates a new version", async (t) => {
  const h = await fixture(t);
  fs.unlinkSync(h.filename);
  const missing = await command(h, "office.capture_external", {
    id: h.document.id,
    expected_revision: 1,
    expected_sha256: "missing",
  });
  assert.equal(missing.revision, 2);
  const restored = await command(h, "office.restore", {
    id: h.document.id,
    expected_revision: 2,
    source_revision: 1,
  });
  assert.equal(restored.revision, 3);
  assert.match(fs.readFileSync(h.filename, "utf8"), /原始段落/);
});
test("strict CSV and Markdown checks reject lossy inputs and preserve semantic supported syntax", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    h.core.request("office.csv.decode", {
      content: 'id,value\n1,"unclosed',
      delimiter: ",",
    }),
  );
  await assert.rejects(
    h.core.request("office.csv.decode", {
      content: 'id,value\n1,a"b',
      delimiter: ",",
    }),
  );
  const original = "## Heading\r\n\r\nA **bold** sentence.\r\n";
  assert.equal(
    (
      await h.core.request("office.markdown.check", {
        original,
        candidate: original.replaceAll("\r\n", "\n"),
      })
    ).equivalent,
    true,
  );
  const html = await h.core.request("office.markdown.check", {
    original: '<img src="https://invalid.example/a">',
    candidate: "",
  });
  assert.equal(html.equivalent, false);
  assert.ok(html.unsupported_features.length);
});
test("fixed references reach chat and Run from immutable content and cannot cross workspaces or grant roots", async (t) => {
  const h = await fixture(t);
  const reference = await command(h, "office.reference.create", {
    id: h.document.id,
    revision: 1,
    kind: "paragraphs",
    start: 1,
    end: 2,
  });
  const chat = await h.core.request("chat.create", {
    title: "Office refs",
    workspace_id: h.wid,
  });
  const client = crypto.randomUUID();
  const receipt = await h.core.request("chat.send", {
    conversation_id: chat.id,
    provider_id: h.provider.id,
    client_turn_id: client,
    text: "Inspect reference",
    office_reference_ids: [reference.id],
  });
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Office reference grant",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [],
      operations: ["read_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const id = await h.start({
    authorization_id: grant.id,
    office_reference_ids: [reference.id],
  });
  const completed = await h.done(id);
  assert.equal(completed.run.office_references[0].id, reference.id);
  assert.equal(completed.run.office_references[0].content, undefined);
  assert.ok(
    h.server.requests.some((request) =>
      JSON.stringify(request.body).includes(reference.id),
    ),
  );
  const noScope = await h.core.request("chat.create", { title: "Wrong scope" });
  await assert.rejects(
    h.core.request("chat.send", {
      conversation_id: noScope.id,
      provider_id: h.provider.id,
      client_turn_id: crypto.randomUUID(),
      text: "Inspect reference",
      office_reference_ids: [reference.id],
    }),
  );
  fs.writeFileSync(h.filename, "new external contents");
  assert.equal(
    (
      await h.core.request("chat.send", {
        conversation_id: chat.id,
        provider_id: h.provider.id,
        client_turn_id: client,
        text: "Inspect reference",
        office_reference_ids: [reference.id],
      })
    ).turn_id,
    receipt.turn_id,
  );
});

test("overlapping workspaces share the physical file draft fence", async (t) => {
  const h = await fixture(t, "notes.md", "original");
  const parent = path.dirname(h.workspace);
  const parentId = (
    await h.core.request("workspace.add", { path: parent })
  ).items.find(
    (item) => item.path === parent || item.name === path.basename(parent),
  )?.id;
  assert.ok(parentId);
  const opened = await command(h, "office.open", {
    workspace_id: parentId,
    path: "workspace/notes.md",
  });
  assert.equal(opened.document.id, h.document.id);
  const value = await draft(h, "unsaved physical file");
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Overlapping root",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: parentId,
      project_ids: [],
      read_roots: [parent],
      write_roots: [parent],
      operations: ["write_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const run = await command(h, "agent.start", {
    client_run_id: crypto.randomUUID(),
    workspace_id: parentId,
    authorization_id: grant.id,
    goal: "Overlapping write",
    action: {
      name: "write_file",
      arguments: {
        path: "workspace/notes.md",
        content: "must not overwrite",
        expected_hash: h.document.sha256,
      },
    },
  });
  assert.equal((await h.done(run.run.id)).run.state, "failed");
  assert.equal(fs.readFileSync(h.filename, "utf8"), "original");
});
test("maximum text with sixteen drafts and a pending save stays below IPC frame limits", async (t) => {
  const original = "\\".repeat(8000);
  const h = await fixture(t, "dense.csv", original);
  const value = await draft(h, original.slice(0, -1) + "x");
  for (let n = 0; n < 15; n++) await draft(h, original, crypto.randomUUID());
  const snapshot = await h.core.request("office.get", {
    id: h.document.id,
    actor: h.actor,
  });
  const db = new DatabaseSync(path.join(h.directory, "data/troop.sqlite3"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_dense_office BEFORE INSERT ON office_versions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'owned frame fault'); END",
  );
  assert.equal(
    (
      await save(h, value, {
        resolve_drafts_sha256: snapshot.foreign_drafts_sha256,
      })
    ).state,
    "needs_reconciliation",
  );
  const current = await h.core.request("office.get", {
    id: h.document.id,
    actor: h.actor,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(current)) < 64000);
  assert.equal(current.document.pending.content, undefined);
  assert.equal(
    (await h.core.request("office.pending", { id: h.document.id })).content,
    value.content,
  );
});

test("conversation automation freezes explicitly attached office references through restart and scheduled Run", async (t) => {
  const proposal = {
    troop_automation: {
      kind: "scheduled",
      name: "Office reference recheck",
      goal: "Quote the fixed reference",
      schedule: {
        kind: "once",
        timezone: "Asia/Shanghai",
        date: "2030-11-09",
        time: "09:00",
        weekdays: [],
      },
    },
  };
  const h = await setup(t, {
    executable: path.resolve(
      __dirname,
      "../../../target/debug",
      process.platform === "win32" ? "troop-core.exe" : "troop-core",
    ),
    reply: JSON.stringify(proposal),
  });
  fs.writeFileSync(
    path.join(h.workspace, "reference.md"),
    "# Scope\n\nFROZEN_OFFICE_REFERENCE\n",
  );
  const doc = (
    await command(h, "office.open", {
      workspace_id: h.wid,
      path: "reference.md",
    })
  ).document;
  const ref = await command(h, "office.reference.create", {
    id: doc.id,
    revision: 1,
    kind: "paragraphs",
    start: 1,
    end: 2,
  });
  const grant = await command(h, "authorizations.save", {
    expected_revision: 0,
    grant: {
      name: "Reference schedule scope",
      purpose: "tool_call",
      agent_id: 1,
      engine_id: "native",
      workspace_id: h.wid,
      project_ids: [],
      read_roots: [h.workspace],
      write_roots: [],
      operations: ["read_file"],
      network: "none",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const chat = await h.core.request("chat.create", {
    title: "Reference automation",
    workspace_id: h.wid,
  });
  const turn = await h.core.request("chat.send", {
    conversation_id: chat.id,
    provider_id: h.provider.id,
    client_turn_id: crypto.randomUUID(),
    text: "Schedule this explicit reference",
    automation: true,
    office_reference_ids: [ref.id],
  });
  const { until } = require("./fixtures/hooks-fixture.cjs");
  await until(async () =>
    (
      await h.core.request("chat.messages", { conversation_id: chat.id })
    ).items.some(
      (m) =>
        m.turn_id === turn.turn_id &&
        m.role === "assistant" &&
        m.status === "completed",
    ),
  );
  await h.core.stop();
  await h.core.start();
  const preview = await h.core.request("automations.preview", {
    turn_id: turn.turn_id,
    authorization_id: grant.id,
  });
  assert.deepEqual(preview.rule.start.office_reference_ids, [ref.id]);
  assert.equal(
    preview.preview.plan.office_references[0].content,
    "FROZEN_OFFICE_REFERENCE\n",
  );
  const saved = await command(h, "automations.confirm", {
    turn_id: turn.turn_id,
    authorization_id: grant.id,
    source_sha256: preview.source_sha256,
    expected_plan_sha256: preview.preview.plan_sha256,
  });
  fs.writeFileSync(
    path.join(h.workspace, "reference.md"),
    "External new content\n",
  );
  const run = await command(h, "schedules.run", {
    id: saved.id,
    expected_revision: saved.revision,
    client_trigger_id: crypto.randomUUID(),
  });
  await h.done(run.run.id);
  const request = h.server.requests.at(-1).body;
  assert.ok(JSON.stringify(request).includes("FROZEN_OFFICE_REFERENCE"));
  assert.ok(!JSON.stringify(request).includes("External new content"));
  assert.equal(
    (await h.core.request("office.reference.get", { id: ref.id })).stale,
    true,
  );
});
