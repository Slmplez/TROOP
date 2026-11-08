const http = require("node:http");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function agentServer({
  plan,
  malformed = false,
  delay = 2,
  thinking = false,
  reply,
  beforeResponse,
  metadata,
} = {}) {
  const requests = [],
    responses = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      requests.push({ method: req.method, url: req.url, body: {} });
      const value = metadata?.(req);
      res.writeHead(value === undefined ? 404 : 200, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify(
          value ?? {
            error: { message: "Owned model fixture endpoint unavailable" },
          },
        ),
      );
      return;
    }
    let raw = "";
    for await (const bytes of req) raw += bytes;
    const body = JSON.parse(raw);
    const request = { body, url: req.url };
    requests.push(request);
    if (beforeResponse) await beforeResponse(request, requests);
    const messages = body.messages ?? body.input;
    const hasResults = messages.some(
      (m) =>
        m.role === "tool" ||
        m.type === "function_call_output" ||
        (Array.isArray(m.content) &&
          m.content.some((b) => b.type === "tool_result")),
    );
    const calls =
      typeof plan === "function"
        ? plan(request, requests)
        : hasResults
          ? []
          : plan;
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    const protocol = pathname.endsWith("/messages")
      ? "anthropic"
      : pathname.endsWith("/responses")
        ? "responses"
        : "chat_completions";
    if (protocol === "chat_completions" && body.stream === false) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-owned-fixture",
          object: "chat.completion",
          created: 1700000000,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: calls?.length
                  ? null
                  : typeof reply === "function"
                    ? reply(request, requests)
                    : (reply ?? "工具结果已核对。"),
                ...(calls?.length
                  ? {
                      tool_calls: calls.map((call, index) => ({
                        id: `owned-call-${index}`,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: JSON.stringify(call.arguments),
                        },
                      })),
                    }
                  : {}),
              },
              finish_reason: calls?.length ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 },
        }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    responses.add(res);
    res.once("close", () => responses.delete(res));
    const emit = async (data) => {
      if (protocol === "chat_completions") {
        data = {
          id: "chatcmpl-owned-fixture",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: body.model,
          ...data,
          choices: data.choices.map((choice, index) => ({ index, ...choice })),
        };
      }
      if (!res.destroyed)
        res.write(
          `${protocol === "anthropic" ? `event: ${data.type}\n` : ""}data: ${JSON.stringify(data)}\n\n`,
        );
      await sleep(delay);
    };
    const fragments = (s) => [s.slice(0, 2), s.slice(2, 7), s.slice(7)];
    if (protocol === "anthropic")
      await emit({
        type: "message_start",
        message: {
          id: "msg-owned-fixture",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 0 },
        },
      });
    const output = [];
    const offset = protocol === "anthropic" && thinking ? 2 : 0;
    if (offset) {
      await emit({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      await emit({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "owned reasoning" },
      });
      await emit({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "owned-signature" },
      });
      await emit({ type: "content_block_stop", index: 0 });
      await emit({
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: "owned-opaque" },
      });
      await emit({ type: "content_block_stop", index: 1 });
    }
    for (const [index, call] of (calls ?? []).entries()) {
      const id = `owned-call-${index}`,
        args = malformed ? '{"broken":' : JSON.stringify(call.arguments);
      if (protocol === "chat_completions") {
        await emit({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id,
                    type: "function",
                    function: { name: call.name, arguments: "" },
                  },
                ],
              },
            },
          ],
        });
        for (const part of fragments(args))
          await emit({
            choices: [
              {
                delta: {
                  tool_calls: [{ index, function: { arguments: part } }],
                },
              },
            ],
          });
      } else if (protocol === "anthropic") {
        await emit({
          type: "content_block_start",
          index: index + offset,
          content_block: { type: "tool_use", id, name: call.name, input: {} },
        });
        for (const part of fragments(args))
          await emit({
            type: "content_block_delta",
            index: index + offset,
            delta: { type: "input_json_delta", partial_json: part },
          });
        await emit({ type: "content_block_stop", index: index + offset });
      } else {
        await emit({
          type: "response.output_item.added",
          output_index: index,
          item: {
            id: `fc_${index}`,
            type: "function_call",
            call_id: id,
            name: call.name,
            arguments: "",
          },
        });
        for (const part of fragments(args))
          await emit({
            type: "response.function_call_arguments.delta",
            output_index: index,
            delta: part,
          });
        output.push({
          id: `fc_${index}`,
          type: "function_call",
          call_id: id,
          name: call.name,
          arguments: args,
          status: "completed",
        });
      }
    }
    if (!calls?.length) {
      if (protocol === "anthropic")
        await emit({
          type: "content_block_start",
          index: offset,
          content_block: { type: "text", text: "" },
        });
      for (const text of reply === undefined
        ? ["工具结果", "已核对。"]
        : [typeof reply === "function" ? reply(request, requests) : reply])
        await emit(
          protocol === "anthropic"
            ? {
                type: "content_block_delta",
                index: offset,
                delta: { type: "text_delta", text },
              }
            : protocol === "responses"
              ? { type: "response.output_text.delta", delta: text }
              : { choices: [{ delta: { content: text } }] },
        );
    }
    if (protocol === "anthropic" && !calls?.length)
      await emit({ type: "content_block_stop", index: offset });
    if (protocol === "chat_completions") {
      await emit({
        choices: [
          { delta: {}, finish_reason: calls?.length ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 },
      });
      if (!res.destroyed) res.write("data: [DONE]\n\n");
    } else if (protocol === "anthropic") {
      await emit({
        type: "message_delta",
        delta: { stop_reason: calls?.length ? "tool_use" : "end_turn" },
        usage: { output_tokens: 9 },
      });
      await emit({ type: "message_stop" });
    } else
      await emit({
        type: "response.completed",
        response: { output, usage: { input_tokens: 11, output_tokens: 9 } },
      });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: async () => {
      for (const res of responses) res.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
module.exports = { agentServer, sleep };
