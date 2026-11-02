const http = require("node:http");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function agentServer({
  plan,
  malformed = false,
  delay = 2,
  thinking = false,
  reply,
  beforeResponse,
} = {}) {
  const requests = [],
    responses = new Set();
  const server = http.createServer(async (req, res) => {
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
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    responses.add(res);
    res.once("close", () => responses.delete(res));
    const emit = async (data) => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
      await sleep(delay);
    };
    const fragments = (s) => [s.slice(0, 2), s.slice(2, 7), s.slice(7)];
    const protocol = req.url.endsWith("/messages")
      ? "anthropic"
      : req.url.endsWith("/responses")
        ? "responses"
        : "chat_completions";
    if (protocol === "anthropic")
      await emit({
        type: "message_start",
        message: { usage: { input_tokens: 11 } },
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
    if (protocol === "chat_completions") {
      await emit({
        choices: [
          { delta: {}, finish_reason: calls?.length ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 9 },
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
