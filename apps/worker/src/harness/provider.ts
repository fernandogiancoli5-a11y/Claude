/**
 * Minimal client for an OpenAI-compatible Chat Completions endpoint.
 *
 * Primary provider: Groq (https://api.groq.com/openai/v1, documented as "mostly
 * compatible with OpenAI's client libraries"). OpenAI itself works with the same
 * wire format but is configuration only and has not been exercised by this project.
 *
 * Deliberately no SDK dependency and no hidden retry loops: every model call is
 * explicit, counted, and classified on failure.
 */

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionResult {
  message: { content: string | null; tool_calls?: ChatToolCall[] };
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
  model: string;
}

export type ProviderErrorKind =
  | "missing_credentials"
  | "auth"
  | "rate_limited"
  | "quota_or_billing"
  | "bad_request"
  | "tool_call_malformed"
  | "context_too_large"
  | "server"
  | "network"
  | "timeout"
  | "cancelled";

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public status?: number,
    public retryAfterSec?: number,
  ) {
    super(message);
  }
  /** Provider's raw error text, for the operator's log only (never sent to collaborators). */
  detail?: string;
}

export interface ProviderConfig {
  /** Display name, e.g. "groq". */
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  /** Name of the env var holding the key, for error messages (never the value). */
  apiKeyEnv: string;
  model: string;
  maxCompletionTokens: number;
  requestTimeoutMs: number;
  /** Retries for 429/5xx/network only; each retry is a counted model call. Default 1. */
  maxRetries: number;
  /** Longest server-requested wait we will honour before giving up on a 429. */
  maxRetryWaitSec: number;
  reasoningEffort?: "low" | "medium" | "high";
  /** USD per 1M tokens; null when unknown (cost then reported as unknown). */
  pricing: { input: number; cachedInput: number; output: number } | null;
}

/**
 * Published prices (USD per 1M tokens) checked on 2026-10-27 against the
 * provider's model page. Prices change; override with LLM_PRICE_* env vars.
 */
export const KNOWN_PRICING: Record<string, { input: number; cachedInput: number; output: number }> =
  {
    // https://console.groq.com/docs/model/openai/gpt-oss-120b
    "groq:openai/gpt-oss-120b": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  };

export const PROVIDER_PRESETS: Record<
  string,
  { baseUrl: string; apiKeyEnv: string; model: string }
> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b",
  },
  // Same wire format; configuration only, not exercised by this project yet.
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-5-mini",
  },
};

export function estimateCostUsd(
  cfg: ProviderConfig,
  usage: CompletionResult["usage"],
): number | null {
  if (!cfg.pricing) return null;
  const uncached = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    (uncached * cfg.pricing.input +
      usage.cachedTokens * cfg.pricing.cachedInput +
      usage.completionTokens * cfg.pricing.output) /
    1_000_000
  );
}

export interface ModelClient {
  readonly config: ProviderConfig;
  complete(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
    onRetry?: (info: { attempt: number; reason: string; waitSec: number }) => void,
    onPace?: (info: { waitSec: number; estimatedTokens: number; remainingTokens: number }) => void,
  ): Promise<{ result: CompletionResult; calls: number }>;
}

/** Characters per token used to estimate a request before sending it (deliberately low). */
const CHARS_PER_TOKEN = 3.5;
/** A per-minute token window never needs a longer wait than this. */
const MAX_PACE_WAIT_MS = 60_000;

/** Parses rate-limit reset durations such as "7.66s", "450ms" or "1m2.5s" into milliseconds. */
export function parseResetMs(v: string | null): number | null {
  if (!v) return null;
  const m = /^(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(
    v.trim(),
  );
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 60_000 + Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0);
}

export function estimateRequestTokens(messages: ChatMessage[], tools: ToolSchema[]) {
  return Math.ceil(JSON.stringify({ messages, tools }).length / CHARS_PER_TOKEN);
}

export class OpenAICompatibleClient implements ModelClient {
  /** Token budget the provider last reported (x-ratelimit-* headers), if it reports one. */
  private tokenBudget: { remaining: number; resetAt: number } | null = null;

  constructor(readonly config: ProviderConfig) {}

  /**
   * Waiting for the provider's per-minute token budget to refill before sending costs
   * nothing; sending and getting a 429 costs a counted model call and a retry.
   */
  private async pace(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
    onPace?: (info: { waitSec: number; estimatedTokens: number; remainingTokens: number }) => void,
  ) {
    const b = this.tokenBudget;
    if (!b) return;
    const estimatedTokens = estimateRequestTokens(messages, tools);
    const waitMs = Math.min(b.resetAt - Date.now(), MAX_PACE_WAIT_MS);
    if (estimatedTokens <= b.remaining || waitMs <= 0) return;
    onPace?.({ waitSec: Math.ceil(waitMs / 1000), estimatedTokens, remainingTokens: b.remaining });
    await sleep(waitMs, signal);
  }

  private recordBudget(headers: Headers) {
    const remaining = Number(headers.get("x-ratelimit-remaining-tokens") ?? NaN);
    const resetMs = parseResetMs(headers.get("x-ratelimit-reset-tokens"));
    this.tokenBudget =
      Number.isFinite(remaining) && resetMs !== null
        ? { remaining, resetAt: Date.now() + resetMs }
        : null;
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
    onRetry?: (info: { attempt: number; reason: string; waitSec: number }) => void,
    onPace?: (info: { waitSec: number; estimatedTokens: number; remainingTokens: number }) => void,
  ) {
    if (!this.config.apiKey) {
      throw new ProviderError(
        "missing_credentials",
        `No API key: set ${this.config.apiKeyEnv} in the worker environment`,
      );
    }
    let calls = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.pace(messages, tools, signal, onPace);
      } catch (err) {
        throw withCalls(err as ProviderError, calls);
      }
      calls++;
      try {
        return { result: await this.once(messages, tools, signal), calls };
      } catch (err) {
        const e = err as ProviderError;
        const retryable = e.kind === "rate_limited" || e.kind === "server" || e.kind === "network";
        if (!retryable || attempt >= this.config.maxRetries || signal.aborted)
          throw withCalls(e, calls);
        const wait = e.retryAfterSec ?? 2 * (attempt + 1);
        if (wait > this.config.maxRetryWaitSec) {
          throw withCalls(
            new ProviderError(
              e.kind,
              `${e.message} (provider asked to wait ${wait}s; limit is ${this.config.maxRetryWaitSec}s)`,
              e.status,
              e.retryAfterSec,
            ),
            calls,
          );
        }
        onRetry?.({ attempt: attempt + 1, reason: e.message, waitSec: wait });
        await sleep(wait * 1000, signal);
      }
    }
  }

  private async once(messages: ChatMessage[], tools: ToolSchema[], signal: AbortSignal) {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      // No tools means a plain answer (used for a turn's closing summary).
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      max_completion_tokens: this.config.maxCompletionTokens,
    };
    if (this.config.reasoningEffort) body.reasoning_effort = this.config.reasoningEffort;
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal.aborted) throw new ProviderError("cancelled", "Model call cancelled");
      if (timeout.aborted) {
        throw new ProviderError(
          "timeout",
          `Model call timed out after ${this.config.requestTimeoutMs}ms`,
        );
      }
      throw new ProviderError(
        "network",
        `Network error calling ${this.config.provider}: ${(err as Error).message}`,
      );
    }
    const text = await res.text().catch(() => "");
    this.recordBudget(res.headers);
    if (!res.ok)
      throw classifyHttpError(this.config, res.status, text, res.headers.get("retry-after"));
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProviderError("server", `Unparseable response from ${this.config.provider}`);
    }
    const choice = data.choices?.[0];
    if (!choice?.message) throw new ProviderError("server", "Response had no choices");
    return {
      message: { content: choice.message.content ?? null, tool_calls: choice.message.tool_calls },
      finishReason: choice.finish_reason ?? null,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      model: data.model ?? this.config.model,
    } satisfies CompletionResult;
  }
}

/** Never includes the API key or request body in messages. */
export function classifyHttpError(...args: Parameters<typeof classifyHttpErrorInner>) {
  const e = classifyHttpErrorInner(...args);
  const body = args[2];
  try {
    const parsed = JSON.parse(body);
    const err = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
    if (err?.message) e.detail = String(err.message).slice(0, 1000);
  } catch {
    e.detail = body.slice(0, 300);
  }
  return e;
}

function classifyHttpErrorInner(
  cfg: Pick<ProviderConfig, "provider" | "apiKeyEnv">,
  status: number,
  body: string,
  retryAfter: string | null,
): ProviderError {
  let message = "";
  let code = "";

  try {
    const parsed = JSON.parse(body);
    const err = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
    // Collaborators see this text: drop the provider account id and upsell links.
    message = String(err?.message ?? "")
      .replace(/ in organization `[^`]*`/g, "")
      .replace(/\s*Need more tokens\?.*$/s, "")
      .slice(0, 500);
    code = String(err?.code ?? err?.type ?? "");
  } catch {
    message = body.slice(0, 200);
  }
  const p = cfg.provider;
  const retry = retryAfter ? Number(retryAfter) : undefined;
  if (status === 401) {
    return new ProviderError(
      "auth",
      `${p} rejected the API key (401). Check ${cfg.apiKeyEnv}.`,
      status,
    );
  }
  if (status === 403)
    return new ProviderError("auth", `${p} denied access (403): ${message}`, status);
  if (status === 429) {
    // OpenAI signals exhausted credit with 429 + insufficient_quota; that must not be retried.
    // Match the code or the quota wording only: Groq's per-minute limit message links to
    // ".../settings/billing", which is a transient rate limit, not exhausted credit.
    if (/insufficient_quota/i.test(code) || /exceeded your current quota/i.test(message)) {
      return new ProviderError(
        "quota_or_billing",
        `${p} quota or billing limit reached: ${message}`,
        status,
      );
    }
    return new ProviderError(
      "rate_limited",
      `${p} rate limit hit (429): ${message}`,
      status,
      retry,
    );
  }
  if (status === 413 || /context_length|too many tokens|context window/i.test(code + message)) {
    return new ProviderError(
      "context_too_large",
      `${p}: request too large for the model: ${message}`,
      status,
    );
  }
  if (status === 400 && /tool_use_failed|failed to call a function/i.test(code + message)) {
    return new ProviderError(
      "tool_call_malformed",
      `${p}: model produced a malformed tool call`,
      status,
    );
  }
  if (status === 498)
    return new ProviderError("rate_limited", `${p}: capacity exceeded (498)`, status, retry);
  if (status >= 500)
    return new ProviderError("server", `${p} server error ${status}`, status, retry);
  return new ProviderError(
    "bad_request",
    `${p} rejected the request (${status}): ${message}`,
    status,
  );
}

function withCalls(e: ProviderError, calls: number) {
  (e as ProviderError & { calls?: number }).calls = calls;
  return e;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new ProviderError("cancelled", "Model call cancelled"));
      },
      { once: true },
    );
  });
}
