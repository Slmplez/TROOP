const { test } = require("node:test");
const assert = require("node:assert/strict");
class Storage {
  constructor() {
    this.values = new Map();
  }
  get length() {
    return this.values.size;
  }
  key(index) {
    return [...this.values.keys()][index];
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, value);
  }
  removeItem(key) {
    this.values.delete(key);
  }
}
async function fixture(storage = new Storage()) {
  const { OperationJournal } = await import(
    "../renderer/client/operation-journal.mjs"
  );
  const journal = new OperationJournal(
    storage,
    () => "00000000-0000-4000-8000-000000000001",
  );
  journal.select("store");
  return { journal, storage, OperationJournal };
}
const receipt = (request, state = "committed") => ({
  operation_id: request.operation_id,
  instance_id: request.instance_id,
  method: request.method,
  state,
  result: { accepted: true },
});

test("journal resolves an archived receipt through its fixed reference without executing again", async () => {
  const { journal, storage, OperationJournal } = await fixture();
  const entry = journal.prepare("store", "agent.approve", {
    id: 1,
    epoch: 1,
    approved: true,
  });
  entry.attempted = true;
  journal.save(entry);
  const reopened = new OperationJournal(storage);
  reopened.select("store");
  const reference = {
    instance_id: "store",
    operation_id: entry.request.operation_id,
    archive_id: "fixed",
  };
  const calls = [];
  const client = {
    request: async (method, input) => {
      calls.push(method);
      if (method === "operations.get")
        return {
          ...receipt(entry.request, "archived"),
          archive_ref: reference,
        };
      assert.equal(method, "operations.archive.query");
      assert.deepEqual(input, reference);
      return receipt(entry.request);
    },
  };
  assert.equal(
    (await reopened.resolve(client, reopened.entries("store")[0])).state,
    "committed",
  );
  assert.deepEqual(calls, ["operations.get", "operations.archive.query"]);
});

test("journal rejects an archive reference pointing at another operation", async () => {
  const { journal } = await fixture();
  const entry = journal.prepare("store", "agent.approve", {
    id: 1,
    epoch: 1,
    approved: true,
  });
  entry.attempted = true;
  journal.save(entry);
  await assert.rejects(
    journal.resolve(
      {
        request: async () => ({
          ...receipt(entry.request, "archived"),
          archive_ref: {
            instance_id: "store",
            operation_id: "other",
            archive_id: "wrong",
          },
        }),
      },
      entry,
    ),
    /归档回执身份/,
  );
});
test("sensitive commands persist only a digest; lost response recovery never stores or replays the credential", async () => {
  const { journal, storage, OperationJournal } = await fixture();
  const input = {
    config: {
      name: "Fixture",
      protocol: "anthropic",
      base_url: "http://127.0.0.1:1337",
      model: "fixture",
      max_output_tokens: 1024,
      idle_timeout_secs: 5,
    },
    api_key: "private-fixture-token",
  };
  const entry = await journal.prepareSensitive("store", "provider.save", input);
  assert.ok(
    !JSON.stringify([...storage.values.values()]).includes(input.api_key),
  );
  assert.equal(entry.redacted, true);
  let dispatches = 0;
  await assert.rejects(
    journal.resolve(
      {
        request: async (method, request) => {
          dispatches++;
          assert.equal(request.input.api_key, input.api_key);
          throw Error("response lost");
        },
      },
      entry,
      input,
    ),
  );
  const restored = new OperationJournal(storage);
  restored.select("store");
  const client = {
    request: async (method) => {
      assert.equal(method, "operations.get");
      return {
        operation_id: entry.request.operation_id,
        instance_id: "store",
        state: "not_found",
      };
    },
  };
  await restored.recover(client, "store");
  await assert.rejects(restored.resolve(client, restored.entries()[0]), {
    kind: "requires_input",
  });
  assert.equal(dispatches, 1);
  assert.equal(
    (await restored.prepareSensitive("store", "provider.save", input)).request
      .operation_id,
    entry.request.operation_id,
  );
});

test("lost response survives renderer reload; reconnect queries without submitting or replaying", async () => {
  const { journal, storage, OperationJournal } = await fixture();
  const entry = journal.prepare("store", "agent.approve", {
    id: 1,
    epoch: 1,
    approved: true,
  });
  let dispatched = 0;
  await assert.rejects(
    journal.resolve(
      {
        request: async () => {
          dispatched++;
          throw Error("lost response");
        },
      },
      entry,
    ),
  );
  const reopened = new OperationJournal(storage);
  reopened.select("store");
  const calls = [];
  await reopened.recover(
    {
      request: async (method) => {
        calls.push(method);
        return receipt(entry.request);
      },
    },
    "store",
  );
  assert.deepEqual(calls, ["operations.get"]);
  assert.equal(dispatched, 1);
  assert.equal(reopened.getSnapshot()[0].receipt.state, "committed");
});

test("not_found only resubmits the original ID after explicit intent; other storage namespaces are isolated", async () => {
  const { journal } = await fixture();
  const entry = journal.prepare("store", "agent.approve", {
    id: 1,
    epoch: 1,
    approved: true,
  });
  entry.attempted = true;
  journal.save(entry);
  const calls = [];
  const client = {
    request: async (method, input) => {
      calls.push([method, input]);
      return receipt(
        entry.request,
        method === "operations.get" ? "not_found" : "committed",
      );
    },
  };
  await journal.recover(client, "store");
  assert.equal(calls.length, 1);
  await journal.resolve(client, entry);
  assert.equal(calls[2][0], "operations.execute");
  assert.equal(calls[2][1].operation_id, entry.request.operation_id);
  journal.select("other");
  assert.equal(journal.getSnapshot().length, 0);
});

test("persist failure prevents dispatch and a late not_found cannot regress committed evidence", async () => {
  const { journal, storage } = await fixture();
  storage.setItem = () => {
    throw Error("quota");
  };
  assert.throws(
    () =>
      journal.prepare("store", "agent.approve", {
        id: 1,
        epoch: 1,
        approved: true,
      }),
    /quota/,
  );
  const f = await fixture();
  const entry = f.journal.prepare("store", "agent.approve", {
    id: 1,
    epoch: 1,
    approved: true,
  });
  f.journal.accept(entry, receipt(entry.request));
  assert.equal(
    f.journal.accept(entry, receipt(entry.request, "not_found")).state,
    "committed",
  );
  f.journal.acknowledge(entry);
  f.journal.accept(entry, receipt(entry.request));
  assert.equal(f.storage.length, 0);
});

test("receipt identity is checked before local pending data can be cleared", async () => {
  const { journal } = await fixture();
  const entry = journal.prepare("store", "agent.approve", {
    id: 1,
    epoch: 1,
    approved: true,
  });
  assert.throws(
    () =>
      journal.accept(entry, {
        ...receipt(entry.request),
        operation_id: "other",
      }),
    { kind: "invalid_response" },
  );
  assert.equal(journal.getSnapshot().length, 1);
});
