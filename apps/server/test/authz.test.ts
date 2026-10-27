import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invite, makeApp, ORIGIN, seed, signup } from "./helpers.js";

let app: Awaited<ReturnType<typeof makeApp>>;
beforeEach(async () => {
  app = await makeApp();
});
afterEach(async () => {
  await app.close();
});

async function newSession(
  owner: Awaited<ReturnType<typeof signup>>,
  projectId: string,
  workerId: string,
) {
  const res = await owner.req("POST", `/api/projects/${projectId}/sessions`, {
    title: "Fix bug",
    prompt: "Fix the inventory bug",
    workerId,
    executionMode: "simulated",
  });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

describe("authentication", () => {
  it("rejects unauthenticated access to protected routes", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/api/workspaces" });
    expect(res.statusCode).toBe(401);
  });

  it("logs in with the right password only", async () => {
    const { email } = await signup(app, "alice");
    const login = (password: string) =>
      app.fastify.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect((await login("wrong password!!")).statusCode).toBe(401);
    expect((await login("correct horse battery")).statusCode).toBe(200);
  });

  it("rejects expired auth sessions", async () => {
    const u = await signup(app);
    app.db.prepare("UPDATE auth_sessions SET expires_at = ?").run(new Date(0).toISOString());
    expect((await u.req("GET", "/api/me")).status).toBe(401);
  });

  it("rejects mutating requests from a foreign Origin", async () => {
    const u = await signup(app);
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: u.cookie, origin: "https://evil.example" },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(403);
    const ok = await app.fastify.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: u.cookie, origin: ORIGIN },
      payload: { name: "x" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("workspace membership", () => {
  it("hides workspaces, projects and sessions from non-members", async () => {
    const { owner, workspaceId, projectId, workerId } = await seed(app);
    const sessionId = await newSession(owner, projectId, workerId);
    const outsider = await signup(app, "mallory");
    for (const url of [
      `/api/workspaces/${workspaceId}`,
      `/api/projects/${projectId}`,
      `/api/sessions/${sessionId}`,
      `/api/sessions/${sessionId}/events`,
    ]) {
      expect((await outsider.req("GET", url)).status).toBe(404);
    }
    expect(
      (await outsider.req("POST", `/api/sessions/${sessionId}/instructions`, { text: "hi" }))
        .status,
    ).toBe(404);
    expect((await outsider.req("POST", `/api/sessions/${sessionId}/stop`)).status).toBe(404);
  });

  it("only owners can invite, create projects, register workers and start sessions", async () => {
    const { owner, workspaceId, projectId, workerId } = await seed(app);
    const collab = await invite(app, owner, workspaceId, "collaborator");
    expect(
      (await collab.req("POST", `/api/workspaces/${workspaceId}/invitations`, { role: "owner" }))
        .status,
    ).toBe(403);
    expect(
      (await collab.req("POST", `/api/workspaces/${workspaceId}/projects`, { name: "x" })).status,
    ).toBe(403);
    expect(
      (await collab.req("POST", `/api/projects/${projectId}/workers`, { name: "x" })).status,
    ).toBe(403);
    const res = await collab.req("POST", `/api/projects/${projectId}/sessions`, {
      title: "t",
      prompt: "p",
      workerId,
      executionMode: "simulated",
    });
    expect(res.status).toBe(403);
  });

  it("invitations are single-use, revocable and expire", async () => {
    const { owner, workspaceId } = await seed(app);
    const inv = (
      await owner.req("POST", `/api/workspaces/${workspaceId}/invitations`, { role: "viewer" })
    ).body;
    const a = await signup(app);
    const b = await signup(app);
    expect((await a.req("POST", `/api/invitations/${inv.token}/accept`)).status).toBe(200);
    expect((await b.req("POST", `/api/invitations/${inv.token}/accept`)).status).toBe(404);

    const inv2 = (await owner.req("POST", `/api/workspaces/${workspaceId}/invitations`, {})).body;
    await owner.req("DELETE", `/api/invitations/${inv2.id}`);
    expect((await b.req("POST", `/api/invitations/${inv2.token}/accept`)).status).toBe(404);

    const inv3 = (await owner.req("POST", `/api/workspaces/${workspaceId}/invitations`, {})).body;
    app.db
      .prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .run(new Date(0).toISOString(), inv3.id);
    expect((await b.req("POST", `/api/invitations/${inv3.token}/accept`)).status).toBe(410);
    expect((await b.req("GET", `/api/workspaces/${workspaceId}`)).status).toBe(404);
  });

  it("removed members lose access immediately", async () => {
    const { owner, workspaceId, projectId } = await seed(app);
    const collab = await invite(app, owner, workspaceId, "collaborator");
    expect((await collab.req("GET", `/api/projects/${projectId}`)).status).toBe(200);
    expect(
      (await owner.req("DELETE", `/api/workspaces/${workspaceId}/members/${collab.userId}`)).status,
    ).toBe(200);
    expect((await collab.req("GET", `/api/projects/${projectId}`)).status).toBe(404);
  });

  it("cannot remove the last owner", async () => {
    const { owner, workspaceId } = await seed(app);
    const res = await owner.req("DELETE", `/api/workspaces/${workspaceId}/members/${owner.userId}`);
    expect(res.status).toBe(409);
  });
});

describe("instructions and approvals", () => {
  it("viewers cannot instruct; collaborators need owner approval; owners are auto-approved", async () => {
    const { owner, workspaceId, projectId, workerId } = await seed(app);
    const sessionId = await newSession(owner, projectId, workerId);
    const viewer = await invite(app, owner, workspaceId, "viewer");
    const collab = await invite(app, owner, workspaceId, "collaborator");

    expect(
      (await viewer.req("POST", `/api/sessions/${sessionId}/instructions`, { text: "do x" }))
        .status,
    ).toBe(403);

    const c = await collab.req("POST", `/api/sessions/${sessionId}/instructions`, {
      text: "also add tests",
    });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("pending_approval");

    // No message command is queued until approved.
    const messageCommands = () =>
      app.core.pendingCommands(workerId).filter((cmd) => cmd.command.kind === "message");
    expect(messageCommands()).toHaveLength(1); // the owner's initial prompt only

    expect(
      (await collab.req("POST", `/api/instructions/${c.body.id}/decision`, { approve: true }))
        .status,
    ).toBe(403);
    expect(
      (await viewer.req("POST", `/api/instructions/${c.body.id}/decision`, { approve: true }))
        .status,
    ).toBe(403);
    expect(
      (await owner.req("POST", `/api/instructions/${c.body.id}/decision`, { approve: true }))
        .status,
    ).toBe(200);
    expect(messageCommands()).toHaveLength(2);
    // Deciding twice is rejected.
    expect(
      (await owner.req("POST", `/api/instructions/${c.body.id}/decision`, { approve: false }))
        .status,
    ).toBe(409);

    const o = await owner.req("POST", `/api/sessions/${sessionId}/instructions`, {
      text: "ship it",
    });
    expect(o.body.status).toBe("approved");
  });

  it("validates instruction length and emptiness", async () => {
    const { owner, projectId, workerId } = await seed(app);
    const sessionId = await newSession(owner, projectId, workerId);
    expect(
      (await owner.req("POST", `/api/sessions/${sessionId}/instructions`, { text: "   " })).status,
    ).toBe(400);
    const huge = "x".repeat(8001);
    expect(
      (await owner.req("POST", `/api/sessions/${sessionId}/instructions`, { text: huge })).status,
    ).toBe(413);
  });

  it("rate-limits instruction floods", async () => {
    const { owner, projectId, workerId } = await seed(app);
    const sessionId = await newSession(owner, projectId, workerId);
    let last = 200;
    for (let i = 0; i < 25; i++) {
      last = (await owner.req("POST", `/api/sessions/${sessionId}/instructions`, { text: `n${i}` }))
        .status;
    }
    expect(last).toBe(429);
  });

  it("only owners decide tool permissions, and only once", async () => {
    const { owner, workspaceId, projectId, workerId } = await seed(app);
    const sessionId = await newSession(owner, projectId, workerId);
    const collab = await invite(app, owner, workspaceId, "collaborator");
    app.core.ingestWorkerEvent(workerId, {
      t: "event",
      id: crypto.randomUUID(),
      sessionId,
      type: "permission.requested",
      payload: { requestId: "req-1", toolName: "Bash", input: { command: "npm test" } },
    });
    const perm = (await owner.req("GET", `/api/sessions/${sessionId}`)).body.permissionRequests[0];
    expect(perm.status).toBe("pending");
    expect(
      (await collab.req("POST", `/api/permissions/${perm.id}/decision`, { allow: true })).status,
    ).toBe(403);
    expect(
      (await owner.req("POST", `/api/permissions/${perm.id}/decision`, { allow: true })).status,
    ).toBe(200);
    expect(
      (await owner.req("POST", `/api/permissions/${perm.id}/decision`, { allow: false })).status,
    ).toBe(409);
    const decision = app.core
      .pendingCommands(workerId)
      .find((c) => c.command.kind === "permission_decision");
    expect(decision?.command).toMatchObject({ requestId: "req-1", behavior: "allow" });
  });
});

describe("worker isolation", () => {
  it("a worker cannot write events into another project's session", async () => {
    const a = await seed(app);
    const b = await seed(app);
    const sessionId = await newSession(a.owner, a.projectId, a.workerId);
    expect(() =>
      app.core.ingestWorkerEvent(b.workerId, {
        t: "event",
        id: crypto.randomUUID(),
        sessionId,
        type: "agent.text",
        payload: { text: "spoofed" },
      }),
    ).toThrow(/not assigned/);
  });

  it("workers cannot author instruction or review events", async () => {
    const { owner, projectId, workerId } = await seed(app);
    const sessionId = await newSession(owner, projectId, workerId);
    expect(() =>
      app.core.ingestWorkerEvent(workerId, {
        t: "event",
        id: crypto.randomUUID(),
        sessionId,
        type: "instruction.approved",
        payload: {},
      }),
    ).toThrow(/not allowed/);
  });

  it("revoked worker tokens no longer authenticate", async () => {
    const { owner, workerId, workerToken } = await seed(app);
    expect(app.core.authenticateWorker(workerToken)).not.toBeNull();
    await owner.req("DELETE", `/api/workers/${workerId}`);
    expect(app.core.authenticateWorker(workerToken)).toBeNull();
  });

  it("worker tokens are never returned after creation", async () => {
    const { owner, projectId, workerToken } = await seed(app);
    const project = await owner.req("GET", `/api/projects/${projectId}`);
    expect(JSON.stringify(project.body)).not.toContain(workerToken);
    const row = app.db.prepare("SELECT token_hash FROM workers").get() as { token_hash: string };
    expect(row.token_hash).not.toContain(workerToken);
  });
});

describe("review and merge gate", () => {
  async function withChangeSet() {
    const s = await seed(app);
    const sessionId = await newSession(s.owner, s.projectId, s.workerId);
    app.core.ingestWorkerEvent(s.workerId, {
      t: "event",
      id: crypto.randomUUID(),
      sessionId,
      type: "changes.updated",
      payload: {
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        branchName: "pairloom/x",
        files: [{ path: "src/a.ts", insertions: 1, deletions: 0 }],
        diff: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
        diffTruncated: false,
      },
    });
    const cs = (await s.owner.req("GET", `/api/sessions/${sessionId}`)).body.changeSet;
    return { ...s, sessionId, cs };
  }

  it("requires an approving review and owner role, and confirmation for simulated changes", async () => {
    const { owner, workspaceId, cs, workerId } = await withChangeSet();
    const collab = await invite(app, owner, workspaceId, "collaborator");
    const viewer = await invite(app, owner, workspaceId, "viewer");

    expect(
      (await owner.req("POST", `/api/changesets/${cs.id}/merge`, { confirmSimulated: true }))
        .status,
    ).toBe(409);
    expect(
      (await viewer.req("POST", `/api/changesets/${cs.id}/reviews`, { decision: "approve" }))
        .status,
    ).toBe(403);
    expect(
      (
        await collab.req("POST", `/api/changesets/${cs.id}/reviews`, {
          decision: "approve",
          body: "lgtm",
        })
      ).status,
    ).toBe(200);
    expect(
      (await collab.req("POST", `/api/changesets/${cs.id}/merge`, { confirmSimulated: true }))
        .status,
    ).toBe(403);
    const unconfirmed = await owner.req("POST", `/api/changesets/${cs.id}/merge`, {});
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.code).toBe("confirm_simulated");
    expect(
      (await owner.req("POST", `/api/changesets/${cs.id}/merge`, { confirmSimulated: true }))
        .status,
    ).toBe(200);
    const merge = app.core.pendingCommands(workerId).find((c) => c.command.kind === "merge");
    expect(merge?.command).toMatchObject({
      changeSetId: cs.id,
      expectedHeadCommit: "b".repeat(40),
    });
    // Not mergeable twice while merging.
    expect(
      (await owner.req("POST", `/api/changesets/${cs.id}/merge`, { confirmSimulated: true }))
        .status,
    ).toBe(409);
  });

  it("a later request-changes review from the same reviewer withdraws approval", async () => {
    const { owner, workspaceId, cs } = await withChangeSet();
    const collab = await invite(app, owner, workspaceId, "collaborator");
    await collab.req("POST", `/api/changesets/${cs.id}/reviews`, { decision: "approve" });
    await new Promise((r) => setTimeout(r, 5));
    await collab.req("POST", `/api/changesets/${cs.id}/reviews`, {
      decision: "request_changes",
      body: "wait",
    });
    expect(
      (await owner.req("POST", `/api/changesets/${cs.id}/merge`, { confirmSimulated: true }))
        .status,
    ).toBe(409);
  });
});
