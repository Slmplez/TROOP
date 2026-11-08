const { test } = require("node:test");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  fs = require("node:fs"),
  path = require("node:path");
const { setup, until, sleep } = require("./fixtures/hooks-fixture.cjs");
const contract = require("../contracts/execution.cjs");
const { writeTestClock } = require("./fixtures/test-clock.cjs");
const read = (h, m, p = {}) => h.core.request(m, p);
const operation = (h, method, input, operation_id = crypto.randomUUID()) =>
  h.core.request("operations.execute", {
    operation_id,
    instance_id: h.core.snapshot().storage_instance,
    method,
    input,
  });
async function command(h, m, p, id) {
  const r = await operation(h, m, p, id);
  assert.equal(r.state, "committed", JSON.stringify(r.error));
  return contract.methods[m] ? contract.validate(m, r.result, true) : r.result;
}
test("one calendar previews fixed-zone once, daily, weekly and DST gap/fold slots", async (t) => {
  const h = await setup(t);
  const preview = (schedule, after) =>
    read(h, "reminders.preview", { schedule, after_ms: Date.parse(after) });
  let value = await preview(
    {
      kind: "once",
      timezone: "Asia/Shanghai",
      time: "09:30",
      date: "2026-11-09",
    },
    "2026-11-08T00:00:00Z",
  );
  assert.equal(value.slots[0].due_at_ms, Date.parse("2026-11-09T01:30:00Z"));
  value = await preview(
    {
      kind: "weekly",
      timezone: "Asia/Shanghai",
      time: "09:30",
      weekdays: [1, 5],
    },
    "2026-11-08T00:00:00Z",
  );
  assert.equal(value.slots[0].local_date, "2026-11-09");
  assert.equal(value.slots[1].local_date, "2026-11-13");
  value = await preview(
    { kind: "daily", timezone: "America/New_York", time: "02:30" },
    "2026-03-07T08:00:00Z",
  );
  assert.equal(value.slots[0].state, "dst_gap");
  assert.equal(value.slots[0].local_date, "2026-03-08");
  assert.equal(value.slots[1].due_at_ms, Date.parse("2026-03-09T06:30:00Z"));
  value = await preview(
    { kind: "daily", timezone: "America/New_York", time: "01:30" },
    "2026-10-31T08:00:00Z",
  );
  assert.equal(value.slots[0].due_at_ms, Date.parse("2026-11-01T05:30:00Z"));
  assert.equal(value.slots[1].local_date, "2026-11-02");
  assert.equal((await read(h, "agent.list")).items.length, 0);
  assert.equal(h.server.requests.length, 0);
});

async function controlled(t, base = "2026-11-08T00:00:00Z") {
  const root = path.resolve(__dirname, "../../../.tmp-troop-reminders");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "clock-")),
    file = path.join(dir, "clock");
  let current = Date.parse(base);
  fs.writeFileSync(file, String(current));
  const h = await setup(t, { coreArgs: ["--test-clock-file", file] });
  return {
    ...h,
    clock: file,
    time: () => current,
    advance: async (ms) => {
      current = ms;
      await writeTestClock(file, ms);
      await sleep(150);
    },
  };
}
const definition = (extra = {}) => ({
  kind: "reminder",
  event: "time.due",
  name: "发布检查提醒",
  enabled: true,
  agent_id: 1,
  project_id: null,
  body: "检查已保存的发布资料",
  schedule: {
    kind: "once",
    timezone: "UTC",
    date: "2026-11-08",
    time: "00:00:02",
  },
  ...extra,
});
const save = (h, rule, old) =>
  command(h, "rules.save", {
    ...(old ? { id: old.id } : {}),
    expected_revision: old?.revision ?? 0,
    rule,
  });
test("a due reminder commits one slot, one durable notification and one claimed OS attempt without a Run or model", async (t) => {
  const h = await controlled(t),
    rule = await save(h, definition());
  assert.equal(rule.next_slot.due_at_ms, h.time() + 2000);
  await h.advance(h.time() + 2000);
  const history = await until(async () => {
    const page = await read(h, "reminders.history", { id: rule.id });
    return page.items.length && page;
  });
  assert.equal(history.items[0].state, "triggered");
  const first = await read(h, "notifications.list", { rule_id: rule.id });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].state, "pending");
  const consumers = [crypto.randomUUID(), crypto.randomUUID()];
  const claimed = await Promise.all(
    consumers.map((consumer_id) =>
      command(h, "notifications.claim", { consumer_id, focused: false }),
    ),
  );
  assert.equal(claimed.filter((value) => value.notification).length, 1);
  const notification = claimed.find((value) => value.notification).notification;
  const input = {
    id: notification.id,
    expected_revision: notification.revision,
    consumer_id: notification.consumer_id,
    attempt_id: notification.attempt_id,
    outcome: "shown",
    reason: "owned native show callback",
  };
  const key = crypto.randomUUID(),
    shown = await command(h, "notifications.complete", input, key);
  assert.equal(shown.state, "shown");
  assert.equal(
    (await command(h, "notifications.complete", input, key)).revision,
    shown.revision,
  );
  assert.equal(shown.read_at_ms, null);
  const seen = await command(h, "notifications.read", {
    id: shown.id,
    expected_revision: shown.revision,
  });
  assert.equal(seen.read_at_ms, h.time());
  await h.advance(h.time() + 1000);
  assert.equal(
    (await read(h, "reminders.history", { id: rule.id })).items.length,
    1,
  );
  assert.equal(
    (await read(h, "notifications.list", { rule_id: rule.id })).items.length,
    1,
  );
  assert.equal((await read(h, "agent.list")).items.length, 0);
  assert.equal(h.server.requests.length, 0);
});

test("sleep spanning more than one scheduler batch skips every overdue slot and backward clocks do not replay", async (t) => {
  const h = await controlled(t, "2026-11-01T00:00:00Z");
  const rule = await save(
    h,
    definition({ schedule: { kind: "daily", timezone: "UTC", time: "12:00" } }),
  );
  await h.advance(Date.parse("2026-11-05T12:00:01Z"));
  const history = await until(async () => {
    const p = await read(h, "reminders.history", { id: rule.id });
    return p.items.length === 5 && p;
  });
  assert.ok(history.items.every((i) => i.state === "skipped"));
  assert.equal((await read(h, "notifications.list")).items.length, 0);
  await h.advance(Date.parse("2026-11-01T00:00:00Z"));
  await h.advance(Date.parse("2026-11-05T12:00:01Z"));
  assert.equal(
    (await read(h, "reminders.history", { id: rule.id })).items.length,
    5,
  );
  assert.equal(h.server.requests.length, 0);
});

test("revisions, pause, cancellation and stable manual trigger keys preserve evidence", async (t) => {
  const h = await controlled(t);
  let rule = await save(h, definition());
  const original = rule;
  rule = await save(h, definition({ enabled: false }), rule);
  assert.equal(rule.phase, "paused");
  const stale = await operation(h, "rules.save", {
    id: rule.id,
    expected_revision: original.revision,
    rule: definition(),
  });
  assert.equal(stale.state, "rejected");
  await h.advance(h.time() + 2000);
  assert.equal(
    (await read(h, "reminders.history", { id: rule.id })).items[0].state,
    "skipped",
  );
  const key = crypto.randomUUID(),
    input = {
      id: rule.id,
      expected_revision: rule.revision,
      client_trigger_id: key,
    };
  const manual = await command(h, "reminders.run", input);
  assert.equal((await command(h, "reminders.run", input)).id, manual.id);
  rule = await command(h, "reminders.cancel", {
    id: rule.id,
    expected_revision: rule.revision,
  });
  assert.equal(rule.phase, "cancelled");
  assert.equal(
    (await read(h, "notifications.list")).items[0].state,
    "cancelled",
  );
  assert.equal(
    (
      await operation(h, "rules.save", {
        id: rule.id,
        expected_revision: rule.revision,
        rule: definition(),
      })
    ).state,
    "rejected",
  );
  assert.equal(
    (
      await operation(h, "reminders.run", {
        ...input,
        expected_revision: rule.revision,
        client_trigger_id: crypto.randomUUID(),
      })
    ).state,
    "rejected",
  );
  assert.equal((await read(h, "agent.list")).items.length, 0);
  assert.equal(h.server.requests.length, 0);
});

test("restart expires queued delivery and records an unacknowledged OS attempt without redispatch", async (t) => {
  const h = await controlled(t);
  const first = await save(h, definition());
  const second = await save(h, definition({ name: "another" }));
  await h.advance(h.time() + 2000);
  const consumer_id = crypto.randomUUID(),
    claimed = (
      await command(h, "notifications.claim", { consumer_id, focused: false })
    ).notification;
  assert.ok(claimed);
  await h.core.stop();
  await h.core.start();
  const page = await read(h, "notifications.list");
  assert.deepEqual(page.items.map((i) => i.state).sort(), [
    "expired",
    "indeterminate",
  ]);
  assert.equal(
    (await command(h, "notifications.claim", { consumer_id, focused: false }))
      .notification,
    null,
  );
  const late = await operation(h, "notifications.complete", {
    id: claimed.id,
    expected_revision: claimed.revision,
    consumer_id,
    attempt_id: claimed.attempt_id,
    outcome: "shown",
    reason: "late callback",
  });
  assert.equal(late.state, "rejected");
  for (const rule of [first, second])
    assert.equal(
      (await read(h, "reminders.history", { id: rule.id })).items.length,
      1,
    );
  assert.equal(h.server.requests.length, 0);
});

test("read state can advance while a claimed notification receives its display acknowledgement", async (t) => {
  const h = await controlled(t),
    rule = await save(h, definition());
  await h.advance(h.time() + 2000);
  const consumer_id = crypto.randomUUID(),
    n = (
      await command(h, "notifications.claim", { consumer_id, focused: false })
    ).notification;
  await command(h, "notifications.read", {
    id: n.id,
    expected_revision: n.revision,
  });
  const result = await command(h, "notifications.complete", {
    id: n.id,
    expected_revision: n.revision,
    consumer_id,
    attempt_id: n.attempt_id,
    outcome: "failed",
    reason: "OS failed",
  });
  assert.equal(result.state, "failed");
  assert.equal(result.read_at_ms, h.time());
  assert.equal(
    (await read(h, "notifications.list", { rule_id: rule.id })).items.length,
    1,
  );
});

test("disabled and focused notifications are suppressed durably without later popup", async (t) => {
  const h = await controlled(t);
  await save(h, definition());
  await command(h, "notifications.preferences.save", {
    expected_revision: 1,
    enabled: false,
  });
  await h.advance(h.time() + 2000);
  const consumer_id = crypto.randomUUID();
  assert.equal(
    (await command(h, "notifications.claim", { consumer_id, focused: false }))
      .notification,
    null,
  );
  assert.equal(
    (await read(h, "notifications.list")).items[0].state,
    "suppressed",
  );
  await command(h, "notifications.preferences.save", {
    expected_revision: 2,
    enabled: true,
  });
  assert.equal(
    (await command(h, "notifications.claim", { consumer_id, focused: false }))
      .notification,
    null,
  );
  const rule = (await read(h, "rules.list")).items[0];
  await command(h, "reminders.run", {
    id: rule.id,
    expected_revision: rule.revision,
    client_trigger_id: crypto.randomUUID(),
  });
  assert.equal(
    (await command(h, "notifications.claim", { consumer_id, focused: true }))
      .notification,
    null,
  );
  assert.ok(
    (await read(h, "notifications.list")).items.every(
      (n) => n.state === "suppressed",
    ),
  );
});

test("cancelled reminders retain history while releasing the available rule capacity", async (t) => {
  const h = await controlled(t);
  for (let i = 0; i < 101; i++) {
    const rule = await save(h, definition({ name: `cancel ${i}` }));
    await command(h, "reminders.cancel", {
      id: rule.id,
      expected_revision: rule.revision,
    });
  }
  const last = await save(h, definition());
  assert.equal(last.phase, "active");
  const list = await read(h, "rules.list");
  assert.equal(list.items.length, 20);
  assert.ok(list.next_offset);
  assert.equal(h.server.requests.length, 0);
});

test("DST runtime skips the gap and fires only the earliest repeated hour", async (t) => {
  const gap = await controlled(t, "2026-03-08T06:59:59Z");
  const rule = await save(
    gap,
    definition({
      schedule: { kind: "daily", timezone: "America/New_York", time: "02:30" },
    }),
  );
  await gap.advance(gap.time() + 1000);
  const page = await read(gap, "reminders.history", { id: rule.id });
  assert.equal(page.items[0].state, "skipped");
  assert.equal(page.items[0].slot.state, "dst_gap");
  assert.equal((await read(gap, "notifications.list")).items.length, 0);
  const fold = await controlled(t, "2026-11-01T05:29:59Z");
  const repeated = await save(
    fold,
    definition({
      schedule: { kind: "daily", timezone: "America/New_York", time: "01:30" },
    }),
  );
  await fold.advance(fold.time() + 1000);
  await fold.advance(fold.time() + 3600000);
  assert.equal(
    (await read(fold, "reminders.history", { id: repeated.id })).items.length,
    1,
  );
  assert.equal((await read(fold, "notifications.list")).items.length, 1);
  assert.equal(
    (await read(fold, "reminders.get", { id: repeated.id })).next_slot
      .local_date,
    "2026-11-02",
  );
  assert.equal(gap.server.requests.length + fold.server.requests.length, 0);
});

test("a notification insert failure rolls back its trigger and scheduler pointer", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const h = await controlled(t);
  const rule = await save(h, definition());
  const file = path.join(h.data, "troop.sqlite3");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER owned_fail_notification BEFORE INSERT ON reminder_notifications BEGIN SELECT RAISE(ABORT,'owned notification failure'); END;",
  );
  db.close();
  await h.advance(h.time() + 2000);
  assert.equal(
    (await read(h, "reminders.history", { id: rule.id })).items.length,
    0,
  );
  assert.equal((await read(h, "notifications.list")).items.length, 0);
  assert.equal(
    (await read(h, "reminders.get", { id: rule.id })).next_slot.due_at_ms,
    h.time(),
  );
  await h.core.stop();
  const reopened = new DatabaseSync(file);
  reopened.exec("DROP TRIGGER owned_fail_notification");
  reopened.close();
  await h.core.start();
  const result = await until(async () => {
    const p = await read(h, "reminders.history", { id: rule.id });
    return p.items[0];
  });
  assert.equal(result.state, "skipped");
  assert.equal((await read(h, "notifications.list")).items.length, 0);
});
