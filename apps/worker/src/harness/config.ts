import { DEFAULT_LIMITS, type HarnessLimits } from "./agent.js";
import { KNOWN_PRICING, PROVIDER_PRESETS, type ProviderConfig } from "./provider.js";

const numEnv = (env: NodeJS.ProcessEnv, key: string, fallback: number) => {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
};

/**
 * LLM_PROVIDER selects a preset (groq is the primary, tested-against-docs provider;
 * openai is configuration only). LLM_BASE_URL / LLM_MODEL override the preset.
 */
export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const provider = (env.LLM_PROVIDER ?? "groq").toLowerCase();
  const preset = PROVIDER_PRESETS[provider];
  if (!preset && !env.LLM_BASE_URL) {
    throw new Error(
      `Unknown LLM_PROVIDER '${provider}'; set LLM_BASE_URL and LLM_API_KEY_ENV for a custom endpoint`,
    );
  }
  const apiKeyEnv = env.LLM_API_KEY_ENV ?? preset?.apiKeyEnv ?? "LLM_API_KEY";
  const model = env.LLM_MODEL || preset!.model;
  const baseUrl = env.LLM_BASE_URL || preset!.baseUrl;
  // A non-default endpoint (proxy, mock, self-hosted) must never be presented as the
  // named provider, and the provider's published prices do not apply to it.
  const customEndpoint = !preset || baseUrl.replace(/\/$/, "") !== preset.baseUrl;
  const label = customEndpoint ? `custom endpoint ${new URL(baseUrl).host}` : provider;
  const known = customEndpoint ? null : (KNOWN_PRICING[`${provider}:${model}`] ?? null);
  const pricing =
    env.LLM_PRICE_INPUT_PER_MTOK && env.LLM_PRICE_OUTPUT_PER_MTOK
      ? {
          input: Number(env.LLM_PRICE_INPUT_PER_MTOK),
          output: Number(env.LLM_PRICE_OUTPUT_PER_MTOK),
          cachedInput: Number(env.LLM_PRICE_CACHED_INPUT_PER_MTOK ?? env.LLM_PRICE_INPUT_PER_MTOK),
        }
      : known;
  const effort = env.LLM_REASONING_EFFORT;
  return {
    provider: label,
    baseUrl,
    apiKey: env[apiKeyEnv] || null,
    apiKeyEnv,
    model,
    maxCompletionTokens: numEnv(env, "LLM_MAX_COMPLETION_TOKENS", 4096),
    requestTimeoutMs: numEnv(env, "LLM_REQUEST_TIMEOUT_MS", 90_000),
    maxRetries: numEnv(env, "LLM_MAX_RETRIES", 1),
    maxRetryWaitSec: numEnv(env, "LLM_MAX_RETRY_WAIT_SEC", 20),
    ...(effort === "low" || effort === "medium" || effort === "high"
      ? { reasoningEffort: effort }
      : {}),
    pricing,
  };
}

export function loadHarnessLimits(env: NodeJS.ProcessEnv = process.env): HarnessLimits {
  const cost = env.AGENT_MAX_COST_USD_PER_SESSION;
  return {
    maxIterationsPerTurn: numEnv(
      env,
      "AGENT_MAX_ITERATIONS_PER_TURN",
      DEFAULT_LIMITS.maxIterationsPerTurn,
    ),
    maxModelCallsPerSession: numEnv(
      env,
      "AGENT_MAX_MODEL_CALLS_PER_SESSION",
      DEFAULT_LIMITS.maxModelCallsPerSession,
    ),
    maxTurnMs: numEnv(env, "AGENT_MAX_TURN_SECONDS", DEFAULT_LIMITS.maxTurnMs / 1000) * 1000,
    maxCostUsdPerSession:
      cost === "none"
        ? null
        : numEnv(env, "AGENT_MAX_COST_USD_PER_SESSION", DEFAULT_LIMITS.maxCostUsdPerSession!),
    commandTimeoutMs:
      numEnv(env, "AGENT_COMMAND_TIMEOUT_SECONDS", DEFAULT_LIMITS.commandTimeoutMs / 1000) * 1000,
    maxContextChars: numEnv(env, "AGENT_MAX_CONTEXT_CHARS", defaultContextChars(env)),
    maxTokensPerTurn: numEnv(env, "AGENT_MAX_TOKENS_PER_TURN", DEFAULT_LIMITS.maxTokensPerTurn),
    maxTokensPerSession: numEnv(
      env,
      "AGENT_MAX_TOKENS_PER_SESSION",
      DEFAULT_LIMITS.maxTokensPerSession,
    ),
  };
}

/**
 * Groq's free tier rejects any request its own pre-count puts over 8,000 tokens per minute
 * (input only; measured at ~3.7 chars/token of JSON, tool schemas included). 22,000 chars of
 * messages plus ~2,700 of tool schemas stays near 6,700 of those tokens.
 */
export const GROQ_CONTEXT_CHARS = 22_000;

function defaultContextChars(env: NodeJS.ProcessEnv) {
  const groq = (env.LLM_PROVIDER ?? "groq").toLowerCase() === "groq" && !env.LLM_BASE_URL;
  return groq ? GROQ_CONTEXT_CHARS : DEFAULT_LIMITS.maxContextChars;
}
