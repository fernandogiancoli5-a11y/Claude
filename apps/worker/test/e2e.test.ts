import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invite, makeApp, seed } from "../../server/test/helpers.js";
import { ClaudeSdkAdapter } from "../src/adapters/claudeSdk.js";
import { SimulatedAdapter } from "../src/adapters/simulated.js";
import { Workspace } from "../src/git.js";
import { ServerLink } from "../src/link.js";
import { SessionManager } from "../src/sessions.js";
import { isolateModelEnv, makeRepo, until, workerConfig } from "./fixtures.js";
import { startStubAnthropic } from "./stubAnthropic.js";

/**
 * Definition of success, automated: two authorized users join one project,
 * observe the same session activity, exchange instructions under controlled
 * permissions, and review + merge an actual code change produced in an
 * isolated git worktree.
 *
 * "simulated" uses the scripted adapter. "real-sdk" uses the real Claude Agent
 * SDK and Claude Code CLI with only the model endpoint replaced by a local
 * protocol stub — so the agent's "decisions" are canned, but every hop
 * (SDK subprocess, permission callback, tool execution, git, server, review)
 * is the production code path.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function bootWorker(
  app: Awaited<ReturnType<typeof makeApp>>,
  token: string,
  repo: ReturnType<typeof makeRepo>,
) {
  const config = workerConfig(repo, { serverUrl: app.url, token });
  const adapters = { real: new ClaudeSdkAdapter(config), simulated: new SimulatedAdapter(0) };
  let manager!: SessionManager;
  const link = new ServerLink(
    app.url,
    token,
    config.stateDir,
    () => ({
      workerVersion: "test",
      adapters: [adapters.real.info(), adapters.simulated.info()],
      liveSessions: manager.liveReports(),
    }),
    (f) => manager.handle(f.sessionId, f.command),
    () => {},
  );
  manager = new SessionManager(link, new Workspace(repo.repo, repo.worktrees), adapters);
  link.start();
  cleanups.push(async () => {
    await manager.stopAll();
    await link.stop();
  });
  await until(() => link.connected, 5000, "worker connected");
  return { link, manager };
}

for (const mode of ["simulated", "real-sdk"] as const) {
  describe(`two-person session (${mode})`, () => {
    it("owner and collaborator collaborate, approve, review and merge a real change", async () => {
      let stubUrl: string | null = null;
      if (mode === "real-sdk") {
        const stub = await startStubAnthropic({
          toolCall: {
            name: "Bash",
            input: {
              command: "echo 'export const MAX_ITEMS = 26;' > inventory.ts",
              description: "write file",
            },
          },
        });
        cleanups.push(stub.close);
        stubUrl = stub.url;
      }
      isolateModelEnv(stubUrl);

      const app = await makeApp();
      cleanups.push(app.close);
      const repo = makeRepo();
      const { owner, workspaceId, projectId, workerId, workerToken } = await seed(app);
      const collab = await invite(app, owner, workspaceId, "collaborator", "bea");
      await bootWorker(app, workerToken, repo);

      const project = (await collab.req("GET", `/api/projects/${projectId}`)).body;
      expect(project.workers.find((w: any) => w.id === workerId).online).toBe(true);

      const executionMode = mode === "simulated" ? "simulated" : "real";
      const created = await owner.req("POST", `/api/projects/${projectId}/sessions`, {
        title: "Cap inventory size",
        prompt: "Add a MAX_ITEMS constant for the inventory",
        workerId,
        executionMode,
        permissionPolicy: "ask_every_time",
      });
      expect(created.status).toBe(200);
      const sessionId = created.body.id as string;
      const detail = async (who = owner) =>
        (await who.req("GET", `/api/sessions/${sessionId}`)).body;

      // The agent asks for a tool; the collaborator cannot approve it, the owner can.
      const pendingPermission = () =>
        until(
          async () => (await detail()).permissionRequests.find((p: any) => p.status === "pending"),
          60000,
          "permission request",
        );
      const pending = await pendingPermission();
      expect(pending.toolName).toBe("Bash");
      expect(
        (await collab.req("POST", `/api/permissions/${pending.id}/decision`, { allow: true }))
          .status,
      ).toBe(403);
      expect(
        (await owner.req("POST", `/api/permissions/${pending.id}/decision`, { allow: true }))
          .status,
      ).toBe(200);

      // First turn ends and produces a change set with a real diff.
      const cs = await until(async () => (await detail()).changeSet, 60000, "change set");
      expect(cs.files.length).toBeGreaterThan(0);
      expect(cs.executionMode).toBe(executionMode);
      if (mode === "real-sdk") {
        expect(cs.files.map((f: any) => f.path)).toContain("inventory.ts");
        expect(cs.diff).toContain("+export const MAX_ITEMS = 26;");
      } else {
        expect(cs.diff).toContain("Written by the Pairloom simulator");
      }

      // Collaborator's instruction requires the host's approval before it reaches the agent.
      const ins = await collab.req("POST", `/api/sessions/${sessionId}/instructions`, {
        text: "Please also document the constant",
      });
      expect(ins.body.status).toBe("pending_approval");
      expect(
        (await owner.req("POST", `/api/instructions/${ins.body.id}/decision`, { approve: true }))
          .status,
      ).toBe(200);
      await until(
        async () =>
          (await detail()).instructions.some(
            (i: any) => i.id === ins.body.id && i.status === "delivered",
          ),
        30000,
        "instruction delivered",
      );

      if (mode === "simulated") {
        // The simulator asks again on the second turn; approve so the turn can finish.
        const p2 = await pendingPermission();
        await owner.req("POST", `/api/permissions/${p2.id}/decision`, { allow: true });
      }
      await until(
        async () => {
          const events = (await owner.req("GET", `/api/sessions/${sessionId}/events`)).body.events;
          return events.filter((e: any) => e.type === "agent.result").length >= 2;
        },
        60000,
        "second turn result",
      );

      if (mode === "simulated") {
        // The simulator edits the notes file every turn, so a second change set follows.
        await until(
          async () => {
            const events = (await owner.req("GET", `/api/sessions/${sessionId}/events`)).body
              .events;
            return events.filter((e: any) => e.type === "changes.updated").length >= 2;
          },
          30000,
          "second change set",
        );
      }

      // Both members observe the same activity log.
      const ownerEvents = (await owner.req("GET", `/api/sessions/${sessionId}/events`)).body.events;
      const collabEvents = (await collab.req("GET", `/api/sessions/${sessionId}/events`)).body
        .events;
      expect(collabEvents.map((e: any) => e.seq)).toEqual(
        ownerEvents.map((e: any) => e.seq).slice(0, collabEvents.length),
      );
      const types = new Set(ownerEvents.map((e: any) => e.type));
      for (const t of [
        "session.created",
        "agent.init",
        "permission.requested",
        "permission.decided",
        "agent.result",
        "changes.updated",
        "instruction.approved",
        "instruction.delivered",
      ]) {
        expect(types, t).toContain(t);
      }
      expect(ownerEvents.every((e: any) => e.executionMode === executionMode)).toBe(true);
      const init = ownerEvents.find((e: any) => e.type === "agent.init");
      if (mode === "real-sdk") {
        expect(init.payload.providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(init.payload.simulated).toBeUndefined();
      } else {
        expect(init.payload.simulated).toBe(true);
        const texts = ownerEvents.filter((e: any) => e.type === "agent.text");
        expect(texts.every((e: any) => e.payload.text.includes("SIMULATED"))).toBe(true);
      }

      // Review then merge the latest change set, once the turn's checkpoint is final (idle).
      await until(async () => (await detail()).session.status === "idle", 15000, "idle to review");
      const latest = (await detail()).changeSet;
      expect(
        (await owner.req("POST", `/api/changesets/${latest.id}/merge`, { confirmSimulated: true }))
          .status,
      ).toBe(409);
      expect(
        (
          await collab.req("POST", `/api/changesets/${latest.id}/reviews`, {
            decision: "approve",
            body: "LGTM",
          })
        ).status,
      ).toBe(200);
      const merge = await owner.req("POST", `/api/changesets/${latest.id}/merge`, {
        confirmSimulated: true,
      });
      expect(merge.status).toBe(200);
      const merged = await until(
        async () => {
          const c = (await detail()).changeSet;
          return c?.status === "merged"
            ? c
            : c?.status === "merge_failed"
              ? Promise.reject(new Error(c.mergeError))
              : undefined;
        },
        30000,
        "merge",
      );
      expect(merged.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
      const mergedFile = mode === "real-sdk" ? "inventory.ts" : ".pairloom/simulated-notes.md";
      expect(existsSync(join(repo.repo, mergedFile))).toBe(true);
      if (mode === "real-sdk") {
        expect(readFileSync(join(repo.repo, "inventory.ts"), "utf8")).toContain("MAX_ITEMS = 26");
      }
      expect(repo.g("log", "--oneline", "-1")).toContain("approved by owner");

      // Stop is explicit and observed by both users.
      await owner.req("POST", `/api/sessions/${sessionId}/stop`);
      await until(
        async () => (await detail(collab)).session.status === "stopped",
        30000,
        "stopped",
      );
    }, 180000);
  });
}

describe("worker restart", () => {
  it("reports the session interrupted (not stopped) and resume restarts it in the same worktree", async () => {
    isolateModelEnv(null);
    const app = await makeApp();
    cleanups.push(app.close);
    const repo = makeRepo();
    const { owner, projectId, workerId, workerToken } = await seed(app);
    const first = await bootWorker(app, workerToken, repo);
    const created = await owner.req("POST", `/api/projects/${projectId}/sessions`, {
      title: "t",
      prompt: "hello",
      workerId,
      executionMode: "simulated",
    });
    const sessionId = created.body.id as string;
    const status = async () =>
      (await owner.req("GET", `/api/sessions/${sessionId}`)).body.session.status;
    await until(async () => (await status()) === "awaiting_approval", 15000, "awaiting approval");

    // Simulate a worker crash: the process (and live agent) is gone.
    await first.link.stop();
    cleanups.pop();
    await until(async () => (await status()) === "disconnected", 5000, "disconnected");

    await bootWorker(app, workerToken, repo); // fresh process, nothing live
    await until(async () => (await status()) === "interrupted", 5000, "interrupted");
    const perms = (await owner.req("GET", `/api/sessions/${sessionId}`)).body.permissionRequests;
    expect(perms.every((p: any) => p.status === "expired")).toBe(true);

    expect((await owner.req("POST", `/api/sessions/${sessionId}/resume`)).status).toBe(200);
    await until(async () => (await status()) === "idle", 15000, "idle after resume");
  }, 60000);
});
