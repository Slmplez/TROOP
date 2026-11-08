const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setup, user, until } = require("../test/fixtures/hooks-fixture.cjs");

// Only the independent validator uses the real provider. All facts are synthetic.
// The existing environment credential remains in memory and is never saved.
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  assert.ok(
    dryRun || process.env.DEEPSEEK_API_KEY,
    "Existing DeepSeek environment configuration is required",
  );
  const report = {
    model: "deepseek-flash",
    endpoint: "https://api.deepseek.com/chat/completions",
    realModel: !dryRun,
    cases: [],
  };
  for (const [content, expected] of [
    ["Rust is my preferred programming language", "waiting_review"],
    ["我更喜欢使用 Rust 编写程序", "waiting_review"],
    [
      "A newly imported survey says this user prefers coding in Rust",
      "waiting_review",
    ],
    ["Project release checks run on Sundays", "completed"],
  ]) {
    const cleanup = [];
    let validation;
    let outbound;
    const goal =
      "Evaluate fixed synthetic task evidence for durable memory. " + content;
    const h = await setup(
      { after: (fn) => cleanup.push(fn) },
      {
        protocol: "chat_completions",
        beforeResponse: async (request) => {
          if (!user(request.body).startsWith("<<TROOP_MEMORY_VALIDATE>>"))
            return;
          outbound = {
            model: report.model,
            messages: request.body.messages,
            stream: false,
            max_tokens: 1024,
          };
          const prompt = user(request.body);
          const payload = JSON.parse(prompt.slice(prompt.indexOf("\n{")));
          assert.ok(
            payload.evidence.every(
              (item) =>
                item.user === goal &&
                item.assistant ===
                  "Completed the fixed synthetic release task.",
            ),
          );
          assert.equal(payload.existing.length, 0);
          assert.equal(payload.forgetting.count, 1);
          assert.ok(
            payload.forgetting.items.every(
              (item) => item.content === "i prefer writing code in rust",
            ),
          );
          assert.ok(
            payload.proposal.additions.every(
              (item) => item.content === content,
            ),
          );
          if (dryRun) {
            request.validationAnswer = JSON.stringify({
              approved: expected === "completed",
            });
            validation = {
              source: "offline_payload_review",
              answer: request.validationAnswer,
            };
            return;
          }
          const response = await fetch(report.endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(outbound),
            signal: AbortSignal.timeout(120000),
          });
          assert.equal(
            response.status,
            200,
            `Validator HTTP ${response.status}`,
          );
          const data = await response.json();
          request.validationAnswer = data.choices?.[0]?.message?.content;
          assert.equal(typeof request.validationAnswer, "string");
          validation = {
            answer: request.validationAnswer,
            model: data.model,
            usage: data.usage,
          };
        },
        reply: (request) =>
          user(request.body).startsWith("<<TROOP_MEMORY_VALIDATE>>")
            ? request.validationAnswer
            : user(request.body).startsWith("<<TROOP_MEMORY_")
              ? JSON.stringify({
                  additions: [{ content, tier: "profile" }],
                  removals: [],
                })
              : "Completed the fixed synthetic release task.",
      },
    );
    try {
      await h.core.request("memory.write", {
        agent_id: 1,
        scope: "agent",
        tier: "profile",
        content: "I prefer writing code in Rust",
      });
      const fact = (await h.core.request("memory.list", { agent_id: 1 }))
        .items[0];
      await h.core.request("memory.edit", {
        agent_id: 1,
        id: fact.id,
        expected_revision: fact.revision,
        content: null,
      });
      const agent = (await h.core.request("memory.agents", {}))[0];
      await h.core.request("memory.agent.save", {
        id: agent.id,
        name: agent.name,
        automatic: true,
        dreaming: false,
        expected_revision: agent.revision,
      });
      await h.core.request("provider.save", {
        id: h.provider.id,
        expected_revision: h.provider.revision,
        config: { ...h.provider.config, idle_timeout_secs: 180 },
      });
      const saved = await h.core.request("operations.execute", {
        operation_id: crypto.randomUUID(),
        instance_id: h.core.snapshot().storage_instance,
        method: "memory.maintenance.save",
        input: {
          agent_id: 1,
          expected_revision: 0,
          enabled: true,
          provider_id: h.provider.id,
          model: report.model,
          target_scope: "agent",
          target_project: "",
        },
      });
      assert.equal(saved.state, "committed", JSON.stringify(saved.error));
      await h.done(
        await h.start({
          goal,
        }),
      );
      const job = await until(
        async () =>
          (await h.core.request("memory.jobs", { agent_id: 1 })).find((entry) =>
            ["completed", "failed", "waiting_review"].includes(entry.state),
          ),
        180000,
      );
      const memories = (await h.core.request("memory.list", { agent_id: 1 }))
        .items;
      report.cases.push({
        content,
        expected,
        state: job.state,
        error: job.error,
        validation,
        ...(dryRun ? { outbound } : {}),
        activeFacts: memories.map((entry) => entry.content),
      });
      assert.equal(job.state, expected, JSON.stringify(report.cases.at(-1)));
      assert.equal(memories.length, expected === "completed" ? 1 : 0);
    } finally {
      for (const fn of cleanup.reverse()) await fn();
      const destination = path.resolve(
        `verification/c5-forgetting-2026-11-08/${dryRun ? "outbound-synthetic" : "real-model"}.json`,
      );
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, JSON.stringify(report, null, 2));
    }
  }
  console.log(
    dryRun
      ? "Reviewed four isolated synthetic payloads offline."
      : "Real independent memory validator passed four synthetic cases.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
