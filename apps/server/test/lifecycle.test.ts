import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FakeWorker, invite, makeApp, ORIGIN, seed, tick } from "./helpers.js";

let app: Awaited<ReturnType<typeof makeApp>>;
const workers: FakeWorker[] = [];
beforeEach(async () => {
  app = await makeApp();
});
afterEach(async () => {
  for (const w of workers.splice(0)) await w.close();
  await app.close();
});

async function connect(token: string, live: unknown[] = []) {
  const w = await FakeWorker.connect(app.url, token, live);
  workers.push(w);
  return w;
}

async function startSession() {
  const s = await seed(app);
  const res = await s.owner.req("POST", `/api/projects/${s.projectId}/sessions`, {
    title: "Fix inventory",
    prompt: "Fix the inventory overflow bug",
    workerId: s.workerId,
    executionMode: "simulated",
  });
  expect(res.status).toBe(200);
  return { ...s, sessionId: res.body.id as string };
}

const status = async (owner: { req: Function }, sessionId: string) =>
  (await (owner as any).req("GET", `/api/sessions/${sessionId}`)).body.session.status;

describe("session lifecycle over the worker protocol", () => {
  it("delivers queued commands on connect and records acked instructions", async () => {
    const { owner, sessionId, workerToken } = await startSession();
    expect(await status(owner, sessionId)).toBe("pending");

    const w = await connect(workerToken);
    const start = await w.waitFor((f) => f.t === "command" && f.command.kind === "start");
    expect(start.command).toMatchObject({ executionMode: "simulated", baseBranch: "main" });
    const msg = await w.waitFor((f) => f.t === "command" && f.command.kind === "message");
    expect(msg.command.text).toBe("Fix the inventory overflow bug");

    w.send({ t: "command_ack", id: start.id, ok: true });
    w.send({ t: "command_ack", id: msg.id, ok: true });
    w.send({
      t: "event",
      id: randomUUID(),
      sessionId,
      type: "session.status",
      payload: { status: "running" },
    });
    await tick();
    const detail = (await owner.req("GET", `/api/sessions/${sessionId}`)).body;
    expect(detail.session.status).toBe("running");
    expect(detail.instructions[0].status).toBe("delivered");
    expect(detail.worker.online).toBe(true);
  });

  it("deduplicates resent worker events and keeps seq strictly increasing", async () => {
    const { owner, sessionId, workerToken } = await startSession();
    const w = await connect(workerToken);
    const id = randomUUID();
    for (let i = 0; i < 3; i++) {
      w.send({ t: "event", id, sessionId, type: "agent.text", payload: { text: "hello" } });
    }
    await w.waitFor((f) => f.t === "ack" && f.id === id);
    await tick();
    const events = (await owner.req("GET", `/api/sessions/${sessionId}/events`)).body.events;
    expect(events.filter((e: any) => e.type === "agent.text")).toHaveLength(1);
    const seqs = events.map((e: any) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // Every event is stamped with the execution mode.
    expect(events.every((e: any) => e.executionMode === "simulated")).toBe(true);
  });

  it("marks live sessions disconnected on drop, and restores them if the worker reports them live", async () => {
    const { owner, sessionId, workerToken } = await startSession();
    let w = await connect(workerToken);
    w.send({
      t: "event",
      id: randomUUID(),
      sessionId,
      type: "session.status",
      payload: { status: "idle" },
    });
    await tick();
    await w.close();
    await tick();
    expect(await status(owner, sessionId)).toBe("disconnected");

    w = await connect(workerToken, [{ sessionId, status: "idle", providerSessionId: null }]);
    await tick();
    expect(await status(owner, sessionId)).toBe("idle");
  });

  it("marks sessions interrupted (not stopped, not succeeded) when the worker returns without them", async () => {
    const { owner, sessionId, workerToken, workerId } = await startSession();
    let w = await connect(workerToken);
    w.send({
      t: "event",
      id: randomUUID(),
      sessionId,
      type: "session.status",
      payload: { status: "running" },
    });
    w.send({
      t: "event",
      id: randomUUID(),
      sessionId,
      type: "permission.requested",
      payload: { requestId: "r1", toolName: "Bash", input: { command: "ls" } },
    });
    await tick();
    await w.close();
    await tick();
    w = await connect(workerToken, []);
    await tick();
    const detail = (await owner.req("GET", `/api/sessions/${sessionId}`)).body;
    expect(detail.session.status).toBe("interrupted");
    expect(detail.permissionRequests[0].status).toBe("expired");
    // Undelivered work is failed, not silently dropped.
    expect(app.core.pendingCommands(workerId)).toHaveLength(0);
  });

  it("resends unacked commands after reconnect", async () => {
    const { sessionId, workerToken } = await startSession();
    let w = await connect(workerToken);
    const first = await w.waitFor((f) => f.t === "command" && f.command.kind === "start");
    await w.close(); // never acked
    await tick();
    w = await connect(workerToken);
    const again = await w.waitFor((f) => f.t === "command" && f.command.kind === "start");
    expect(again.id).toBe(first.id);
    expect(again.sessionId).toBe(sessionId);
  });

  it("stop on a live session goes through stopping, and a worker cannot revive a stopped session", async () => {
    const { owner, sessionId, workerToken } = await startSession();
    const w = await connect(workerToken);
    w.send({
      t: "event",
      id: randomUUID(),
      sessionId,
      type: "session.status",
      payload: { status: "idle" },
    });
    await tick();
    expect((await owner.req("POST", `/api/sessions/${sessionId}/stop`)).body.status).toBe(
      "stopping",
    );
    await w.waitFor((f) => f.t === "command" && f.command.kind === "stop");
    w.send({
      t: "event",
      id: randomUUID(),
      sessionId,
      type: "session.status",
      payload: { status: "stopped" },
    });
    await tick();
    expect(await status(owner, sessionId)).toBe("stopped");
    w.send({
      t: "event",
      id: randomUUID(),
      sessionId,
      type: "session.status",
      payload: { status: "running" },
    });
    await tick();
    expect(await status(owner, sessionId)).toBe("stopped");
    // Instructions to a stopped session are refused.
    expect(
      (await owner.req("POST", `/api/sessions/${sessionId}/instructions`, { text: "more" })).status,
    ).toBe(409);
  });

  it("stop on a never-started session ends it directly and cancels queued commands", async () => {
    const { owner, sessionId, workerId } = await startSession();
    expect((await owner.req("POST", `/api/sessions/${sessionId}/stop`)).body.status).toBe(
      "stopped",
    );
    expect(app.core.pendingCommands(workerId)).toHaveLength(0);
  });

  it("a failed start ack fails the session with the worker's reason", async () => {
    const { owner, sessionId, workerToken } = await startSession();
    const w = await connect(workerToken);
    const start = await w.waitFor((f) => f.t === "command" && f.command.kind === "start");
    w.send({ t: "command_ack", id: start.id, ok: false, error: "ANTHROPIC_API_KEY not set" });
    await tick();
    const detail = (await owner.req("GET", `/api/sessions/${sessionId}`)).body.session;
    expect(detail.status).toBe("failed");
    expect(detail.error).toContain("ANTHROPIC_API_KEY");
  });

  it("refuses a real-mode session when the worker reports the real adapter unavailable", async () => {
    const s = await seed(app);
    await connect(s.workerToken);
    const res = await s.owner.req("POST", `/api/projects/${s.projectId}/sessions`, {
      title: "t",
      prompt: "p",
      workerId: s.workerId,
      executionMode: "real",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("adapter_unavailable");
  });

  it("rejects bad worker tokens", async () => {
    const code = await new Promise<number>((resolve) => {
      const s = new WebSocket(app.url.replace("http", "ws") + "/ws/worker", {
        headers: { authorization: "Bearer plw_nope" },
      });
      s.on("close", (c) => resolve(c));
    });
    expect(code).toBe(4001);
  });
});

describe("browser realtime", () => {
  function browser(cookie: string, origin = ORIGIN) {
    const frames: any[] = [];
    const s = new WebSocket(app.url.replace("http", "ws") + "/ws", { headers: { cookie, origin } });
    s.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    const opened = new Promise<void>((res) => s.once("open", () => res()));
    const closed = new Promise<number>((res) => s.once("close", (c) => res(c)));
    return { s, frames, opened, closed };
  }

  it("replays history after afterSeq and streams new events to both members", async () => {
    const { owner, workspaceId, sessionId, workerToken } = await startSession();
    const collab = await invite(app, owner, workspaceId, "collaborator");
    const w = await connect(workerToken);

    const a = browser(owner.cookie);
    const b = browser(collab.cookie);
    await Promise.all([a.opened, b.opened]);
    a.s.send(JSON.stringify({ t: "subscribe_session", sessionId, afterSeq: 0 }));
    b.s.send(JSON.stringify({ t: "subscribe_session", sessionId, afterSeq: 2 }));
    await tick(100);
    const replayA = a.frames.filter((f) => f.t === "event").map((f) => f.event.seq);
    const replayB = b.frames.filter((f) => f.t === "event").map((f) => f.event.seq);
    expect(replayA[0]).toBe(1);
    expect(replayB.every((s: number) => s > 2)).toBe(true);

    w.send({
      t: "event",
      id: randomUUID(),
      sessionId,
      type: "agent.text",
      payload: { text: "working" },
    });
    await tick(100);
    for (const c of [a, b]) {
      expect(c.frames.some((f) => f.t === "event" && f.event.payload.text === "working")).toBe(
        true,
      );
    }
    a.s.close();
    b.s.close();
  });

  it("refuses subscriptions from non-members and stops streaming to removed members", async () => {
    const { owner, workspaceId, sessionId, workerToken } = await startSession();
    const collab = await invite(app, owner, workspaceId, "collaborator");
    const outsider = await (await import("./helpers.js")).signup(app, "eve");
    const w = await connect(workerToken);

    const o = browser(outsider.cookie);
    const c = browser(collab.cookie);
    await Promise.all([o.opened, c.opened]);
    o.s.send(JSON.stringify({ t: "subscribe_session", sessionId, afterSeq: 0 }));
    c.s.send(JSON.stringify({ t: "subscribe_session", sessionId, afterSeq: 0 }));
    await tick(100);
    expect(o.frames.some((f) => f.t === "error")).toBe(true);
    expect(o.frames.some((f) => f.t === "event")).toBe(false);

    await owner.req("DELETE", `/api/workspaces/${workspaceId}/members/${collab.userId}`);
    const before = c.frames.length;
    w.send({
      t: "event",
      id: randomUUID(),
      sessionId,
      type: "agent.text",
      payload: { text: "secret" },
    });
    await tick(100);
    expect(c.frames.slice(before).some((f) => f.t === "event")).toBe(false);
    o.s.close();
    c.s.close();
  });

  it("closes sockets without a valid cookie or from a foreign origin", async () => {
    const { owner } = await startSession();
    expect(await browser("pl_session=bogus").closed).toBe(4001);
    expect(await browser(owner.cookie, "https://evil.example").closed).toBe(4003);
  });
});
