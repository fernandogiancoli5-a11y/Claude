import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AdapterInfo, LIMITS as SHARED_LIMITS, truncate } from "@pairloom/shared";
import type { AgentAdapter, AgentContext, AgentRun } from "../adapters/types.js";
import {
  type ChatMessage,
  type ChatToolCall,
  type ModelClient,
  ProviderError,
  type ToolSchema,
  estimateCostUsd,
  estimateRequestTokens,
} from "./provider.js";
import { buildRequestMessages } from "./context.js";
import {
  type ProjectSettings,
  Sandbox,
  type ToolName,
  ToolError,
  classifyToolCall,
  codeExecutionAllowed,
  loadProjectSettings,
  runCommand,
  toolSchemas,
} from "./tools.js";

export interface HarnessLimits {
  /** Model calls allowed within one turn (one instruction). */
  maxIterationsPerTurn: number;
  /** Model calls allowed over the whole session, retries included. */
  maxModelCallsPerSession: number;
  /** Wall-clock budget for one turn, including tool execution and approval waits. */
  maxTurnMs: number;
  /** Estimated spend cap for the session; null = no cap (only when pricing is unknown). */
  maxCostUsdPerSession: number | null;
  commandTimeoutMs: number;
  /** Request budget in characters of JSON; see buildRequestMessages. */
  maxContextChars: number;
  /**
   * Prompt + completion tokens one turn may use. Free tiers share a small daily allowance
   * across the whole deployment, so one wandering task must not spend all of it.
   */
  maxTokensPerTurn: number;
  /** The same across all turns of a task, so "continue" can't reset the spending. */
  maxTokensPerSession: number;
}

export const DEFAULT_LIMITS: HarnessLimits = {
  maxIterationsPerTurn: 25,
  maxModelCallsPerSession: 80,
  maxTurnMs: 10 * 60_000,
  maxCostUsdPerSession: 0.5,
  commandTimeoutMs: 120_000,
  maxContextChars: 240_000,
  maxTokensPerTurn: 60_000,
  maxTokensPerSession: 150_000,
};

interface Transcript {
  version: 1;
  messages: ChatMessage[];
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

const READ_ONLY_TOOLS = new Set<ToolName>(["list_files", "read_file", "search"]);

const KNOWN_TOOLS = new Set<ToolName>([
  "list_files",
  "read_file",
  "search",
  "write_file",
  "edit_file",
  "delete_file",
  "run_tests",
  "run_command",
]);

function systemPrompt(settings: ProjectSettings, canRunCode = true) {
  return `You are a careful software engineer working inside Pairloom, a shared workspace where a small team supervises you.

Environment:
- You can only act through the provided tools. Paths are relative to the project root. You cannot leave the project directory.
- You work on an isolated git branch. Do not try to commit, push, or switch branches; Pairloom handles git and humans review your diff before merging.
- Commands run without a shell (argv arrays only). Network tools, sudo and git branch/remote commands are refused. Deleting files and running arbitrary commands need the session host's approval; a denial is final for that call.
${!canRunCode ? "- You cannot run code, tests or commands here. Don't claim anything was tested; say what the reviewers should check." : settings.testCommand ? `- Run the test suite with the run_tests tool (${settings.testCommand.join(" ")}).` : "- This project has no configured test command."}

Working style:
- Messages come from different collaborators; each one says who sent it and was approved by the host.
- Look at the relevant files before editing. Keep changes small and focused on the request.
- Prefer edit_file for small changes; use write_file for new files.
- Read a file once; earlier tool results stay in your context. After an edit, read back only the lines you changed (read_file with offset/limit).
- Every model call counts against a small per-minute budget, so stop calling tools as soon as the change is done.
${canRunCode ? "- After changing code, run the tests if available and fix failures you caused.\n- Finish with a short summary: what you changed, and the result of the last test run. Never claim tests passed unless you ran them and they did." : "- Finish with a short summary: what you changed, and what reviewers should check, since nothing was run."}`;
}

export class HarnessAdapter implements AgentAdapter {
  constructor(
    private client: ModelClient,
    private limits: HarnessLimits,
    private stateDir: string,
  ) {}

  info(): AdapterInfo {
    const c = this.client.config;
    const base = {
      kind: "llm-harness" as const,
      provider: c.provider,
      model: c.model,
      codeExecution: codeExecutionAllowed(),
    };
    return c.apiKey
      ? {
          ...base,
          available: true,
          detail: `${c.provider} ${c.model} via OpenAI-compatible API (key present; validated on first call)`,
        }
      : {
          ...base,
          available: false,
          detail: `No ${c.apiKeyEnv} on this worker; real agent sessions are unavailable.`,
        };
  }

  async start(ctx: AgentContext): Promise<AgentRun> {
    if (!this.client.config.apiKey) {
      throw new Error(
        `Real agent unavailable: ${this.client.config.apiKeyEnv} is not set on the worker`,
      );
    }
    const cfg = this.client.config;
    const limits = this.limits;
    const sandbox = new Sandbox(ctx.cwd);
    const canRunCode = codeExecutionAllowed();
    const settings: ProjectSettings = canRunCode
      ? loadProjectSettings(ctx.cwd)
      : { testCommand: null, allowedCommands: [] };
    // Without code execution the model never sees the run tools, so it doesn't plan around them.
    const tools = toolSchemas(settings).filter(
      (t) => canRunCode || (t.function.name !== "run_command" && t.function.name !== "run_tests"),
    );
    const transcriptDir = join(this.stateDir, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptId = `harness-${ctx.sessionId}`;
    const transcriptPath = join(transcriptDir, `${ctx.sessionId}.json`);
    const sandboxHome = join(this.stateDir, "sandbox-home");

    let state: Transcript;
    let resumed = false;
    if (ctx.resumeProviderSessionId && existsSync(transcriptPath)) {
      state = JSON.parse(readFileSync(transcriptPath, "utf8")) as Transcript;
      resumed = true;
      repairDanglingToolCalls(state.messages);
      state.messages.push({
        role: "user",
        content:
          "[Pairloom] The worker restarted and this session was resumed from its saved transcript. " +
          "Any turn in progress was cut off; files may be partially edited. Re-check the project state before continuing.",
      });
    } else {
      if (ctx.resumeProviderSessionId) {
        ctx.emit("system.notice", {
          level: "warn",
          message:
            "No saved transcript found on this worker; starting a fresh conversation in the same worktree.",
        });
      }
      state = {
        version: 1,
        messages: [{ role: "system", content: systemPrompt(settings, canRunCode) }],
        modelCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: cfg.pricing ? 0 : null,
      };
    }
    const persist = () => {
      const tmp = `${transcriptPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, transcriptPath);
    };
    persist();

    ctx.onProviderSession(transcriptId);
    ctx.emit("agent.init", {
      providerSessionId: transcriptId,
      harness: "pairloom-llm-harness",
      provider: cfg.provider,
      model: cfg.model,
      cwd: ctx.cwd,
      tools: tools.map((t) => t.function.name),
      testCommand: settings.testCommand,
      resumed,
      limits: {
        maxIterationsPerTurn: limits.maxIterationsPerTurn,
        maxModelCallsPerSession: limits.maxModelCallsPerSession,
        maxTurnMs: limits.maxTurnMs,
        maxCostUsdPerSession: limits.maxCostUsdPerSession,
      },
    });

    const queue: string[] = [];
    let busy = false;
    let stopped = false;
    let current: AbortController | null = null;

    const runTurn = async (text: string) => {
      const controller = new AbortController();
      current = controller;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, limits.maxTurnMs);
      const turnStart = Date.now();
      const turnStartCalls = state.modelCalls;
      const turnStartCost = state.costUsd;
      let iterations = 0;
      let malformedRetries = 0;
      const seenReads = new Set<string>();
      /** Consecutive tool calls answered "same as before": the model is going in circles. */
      let repeats = 0;
      const edited = new Set<string>();
      const turnStartTokens = state.promptTokens + state.completionTokens;
      /** True once a response came without usage figures and tokens had to be estimated. */
      let usageEstimated = false;
      const addUsage = (
        result: {
          usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
          message: { content: string | null };
        },
        sent: ChatMessage[],
        sentTools: ToolSchema[],
      ) => {
        let usage = result.usage;
        if (!usage.promptTokens && !usage.completionTokens) {
          // Never let missing figures switch the budget off: estimate from what was sent.
          usageEstimated = true;
          usage = {
            promptTokens: estimateRequestTokens(sent, sentTools),
            completionTokens: Math.ceil((result.message.content ?? "").length / 3.5) + 50,
            cachedTokens: 0,
          };
        }
        state.promptTokens += usage.promptTokens;
        state.completionTokens += usage.completionTokens;
        const cost = estimateCostUsd(cfg, usage);
        if (state.costUsd !== null && cost !== null) state.costUsd += cost;
      };
      let lastTestRun: { exitCode: number | null; timedOut: boolean } | null = null;
      state.messages.push({ role: "user", content: text });
      persist();

      const finish = (subtype: string, isError: boolean, extra: Record<string, unknown> = {}) => {
        clearTimeout(timer);
        current = null;
        ctx.emit("agent.result", {
          subtype,
          isError,
          provider: cfg.provider,
          model: cfg.model,
          numTurns: iterations,
          modelCallsThisTurn: state.modelCalls - turnStartCalls,
          modelCallsSession: state.modelCalls,
          promptTokensSession: state.promptTokens,
          completionTokensSession: state.completionTokens,
          totalCostUsd:
            state.costUsd !== null && turnStartCost !== null ? state.costUsd - turnStartCost : null,
          sessionCostUsd: state.costUsd,
          costIsEstimate: true,
          durationMs: Date.now() - turnStart,
          tokensThisTurn: state.promptTokens + state.completionTokens - turnStartTokens,
          tokensSession: state.promptTokens + state.completionTokens,
          usageEstimated,
          lastTestRun,
          filesEdited: [...edited],
          ...extra,
        });
        ctx.onTurnEnd({ subtype, isError });
      };
      const aborted = () => (timedOut ? "error_max_time" : "interrupted");

      const wrapUp = async (subtype: string, message: string) => {
        const files = edited.size ? [...edited].join(", ") : "none";
        state.messages.push({
          role: "user",
          content:
            `[Pairloom] This turn is ending: ${message}. Tools are off now. In a few lines, say ` +
            `which files you changed (this turn: ${files}), what is done, and what is still left to do.`,
        });
        persist();
        try {
          const sent = buildRequestMessages(state.messages, limits.maxContextChars);
          const { result, calls } = await this.client.complete(sent, [], controller.signal);
          iterations++;
          state.modelCalls += calls;
          addUsage(result, sent, []);
          state.messages.push({ role: "assistant", content: result.message.content });
          persist();
          if (result.message.content?.trim()) {
            ctx.emit("agent.text", {
              text: truncate(result.message.content, SHARED_LIMITS.agentTextMaxChars),
            });
          }
        } catch (err) {
          if (controller.signal.aborted) return finish(aborted(), true);
          const e = err instanceof ProviderError ? err : new ProviderError("server", String(err));
          state.modelCalls += (e as ProviderError & { calls?: number }).calls ?? 1;
          persist();
          if (e.detail) console.error(`[provider ${cfg.provider}] ${e.status ?? ""} ${e.detail}`);
          ctx.emit("system.notice", {
            level: "warn",
            message: `The closing summary couldn't be generated: ${e.message}`,
          });
        }
        return finish(subtype, true, { message });
      };

      for (;;) {
        if (controller.signal.aborted) return finish(aborted(), true);
        if (iterations >= limits.maxIterationsPerTurn) {
          return finish("error_max_iterations", true, {
            message: `Stopped after ${limits.maxIterationsPerTurn} model calls in one turn`,
          });
        }
        if (state.modelCalls >= limits.maxModelCallsPerSession) {
          return finish("error_max_model_calls", true, {
            message: `Session reached its cap of ${limits.maxModelCallsPerSession} model calls`,
          });
        }
        if (
          limits.maxCostUsdPerSession !== null &&
          state.costUsd !== null &&
          state.costUsd >= limits.maxCostUsdPerSession
        ) {
          return finish("error_budget", true, {
            message: `Estimated session cost $${state.costUsd.toFixed(4)} reached the cap of $${limits.maxCostUsdPerSession}`,
          });
        }

        // Stop before a hard limit, keeping one tools-off call so the model can say what it
        // did and what is left, instead of the turn just ending mid-edit.
        const turnTokens = state.promptTokens + state.completionTokens - turnStartTokens;
        const stop =
          iterations >= limits.maxIterationsPerTurn - 1
            ? {
                subtype: "error_max_iterations",
                message: `Stopped at the limit of ${limits.maxIterationsPerTurn} model calls in one turn`,
              }
            : turnTokens >= limits.maxTokensPerTurn
              ? {
                  subtype: "error_token_budget",
                  message: `Stopped after using ${turnTokens} tokens, this turn's budget of ${limits.maxTokensPerTurn}`,
                }
              : state.promptTokens + state.completionTokens >= limits.maxTokensPerSession
                ? {
                    subtype: "error_session_token_budget",
                    message: `This task has used its total budget of ${limits.maxTokensPerSession} tokens across all turns`,
                  }
                : repeats >= 3
                  ? {
                      subtype: "error_no_progress",
                      message:
                        "Stopped: the agent repeated the same tool calls without making progress",
                    }
                  : null;
        if (stop) {
          // Already over the task's total at the start of a turn: no summary call either.
          if (iterations === 0 && stop.subtype === "error_session_token_budget")
            return finish(stop.subtype, true, { message: stop.message });
          return wrapUp(stop.subtype, stop.message);
        }
        const request = buildRequestMessages(state.messages, limits.maxContextChars);
        let completion;
        try {
          completion = await this.client.complete(
            request,
            tools,
            controller.signal,
            (r) =>
              ctx.emit("system.notice", {
                level: "warn",
                message: `${r.reason}; retry ${r.attempt} in ${r.waitSec}s (counts toward the model-call cap)`,
              }),
            (p) =>
              ctx.emit("system.notice", {
                level: "info",
                message: `Waiting ${p.waitSec}s for ${cfg.provider}'s per-minute token budget (~${p.estimatedTokens} needed, ${p.remainingTokens} left); no model call used`,
              }),
          );
        } catch (err) {
          const e = err instanceof ProviderError ? err : new ProviderError("server", String(err));
          state.modelCalls += (e as ProviderError & { calls?: number }).calls ?? 1;
          iterations++;
          persist();
          if (e.kind === "cancelled" || controller.signal.aborted) return finish(aborted(), true);
          if (e.kind === "tool_call_malformed" && malformedRetries < 1) {
            malformedRetries++;
            ctx.emit("system.notice", {
              level: "warn",
              message: `${e.message}; asking the model to retry once`,
            });
            state.messages.push({
              role: "user",
              content:
                "[Pairloom] Your last tool call could not be parsed. Call one tool at a time with valid JSON arguments.",
            });
            continue;
          }
          // Full provider text (account ids etc.) goes to the operator's log, not the team.
          if (e.detail) console.error(`[provider ${cfg.provider}] ${e.status ?? ""} ${e.detail}`);
          ctx.emit("agent.error", { message: e.message, kind: e.kind, status: e.status ?? null });
          return finish(`error_provider_${e.kind}`, true, { message: e.message });
        }

        const { result, calls } = completion;
        iterations++;
        state.modelCalls += calls;
        addUsage(result, request, tools);
        const toolCalls = (result.message.tool_calls ?? []).filter((t) => t.type === "function");
        state.messages.push({
          role: "assistant",
          content: result.message.content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
        persist();
        if (result.message.content?.trim()) {
          ctx.emit("agent.text", {
            text: truncate(result.message.content, SHARED_LIMITS.agentTextMaxChars),
          });
        }
        if (toolCalls.length === 0) {
          if (result.finishReason === "length") {
            return finish("error_output_truncated", true, {
              message: "The model hit its output token limit before finishing",
            });
          }
          return finish("end_turn", false);
        }

        for (const call of toolCalls) {
          // An identical read with nothing written since returns a pointer, not the same text
          // again: repeats burned the provider's per-minute token budget without progress.
          const key = readKey(call, sandbox);
          const readOnly = READ_ONLY_TOOLS.has(call.function.name as ToolName);
          if (readOnly && seenReads.has(key) && !controller.signal.aborted) {
            const note =
              "[Pairloom] Same call as earlier in this turn and no file has changed since; " +
              "use that result. If you are done, reply with a summary instead of calling tools.";
            ctx.emit("agent.tool_use", {
              toolUseId: call.id,
              toolName: call.function.name,
              input: truncate(call.function.arguments ?? "", SHARED_LIMITS.toolPayloadMaxChars),
            });
            ctx.emit("agent.tool_result", { toolUseId: call.id, isError: false, output: note });
            state.messages.push({ role: "tool", tool_call_id: call.id, content: note });
            persist();
            repeats++;
            continue;
          }
          repeats = 0;
          if (readOnly) seenReads.add(key);
          else seenReads.clear();
          const output = controller.signal.aborted
            ? "Not executed: the turn was interrupted."
            : await this.executeTool(
                call,
                ctx,
                sandbox,
                settings,
                controller.signal,
                sandboxHome,
                (r) => (lastTestRun = r),
              );
          const changed = /^(?:Edited|Wrote|Deleted) ([^\s.(]+(?:\.[^\s.(]+)*)/.exec(output);
          if (changed) edited.add(changed[1]!);
          state.messages.push({ role: "tool", tool_call_id: call.id, content: output });
          persist();
        }
      }
    };

    const pump = async () => {
      if (busy) return;
      busy = true;
      try {
        while (queue.length && !stopped) await runTurn(queue.shift()!);
      } catch (err) {
        // Unexpected harness bug: report, never claim success.
        ctx.emit("agent.error", { message: `Harness error: ${(err as Error).message}` });
        ctx.onTurnEnd({ subtype: "error_harness", isError: true });
      } finally {
        busy = false;
      }
    };

    return {
      send: (text) => {
        if (stopped) throw new Error("Session is stopped");
        queue.push(text);
        ctx.onTurnStart();
        void pump();
      },
      interrupt: async () => {
        current?.abort();
      },
      stop: async () => {
        stopped = true;
        queue.length = 0;
        current?.abort();
        ctx.onExit({ error: null });
      },
    };
  }

  private async executeTool(
    call: ChatToolCall,
    ctx: AgentContext,
    sandbox: Sandbox,
    settings: ProjectSettings,
    signal: AbortSignal,
    sandboxHome: string,
    onTestRun: (r: { exitCode: number | null; timedOut: boolean }) => void,
  ): Promise<string> {
    const name = call.function.name as ToolName;
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error();
    } catch {
      ctx.emit("agent.tool_result", {
        toolUseId: call.id,
        isError: true,
        output: "Invalid JSON arguments",
      });
      return "Error: arguments were not valid JSON. Retry with a JSON object.";
    }
    ctx.emit("agent.tool_use", {
      toolUseId: call.id,
      toolName: name,
      input: truncate(
        JSON.stringify(redactForDisplay(name, args)),
        SHARED_LIMITS.toolPayloadMaxChars,
      ),
    });
    const report = (output: string, isError: boolean, extra: Record<string, unknown> = {}) => {
      ctx.emit("agent.tool_result", {
        toolUseId: call.id,
        isError,
        output: truncate(output, SHARED_LIMITS.toolPayloadMaxChars),
        ...extra,
      });
      return output;
    };
    // The parse check's verdict travels as its own field: reviewers see it even when the long
    // edit preview is truncated for display.
    const reportEdit = (output: string) => {
      const warning = /\nWARNING: (.*)$/.exec(output)?.[1];
      return report(output, false, {
        path: String(args.path).replace(/^\.\//, ""),
        parseOk: !warning,
        ...(warning ? { syntaxWarning: warning.slice(0, 300) } : {}),
      });
    };
    if (!KNOWN_TOOLS.has(name) || (name === "run_tests" && !settings.testCommand)) {
      return report(`Error: unknown tool '${name}'`, true);
    }
    try {
      const permission = classifyToolCall(name, args, ctx.permissionPolicy, settings, sandbox);
      if (permission === "ask") {
        const answer = await ctx.requestPermission({
          toolName: name,
          input: redactForDisplay(name, args),
          title: describeCall(name, args, settings),
          signal,
        });
        if (answer.behavior === "deny")
          return report(`Denied by the session host: ${answer.message}`, true);
      }
      if (signal.aborted) return report("Not executed: the turn was interrupted.", true);
      switch (name) {
        case "list_files":
          return report(sandbox.listFiles(args.path ? String(args.path) : "."), false);
        case "read_file":
          return report(await sandbox.readFile(String(args.path), ...readRange(args)), false);
        case "search":
          return report(
            sandbox.search(String(args.pattern ?? ""), args.path ? String(args.path) : "."),
            false,
          );
        case "write_file":
          return reportEdit(await sandbox.writeFile(String(args.path), args.content as string));
        case "edit_file":
          return reportEdit(
            await sandbox.editFile(
              String(args.path),
              args.old_string as string,
              args.new_string as string,
            ),
          );
        case "delete_file":
          return report(await sandbox.deleteFile(String(args.path)), false);
        case "run_tests":
        case "run_command": {
          const argv = name === "run_tests" ? settings.testCommand! : (args.argv as string[]);
          const r = await runCommand(argv, {
            cwd: sandbox.root,
            timeoutMs: this.limits.commandTimeoutMs,
            signal,
            sandboxHome,
          });
          if (name === "run_tests") onTestRun({ exitCode: r.exitCode, timedOut: r.timedOut });
          const status = r.timedOut
            ? `TIMED OUT after ${this.limits.commandTimeoutMs}ms (killed)`
            : r.cancelled
              ? "CANCELLED (killed)"
              : `exit code ${r.exitCode}${r.signal ? ` (signal ${r.signal})` : ""}`;
          return report(`$ ${argv.join(" ")}\n${status}\n${r.output}`, r.exitCode !== 0, {
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            durationMs: r.durationMs,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : `Tool failed: ${(err as Error).message}`;
      return report(`Error: ${msg}`, true);
    }
    return report("Error: unhandled tool", true);
  }
}

/**
 * What a read-only call actually returns, so the same read spelled differently (line_start vs
 * offset, or a range past the end of the file) still counts as a repeat.
 */
function readKey(call: ChatToolCall, sandbox: Sandbox): string {
  const name = call.function.name;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return `${name}\0${call.function.arguments}`;
  }
  if (name === "read_file" && typeof args.path === "string") {
    try {
      const { abs, rel } = sandbox.resolve(args.path);
      const lines = readFileSync(abs, "utf8").split("\n").length;
      const [offset = 0, limit] = readRange(args);
      const start = Math.min(offset, lines);
      const end = Math.min(limit === undefined ? lines : start + limit, lines);
      return `read_file\0${rel}\0${start}\0${end}`;
    } catch {
      // Unreadable: fall through to the literal key; the tool reports the error itself.
    }
  }
  if (typeof args.path === "string") args.path = args.path.replace(/^\.?\/?$/, ".");
  return `${name}\0${JSON.stringify(args, Object.keys(args).sort())}`;
}

/**
 * offset/limit is the schema, but models (gpt-oss in particular) often send 1-based
 * line_start/line_end instead. Ignoring those returned the whole file every time and the
 * model kept re-reading it, so honour the common spellings.
 */
export function readRange(args: Record<string, unknown>): [number | undefined, number | undefined] {
  const offset = num(args.offset);
  if (offset !== undefined || num(args.limit) !== undefined) return [offset, num(args.limit)];
  const start = num(args.line_start ?? args.start_line ?? args.start);
  const end = num(args.line_end ?? args.end_line ?? args.end);
  const from = start ? start - 1 : 0;
  if (start === undefined && end === undefined) return [undefined, undefined];
  return [from, end !== undefined ? Math.max(1, end - from) : undefined];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined;
}

/** Large file contents are summarised in the activity log; the full diff is reviewed separately. */
function redactForDisplay(name: ToolName, args: Record<string, unknown>) {
  if (name === "write_file" && typeof args.content === "string") {
    return { path: args.path, content: `[${args.content.length} chars]` };
  }
  return args;
}

function describeCall(name: ToolName, args: Record<string, unknown>, settings: ProjectSettings) {
  switch (name) {
    case "run_command":
      return `Agent wants to run: ${(args.argv as string[]).join(" ")}`;
    case "run_tests":
      return `Agent wants to run the tests: ${settings.testCommand?.join(" ")}`;
    case "delete_file":
      return `Agent wants to delete ${String(args.path)}`;
    case "read_file":
      return `Agent wants to read a possibly sensitive file: ${String(args.path)}`;
    default:
      return `Agent wants to ${name.replace("_", " ")} ${String(args.path ?? "")}`;
  }
}

/** After a crash, an assistant tool call may have no result; the API requires one. */
function repairDanglingToolCalls(messages: ChatMessage[]) {
  const answered = new Set(
    messages
      .filter((m) => m.role === "tool")
      .map((m) => (m as { tool_call_id: string }).tool_call_id),
  );
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.tool_calls) continue;
    const missing = m.tool_calls.filter((t) => !answered.has(t.id));
    let insertAt = i + 1;
    while (insertAt < messages.length && messages[insertAt]!.role === "tool") insertAt++;
    messages.splice(
      insertAt,
      0,
      ...missing.map((t) => ({
        role: "tool" as const,
        tool_call_id: t.id,
        content: "Result lost: the worker restarted before this tool call completed.",
      })),
    );
  }
}
