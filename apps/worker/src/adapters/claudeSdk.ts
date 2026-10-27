import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  type CanUseTool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { type AdapterInfo, LIMITS, truncate } from "@pairloom/shared";
import { type WorkerConfig, buildAgentEnv, detectModelCredential } from "../config.js";
import type { AgentAdapter, AgentContext, AgentRun } from "./types.js";

/**
 * Deny rules apply in every permission mode. Pattern rules are best-effort
 * ("as written" matching), which is why Bash is never auto-approved: anything
 * not read-only reaches the host through canUseTool.
 */
export const DENIED_TOOL_RULES = [
  "Bash(git push*)",
  "Bash(git remote*)",
  "Bash(git checkout*)",
  "Bash(git switch*)",
  "Bash(git worktree*)",
  "Bash(git reset --hard*)",
  "Bash(git merge*)",
  "Bash(git rebase*)",
  "Bash(rm -rf /*)",
  "Bash(sudo *)",
];

const COLLAB_PROMPT = `You are working inside Pairloom, a shared workspace where several people collaborate with you.
- Messages may come from different collaborators; each is prefixed with who sent it. All were approved by the session host.
- You work in an isolated git worktree on a dedicated branch. Do not push, switch branches, or modify git remotes.
- Your changes are reviewed by humans before being merged. Summarize what you changed at the end of each task.`;

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string) {
    if (this.closed) throw new Error("Session input is closed");
    const msg = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }

  close() {
    this.closed = true;
    if (this.waiting) this.waiting({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

function sdkVersion(): string | undefined {
  try {
    // package.json is not in the SDK's exports map; locate it next to the entry point.
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
    return pkg.version as string;
  } catch {
    return undefined;
  }
}

export class ClaudeSdkAdapter implements AgentAdapter {
  constructor(private config: WorkerConfig) {}

  info(): AdapterInfo {
    const credential = detectModelCredential();
    const version = sdkVersion();
    return credential
      ? {
          kind: "claude-agent-sdk",
          available: true,
          detail: `Claude Agent SDK with ${credential} (credential present; validated on first turn)`,
          ...(version ? { version } : {}),
        }
      : {
          kind: "claude-agent-sdk",
          available: false,
          detail:
            "No model credential on this worker. Set ANTHROPIC_API_KEY (or Bedrock/Vertex) in the worker environment.",
          ...(version ? { version } : {}),
        };
  }

  async start(ctx: AgentContext): Promise<AgentRun> {
    if (!detectModelCredential()) {
      throw new Error("Real agent unavailable: no ANTHROPIC_API_KEY / Bedrock / Vertex credential on worker");
    }
    const input = new InputQueue();
    const abort = new AbortController();
    let stopping = false;

    const canUseTool: CanUseTool = async (toolName, toolInput, opts) => {
      const answer = await ctx.requestPermission({
        toolName,
        input: toolInput,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.decisionReason ? { decisionReason: opts.decisionReason } : {}),
        signal: opts.signal,
      });
      return answer.behavior === "allow"
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: answer.message };
    };

    const options: Options = {
      cwd: ctx.cwd,
      abortController: abort,
      permissionMode: ctx.permissionPolicy === "accept_edits_in_worktree" ? "acceptEdits" : "default",
      canUseTool,
      disallowedTools: DENIED_TOOL_RULES,
      // Load the repository's CLAUDE.md / project settings, but not the worker host's user settings.
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: COLLAB_PROMPT },
      env: buildAgentEnv(this.config),
      maxTurns: this.config.maxTurns,
      ...(this.config.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.config.maxBudgetUsd } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(ctx.resumeProviderSessionId ? { resume: ctx.resumeProviderSessionId } : {}),
      stderr: (data: string) => {
        if (process.env.PAIRLOOM_DEBUG) process.stderr.write(`[claude ${ctx.sessionId}] ${data}`);
      },
    };

    const q: Query = query({ prompt: input, options });

    void (async () => {
      let error: string | null = null;
      try {
        for await (const message of q) this.handle(ctx, message, q);
      } catch (err) {
        if (!stopping) error = (err as Error).message || String(err);
      } finally {
        ctx.onExit({ error });
      }
    })();

    return {
      send: (text) => {
        input.push(text);
        ctx.onTurnStart();
      },
      interrupt: async () => {
        await q.interrupt();
      },
      stop: async () => {
        stopping = true;
        input.close();
        try {
          q.close();
        } catch {
          abort.abort();
        }
      },
    };
  }

  private handle(ctx: AgentContext, m: SDKMessage, q: Query) {
    switch (m.type) {
      case "system":
        if (m.subtype === "api_retry") {
          ctx.emit("system.notice", {
            level: "warn",
            message: `Model API error ${m.error_status ?? "?"} (${m.error}); retry ${m.attempt}/${m.max_retries}`,
          });
          // A rejected credential will not start working on retry: fail fast and visibly.
          if ((m.error_status === 401 || m.error_status === 403) && m.attempt >= 2) {
            ctx.emit("agent.error", {
              message: `Model credential rejected by provider (HTTP ${m.error_status}). Check the worker's API key.`,
            });
            void q.interrupt().catch(() => {});
          }
          return;
        }
        if (m.subtype === "init") {
          ctx.onProviderSession(m.session_id);
          ctx.emit("agent.init", {
            providerSessionId: m.session_id,
            model: m.model,
            cwd: m.cwd,
            claudeCodeVersion: m.claude_code_version,
            permissionMode: m.permissionMode,
            apiKeySource: m.apiKeySource,
            toolCount: m.tools.length,
          });
        }
        return;
      case "assistant": {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text.trim()) {
            ctx.emit("agent.text", {
              text: truncate(block.text, LIMITS.agentTextMaxChars),
              subagent: m.parent_tool_use_id !== null,
            });
          } else if (block.type === "tool_use") {
            ctx.emit("agent.tool_use", {
              toolUseId: block.id,
              toolName: block.name,
              input: truncate(JSON.stringify(block.input), LIMITS.toolPayloadMaxChars),
              subagent: m.parent_tool_use_id !== null,
            });
          }
        }
        if (m.error) ctx.emit("agent.error", { message: `Assistant error: ${m.error}` });
        return;
      }
      case "user": {
        const content = m.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type === "tool_result") {
            const text =
              typeof block.content === "string"
                ? block.content
                : (block.content ?? [])
                    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
                    .join("\n");
            ctx.emit("agent.tool_result", {
              toolUseId: block.tool_use_id,
              isError: Boolean(block.is_error),
              output: truncate(text, LIMITS.toolPayloadMaxChars),
            });
          }
        }
        return;
      }
      case "result": {
        ctx.emit("agent.result", {
          subtype: m.subtype,
          isError: m.is_error,
          numTurns: m.num_turns,
          totalCostUsd: m.total_cost_usd,
          durationMs: m.duration_ms,
          ...(m.subtype === "success"
            ? { result: truncate(m.result, LIMITS.agentTextMaxChars) }
            : { errors: "errors" in m ? m.errors : [] }),
        });
        ctx.onTurnEnd({ subtype: m.subtype, isError: m.is_error });
        return;
      }
      default:
        return;
    }
  }
}
