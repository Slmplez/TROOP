const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { setup, until, sleep } = require("../test/fixtures/hooks-fixture.cjs");
const { CoreSupervisor } = require("../src/core-client.cjs");
const { coreBinary } = require("../src/core-path.cjs");
const {
  createBackup,
  restoreBackup,
  sha256,
} = require("../src/event-deployment.cjs");
const {
  cleanupEventCredentials,
} = require("../test/fixtures/events-credentials.cjs");

const root = path.resolve(__dirname, "../../..");
const faultMode = process.argv.includes("--faults");
const evidence = path.join(
  root,
  faultMode
    ? "verification/github-deployment-e3-2026-11-08"
    : "verification/github-deployment-e2-2026-11-08",
);
const repository = "Slmplez/TROOP";
const environment = {
  ...process.env,
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
};
process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.ALL_PROXY = "";
fs.mkdirSync(evidence, { recursive: true });
const report = {
  repository,
  started_at: new Date().toISOString(),
  scenarios: [],
  cleanup: [],
};
const save = () =>
  fs.writeFileSync(
    path.join(evidence, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const redactions = [];
const gh = (route, method = "GET", input) => {
  const args = ["api", route, "--method", method];
  if (input !== undefined) args.push("--input", "-");
  let value;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      value = execFileSync("gh", args, {
        env: environment,
        windowsHide: true,
        encoding: "utf8",
        input: input === undefined ? undefined : JSON.stringify(input),
        timeout: method === "POST" ? 30000 : 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      break;
    } catch (error) {
      report.last_api_failure = {
        route,
        method,
        code: error.code ?? null,
        status: error.status,
        signal: error.signal,
        http_status:
          String(error.stderr ?? "").match(/HTTP (\d{3})/)?.[1] ?? null,
        detail: redactions
          .reduce(
            (text, secret) => text.replaceAll(secret, "[redacted]"),
            String(error.stderr ?? ""),
          )
          .slice(0, 700),
      };
      report.api_failures ??= [];
      report.api_failures.push(report.last_api_failure);
      const beforeConnect = /dial tcp .*connectex/.test(
        String(error.stderr ?? ""),
      );
      if (
        (method === "POST" && !route.endsWith("/attempts") && !beforeConnect) ||
        attempt === 4
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  return value.trim()
    ? JSON.parse(value, (key, item, context) =>
        typeof item === "number" && !Number.isSafeInteger(item)
          ? context.source
          : item,
      )
    : null;
};
async function command(core, method, input) {
  const receipt = await core.request("operations.execute", {
    operation_id: crypto.randomUUID(),
    instance_id: core.snapshot().storage_instance,
    method,
    input,
  });
  assert.equal(receipt.state, "committed", JSON.stringify(receipt.error));
  return receipt.result;
}

async function main() {
  const permission = gh(`repos/${repository}`);
  assert.equal(permission.full_name, repository);
  assert.equal(permission.permissions.admin, true);
  report.repository_permission = "admin";
  let target = null,
    source = null,
    tunnel = null;
  const proxy = http.createServer((request, response) => {
    if (
      !target ||
      request.method !== "POST" ||
      request.url !== `/webhooks/${source}`
    ) {
      response.writeHead(404).end();
      return;
    }
    const destination = new URL(request.url, target);
    const forwarded = http.request(
      destination,
      { method: "POST", headers: request.headers },
      (upstream) => {
        report.proxy_last_status = upstream.statusCode;
        response.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(response);
      },
    );
    forwarded.on("error", (error) => {
      report.proxy_last_error = error.code;
      response.writeHead(502).end();
    });
    forwarded.setTimeout(10000, () => forwarded.destroy());
    request.on("aborted", () => forwarded.destroy());
    request.pipe(forwarded);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const binary = path.join(
      root,
      ".scratch/event-deployment-tools/cloudflared.exe",
    );
    assert.equal(
      crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
      "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343",
    );
    let tunnelOutput = "";
    tunnel = spawn(
      binary,
      [
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "--url",
        `http://127.0.0.1:${proxy.address().port}`,
      ],
      {
        env: environment,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    tunnel.stderr.on("data", (chunk) => {
      tunnelOutput = (tunnelOutput + chunk.toString()).slice(-18000);
    });
    tunnel.stdout.on("data", (chunk) => {
      tunnelOutput = (tunnelOutput + chunk.toString()).slice(-18000);
    });
    let origin;
    try {
      origin = await until(
        () =>
          tunnelOutput.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0],
        60000,
      );
      await until(
        () => tunnelOutput.includes("Registered tunnel connection"),
        60000,
      );
    } catch (error) {
      fs.writeFileSync(path.join(evidence, "tunnel.log"), tunnelOutput);
      throw error;
    }
    report.tunnel = {
      provider: "Cloudflare Quick Tunnel",
      version: "2026.10.7",
      origin,
      allowed_route: "POST /webhooks/<experiment-source-id>",
    };
    console.log("Temporary HTTPS tunnel connected.");
    save();
    for (const mode of faultMode ? ["independent"] : ["local", "independent"]) {
      const cleanups = [];
      const h = await setup({ after: (fn) => cleanups.push(fn) });
      let receiver = null,
        hook = null,
        issue = null;
      const item = { mode, steps: [], cleanup: {} };
      report.scenarios.push(item);
      const secret = crypto.randomBytes(32).toString("hex");
      const consumer = crypto.randomBytes(32).toString("hex");
      redactions.push(secret, consumer);
      source = crypto.randomUUID();
      try {
        const consumerId = h.core.snapshot().storage_instance;
        const definition = {
          name: `E2 isolated ${mode}`,
          kind: "github",
          project: repository,
          workspace_id: h.wid,
          enabled: true,
          mode: "local",
          api_base_url: "https://api.github.com",
          consumer_id: consumerId,
        };
        if (mode === "independent") {
          receiver = new CoreSupervisor({
            executable: path.resolve(__dirname, "../bin", coreBinary),
            args: [
              "--data-dir",
              path.join(h.directory, "receiver"),
              "--event-receiver",
            ],
            timeout: 10000,
          });
          await receiver.start();
          target = (await receiver.request("events.health", {})).address;
          await command(receiver, "events.source.save", {
            id: source,
            expected_revision: 0,
            definition,
            secrets: { webhook_secret: secret, consumer_token: consumer },
          });
          const health = await receiver.request("events.health", {});
          definition.mode = "remote";
          definition.receiver_url = health.address;
          definition.receiver_instance = health.instance_id;
        } else target = (await h.core.request("events.health", {})).address;
        await command(h.core, "events.source.save", {
          id: source,
          expected_revision: 0,
          definition,
          secrets: { webhook_secret: secret, consumer_token: consumer },
        });
        await until(async () => {
          try {
            const probe = await fetch(`${origin}/webhooks/${source}`, {
              method: "POST",
              body: "{}",
              signal: AbortSignal.timeout(5000),
            });
            item.public_probe_status = probe.status;
            await probe.arrayBuffer();
            return probe.status === 401;
          } catch {
            return false;
          }
        }, 60000);
        item.steps.push(
          "public HTTPS reached the selected Core signature gate",
        );
        const grant = await command(h.core, "authorizations.save", {
          expected_revision: 0,
          grant: {
            name: "E2 synthetic output only",
            purpose: "tool_call",
            agent_id: 1,
            engine_id: "native",
            workspace_id: h.wid,
            project_ids: [],
            read_roots: [h.workspace],
            write_roots: [h.workspace],
            operations: ["write_file"],
            network: "none",
            expires_at: Math.floor(Date.now() / 1000) + 900,
            rule_id: null,
          },
        });
        const outputFile = `github-${mode}.txt`;
        const rule = await command(h.core, "rules.save", {
          expected_revision: 0,
          rule: {
            name: `E2 ${mode} issue opened`,
            enabled: true,
            event: "github.issue.changed",
            event_state: "open",
            source_id: source,
            source_run_id: null,
            workspace_id: h.wid,
            expires_at: grant.expires_at,
            start: {
              client_run_id: crypto.randomUUID(),
              workspace_id: h.wid,
              agent_id: 1,
              authorization_id: grant.id,
              goal: "Save isolated evidence for the authorized real GitHub webhook experiment",
              action: {
                name: "write_file",
                arguments: {
                  path: outputFile,
                  content: `Verified real GitHub issue webhook (${mode}).\n`,
                  expected_hash: "missing",
                },
              },
            },
          },
        });
        item.hook_url_attempted = `${origin}/webhooks/${source}`;
        save();
        hook = gh(`repos/${repository}/hooks`, "POST", {
          name: "web",
          active: true,
          events: ["issues"],
          config: {
            url: `${origin}/webhooks/${source}`,
            content_type: "json",
            secret,
            insecure_ssl: "0",
          },
        });
        item.hook_id = hook.id;
        item.source_id = source;
        if (receiver) await h.core.stop();
        item.issue_title_attempted = `[E2 experiment] TROOP ${mode} webhook ${new Date().toISOString()}`;
        save();
        issue = gh(`repos/${repository}/issues`, "POST", {
          title: item.issue_title_attempted,
          body: "Authorized isolated integration experiment for event receipt, current-state verification, deduplication and restart. This issue is closed automatically after validation. Contains synthetic data only.",
        });
        item.issue_url = issue.html_url;
        item.issue_number = issue.number;
        save();
        const inboxCore = receiver ?? h.core;
        await until(
          async () =>
            (await inboxCore.request("events.inbox", { source_id: source }))
              .items.length > 0,
          90000,
        );
        item.steps.push(
          receiver
            ? "real GitHub event persisted while consumer Core was offline"
            : "real GitHub event persisted through public HTTPS",
        );
        if (receiver) await h.core.start();
        const record = await until(async () => {
          const page = await h.core.request("events.records", {
            source_id: source,
          });
          return page.items.find(
            (event) =>
              event.subject_id === String(issue.number) &&
              event.review_state === "valid",
          );
        }, 90000);
        item.steps.push(
          "current issue state verified against the real GitHub API",
        );
        const run = await until(async () => {
          const history = await h.core.request("rules.history", {
            id: rule.id,
          });
          return history.deliveries.find(
            (delivery) => delivery.state === "dispatched",
          );
        }, 30000);
        await h.done(run.run_id);
        assert.ok(
          fs
            .readFileSync(path.join(h.workspace, outputFile), "utf8")
            .includes("Verified real GitHub"),
        );
        item.run_id = run.run_id;
        item.external_event_id = record.id;
        item.steps.push(
          "preauthorized native write_file produced the fixed synthetic output with zero model requests",
        );
        if (!faultMode) {
          const deliveries = gh(
            `repos/${repository}/hooks/${hook.id}/deliveries`,
          );
          const delivery = deliveries.find(
            (entry) => entry.event === "issues" && entry.action === "opened",
          );
          assert.ok(delivery, "GitHub delivery receipt missing");
          item.delivery = {
            id: delivery.id,
            guid: delivery.guid,
            status_code: delivery.status_code,
          };
          gh(
            `repos/${repository}/hooks/${hook.id}/deliveries/${delivery.id}/attempts`,
            "POST",
          );
          const redelivery = await until(async () => {
            try {
              const attempts = gh(
                `repos/${repository}/hooks/${hook.id}/deliveries`,
              );
              return attempts.find(
                (attempt) =>
                  attempt.guid === delivery.guid &&
                  attempt.redelivery === true &&
                  attempt.status_code === 202,
              );
            } catch {
              return false;
            }
          }, 60000);
          item.redelivery = {
            id: redelivery.id,
            status_code: redelivery.status_code,
          };
          assert.equal(
            (await inboxCore.request("events.inbox", { source_id: source }))
              .items.length,
            1,
          );
          assert.equal(
            (await h.core.request("agent.list", {})).items.length,
            1,
          );
          item.steps.push(
            "GitHub redelivery retained one Inbox event and one Run",
          );
        }
        await h.core.stop();
        await h.core.start();
        await sleep(500);
        assert.equal((await h.core.request("agent.list", {})).items.length, 1);
        item.steps.push(
          "Core restart retained the Run identity without replaying effects",
        );
        if (faultMode) {
          const originalHealth = await receiver.request("events.health", {});
          const binary = path.resolve(__dirname, "../bin", coreBinary);
          const snapshotDirectory = path.join(h.directory, "receiver-backup");
          const restoredDirectory = path.join(h.directory, "receiver-restored");
          const manifest = await createBackup(
            {
              version: 1,
              mode: "receiver",
              executable: binary,
              core_sha256: sha256(binary),
              data_directory: path.join(h.directory, "receiver"),
              listen: new URL(originalHealth.address).host,
              health_file: path.join(h.directory, "backup-health.json"),
            },
            snapshotDirectory,
          );
          await command(h.core, "authorizations.revoke", {
            id: grant.id,
            expected_revision: grant.revision,
          });
          await receiver.stop();
          gh(`repos/${repository}/issues/${issue.number}`, "PATCH", {
            state: "closed",
          });
          await sleep(1200);
          const reopened = gh(
            `repos/${repository}/issues/${issue.number}`,
            "PATCH",
            { state: "open" },
          );
          const failed = await until(async () => {
            try {
              return gh(`repos/${repository}/hooks/${hook.id}/deliveries`).find(
                (entry) =>
                  entry.action === "reopened" && entry.status_code >= 400,
              );
            } catch {
              return false;
            }
          }, 60000);
          item.receiver_outage_delivery = {
            id: failed.id,
            guid: failed.guid,
            status_code: failed.status_code,
          };
          restoreBackup(snapshotDirectory, restoredDirectory);
          receiver = new CoreSupervisor({
            executable: binary,
            args: ["--data-dir", restoredDirectory, "--event-receiver"],
            timeout: 10000,
          });
          await receiver.start();
          const restoredHealth = await receiver.request("events.health", {});
          assert.equal(restoredHealth.instance_id, manifest.instance_id);
          target = restoredHealth.address;
          definition.receiver_url = target;
          await command(h.core, "events.source.save", {
            id: source,
            expected_revision: 1,
            definition,
            secrets: {},
          });
          gh(
            `repos/${repository}/hooks/${hook.id}/deliveries/${failed.id}/attempts`,
            "POST",
          );
          const recoveredDelivery = await until(async () => {
            try {
              return gh(`repos/${repository}/hooks/${hook.id}/deliveries`).find(
                (entry) =>
                  entry.guid === failed.guid &&
                  entry.redelivery &&
                  entry.status_code === 202,
              );
            } catch {
              return false;
            }
          }, 60000);
          item.recovered_delivery = {
            id: recoveredDelivery.id,
            status_code: recoveredDelivery.status_code,
          };
          await until(
            async () =>
              (
                await h.core.request("events.records", { source_id: source })
              ).items.find(
                (entry) =>
                  entry.subject_version === reopened.updated_at &&
                  entry.state === "open" &&
                  entry.review_state === "valid",
              ),
            90000,
          );
          assert.equal(
            (await h.core.request("agent.list", {})).items.length,
            1,
          );
          item.steps.push(
            "receiver outage produced a real GitHub failure; restoring the consistent backup and redelivering retained source identity and durable events",
          );
          const replacement = crypto.randomBytes(32).toString("hex");
          redactions.push(replacement);
          await command(receiver, "events.source.save", {
            id: source,
            expected_revision: 1,
            definition: {
              name: `E2 isolated ${mode}`,
              kind: "github",
              project: repository,
              workspace_id: h.wid,
              enabled: true,
              mode: "local",
              api_base_url: "https://api.github.com",
              consumer_id: consumerId,
            },
            secrets: { webhook_secret: replacement },
          });
          gh(`repos/${repository}/hooks/${hook.id}/config`, "PATCH", {
            url: `${origin}/webhooks/${source}`,
            content_type: "json",
            secret: replacement,
            insecure_ssl: "0",
          });
          const oldBody = "{}";
          const rejectedOldKey = await fetch(`${origin}/webhooks/${source}`, {
            method: "POST",
            body: oldBody,
            headers: {
              "x-github-event": "issues",
              "x-github-delivery": crypto.randomUUID(),
              "x-hub-signature-256":
                "sha256=" +
                crypto
                  .createHmac("sha256", secret)
                  .update(oldBody)
                  .digest("hex"),
            },
          });
          assert.equal(rejectedOldKey.status, 401);
          await rejectedOldKey.arrayBuffer();
          gh(`repos/${repository}/issues/${issue.number}`, "PATCH", {
            state: "closed",
          });
          await sleep(1200);
          const rotatedEvent = gh(
            `repos/${repository}/issues/${issue.number}`,
            "PATCH",
            { state: "open" },
          );
          const rotated = await until(
            async () =>
              (
                await h.core.request("events.records", { source_id: source })
              ).items.find(
                (entry) =>
                  entry.subject_version === rotatedEvent.updated_at &&
                  entry.state === "open" &&
                  entry.review_state === "valid",
              ),
            90000,
          );
          // Let the existing workspace cooldown expire so the grant denial is
          // independently observable in the normal simulation entry point.
          await sleep(61000);
          const denied = await h.core.request("rules.simulate", {
            id: rule.id,
            external_event_id: rotated.id,
          });
          assert.equal(denied.matched, true);
          assert.equal(denied.executable, false);
          assert.ok(denied.reason.includes("授权"), denied.reason);
          assert.equal(
            (await h.core.request("agent.list", {})).items.length,
            1,
          );
          item.rotation = {
            old_signature_status: 401,
            new_github_event: rotated.id,
            revoked_grant_blocker: denied.reason,
            total_runs: 1,
          };
          item.steps.push(
            "rotated webhook key accepted a new real GitHub event, rejected the old signature, and the revoked execution grant blocked a new Run",
          );
        }
        item.passed = true;
      } catch (error) {
        item.failure = {
          kind: error.name,
          code: error.code ?? null,
          api: report.last_api_failure ?? null,
        };
        throw error;
      } finally {
        // Reconcile an ambiguous create by its exact owned identity before
        // cleanup, so a lost POST response cannot leave an untracked object.
        if (!hook && item.hook_url_attempted) {
          try {
            hook = gh(`repos/${repository}/hooks`).find(
              (entry) => entry.config.url === item.hook_url_attempted,
            );
          } catch {
            item.cleanup.hook_reconciliation_failed = true;
          }
        }
        if (!issue && item.issue_title_attempted) {
          try {
            issue = gh(
              `repos/${repository}/issues?state=open&creator=Slmplez&per_page=100`,
            ).find((entry) => entry.title === item.issue_title_attempted);
          } catch {
            item.cleanup.issue_reconciliation_failed = true;
          }
        }
        if (hook) {
          try {
            gh(`repos/${repository}/hooks/${hook.id}`, "DELETE");
            item.cleanup.webhook_deleted = true;
          } catch {
            item.cleanup.webhook_deleted = false;
          }
        }
        if (issue) {
          try {
            gh(`repos/${repository}/issues/${issue.number}`, "PATCH", {
              state: "closed",
              state_reason: "completed",
            });
            item.cleanup.issue_closed = true;
          } catch (error) {
            item.cleanup.issue_closed = false;
            item.cleanup.issue_close_error = error.code ?? error.status;
          }
        }
        target = null;
        if (receiver) {
          await receiver.stop();
          cleanupEventCredentials([path.join(h.directory, "receiver")]);
        }
        for (const cleanup of cleanups) await cleanup();
        save();
      }
      console.log(`Real GitHub ${mode} scenario passed.`);
    }
    report.passed = report.scenarios.every(
      (item) =>
        item.passed &&
        item.cleanup.webhook_deleted &&
        item.cleanup.issue_closed,
    );
  } finally {
    if (tunnel) {
      const stopped = new Promise((resolve) => tunnel.once("close", resolve));
      if (tunnel.exitCode === null) {
        tunnel.kill();
        await stopped;
      }
    }
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    report.completed_at = new Date().toISOString();
    report.tunnel_stopped = true;
    save();
  }
}
main().catch((error) => {
  report.passed = false;
  // Avoid persisting gh command input or diagnostic objects containing secrets.
  report.error =
    error instanceof assert.AssertionError
      ? error.message
      : "Experiment failed; inspect stage records and network availability.";
  save();
  console.error(report.error);
  process.exitCode = 1;
});
