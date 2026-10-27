import { createServer, type Server } from "node:http";

/**
 * A local HTTP server that speaks just enough of the Anthropic Messages
 * streaming protocol for the real Claude Code CLI to complete a turn.
 * It is NOT a model: it always answers with fixed text (or a scripted tool call).
 * Used to prove the adapter really launches and drives Claude Code.
 */
export interface StubOptions {
  /** If set, the first assistant turn requests this tool call; later turns reply with text. */
  toolCall?: { name: string; input: Record<string, unknown> };
  status?: number;
}

export async function startStubAnthropic(opts: StubOptions = {}) {
  const requests: Array<{ path: string; body: any }> = [];
  let toolCallSent = false;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      requests.push({ path: req.url ?? "", body });
      if (opts.status) {
        res.writeHead(opts.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const model = body?.model ?? "stub-model";
      const useTool = opts.toolCall && !toolCallSent && Array.isArray(body?.tools) && body.tools.length > 0;
      if (useTool) toolCallSent = true;
      const events: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ];
      if (useTool) {
        events.push(
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_stub1", name: opts.toolCall!.name, input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(opts.toolCall!.input) } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
        );
      } else {
        events.push(
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "STUB-REPLY: protocol stub, not a model." } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
        );
      }
      events.push(["message_stop", { type: "message_stop" }]);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
