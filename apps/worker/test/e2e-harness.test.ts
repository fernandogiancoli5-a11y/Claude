import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invite, makeApp, seed } from "../../server/test/helpers.js";
import { SimulatedAdapter } from "../src/adapters/simulated.js";
import { Workspace } from "../src/git.js";
import { DEFAULT_LIMITS, HarnessAdapter } from "../src/harness/agent.js";
import { OpenAICompatibleClient } from "../src/harness/provider.js";
import { ServerLink } from "../src/link.js";
import { SessionManager } from "../src/sessions.js";
import { until } from "./fixtures.js";
import { error, startStubOpenAI, type StubReply, text, toolCalls } from "./stubOpenAI.js";

/**
 * MOCKED-PROVIDER END-TO-END: real server, real worker, real git, the real
 * sample app and its real tests — but the model is a scripted stub. This proves
 * the product plumbing (streaming, approvals, collaborator instructions, checks,
 * cancellation, crash recovery, review/merge, honest failures). It is NOT
 * evidence that any real model can do the task; see *.real.test.ts for that.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function sampleRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pl-e2e-"));
  const repo = join(dir, "sample-repo");
  execFileSync("bash", [join(ROOT, "scripts/sample-repo.sh"), repo]);
  return { dir, repo, worktrees: join(dir, "worktrees"), state: join(dir, "worker-state") };
}

let boots = 0;
async function bootWorker(
  app: { url: string },
  token: string,
  r: ReturnType<typeof sampleRepo>,
  stubUrl: string,
  key: string | null,
) {
  const client = new OpenAICompatibleClient({
    provider: "groq",
    baseUrl: stubUrl,
    apiKey: key,
    apiKeyEnv: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b",
    maxCompletionTokens: 1024,
    requestTimeoutMs: 30_000,
    maxRetries: 0,
    maxRetryWaitSec: 0,
    pricing: { input: 0.15, cachedInput: 0.075, output: 0.6 },
  });
  const adapters = {
    real: new HarnessAdapter(client, DEFAULT_LIMITS, r.state),
    simulated: new SimulatedAdapter(0),
  };
  let manager!: SessionManager;
  // Each boot gets its own link state so an abandoned "crashed" instance cannot interfere.
  const link = new ServerLink(
    app.url,
    token,
    join(r.state, `link-${++boots}`),
    () => ({
      workerVersion: "test",
      adapters: [adapters.real.info(), adapters.simulated.info()],
      liveSessions: manager.liveReports(),
    }),
    (f) => manager.handle(f.sessionId, f.command),
    () => {},
  );
  manager = new SessionManager(link, new Workspace(r.repo, r.worktrees), adapters, r.state);
  link.start();
  cleanups.push(async () => {
    await manager.stopAll();
    await link.stop();
  });
  await until(() => link.connected, 5000, "worker connected");
  return { link, manager };
}

const DISCOUNT_FN = `export function applyDiscount(cart, code) {
  const rates = { SAVE10: 10 };
  if (!(code in rates)) throw new Error(\`Unknown discount code: \${code}\`);
  return Math.floor((subtotalCents(cart) * (100 - rates[code])) / 100);
}
`;
const DISCOUNT_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, applyDiscount, createCart } from "../src/cart.js";

test("SAVE10 takes 10% off", () => {
  const cart = addItem(createCart(), { sku: "a", priceCents: 999 });
  assert.equal(applyDiscount(cart, "SAVE10"), 899);
});

test("unknown codes throw", () => {
  assert.throws(() => applyDiscount(createCart(), "NOPE"));
});
`;

describe("two-person real-harness session (MOCKED provider)", () => {
  it("streams work, gates tools and instructions, verifies tests, survives interrupt and worker crash, then merges", async () => {
    const replies: StubReply[] = [
      // Turn 1: implement the feature.
      toolCalls({ name: "read_file", args: { path: "src/cart.js" } }),
      toolCalls({
        name: "edit_file",
        args: {
          path: "src/cart.js",
          old_string: "export function subtotalCents",
          new_string: DISCOUNT_FN + "\nexport function subtotalCents",
        },
      }),
      toolCalls({
        name: "write_file",
        args: { path: "test/discount.test.js", content: DISCOUNT_TEST },
      }),
      toolCalls({ name: "run_command", args: { argv: ["node", "-e", "console.log('lint ok')"] } }),
      toolCalls({ name: "run_tests", args: {} }),
      text("Implemented applyDiscount with SAVE10 and tests. npm test: 6 passed."),
      // Turn 2: collaborator's instruction.
      toolCalls({
        name: "edit_file",
        args: {
          path: "src/cart.js",
          old_string: "{ SAVE10: 10 }",
          new_string: "{ SAVE10: 10, SAVE20: 20 }",
        },
      }),
      toolCalls({ name: "run_tests", args: {} }),
      text("Added SAVE20."),
      // Turn 3: will be interrupted while "thinking".
      { ...text("too late"), delayMs: 20_000 },
      // Turn 4: in-flight when the worker "crashes".
      { ...text("never delivered"), delayMs: 60_000 },
      // Turn 5: after resume.
      text("Resumed after the worker restart; the code is unchanged since the last checkpoint."),
    ];
    const stub = await startStubOpenAI(() => replies.shift() ?? text("(script exhausted)"));
    cleanups.push(stub.close);

    const app = await makeApp();
    cleanups.push(app.close);
    const r = sampleRepo();
    const { owner, workspaceId, projectId, workerId, workerToken } = await seed(app);
    const collab = await invite(app, owner, workspaceId, "collaborator", "bea");
    const first = await bootWorker(app, workerToken, r, stub.url, "gsk_stub_key");

    const created = await owner.req("POST", `/api/projects/${projectId}/sessions`, {
      title: "Add discount codes",
      prompt:
        "Add applyDiscount(cart, code) supporting SAVE10 (10% off, round down); unknown codes throw. Add tests.",
      workerId,
      executionMode: "real",
    });
    expect(created.status).toBe(200);
    const sessionId = created.body.id as string;
    const detail = async (who = owner) => (await who.req("GET", `/api/sessions/${sessionId}`)).body;
    const events = async (who = owner) =>
      (await who.req("GET", `/api/sessions/${sessionId}/events`)).body.events as any[];
    const results = async () => (await events()).filter((e) => e.type === "agent.result");

    // The arbitrary command needs the host; the collaborator cannot approve it.
    const perm = await until(
      async () => (await detail()).permissionRequests.find((p: any) => p.status === "pending"),
      20000,
      "permission",
    );
    expect(perm.toolName).toBe("run_command");
    expect(
      (await collab.req("POST", `/api/permissions/${perm.id}/decision`, { allow: true })).status,
    ).toBe(403);
    expect(
      (await owner.req("POST", `/api/permissions/${perm.id}/decision`, { allow: true })).status,
    ).toBe(200);

    await until(async () => (await results()).length >= 1, 30000, "turn 1");
    const r1 = (await results())[0].payload;
    expect(r1).toMatchObject({
      subtype: "end_turn",
      isError: false,
      provider: "groq",
      lastTestRun: { exitCode: 0 },
    });
    const cs1 = await until(async () => (await detail()).changeSet, 15000, "change set");
    expect(cs1.files.map((f: any) => f.path).sort()).toEqual([
      "src/cart.js",
      "test/discount.test.js",
    ]);
    expect(cs1.executionMode).toBe("real");

    // The collaborator sees the same stream, and the init event names provider + model.
    const collabEvents = await events(collab);
    const init = collabEvents.find((e) => e.type === "agent.init");
    expect(init.payload).toMatchObject({
      provider: "groq",
      model: "openai/gpt-oss-120b",
      harness: "pairloom-llm-harness",
    });
    expect(
      collabEvents.some((e) => e.type === "agent.tool_use" && e.payload.toolName === "run_tests"),
    ).toBe(true);
    expect(JSON.stringify(collabEvents)).not.toContain("gsk_stub_key");

    // Collaborator instruction -> host approval -> agent turn.
    const ins = await collab.req("POST", `/api/sessions/${sessionId}/instructions`, {
      text: "Also support SAVE20",
    });
    expect(ins.body.status).toBe("pending_approval");
    await owner.req("POST", `/api/instructions/${ins.body.id}/decision`, { approve: true });
    await until(async () => (await results()).length >= 2, 30000, "turn 2");
    // "idle" is only announced once the turn's checkpoint is recorded, so a reviewer who
    // sees idle is looking at the final change set, never one about to be superseded.
    await until(async () => (await detail()).session.status === "idle", 15000, "idle turn 2");
    expect((await detail()).changeSet.diff).toContain("SAVE20");

    // Reviewers run the project's tests themselves, independent of the agent's claims.
    expect((await collab.req("POST", `/api/sessions/${sessionId}/checks`)).status).toBe(200);
    const checks = await until(
      async () => (await events(collab)).find((e) => e.type === "checks.completed"),
      30000,
      "checks",
    );
    expect(checks.payload).toMatchObject({ passed: true, exitCode: 0 });
    expect(checks.payload.output).toMatch(/# pass 6/);

    // Cancellation: interrupt a slow turn; it is reported as interrupted, not success.
    await owner.req("POST", `/api/sessions/${sessionId}/instructions`, {
      text: "Think about refactoring",
    });
    await until(async () => (await detail()).session.status === "running", 10000, "running");
    expect((await owner.req("POST", `/api/sessions/${sessionId}/interrupt`)).status).toBe(200);
    await until(async () => (await results()).length >= 3, 10000, "turn 3 ended");
    expect((await results())[2].payload).toMatchObject({ subtype: "interrupted", isError: true });
    await until(
      async () => (await detail()).session.status === "idle",
      10000,
      "idle after interrupt",
    );

    // Worker crash mid-turn: process gone (we abandon it without a clean shutdown).
    await owner.req("POST", `/api/sessions/${sessionId}/instructions`, {
      text: "Update the README",
    });
    await until(async () => (await detail()).session.status === "running", 10000, "running turn 4");
    await first.link.stop(); // socket closes; the in-flight turn is abandoned with the "dead" process
    cleanups.splice(cleanups.indexOf(cleanups.at(-1)!), 1);
    await until(
      async () => (await detail(collab)).session.status === "disconnected",
      10000,
      "disconnected",
    );
    await bootWorker(app, workerToken, r, stub.url, "gsk_stub_key"); // fresh process, nothing live
    await until(
      async () => (await detail()).session.status === "interrupted",
      10000,
      "interrupted",
    );
    expect((await results()).length).toBe(3); // no fabricated result for the lost turn

    // Resume reloads the persisted transcript on the same worker volume.
    expect((await owner.req("POST", `/api/sessions/${sessionId}/resume`)).status).toBe(200);
    await until(async () => (await detail()).session.status === "idle", 15000, "idle after resume");
    const resumedInit = (await events()).filter((e) => e.type === "agent.init").at(-1);
    expect(resumedInit.payload.resumed).toBe(true);
    await owner.req("POST", `/api/sessions/${sessionId}/instructions`, { text: "Status?" });
    await until(async () => (await results()).length >= 4, 15000, "turn after resume");
    const lastRequest = stub.requests.at(-1)!.body.messages;
    expect(JSON.stringify(lastRequest)).toContain("worker restarted");
    expect(JSON.stringify(lastRequest)).toContain("Implemented applyDiscount"); // earlier history survived

    // Review and merge the checked change, once the turn's checkpoint is final (idle).
    await until(async () => (await detail()).session.status === "idle", 15000, "idle to review");
    const cs = (await detail()).changeSet;
    await collab.req("POST", `/api/changesets/${cs.id}/reviews`, {
      decision: "approve",
      body: "tests pass",
    });
    expect((await owner.req("POST", `/api/changesets/${cs.id}/merge`, {})).status).toBe(200);
    const merged = await until(
      async () => {
        const c = (await detail()).changeSet;
        return c?.status === "merged" || c?.status === "merge_failed" ? c : null;
      },
      15000,
      "merge outcome",
    );
    expect(merged.mergeError ?? null).toBeNull();
    expect(merged.status).toBe("merged");
    expect(readFileSync(join(r.repo, "src/cart.js"), "utf8")).toContain("SAVE20: 20");
  }, 120_000);

  it("an invalid provider key is reported as a failed turn, never as success", async () => {
    const stub = await startStubOpenAI(() => error(401, "Invalid API Key", "invalid_api_key"));
    cleanups.push(stub.close);
    const app = await makeApp();
    cleanups.push(app.close);
    const r = sampleRepo();
    const { owner, projectId, workerId, workerToken } = await seed(app);
    await bootWorker(app, workerToken, r, stub.url, "gsk_wrong");
    const created = await owner.req("POST", `/api/projects/${projectId}/sessions`, {
      title: "t",
      prompt: "Add applyDiscount",
      workerId,
      executionMode: "real",
    });
    const sessionId = created.body.id;
    const evs = await until(
      async () => {
        const e = (await owner.req("GET", `/api/sessions/${sessionId}/events`)).body.events;
        return e.some((x: any) => x.type === "agent.result") ? e : null;
      },
      15000,
      "result",
    );
    const result = evs.find((e: any) => e.type === "agent.result").payload;
    expect(result).toMatchObject({ subtype: "error_provider_auth", isError: true });
    expect(evs.find((e: any) => e.type === "agent.error").payload.message).toMatch(
      /rejected the API key/,
    );
    expect(stub.requests).toHaveLength(1);
  }, 60_000);

  it("a worker without a key cannot be asked for a real session", async () => {
    const stub = await startStubOpenAI(() => text("unused"));
    cleanups.push(stub.close);
    const app = await makeApp();
    cleanups.push(app.close);
    const r = sampleRepo();
    const { owner, projectId, workerId, workerToken } = await seed(app);
    await bootWorker(app, workerToken, r, stub.url, null);
    const res = await owner.req("POST", `/api/projects/${projectId}/sessions`, {
      title: "t",
      prompt: "p",
      workerId,
      executionMode: "real",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/GROQ_API_KEY/);
    expect(stub.requests).toHaveLength(0);
  }, 30_000);
});
