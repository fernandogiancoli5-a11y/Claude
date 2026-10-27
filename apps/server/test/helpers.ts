process.env.NODE_ENV = "test";

import { WebSocket } from "ws";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";

export const ORIGIN = "http://localhost:5173";

export async function makeApp(): Promise<App & { url: string; close: () => Promise<void> }> {
  const config = { ...loadConfig({}), databasePath: ":memory:", allowedOrigins: [ORIGIN] };
  const app = await buildApp(config, openDb(":memory:"));
  await app.fastify.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.fastify.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { ...app, url: `http://127.0.0.1:${port}`, close: () => app.fastify.close() };
}

export interface Client {
  email: string;
  cookie: string;
  userId: string;
  req: (method: string, url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
}

let counter = 0;
export async function signup(app: App, name = "user"): Promise<Client> {
  const email = `${name}-${++counter}@example.com`;
  const res = await app.fastify.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "correct horse battery", displayName: name },
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  const cookie = raw.split(";")[0]!;
  const userId = res.json().user.id as string;
  return {
    email,
    cookie,
    userId,
    req: async (method, url, payload) => {
      const r = await app.fastify.inject({
        method: method as "GET",
        url,
        headers: { cookie },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });
      return { status: r.statusCode, body: r.body ? safeJson(r.body) : null };
    },
  };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Owner with a workspace, project and registered worker. */
export async function seed(app: App) {
  const owner = await signup(app, "owner");
  const ws = (await owner.req("POST", "/api/workspaces", { name: "Rogue team" })).body;
  const project = (
    await owner.req("POST", `/api/workspaces/${ws.id}/projects`, {
      name: "Rogue",
      defaultBranch: "main",
    })
  ).body;
  const worker = (
    await owner.req("POST", `/api/projects/${project.id}/workers`, { name: "laptop" })
  ).body;
  return {
    owner,
    workspaceId: ws.id as string,
    projectId: project.id as string,
    workerId: worker.worker.id as string,
    workerToken: worker.token as string,
  };
}

export async function invite(
  app: App,
  owner: Client,
  workspaceId: string,
  role: string,
  who?: string,
) {
  const inv = (await owner.req("POST", `/api/workspaces/${workspaceId}/invitations`, { role }))
    .body;
  const member = await signup(app, who);
  const accepted = await member.req("POST", `/api/invitations/${inv.token}/accept`);
  if (accepted.status !== 200) throw new Error(`accept failed ${JSON.stringify(accepted.body)}`);
  return member;
}

/** Minimal scripted worker socket for protocol tests. */
export class FakeWorker {
  socket!: WebSocket;
  frames: any[] = [];
  private waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];

  static async connect(url: string, token: string, live: unknown[] = [], adapters?: unknown[]) {
    const w = new FakeWorker();
    w.socket = new WebSocket(url.replace("http", "ws") + "/ws/worker", {
      headers: { authorization: `Bearer ${token}` },
    });
    w.socket.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      w.frames.push(f);
      w.waiters = w.waiters.filter((x) => (x.pred(f) ? (x.resolve(f), false) : true));
    });
    await new Promise<void>((res, rej) => {
      w.socket.once("open", () => res());
      w.socket.once("error", rej);
    });
    w.send({
      t: "hello",
      protocol: 1,
      workerVersion: "test",
      adapters: adapters ?? [
        { kind: "claude-agent-sdk", available: false, detail: "no key in test" },
        { kind: "simulated", available: true, detail: "scripted" },
      ],
      liveSessions: live,
    });
    await w.waitFor((f) => f.t === "welcome");
    return w;
  }

  send(frame: unknown) {
    this.socket.send(JSON.stringify(frame));
  }

  waitFor(pred: (f: any) => boolean, timeoutMs = 3000): Promise<any> {
    const existing = this.frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  commands(kind?: string) {
    return this.frames.filter((f) => f.t === "command" && (!kind || f.command.kind === kind));
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((res) => {
      this.socket.once("close", () => res());
      this.socket.close();
    });
  }
}

export const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
