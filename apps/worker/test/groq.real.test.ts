import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentContext, TurnOutcome } from "../src/adapters/types.js";
import { HarnessAdapter } from "../src/harness/agent.js";
import { loadHarnessLimits, loadProviderConfig } from "../src/harness/config.js";
import { OpenAICompatibleClient } from "../src/harness/provider.js";
import { runCommand } from "../src/harness/tools.js";
import { until } from "./fixtures.js";

/**
 * REAL PROVIDER. Calls Groq's API with GROQ_API_KEY and spends real (small)
 * money. Skipped unless PAIRLOOM_REAL_PROVIDER_TEST=1 and GROQ_API_KEY are set.
 * Capped at 30 model calls and $0.10 estimated per session.
 */
const enabled =
  process.env.PAIRLOOM_REAL_PROVIDER_TEST === "1" && Boolean(process.env.GROQ_API_KEY);
const SAMPLE = resolve(import.meta.dirname, "../../../samples/tiny-cart");

function harness(env: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(join(tmpdir(), "pl-real-"));
  const cwd = join(dir, "proj");
  cpSync(SAMPLE, cwd, { recursive: true });
  const config = loadProviderConfig({ ...env, LLM_PROVIDER: "groq" });
  const limits = loadHarnessLimits({
    AGENT_MAX_ITERATIONS_PER_TURN: "20",
    AGENT_MAX_MODEL_CALLS_PER_SESSION: "30",
    AGENT_MAX_COST_USD_PER_SESSION: "0.10",
    AGENT_MAX_TURN_SECONDS: "240",
  });
  const events: Array<{ type: string; payload: any }> = [];
  const turns: TurnOutcome[] = [];
  const ctx: AgentContext = {
    sessionId: "ses_real",
    cwd,
    title: "real",
    permissionPolicy: "accept_edits_in_worktree",
    resumeProviderSessionId: null,
    emit: (type, payload) => {
      events.push({ type, payload });
      if (type === "agent.tool_use")
        console.log(`  tool: ${payload.toolName} ${String(payload.input).slice(0, 120)}`);
      if (type === "agent.text") console.log(`  text: ${String(payload.text).slice(0, 200)}`);
      if (type === "agent.result" || type === "agent.error")
        console.log(`  ${type}: ${JSON.stringify(payload).slice(0, 400)}`);
    },
    // Only the allowlisted test command and in-worktree edits run without asking; deny anything else.
    requestPermission: async () => ({
      behavior: "deny",
      message: "not allowed in the automated real-provider test",
    }),
    onProviderSession: () => {},
    onTurnStart: () => {},
    onTurnEnd: (o) => turns.push(o),
    onExit: () => {},
  };
  return {
    adapter: new HarnessAdapter(new OpenAICompatibleClient(config), limits, join(dir, "state")),
    ctx,
    cwd,
    events,
    turns,
  };
}

describe.skipIf(!enabled)("Groq real provider (spends money)", () => {
  it("implements the tiny-cart discount feature and the project tests pass when re-run independently", async () => {
    const h = harness(process.env);
    const run = await h.adapter.start(h.ctx);
    run.send(
      "Add applyDiscount(cart, code) to src/cart.js. Code SAVE10 takes 10% off the subtotal, rounding down to whole cents; " +
        "unknown codes throw an Error. Add tests in test/discount.test.js using node:test, then run the tests and make sure they pass.",
    );
    await until(() => h.turns.length > 0, 280_000, "turn end");
    await run.stop();
    const result = h.events.find((e) => e.type === "agent.result")!.payload;
    console.log(
      `  cost estimate: $${result.sessionCostUsd} · model calls: ${result.modelCallsSession}`,
    );
    expect(h.turns[0]).toEqual({ subtype: "end_turn", isError: false });
    // Do not trust the agent's claim: run the tests ourselves.
    const check = await runCommand(["npm", "test"], {
      cwd: h.cwd,
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      sandboxHome: join(h.cwd, "..", "home"),
    });
    console.log(
      check.output
        .split("\n")
        .filter((l) => /^# (pass|fail)/.test(l))
        .join(" "),
    );
    expect(check.exitCode).toBe(0);
    expect(check.output).toMatch(/discount|SAVE10|applyDiscount/i);
  });

  it("an invalid key is reported as an auth failure after exactly one call", async () => {
    const h = harness({ ...process.env, GROQ_API_KEY: "gsk_invalid_key_for_testing" });
    const run = await h.adapter.start(h.ctx);
    run.send("Say hello");
    await until(() => h.turns.length > 0, 60_000, "turn end");
    await run.stop();
    expect(h.turns[0]).toEqual({ subtype: "error_provider_auth", isError: true });
  });
});

describe.skipIf(enabled)("Groq real provider", () => {
  it.skip("NOT RUN: set GROQ_API_KEY and PAIRLOOM_REAL_PROVIDER_TEST=1 to run real-provider tests", () => {});
});
