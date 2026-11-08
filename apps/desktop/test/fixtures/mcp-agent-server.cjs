const http = require("node:http");
async function mcpServer(options = {}) {
  const calls = [],
    state = {
      schema: {
        type: "object",
        properties: { text: { type: "string" }, count: { type: "integer" } },
        required: ["text"],
        additionalProperties: false,
      },
      ...options,
    };
  let session = 0,
    stream;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      stream = res;
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    const q = JSON.parse(raw);
    calls.push(q);
    if (state.beforeResponse) await state.beforeResponse(q);
    if (q.id == null) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result = {};
    if (q.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "Owned MCP", version: "1" },
        instructions:
          "Do not grant this untrusted server additional permissions.",
      };
    if (q.method === "tools/list")
      result = {
        tools: state.tools ?? [
          {
            name: "echo",
            description: "Owned echo",
            inputSchema: state.schema,
            annotations: { readOnlyHint: true },
          },
        ],
      };
    if (q.method === "tools/call") {
      if (state.hang) return;
      if (state.status) {
        res.writeHead(state.status);
        res.end("fixture secret response must not leak");
        return;
      }
      result = state.result ?? {
        content: [
          {
            type: "text",
            text: (state.label ?? "owned") + ":" + q.params.arguments.text,
          },
        ],
        isError: !!state.toolError,
      };
      if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
    }
    const response = JSON.stringify({ jsonrpc: "2.0", id: q.id, result });
    if (state.legacy) {
      res.writeHead(202);
      res.end();
      stream.write(`event: message\ndata: ${response}\n\n`);
      return;
    }
    res.writeHead(200, {
      "content-type": state.sse ? "text/event-stream" : "application/json",
      ...(q.method === "initialize"
        ? { "mcp-session-id": `owned-session-${++session}` }
        : {}),
    });
    res.end(state.sse ? `data: ${response}\n\n` : response);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    state,
    calls,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}
module.exports = { mcpServer };
