import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSdkAdapter } from "../src/adapters/claudeSdk.js";
import type { AgentContext, PermissionAsk, TurnOutcome } from "../src/adapters/types.js";
import { buildAgentEnv } from "../src/config.js";
import { isolateModelEnv, makeRepo, until, workerConfig } from "./fixtures.js";
import { startStubAnthropic } from "./stubAnthropic.js";

/**
 * These tests run the REAL Claude Agent SDK and the bundled Claude Code CLI.
 * Only the model endpoint is replaced by a local protocol stub (fixed replies),
 * so they prove the adapter launches, streams, gates tools, and reports errors
 * through the supported interface — not that any model produced good code.
 */
const stubs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
});

function recorder(cwd: string, answer: (a: PermissionAsk) => "allow" | "deny" = () => "allow") {
  const events: Array<{ type: string; payload: any }> = [];
  const asks: PermissionAsk[] = [];
  const turns: TurnOutcome[] = [];
  let exit: { error: string | null } | null = null;
  const ctx: AgentContext = {
    sessionId: "ses_test",
    cwd,
    title: "t",
    permissionPolicy: "ask_every_time",
    resumeProviderSessionId: null,
    emit: (type, payload) => events.push({ type, payload }),
    requestPermission: async (a) => {
      asks.push(a);
      return answer(a) === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "denied in test" };
    },
    onProviderSession: () => {},
    onTurnStart: () => {},
    onTurnEnd: (o) => turns.push(o),
    onExit: (e) => (exit = e),
  };
  return { ctx, events, asks, turns, getExit: () => exit };
}

describe("ClaudeSdkAdapter (real SDK + CLI, stubbed model endpoint)", () => {
  it("reports itself unavailable without a supported credential, and refuses to start", async () => {
    isolateModelEnv(null);
    const r = makeRepo();
    const adapter = new ClaudeSdkAdapter(workerConfig(r));
    expect(adapter.info().available).toBe(false);
    expect(adapter.info().version).toBe("0.3.311");
    await expect(adapter.start(recorder(r.repo).ctx)).rejects.toThrow(/no ANTHROPIC_API_KEY/);
  });

  it("never passes the worker token or unrelated secrets to the agent process", () => {
    process.env.PAIRLOOM_WORKER_TOKEN = "plw_secret";
    process.env.DATABASE_URL = "postgres://secret";
    const env = buildAgentEnv(workerConfig(makeRepo()));
    expect(env.PAIRLOOM_WORKER_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeDefined();
  });

  it("runs a turn: init with provider session id, assistant text, success result", async () => {
    const stub = await startStubAnthropic();
    stubs.push(stub);
    isolateModelEnv(stub.url);
    const r = makeRepo();
    const rec = recorder(r.repo);
    const run = await new ClaudeSdkAdapter(workerConfig(r)).start(rec.ctx);
    run.send("Say hi");
    await until(() => rec.turns.length > 0, 60000, "turn end");
    const init = rec.events.find((e) => e.type === "agent.init");
    expect(init?.payload.providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(init?.payload.apiKeySource).toBe("ANTHROPIC_API_KEY");
    expect(rec.events.some((e) => e.type === "agent.text" && e.payload.text.includes("STUB-REPLY"))).toBe(true);
    expect(rec.turns[0]).toEqual({ subtype: "success", isError: false });
    await run.stop();
  }, 90000);

  it("routes tool calls to the host for approval and only runs them when allowed", async () => {
    const stub = await startStubAnthropic({
      toolCall: { name: "Bash", input: { command: "touch created-by-agent.txt", description: "create file" } },
    });
    stubs.push(stub);
    isolateModelEnv(stub.url);
    const r = makeRepo();
    const rec = recorder(r.repo, () => "allow");
    const run = await new ClaudeSdkAdapter(workerConfig(r)).start(rec.ctx);
    run.send("Create a file");
    await until(() => rec.turns.length > 0, 60000, "turn end");
    expect(rec.asks.map((a) => a.toolName)).toContain("Bash");
    expect(rec.events.some((e) => e.type === "agent.tool_use" && e.payload.toolName === "Bash")).toBe(true);
    expect(existsSync(join(r.repo, "created-by-agent.txt"))).toBe(true);
    await run.stop();
  }, 90000);

  it("a denied tool call does not run", async () => {
    const stub = await startStubAnthropic({
      toolCall: { name: "Bash", input: { command: "touch should-not-exist.txt", description: "create file" } },
    });
    stubs.push(stub);
    isolateModelEnv(stub.url);
    const r = makeRepo();
    const rec = recorder(r.repo, () => "deny");
    const run = await new ClaudeSdkAdapter(workerConfig(r)).start(rec.ctx);
    run.send("Create a file");
    await until(() => rec.turns.length > 0, 60000, "turn end");
    expect(rec.asks).toHaveLength(1);
    expect(existsSync(join(r.repo, "should-not-exist.txt"))).toBe(false);
    const result = rec.events.find((e) => e.type === "agent.tool_result");
    expect(result?.payload.isError).toBe(true);
    await run.stop();
  }, 90000);

  it("reports provider auth failures truthfully instead of claiming success", async () => {
    const stub = await startStubAnthropic({ status: 401 });
    stubs.push(stub);
    isolateModelEnv(stub.url);
    const r = makeRepo();
    const rec = recorder(r.repo);
    const run = await new ClaudeSdkAdapter(workerConfig(r)).start(rec.ctx);
    run.send("Say hi");
    const err = await until(
      () => rec.events.find((e) => e.type === "agent.error"),
      30000,
      "credential error",
    );
    expect(err.payload.message).toMatch(/credential rejected.*401/);
    expect(rec.events.some((e) => e.type === "system.notice" && /401/.test(e.payload.message))).toBe(true);
    // Retries were cut short rather than running the full backoff schedule.
    await until(() => rec.turns.length > 0 || rec.getExit(), 15000, "turn end after interrupt");
    expect(rec.turns.find((t) => t.subtype === "success" && !t.isError)).toBeUndefined();
    expect(stub.requests.filter((x) => x.path.startsWith("/v1/messages")).length).toBeLessThan(5);
    await run.stop();
  }, 90000);
});
