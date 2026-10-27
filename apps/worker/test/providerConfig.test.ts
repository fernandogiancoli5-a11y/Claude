import { describe, expect, it } from "vitest";
import { loadHarnessLimits, loadProviderConfig } from "../src/harness/config.js";
import { classifyHttpError } from "../src/harness/provider.js";

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
