// A deterministic loopback HTTP/SSE service. Never contacts a commercial provider.
const http = require("node:http");
const { once } = require("node:events");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function modelServer() {
  const requests = [];
  const connections = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 500000) {
          res.writeHead(413).end();
          return;
        }
      }
      const body = JSON.parse(raw);
      const record = {
        url: req.url,
        body,
        headers: req.headers,
        closed: false,
      };
      requests.push(record);
      res.on("close", () => {
        record.closed = true;
      });
      const mode = req.url.split("/")[1];
      if (mode === "redirect") {
        res.writeHead(307, { location: "/normal/chat/completions" }).end();
        return;
      }
      if (mode === "auth" || mode === "rate") {
        res
          .writeHead(mode === "auth" ? 401 : 429, {
            "content-type": "application/json",
          })
          .end(
            JSON.stringify({
              error: {
                message:
                  "ECHO " +
                  req.headers.authorization +
                  " " +
                  req.headers["x-api-key"],
              },
            }),
          );
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      const send = (data, event) => {
        if (res.destroyed) return;
        res.write(
          (event ? "event: " + event + "\r\n" : "") +
            "data: " +
            (typeof data === "string" ? data : JSON.stringify(data)) +
            "\r\n\r\n",
        );
      };
      if (mode === "malformed") {
        res.end("data: not-json\n\n");
        return;
      }
      if (mode === "oversize") {
        res.end("data: " + "x".repeat(66000) + "\n\n");
        return;
      }
      if (mode === "timeout") {
        return;
      }
      const responses = req.url.endsWith("/responses"),
        anthropic = req.url.endsWith("/messages");
      if (anthropic)
        send(
          {
            type: "message_start",
            message: { usage: { input_tokens: 9, output_tokens: 0 } },
          },
          "message_start",
        );
      const text =
        mode === "long" ? "段落\n".repeat(1800) : "你好，来自真实 HTTP 流。";
      const chunks =
        mode === "long"
          ? [text]
          : [text.slice(0, 2), text.slice(2, 8), text.slice(8)];
      for (let i = 0; i < chunks.length; i++) {
        const delta = responses
          ? { type: "response.output_text.delta", delta: chunks[i] }
          : anthropic
            ? {
                type: "content_block_delta",
                delta: { type: "text_delta", text: chunks[i] },
              }
            : {
                choices: [
                  {
                    index: 0,
                    delta: { content: chunks[i] },
                    finish_reason: null,
                  },
                ],
              };
        const line = "data: " + JSON.stringify(delta) + "\r\n\r\n";
        // Split within the UTF-8 encoding of the first Chinese character.
        const buffer = Buffer.from(line);
        const split = buffer.indexOf(Buffer.from(chunks[i][0])) + 1;
        if (!res.destroyed) res.write(buffer.subarray(0, split));
        await sleep(3);
        if (!res.destroyed) res.write(buffer.subarray(split));
        if (i === 0 && mode === "drop") {
          await sleep(80);
          res.destroy();
          return;
        }
        await sleep(mode === "slow" ? 1500 : mode === "ui" ? 250 : 40);
        if (res.destroyed) return;
      }
      if (mode === "tool")
        send({
          choices: [{ delta: { tool_calls: [{ id: "owned-fixture-tool" }] } }],
        });
      else if (mode === "stream-error")
        send({ error: { message: "must not be echoed" } });
      else if (responses)
        send(
          {
            type: "response.completed",
            response: { usage: { input_tokens: 9, output_tokens: 7 } },
          },
          "response.completed",
        );
      else if (anthropic) {
        send(
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 7 },
          },
          "message_delta",
        );
        send({ type: "message_stop" }, "message_stop");
      } else {
        send({
          choices: [
            { delta: {}, finish_reason: mode === "length" ? "length" : "stop" },
          ],
        });
        send({
          choices: [],
          usage: { prompt_tokens: 9, completion_tokens: 7 },
        });
        send("[DONE]");
      }
      res.end();
    } catch {
      if (!res.destroyed) res.destroy();
    }
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
module.exports = { modelServer, sleep };
