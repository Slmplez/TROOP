import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const reportPath = path.join(
  root,
  "verification/cli-engines-2026-11-07/environment-smoke.json",
);
const temporary = path.join(root, ".tmp-troop-cli");
fs.mkdirSync(temporary, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporary, "environment-"));
const npmRoot = path.join(process.env.APPDATA, "npm/node_modules");
const marker = "TROOP_CLI_CONNECTION_OK";
const prompt = `Reply with exactly ${marker}. Do not use tools or access files.`;
function claudeConfiguration() {
  const settingsPath = path.join(
    process.env.USERPROFILE,
    ".claude/settings.json",
  );
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
  const env = Object.fromEntries(
    Object.entries(settings.env ?? {}).filter(
      ([key, value]) =>
        /^ANTHROPIC_(BASE_URL|API_KEY|AUTH_TOKEN|MODEL|DEFAULT_.*_MODEL)$/.test(
          key,
        ) && typeof value === "string",
    ),
  );
  return {
    env,
    model: typeof settings.model === "string" ? settings.model : null,
  };
}
const timeoutMs = Number(process.env.TROOP_CLI_PROBE_TIMEOUT_MS ?? 120000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000)
  throw Error("CLI probe timeout must be between 1000 and 120000 ms");

function npmProgram(packageName, binName) {
  const packageRoot = path.join(npmRoot, packageName);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  const entry = path.resolve(
    packageRoot,
    typeof pkg.bin === "string" ? pkg.bin : pkg.bin[binName],
  );
  return entry.endsWith(".exe") ? [entry, []] : [process.execPath, [entry]];
}
const engines = [
  {
    id: "codex",
    program: () => npmProgram("@openai/codex", "codex"),
    args: [
      "-a",
      "never",
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      prompt,
    ],
  },
  {
    id: "claude",
    program: () => npmProgram("@anthropic-ai/claude-code", "claude"),
    args: [
      "--print",
      "--restricted",
      "--safe-mode",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      "",
      "--no-session-persistence",
      "--output-format",
      "json",
      prompt,
    ],
  },
  {
    id: "grok",
    program: () => [
      path.join(process.env.USERPROFILE, ".grok/bin/grok.exe"),
      [],
    ],
    args: [
      "--single",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--disable-web-search",
      "--no-subagents",
    ],
  },
  {
    id: "opencode",
    program: () => npmProgram("opencode-ai", "opencode"),
    args: ["--pure", "run", "--format", "json", prompt],
    env: { OPENCODE_PERMISSION: '{"*":"deny"}' },
  },
  {
    id: "oh-my-pi",
    program: () => [path.join(process.env.LOCALAPPDATA, "omp/omp.exe"), []],
    args: [
      "--print",
      "--mode",
      "json",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--no-context-files",
      "--no-title",
      prompt,
    ],
  },
  {
    id: "pi",
    program: () => npmProgram("@earendil-works/pi-coding-agent", "pi"),
    args: [
      "--print",
      "--mode",
      "json",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
      prompt,
    ],
  },
  {
    id: "copilot",
    program: () => npmProgram("@github/copilot", "copilot"),
    args: [
      "--prompt",
      prompt,
      "--no-ask-user",
      "--available-tools",
      "--disable-builtin-mcps",
      "--no-custom-instructions",
      "--no-auto-update",
      "--output-format",
      "json",
    ],
  },
];

function assistantText(event) {
  if (event.type === "item.completed" && event.item?.type === "agent_message")
    return event.item.text;
  if (event.type === "result" && !event.is_error) return event.result;
  if (event.type === "text") return event.part?.text ?? event.text;
  if (event.type === "assistant.message") return event.data?.content;
  if (
    event.message?.role === "assistant" &&
    Array.isArray(event.message.content)
  )
    return event.message.content
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("");
  return "";
}
function classify(text) {
  if (/quota|credits?|billing|insufficient.balance|subscription/i.test(text))
    return "account_access_required";
  if (
    /unauth|not.authenticated|log.?in|sign.?in|no.api.key|missing.api.key|authentication/i.test(
      text,
    )
  )
    return "authentication_required";
  if (
    /ECONN|ENOTFOUND|fetch.failed|timed.out|connection|network|TLS|certificate/i.test(
      text,
    )
  )
    return "network_error";
  if (
    /unknown.option|unexpected.argument|unrecognized|invalid.argument/i.test(
      text,
    )
  )
    return "invocation_rejected";
  return "process_error";
}
async function check(engine) {
  const cwd = path.join(directory, engine.id);
  fs.mkdirSync(cwd);
  const started = Date.now();
  let program,
    args = engine.args,
    modelEnvironment = engine.env;
  try {
    program = engine.program();
    if (engine.id === "claude") {
      const configuration = claudeConfiguration();
      modelEnvironment = configuration.env;
      if (configuration.model)
        args = [...args.slice(0, -1), "--model", configuration.model, prompt];
    }
  } catch {
    return {
      engine: engine.id,
      state: "configuration_unavailable",
      confirmed_assistant_reply: false,
      duration_ms: Date.now() - started,
    };
  }
  const child = spawn(program[0], [...program[1], ...args], {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      DISABLE_AUTOUPDATER: "1",
      ...modelEnvironment,
    },
  });
  let output = "",
    errors = "",
    timedOut = false,
    terminationExitCode = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    output = (output + text).slice(-262144);
  });
  child.stderr.on("data", (text) => {
    errors = (errors + text).slice(-65536);
  });
  const outcome = await new Promise((resolve) => {
    let completed = false,
      grace;
    const finish = (code, closed) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (!closed) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      resolve({ code, closed });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.pid) {
        const termination = spawnSync(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
            timeout: 3000,
          },
        );
        terminationExitCode = termination.status;
      }
      grace = setTimeout(() => finish(null, false), 2000);
    }, timeoutMs);
    child.once("error", () => finish(null, true));
    child.once("close", (code) => finish(code, true));
  });
  const code = outcome.code;
  const events = output.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const confirmed =
    !timedOut &&
    code === 0 &&
    events.some((event) => {
      const reply = assistantText(event);
      return typeof reply === "string" && reply.trim() === marker;
    });
  return {
    engine: engine.id,
    exit_code: code,
    timed_out: timedOut,
    termination_exit_code: terminationExitCode,
    confirmed_assistant_reply: confirmed,
    process_closed: outcome.closed,
    state: !outcome.closed
      ? "stop_unconfirmed"
      : confirmed
        ? "connected"
        : timedOut
          ? "timed_out"
          : classify(output + errors),
    diagnostic_terms: [
      "credit",
      "balance",
      "billing",
      "authentication",
      "API key",
      "token",
      "invalid",
      "permission",
      "trust",
      "config",
      "subscription",
      "model",
      "limit",
      "unauthorized",
    ].filter((term) =>
      (output + errors).toLowerCase().includes(term.toLowerCase()),
    ),
    event_types: [
      ...new Set(events.map((event) => event.type).filter(Boolean)),
    ].slice(0, 20),
    duration_ms: Date.now() - started,
  };
}

const report = {
  scope: "standalone_cli_model_connectivity",
  production_core_acceptance: false,
  directory,
  results: [],
};
const selected = process.argv.slice(2);
const pending = engines.filter(
  (engine) => !selected.length || selected.includes(engine.id),
);
await Promise.all(
  Array.from({ length: 2 }, async () => {
    while (pending.length) {
      const result = await check(pending.shift());
      report.results.push(result);
      if (result.state === "stop_unconfirmed") pending.length = 0;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(result));
    }
  }),
);
