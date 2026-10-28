import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/harness/agent.js";
import {
  GROQ_CONTEXT_CHARS,
  loadHarnessLimits,
  loadProviderConfig,
} from "../src/harness/config.js";
import { classifyHttpError, parseResetMs } from "../src/harness/provider.js";

describe("provider configuration", () => {
  it("defaults to Groq gpt-oss-120b with published pricing, reading the key from GROQ_API_KEY", () => {
    const c = loadProviderConfig({ GROQ_API_KEY: "k" });
    expect(c).toMatchObject({
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-120b",
      apiKey: "k",
      maxRetries: 1,
      pricing: { input: 0.15, cachedInput: 0.075, output: 0.6 },
    });
    expect(loadProviderConfig({}).apiKey).toBeNull();
  });

  it("labels a non-default endpoint honestly and does not apply the provider's prices", () => {
    const c = loadProviderConfig({ GROQ_API_KEY: "k", LLM_BASE_URL: "http://127.0.0.1:4000/v1" });
    expect(c.provider).toBe("custom endpoint 127.0.0.1:4000");
    expect(c.pricing).toBeNull();
  });

  it("openai is configuration only and has no assumed pricing", () => {
    const c = loadProviderConfig({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" });
    expect(c).toMatchObject({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY", pricing: null });
  });

  it("parses limits and rejects nonsense", () => {
    const l = loadHarnessLimits({
      AGENT_MAX_TURN_SECONDS: "30",
      AGENT_MAX_COST_USD_PER_SESSION: "none",
    });
    expect(l.maxTurnMs).toBe(30_000);
    expect(l.maxCostUsdPerSession).toBeNull();
    expect(() => loadHarnessLimits({ AGENT_MAX_MODEL_CALLS_PER_SESSION: "-1" })).toThrow();
  });
});

describe("provider error classification", () => {
  const cfg = { provider: "groq", apiKeyEnv: "GROQ_API_KEY" };
  it.each([
    [401, '{"error":{"message":"Invalid API Key"}}', "auth"],
    [429, '{"error":{"message":"Rate limit reached for model"}}', "rate_limited"],
    [
      429,
      '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM). Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}',
      "rate_limited",
    ],
    [
      429,
      '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}',
      "quota_or_billing",
    ],
    [413, '{"error":{"message":"Request too large"}}', "context_too_large"],
    [
      400,
      '{"error":{"message":"Failed to call a function.","code":"tool_use_failed"}}',
      "tool_call_malformed",
    ],
    [498, "{}", "rate_limited"],
    [503, "{}", "server"],
    [400, '{"error":{"message":"bad"}}', "bad_request"],
  ])("%s %s -> %s", (status, body, kind) => {
    expect(classifyHttpError(cfg, status as number, body as string, "3").kind).toBe(kind);
  });
});

describe("request budget", () => {
  it("parses provider reset durations", () => {
    expect(parseResetMs("7.66s")).toBe(7660);
    expect(parseResetMs("450ms")).toBe(450);
    expect(parseResetMs("1m2.5s")).toBe(62_500);
    expect(parseResetMs("2m")).toBe(120_000);
    expect(parseResetMs("soon")).toBeNull();
    expect(parseResetMs(null)).toBeNull();
  });

  it("defaults the context budget to Groq's free-tier size only for Groq", () => {
    expect(loadHarnessLimits({}).maxContextChars).toBe(GROQ_CONTEXT_CHARS);
    expect(loadHarnessLimits({ LLM_PROVIDER: "groq" }).maxContextChars).toBe(GROQ_CONTEXT_CHARS);
    expect(loadHarnessLimits({ LLM_PROVIDER: "openai" }).maxContextChars).toBe(
      DEFAULT_LIMITS.maxContextChars,
    );
    expect(
      loadHarnessLimits({ LLM_PROVIDER: "groq", LLM_BASE_URL: "http://127.0.0.1:1" })
        .maxContextChars,
    ).toBe(DEFAULT_LIMITS.maxContextChars);
    expect(loadHarnessLimits({ AGENT_MAX_CONTEXT_CHARS: "5000" }).maxContextChars).toBe(5000);
  });
});

describe("provider error text shown to collaborators", () => {
  it("drops the provider account id and upsell link", async () => {
    const { classifyHttpError } = await import("../src/harness/provider.js");
    const e = classifyHttpError(
      { provider: "groq", apiKeyEnv: "GROQ_API_KEY" },
      429,
      JSON.stringify({
        error: {
          message:
            "Rate limit reached for model `m` in organization `org_secret123` service tier `on_demand` on tokens per day (TPD): Limit 200000. Please try again in 2m. Need more tokens? Upgrade at https://x",
        },
      }),
      "150",
    );
    expect(e.kind).toBe("rate_limited");
    expect(e.message).toMatch(/tokens per day/);
    expect(e.message).not.toMatch(/org_secret123|Need more tokens/);
  });
});
