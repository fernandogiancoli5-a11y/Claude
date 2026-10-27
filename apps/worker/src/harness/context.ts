import type { ChatMessage, ChatToolCall } from "./provider.js";

/**
 * Builds the messages actually sent to the model from the saved transcript.
 *
 * The transcript is never modified (resume and audit need it intact); only the request
 * view drops content the model no longer needs. Every model call re-sends the whole
 * history, so stale content is paid for on every later call, and providers with
 * per-minute token limits (Groq's free tier: 8,000) reject or throttle long sessions.
 *
 * In order:
 * 1. Earlier turns: each turn ends with the agent's own summary, so tool outputs and
 *    bulky tool-call arguments from before the latest finished turn become short stubs.
 * 2. Current turn: a read_file output is stale once the same file is read again or
 *    rewritten with write_file; a write_file's content is stale once the same file is
 *    rewritten again; a run_tests output is stale once tests run again.
 * 3. Backstop: if still over maxChars, the oldest remaining tool outputs are elided.
 */
export function buildRequestMessages(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const out = messages.map((m) => ({ ...m })) as ChatMessage[];
  const calls = new Map<string, { name: string; args: Record<string, unknown>; at: number }>();
  out.forEach((m, at) => {
    if (m.role !== "assistant" || !m.tool_calls) return;
    for (const c of m.tool_calls) calls.set(c.id, { name: c.function.name, args: parse(c), at });
  });

  // 1. Everything up to the last assistant message without tool calls belongs to finished turns.
  let boundary = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role === "assistant" && !m.tool_calls?.length) {
      boundary = i;
      break;
    }
  }
  for (let i = 0; i < boundary; i++) {
    const m = out[i]!;
    if (m.role === "tool" && m.content.length > STUB_OVER) {
      const name = calls.get(m.tool_call_id)?.name ?? "tool";
      out[i] = {
        ...m,
        content: `[${name} output from an earlier turn omitted; call it again if needed]`,
      };
    } else if (m.role === "assistant" && m.tool_calls) {
      out[i] = { ...m, tool_calls: m.tool_calls.map((c) => shrinkArgs(c, BULKY_ARGS)) };
    }
  }

  // 2. Superseded content anywhere in the history.
  const lastAt = (pred: (name: string, path: string | null) => boolean) => {
    let at = -1;
    for (const c of calls.values()) if (pred(c.name, pathOf(c.args)) && c.at > at) at = c.at;
    return at;
  };
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role === "tool") {
      const c = calls.get(m.tool_call_id);
      if (!c || m.content.length <= STUB_OVER) continue;
      const p = pathOf(c.args);
      if (c.name === "read_file" && p) {
        const later = lastAt((n, q) => q === p && (n === "read_file" || n === "write_file"));
        if (later > c.at)
          out[i] = { ...m, content: `[stale: ${p} was read again or rewritten later]` };
      } else if (c.name === "run_tests" && lastAt((n) => n === "run_tests") > c.at) {
        out[i] = {
          ...m,
          content: `${firstLine(m.content)}\n[output omitted: tests ran again later]`,
        };
      }
    } else if (m.role === "assistant" && m.tool_calls) {
      out[i] = {
        ...m,
        tool_calls: m.tool_calls.map((c) => {
          const p = pathOf(parse(c));
          if (c.function.name !== "write_file" || !p) return c;
          const later = lastAt((n, q) => n === "write_file" && q === p);
          return later > i ? shrinkArgs(c, ["content"]) : c;
        }),
      };
    }
  }

  // 3. Backstop for whatever is still too large.
  const size = () => JSON.stringify(out).length;
  for (let i = 0; i < out.length && size() > maxChars; i++) {
    const m = out[i]!;
    if (m.role === "tool" && m.content.length > 300) {
      out[i] = {
        ...m,
        content: m.content.slice(0, 200) + "\n[older tool output elided to fit the context window]",
      };
    }
  }
  return out;
}

const STUB_OVER = 120;
const BULKY_ARGS = ["content", "old_string", "new_string"];

function parse(c: ChatToolCall): Record<string, unknown> {
  try {
    const v = JSON.parse(c.function.arguments || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function pathOf(args: Record<string, unknown>): string | null {
  return typeof args.path === "string" ? args.path.replace(/^\.\//, "") : null;
}

function shrinkArgs(c: ChatToolCall, keys: string[]): ChatToolCall {
  const args = parse(c);
  let changed = false;
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > STUB_OVER) {
      args[k] = `[${v.length} chars omitted]`;
      changed = true;
    }
  }
  return changed ? { ...c, function: { ...c.function, arguments: JSON.stringify(args) } } : c;
}

function firstLine(s: string) {
  return s.split("\n", 1)[0]!.slice(0, 200);
}
