import { createServer, type Server } from "node:http";

/**
 * MOCKED PROVIDER. A local server speaking the OpenAI-compatible
 * /chat/completions wire format, driven by a script. It is not a model and its
 * results prove nothing about real model behaviour — only that the harness
 * handles the protocol, tools, limits and errors correctly.
 */
export interface StubReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}
export type StubScript = (req: { body: any; n: number }) => StubReply | Promise<StubReply>;

export function toolCalls(
  ...calls: Array<{ name: string; args: unknown; id?: string }>
): StubReply {
  return completion(
    {
      content: null,
      tool_calls: calls.map((c, i) => ({
        id: c.id ?? `call_${Math.random().toString(36).slice(2, 8)}_${i}`,
        type: "function",
        function: {
          name: c.name,
          arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
        },
      })),
    },
    "tool_calls",
  );
}

export function text(content: string, finish = "stop"): StubReply {
  return completion({ content }, finish);
}

function completion(message: Record<string, unknown>, finish: string): StubReply {
  return {
    body: {
      id: "chatcmpl-stub",
      object: "chat.completion",
      model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
    },
  };
}

export function error(
  status: number,
  message: string,
  code?: string,
  headers?: Record<string, string>,
): StubReply {
  return {
    status,
    body: { error: { message, type: "invalid_request_error", ...(code ? { code } : {}) } },
    headers,
  };
}

export async function startStubOpenAI(script: StubScript) {
  const requests: Array<{ body: any; authorized: boolean }> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ body, authorized: (req.headers.authorization ?? "").startsWith("Bearer ") });
      const reply = await script({ body, n: requests.length });
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (res.destroyed) return;
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...(reply.headers ?? {}),
      });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
