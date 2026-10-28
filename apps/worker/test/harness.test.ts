import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContext, PermissionAsk, TurnOutcome } from "../src/adapters/types.js";
import { DEFAULT_LIMITS, HarnessAdapter, type HarnessLimits } from "../src/harness/agent.js";
import { OpenAICompatibleClient, type ProviderConfig } from "../src/harness/provider.js";
import { until } from "./fixtures.js";
import { error, startStubOpenAI, type StubScript, text, toolCalls } from "./stubOpenAI.js";

/**
 * MOCKED-PROVIDER TESTS. The model is a scripted local stub; these verify the
 * harness (tool loop, permissions, limits, errors, recovery), not model quality.
 */
const SAMPLE = resolve(import.meta.dirname, "../../../samples/tiny-cart");
const KEY = "gsk_test_key_must_not_leak_123";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

function sampleProject() {
  const dir = mkdtempSync(join(tmpdir(), "pl-harness-"));
  cpSync(SAMPLE, join(dir, "proj"), { recursive: true });
  return { cwd: join(dir, "proj"), stateDir: join(dir, "state") };
}

async function setup(
  script: StubScript,
  opts: {
    limits?: Partial<HarnessLimits>;
    provider?: Partial<ProviderConfig>;
    policy?: any;
    answer?: (a: PermissionAsk) => boolean;
  } = {},
) {
  const stub = await startStubOpenAI(script);
  closers.push(stub.close);
  const { cwd, stateDir } = sampleProject();
  const config: ProviderConfig = {
    provider: "groq",
    baseUrl: stub.url,
    apiKey: KEY,
    apiKeyEnv: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b",
    maxCompletionTokens: 1024,
    requestTimeoutMs: 10_000,
    maxRetries: 1,
    maxRetryWaitSec: 5,
    pricing: { input: 0.15, cachedInput: 0.075, output: 0.6 },
    ...opts.provider,
  };
  const limits = { ...DEFAULT_LIMITS, commandTimeoutMs: 30_000, ...opts.limits };
  const adapter = new HarnessAdapter(new OpenAICompatibleClient(config), limits, stateDir);
  const events: Array<{ type: string; payload: any }> = [];
  const asks: PermissionAsk[] = [];
  const turns: TurnOutcome[] = [];
  let providerSession: string | null = null;
  const makeCtx = (resume: string | null): AgentContext => ({
    sessionId: "ses_test",
    cwd,
    title: "t",
    permissionPolicy: opts.policy ?? "accept_edits_in_worktree",
    resumeProviderSessionId: resume,
    emit: (type, payload) => events.push({ type, payload }),
    requestPermission: async (a) => {
      asks.push(a);
      return (opts.answer ?? (() => true))(a)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "no thanks" };
    },
    onProviderSession: (id) => (providerSession = id),
    onTurnStart: () => {},
    onTurnEnd: (o) => turns.push(o),
    onExit: () => {},
  });
  const run = await adapter.start(makeCtx(null));
  const result = () => events.filter((e) => e.type === "agent.result").at(-1)?.payload;
  return {
    stub,
    adapter,
    run,
    events,
    asks,
    turns,
    cwd,
    stateDir,
    result,
    makeCtx,
    providerSession: () => providerSession,
  };
}

describe("harness: a coding task end to end (mocked provider)", () => {
  it("reads, edits, runs the real sample tests, and reports usage and estimated cost", async () => {
    const discount = `
export function applyDiscount(cart, code) {
  if (code !== "SAVE10") throw new Error("unknown code");
  return Math.floor(subtotalCents(cart) * 0.9);
}
`;
    const t = await setup(({ n }) => {
      if (n === 1) return toolCalls({ name: "list_files", args: {} });
      if (n === 2) return toolCalls({ name: "read_file", args: { path: "src/cart.js" } });
      if (n === 3) {
        return toolCalls({
          name: "edit_file",
          args: {
            path: "src/cart.js",
            old_string: "export function subtotalCents",
            new_string: discount.trim() + "\n\nexport function subtotalCents",
          },
        });
      }
      if (n === 4) return toolCalls({ name: "run_tests", args: {} });
      return text("Added applyDiscount. Tests: 4 passed.");
    });
    t.run.send("Add applyDiscount");
    await until(() => t.turns.length > 0, 30000, "turn end");

    expect(t.turns[0]).toEqual({ subtype: "end_turn", isError: false });
    expect(readFileSync(join(t.cwd, "src/cart.js"), "utf8")).toContain("applyDiscount");
    const r = t.result();
    expect(r.lastTestRun).toEqual({ exitCode: 0, timedOut: false });
    expect(r.modelCallsSession).toBe(5);
    expect(r.totalCostUsd).toBeCloseTo((5 * 1000 * 0.15 + 5 * 100 * 0.6) / 1e6, 8);
    const testResult = t.events.find(
      (e) => e.type === "agent.tool_result" && e.payload.exitCode !== undefined,
    );
    expect(testResult!.payload.output).toMatch(/# pass 4/);
    // The model saw the tool results in order, and requests carried a bearer token.
    expect(t.stub.requests[4]!.body.messages.at(-1).role).toBe("tool");
    expect(t.stub.requests.every((q) => q.authorized)).toBe(true);
    expect(t.stub.requests[0]!.body.model).toBe("openai/gpt-oss-120b");
    // The API key never appears in anything sent to collaborators.
    expect(JSON.stringify(t.events)).not.toContain(KEY);
  });

  it("asks the host before arbitrary commands and deletes; a denial means nothing runs", async () => {
    const t = await setup(
      ({ n }) => {
        if (n === 1)
          return toolCalls({
            name: "run_command",
            args: { argv: ["node", "-e", "require('fs').writeFileSync('pwned.txt','x')"] },
          });
        if (n === 2) return toolCalls({ name: "delete_file", args: { path: "src/cart.js" } });
        return text("ok");
      },
      { answer: () => false },
    );
    t.run.send("try things");
    await until(() => t.turns.length > 0, 20000, "turn end");
    expect(t.asks.map((a) => a.toolName)).toEqual(["run_command", "delete_file"]);
    expect(t.asks[0]!.title).toContain("node -e");
    expect(existsSync(join(t.cwd, "pwned.txt"))).toBe(false);
    expect(existsSync(join(t.cwd, "src/cart.js"))).toBe(true);
    const denied = t.events.filter(
      (e) => e.type === "agent.tool_result" && /Denied by the session host/.test(e.payload.output),
    );
    expect(denied).toHaveLength(2);
  });

  it("returns tool errors to the model instead of escaping the sandbox", async () => {
    const t = await setup(({ n }) => {
      if (n === 1)
        return toolCalls({ name: "read_file", args: { path: "../../../../etc/passwd" } });
      if (n === 2)
        return toolCalls({
          name: "run_command",
          args: { argv: ["git", "push", "origin", "main"] },
        });
      if (n === 3) return toolCalls({ name: "nonexistent_tool", args: {} });
      if (n === 4) return toolCalls({ name: "write_file", args: "{not json" });
      return text("done");
    });
    t.run.send("misbehave");
    await until(() => t.turns.length > 0, 20000, "turn end");
    const outputs = t.events
      .filter((e) => e.type === "agent.tool_result")
      .map((e) => e.payload.output);
    expect(outputs[0]).toMatch(/outside the project/);
    expect(outputs[1]).toMatch(/git push' is not allowed/);
    expect(outputs[2]).toMatch(/unknown tool/);
    expect(outputs[3]).toMatch(/Invalid JSON/);
    expect(t.asks).toHaveLength(1); // git push was asked about, then hard-denied anyway
  });
});

describe("harness: provider failures are explicit and not retried in loops", () => {
  it("invalid key: one call, auth error, no success", async () => {
    const t = await setup(() => error(401, "Invalid API Key", "invalid_api_key"));
    t.run.send("hi");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.turns[0]).toEqual({ subtype: "error_provider_auth", isError: true });
    expect(t.stub.requests).toHaveLength(1);
    const err = t.events.find((e) => e.type === "agent.error");
    expect(err!.payload.message).toMatch(/rejected the API key.*GROQ_API_KEY/);
    expect(err!.payload.message).not.toContain(KEY);
  });

  it("429 honours a short retry-after once, then succeeds", async () => {
    const t = await setup(({ n }) =>
      n === 1
        ? error(429, "slow down", "rate_limit_exceeded", { "retry-after": "1" })
        : text("done"),
    );
    t.run.send("hi");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.turns[0]!.isError).toBe(false);
    expect(t.stub.requests).toHaveLength(2);
    expect(
      t.events.some((e) => e.type === "system.notice" && /retry 1/.test(e.payload.message)),
    ).toBe(true);
    expect(t.result().modelCallsSession).toBe(2);
  });

  it("waits for the reported per-minute token budget instead of spending a 429 retry", async () => {
    const budget = { "x-ratelimit-remaining-tokens": "10", "x-ratelimit-reset-tokens": "600ms" };
    const t = await setup(({ n }) =>
      n === 1 ? { ...toolCalls({ name: "list_files", args: {} }), headers: budget } : text("done"),
    );
    const start = Date.now();
    t.run.send("hi");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.turns[0]!.isError).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(500);
    expect(t.stub.requests).toHaveLength(2);
    expect(t.result().modelCallsSession).toBe(2);
    expect(
      t.events.some(
        (e) =>
          e.type === "system.notice" &&
          /per-minute token budget.*no model call used/.test(e.payload.message),
      ),
    ).toBe(true);
  });

  it("429 with a long retry-after fails immediately; repeated 429s stop after the retry cap", async () => {
    const long = await setup(() =>
      error(429, "tpm exceeded", "rate_limit_exceeded", { "retry-after": "600" }),
    );
    long.run.send("hi");
    await until(() => long.turns.length > 0, 10000, "turn end");
    expect(long.turns[0]!.subtype).toBe("error_provider_rate_limited");
    expect(long.stub.requests).toHaveLength(1);

    const repeated = await setup(() => error(429, "busy", undefined, { "retry-after": "0" }));
    repeated.run.send("hi");
    await until(() => repeated.turns.length > 0, 10000, "turn end");
    expect(repeated.stub.requests).toHaveLength(2);
    expect(repeated.turns[0]!.isError).toBe(true);
  });

  it("quota/billing exhaustion is never retried", async () => {
    const t = await setup(() =>
      error(429, "You exceeded your current quota", "insufficient_quota"),
    );
    t.run.send("hi");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.turns[0]!.subtype).toBe("error_provider_quota_or_billing");
    expect(t.stub.requests).toHaveLength(1);
  });

  it("a malformed tool call gets one corrective retry", async () => {
    const t = await setup(({ n }) =>
      n === 1 ? error(400, "Failed to call a function.", "tool_use_failed") : text("fixed"),
    );
    t.run.send("hi");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.turns[0]!.isError).toBe(false);
    expect(t.stub.requests[1]!.body.messages.at(-1).content).toMatch(/could not be parsed/);
  });

  it("missing credentials make the adapter unavailable and refuse to start", async () => {
    const { cwd, stateDir } = sampleProject();
    const adapter = new HarnessAdapter(
      new OpenAICompatibleClient({
        provider: "groq",
        baseUrl: "http://127.0.0.1:9",
        apiKey: null,
        apiKeyEnv: "GROQ_API_KEY",
        model: "openai/gpt-oss-120b",
        maxCompletionTokens: 10,
        requestTimeoutMs: 1000,
        maxRetries: 0,
        maxRetryWaitSec: 0,
        pricing: null,
      }),
      DEFAULT_LIMITS,
      stateDir,
    );
    expect(adapter.info()).toMatchObject({
      available: false,
      kind: "llm-harness",
      provider: "groq",
    });
    expect(adapter.info().detail).toContain("GROQ_API_KEY");
    await expect(adapter.start({ cwd } as AgentContext)).rejects.toThrow(/GROQ_API_KEY/);
  });

  it("an unreachable provider is a visible network error", async () => {
    const t = await setup(() => text("never"), {
      provider: { baseUrl: "http://127.0.0.1:9/v1", maxRetries: 0 },
    });
    t.run.send("hi");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.turns[0]!.subtype).toBe("error_provider_network");
  });
});

describe("harness: limits, cancellation and recovery", () => {
  const forever: StubScript = () => toolCalls({ name: "list_files", args: {} });

  it("stops at the per-turn iteration cap", async () => {
    const t = await setup(forever, { limits: { maxIterationsPerTurn: 3 } });
    t.run.send("loop");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.turns[0]).toEqual({ subtype: "error_max_iterations", isError: true });
    expect(t.stub.requests).toHaveLength(3);
  });

  it("stops at the session model-call cap across turns", async () => {
    const t = await setup(forever, {
      limits: { maxIterationsPerTurn: 3, maxModelCallsPerSession: 4 },
    });
    t.run.send("one");
    await until(() => t.turns.length > 0, 10000, "turn 1");
    t.run.send("two");
    await until(() => t.turns.length > 1, 10000, "turn 2");
    expect(t.turns[1]!.subtype).toBe("error_max_model_calls");
    expect(t.stub.requests).toHaveLength(4);
  });

  it("stops when the estimated cost reaches the budget", async () => {
    const t = await setup(forever, { limits: { maxCostUsdPerSession: 0.0005 } });
    t.run.send("spend");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.turns[0]!.subtype).toBe("error_budget");
    // each stub call costs $0.00021 at the configured prices: 3 calls cross $0.0005
    expect(t.stub.requests).toHaveLength(3);
  });

  it("stops at the wall-clock limit", async () => {
    const t = await setup(
      () => ({ ...toolCalls({ name: "list_files", args: {} }), delayMs: 400 }),
      {
        limits: { maxTurnMs: 300 },
      },
    );
    t.run.send("slow");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.turns[0]!.subtype).toBe("error_max_time");
  });

  it("interrupt cancels an in-flight model call promptly and reports interrupted", async () => {
    const t = await setup(() => ({ ...text("late"), delayMs: 5000 }));
    t.run.send("long");
    await until(() => t.stub.requests.length > 0, 5000, "request");
    const started = Date.now();
    await t.run.interrupt();
    await until(() => t.turns.length > 0, 5000, "turn end");
    expect(t.turns[0]).toEqual({ subtype: "interrupted", isError: true });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("interrupt kills a running test command", async () => {
    const t = await setup(({ n }) =>
      n === 1
        ? toolCalls({
            name: "run_command",
            args: { argv: ["node", "-e", "setTimeout(()=>{}, 60000)"] },
          })
        : text("x"),
    );
    t.run.send("run slow command");
    await until(() => t.asks.length > 0, 5000, "approval asked");
    await until(() => t.events.some((e) => e.type === "agent.tool_use"), 5000, "tool started");
    await new Promise((r) => setTimeout(r, 200));
    await t.run.interrupt();
    await until(() => t.turns.length > 0, 5000, "turn end");
    expect(t.turns[0]!.subtype).toBe("interrupted");
    const out = t.events.find((e) => e.type === "agent.tool_result");
    expect(out!.payload.output).toMatch(/CANCELLED/);
  });

  it("sends earlier turns' tool output as stubs while the saved transcript keeps it", async () => {
    const t = await setup(({ n }) => {
      if (n === 1) return toolCalls({ name: "read_file", args: { path: "src/cart.js" } });
      return text(`summary ${n}`);
    });
    t.run.send("turn one");
    await until(() => t.turns.length === 1, 10000, "turn 1");
    t.run.send("turn two");
    await until(() => t.turns.length === 2, 10000, "turn 2");
    const toolMsg = (msgs: any[]) => msgs.find((m) => m.role === "tool").content as string;
    expect(toolMsg(t.stub.requests[1]!.body.messages)).toMatch(/subtotalCents/);
    expect(toolMsg(t.stub.requests[2]!.body.messages)).toMatch(
      /output from an earlier turn omitted/,
    );
    const transcript = JSON.parse(
      readFileSync(join(t.stateDir, "transcripts", "ses_test.json"), "utf8"),
    );
    expect(toolMsg(transcript.messages)).toMatch(/subtotalCents/);
  });

  it("persists the transcript and resumes after a simulated worker crash", async () => {
    let crashed = false;
    const t = await setup(({ n, body }) => {
      if (n === 1)
        return toolCalls({ name: "read_file", args: { path: "README.md" }, id: "call_a" });
      if (n === 2 && !crashed) return { ...text("never"), delayMs: 60_000 }; // "crash" while waiting here
      // After resume: the model must see the earlier tool result and the resume note.
      const last = body.messages.at(-2)?.content ?? "";
      return text(
        /worker restarted/.test(JSON.stringify(body.messages))
          ? `resumed ok ${last.length}`
          : "no note",
      );
    });
    t.run.send("read the readme");
    await until(() => t.stub.requests.length >= 2, 10000, "second call");
    crashed = true; // pretend the process died: drop this run, start a new adapter instance
    const transcript = JSON.parse(
      readFileSync(join(t.stateDir, "transcripts", "ses_test.json"), "utf8"),
    );
    expect(
      transcript.messages.some((m: any) => m.role === "tool" && m.tool_call_id === "call_a"),
    ).toBe(true);

    const adapter2 = new HarnessAdapter(t.adapter["client"], { ...DEFAULT_LIMITS }, t.stateDir);
    const events2: any[] = [];
    const turns2: TurnOutcome[] = [];
    const run2 = await adapter2.start({
      ...t.makeCtx(t.providerSession()),
      emit: (type, payload) => events2.push({ type, payload }),
      onTurnEnd: (o) => turns2.push(o),
    });
    expect(events2.find((e) => e.type === "agent.init").payload.resumed).toBe(true);
    run2.send("continue");
    await until(() => turns2.length > 0, 10000, "resumed turn");
    expect(events2.find((e) => e.type === "agent.text").payload.text).toMatch(/resumed ok/);
    await t.run.stop();
  });
});

describe("harness: steering a model that repeats itself", () => {
  it("honours 1-based line_start/line_end on read_file", async () => {
    const t = await setup(({ n }) =>
      n === 1
        ? toolCalls({
            name: "read_file",
            args: { path: "src/cart.js", line_start: 3, line_end: 4 },
          })
        : text("done"),
    );
    t.run.send("read");
    await until(() => t.turns.length > 0, 10000, "turn end");
    const out = t.events.find((e) => e.type === "agent.tool_result")!.payload.output as string;
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toMatch(/^ {3}3\| /);
  });

  it("answers an identical repeated read with a pointer until a file changes", async () => {
    const read = { name: "read_file", args: { path: "src/cart.js" } };
    const t = await setup(({ n }) => {
      if (n <= 2) return toolCalls(read);
      if (n === 3)
        return toolCalls({ name: "write_file", args: { path: "notes.txt", content: "x" } });
      if (n === 4) return toolCalls(read);
      return text("done");
    });
    t.run.send("read twice");
    await until(() => t.turns.length > 0, 10000, "turn end");
    const outs = t.events
      .filter((e) => e.type === "agent.tool_result")
      .map((e) => e.payload.output as string);
    expect(outs[0]).toMatch(/export function/);
    expect(outs[1]).toMatch(/Same call as earlier in this turn/);
    // After a write, the same read returns real content again.
    expect(outs[3]).toMatch(/export function/);
    expect(t.turns[0]).toEqual({ subtype: "end_turn", isError: false });
  });

  it("keeps the last step for a tools-off summary of done and remaining work", async () => {
    const t = await setup(
      ({ n, body }) =>
        !body.tools
          ? text("Changed notes.txt. Still left: the tests.")
          : n === 1
            ? toolCalls({ name: "write_file", args: { path: "notes.txt", content: "x" } })
            : toolCalls({ name: "list_files", args: { path: `p${n}` } }),
      { limits: { maxIterationsPerTurn: 4 } },
    );
    t.run.send("loop");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.stub.requests).toHaveLength(4);
    const last = t.stub.requests[3]!.body;
    expect(last.tools).toBeUndefined();
    expect(JSON.stringify(last.messages.at(-1))).toMatch(/this turn: notes\.txt/);
    const r = t.result();
    expect(r.subtype).toBe("error_max_iterations");
    expect(r.isError).toBe(true);
    expect(r.filesEdited).toEqual(["notes.txt"]);
    expect(t.events.filter((e) => e.type === "agent.text").at(-1)!.payload.text).toMatch(
      /Still left/,
    );
  });

  it("stops a model that keeps repeating the same call, with a clear reason", async () => {
    const t = await setup(({ body }) =>
      !body.tools ? text("I was stuck.") : toolCalls({ name: "list_files", args: {} }),
    );
    t.run.send("loop");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.result().subtype).toBe("error_no_progress");
    expect(t.result().message).toMatch(/without making progress/);
    // 1 real call + 3 answered "same as before" + 1 closing summary.
    expect(t.stub.requests).toHaveLength(5);
  });

  it("stops at the per-turn token budget so one task can't spend the day's allowance", async () => {
    const t = await setup(
      ({ n, body }) =>
        !body.tools ? text("summary") : toolCalls({ name: "list_files", args: { path: `p${n}` } }),
      { limits: { maxTokensPerTurn: 2500 } },
    );
    t.run.send("spend");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.result().subtype).toBe("error_token_budget");
    // Each stub call reports 1100 tokens: 3 calls cross 2500, then the summary.
    expect(t.stub.requests).toHaveLength(4);
  });

  it("continuing after an unfinished turn keeps the earlier work and history", async () => {
    let turn = 1;
    const t = await setup(
      ({ body }) => {
        if (!body.tools) return text("Wrote notes.txt; tests still missing.");
        if (turn === 1)
          return toolCalls({ name: "write_file", args: { path: "notes.txt", content: "x" } });
        return text("Added the rest.");
      },
      { limits: { maxIterationsPerTurn: 2 } },
    );
    t.run.send("first");
    await until(() => t.turns.length > 0, 10000, "turn 1");
    expect(t.turns[0]!.subtype).toBe("error_max_iterations");
    expect(readFileSync(join(t.cwd, "notes.txt"), "utf8")).toBe("x");
    turn = 2;
    t.run.send("Continue where you left off");
    await until(() => t.turns.length > 1, 10000, "turn 2");
    expect(t.turns[1]).toEqual({ subtype: "end_turn", isError: false });
    // The continuation request carries the first turn (its write and summary), not a fresh start.
    const msgs = JSON.stringify(t.stub.requests.at(-1)!.body.messages);
    expect(msgs).toMatch(/"first"/);
    expect(msgs).toMatch(/tests still missing/);
    // The partial edit was not redone or lost.
    expect(readFileSync(join(t.cwd, "notes.txt"), "utf8")).toBe("x");
  });

  it("estimates tokens when the provider reports no usage, so the budget still applies", async () => {
    const noUsage = (r: any) => {
      delete r.body.usage;
      return r;
    };
    const t = await setup(
      ({ n, body }) =>
        noUsage(
          !body.tools
            ? text("summary")
            : toolCalls({ name: "list_files", args: { path: `p${n}` } }),
        ),
      { limits: { maxTokensPerTurn: 3000 } },
    );
    t.run.send("spend");
    await until(() => t.turns.length > 0, 10000, "turn end");
    const r = t.result();
    expect(r.subtype).toBe("error_token_budget");
    expect(r.usageEstimated).toBe(true);
    expect(r.tokensThisTurn).toBeGreaterThanOrEqual(3000);
  });

  it("a task's total budget carries across turns; a continue at the cap makes no model call", async () => {
    const t = await setup(
      ({ n, body }) =>
        !body.tools ? text("summary") : toolCalls({ name: "list_files", args: { path: `p${n}` } }),
      { limits: { maxTokensPerSession: 2500 } },
    );
    t.run.send("first");
    await until(() => t.turns.length > 0, 10000, "turn 1");
    expect(t.result().subtype).toBe("error_session_token_budget");
    const before = t.stub.requests.length;
    t.run.send("Continue where you left off");
    await until(() => t.turns.length > 1, 10000, "turn 2");
    expect(t.result().subtype).toBe("error_session_token_budget");
    expect(t.stub.requests.length).toBe(before);
  });

  it("a failed closing summary is reported, and the turn still ends unfinished", async () => {
    const t = await setup(
      ({ n, body }) =>
        !body.tools
          ? error(500, "boom")
          : toolCalls({ name: "list_files", args: { path: `p${n}` } }),
      { limits: { maxIterationsPerTurn: 3 }, provider: { maxRetries: 0 } },
    );
    t.run.send("loop");
    await until(() => t.turns.length > 0, 10000, "turn end");
    expect(t.result()).toMatchObject({ subtype: "error_max_iterations", isError: true });
    const notice = t.events.find((e) => e.type === "system.notice");
    expect(notice!.payload.message).toMatch(/closing summary couldn't be generated/);
  });

  it("warns the model when an edit leaves the file unparseable (the real run's bug)", async () => {
    // What gpt-oss did on 2026-10-28: inserted a function inside subtotalCents' body.
    const t = await setup(({ n }) =>
      n === 1
        ? toolCalls({
            name: "edit_file",
            args: {
              path: "src/cart.js",
              old_string: "export function subtotalCents(cart) {\n",
              new_string:
                "export function subtotalCents(cart) {\n}\n\nexport function itemCount(cart) {\n  return cart.items.reduce((s, i) => s + i.quantity, 0);\n}\n",
            },
          })
        : text("done"),
    );
    t.run.send("edit");
    await until(() => t.turns.length > 0, 10000, "turn end");
    const out = t.events.find((e) => e.type === "agent.tool_result")!.payload.output as string;
    expect(out).toMatch(/WARNING: src\/cart\.js no longer parses \(line \d+/);
    // Reviewers get the verdict as its own field, independent of display truncation.
    const payload = t.events.find((e) => e.type === "agent.tool_result")!.payload;
    expect(payload).toMatchObject({ path: "src/cart.js", parseOk: false });
    expect(payload.syntaxWarning).toMatch(/no longer parses/);
    // The model receives it too (it's in the tool message), not only the activity feed.
    expect(JSON.stringify(t.stub.requests[1]!.body.messages.at(-1))).toMatch(/no longer parses/);
  });

  it("a successful edit returns the changed lines with numbers", async () => {
    const t = await setup(({ n }) =>
      n === 1
        ? toolCalls({
            name: "edit_file",
            args: {
              path: "src/cart.js",
              old_string: "export function subtotalCents",
              new_string:
                "export function itemCount(cart) {\n  return 0;\n}\n\nexport function subtotalCents",
            },
          })
        : text("done"),
    );
    t.run.send("edit");
    await until(() => t.turns.length > 0, 10000, "turn end");
    const out = t.events.find((e) => e.type === "agent.tool_result")!.payload.output as string;
    expect(out).toMatch(/^Edited src\/cart\.js\. Lines \d+-\d+ now read:/);
    expect(out).toMatch(/\d+\| export function itemCount\(cart\) \{/);
    expect(out).not.toMatch(/WARNING/);
    expect(t.result().filesEdited).toEqual(["src/cart.js"]);
  });

  it("treats the same whole-file read in different spellings as a repeat", async () => {
    const t = await setup(({ n }) =>
      n === 1
        ? toolCalls({
            name: "read_file",
            args: { path: "src/cart.js", line_start: 1, line_end: 400 },
          })
        : n === 2
          ? toolCalls({ name: "read_file", args: { path: "./src/cart.js", offset: 0, limit: 200 } })
          : text("done"),
    );
    t.run.send("read");
    await until(() => t.turns.length > 0, 10000, "turn end");
    const outs = t.events
      .filter((e) => e.type === "agent.tool_result")
      .map((e) => e.payload.output as string);
    expect(outs[0]).toMatch(/export function/);
    expect(outs[1]).toMatch(/Same call as earlier in this turn/);
  });

  it("an ambiguous edit says where the matches are", async () => {
    const t = await setup(({ n }) =>
      n === 1
        ? toolCalls({
            name: "edit_file",
            args: { path: "src/cart.js", old_string: "export", new_string: "x" },
          })
        : text("done"),
    );
    t.run.send("edit");
    await until(() => t.turns.length > 0, 10000, "turn end");
    const r = t.events.find((e) => e.type === "agent.tool_result")!.payload;
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/starting at lines \d+, \d+/);
    // Nothing was changed.
    expect(readFileSync(join(t.cwd, "src/cart.js"), "utf8")).toBe(
      readFileSync(join(SAMPLE, "src/cart.js"), "utf8"),
    );
    expect(t.result().filesEdited).toEqual([]);
  });
});
