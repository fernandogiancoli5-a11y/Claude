import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { ExecutionMode, LIMITS, PermissionPolicy, Role } from "@pairloom/shared";
import type { ServerConfig } from "./config.js";
import { AuthService, SESSION_COOKIE } from "./auth.js";
import { Core, HttpError } from "./core.js";
import { type Db, openDb } from "./db.js";
import { Hub } from "./hub.js";

export interface App {
  fastify: FastifyInstance;
  core: Core;
  hub: Hub;
  auth: AuthService;
  db: Db;
}

const Email = z.string().trim().toLowerCase().email().max(254);
const Name = z.string().trim().min(1).max(100);
const BranchName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._\/-]+$/, "Invalid branch name")
  .refine((b) => !b.includes("..") && !b.startsWith("-"), "Invalid branch name");

export async function buildApp(
  config: ServerConfig,
  db: Db = openDb(config.databasePath),
): Promise<App> {
  const fastify = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === "true",
  });
  const core = new Core(db);
  const hub = new Hub(core, config.heartbeatMs);
  core.notifier = hub;
  const auth = new AuthService(db, config);
  core.reconcileOnStartup();

  await fastify.register(cookie);
  await fastify.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.message, code: err.code });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "Invalid request", issues: err.issues.slice(0, 5) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    fastify.log.error(err);
    return reply.status(500).send({ error: "Internal error" });
  });

  // CSRF defence in depth: SameSite=Lax cookies + JSON-only bodies + Origin allowlist.
  const originAllowed = (origin: string | undefined) =>
    !origin || config.allowedOrigins.includes(origin);
  fastify.addHook("onRequest", async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req.headers.origin)) {
      throw new HttpError(403, "Origin not allowed");
    }
  });

  const user = (req: FastifyRequest) => auth.requireUser(req);
  const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> =>
    schema.parse(req.body ?? {});
  const param = (req: FastifyRequest, key: string) =>
    z
      .string()
      .max(64)
      .parse((req.params as Record<string, unknown>)[key]);

  // ------------------------------------------------------------- auth

  fastify.post("/api/auth/signup", async (req, reply) => {
    const input = body(
      z.object({
        email: Email,
        password: z.string().min(10).max(200),
        displayName: Name,
        inviteToken: z.string().max(200).optional(),
      }),
      req,
    );
    if (!config.openSignup && !(input.inviteToken && core.isInvitationUsable(input.inviteToken))) {
      throw new HttpError(403, "Signup requires a valid invitation");
    }
    const u = await auth.signup(input.email, input.password, input.displayName);
    const s = auth.createSession(u.id);
    auth.setCookie(reply, s.token, s.expiresAt);
    let joined: { workspaceId: string } | null = null;
    if (input.inviteToken) joined = core.acceptInvitation(u.id, input.inviteToken);
    return { user: { id: u.id, email: u.email, displayName: u.display_name }, joined };
  });

  fastify.post("/api/auth/login", async (req, reply) => {
    const input = body(z.object({ email: Email, password: z.string().max(200) }), req);
    const u = await auth.login(input.email, input.password);
    const s = auth.createSession(u.id);
    auth.setCookie(reply, s.token, s.expiresAt);
    return { user: { id: u.id, email: u.email, displayName: u.display_name } };
  });

  fastify.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) auth.revoke(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  fastify.get("/api/me", async (req) => {
    const u = user(req);
    return { user: { id: u.id, email: u.email, displayName: u.display_name } };
  });

  // -------------------------------------------------------- workspaces

  fastify.get("/api/workspaces", async (req) => ({
    workspaces: core.listWorkspaces(user(req).id),
  }));
  fastify.get("/api/dashboard", async (req) => core.getDashboard(user(req).id));


  fastify.post("/api/workspaces", async (req) => {
    const { name } = body(z.object({ name: Name }), req);
    return core.createWorkspace(user(req).id, name);
  });

  fastify.get("/api/workspaces/:id", async (req) =>
    core.getWorkspace(user(req).id, param(req, "id")),
  );

  fastify.post("/api/workspaces/:id/invitations", async (req) => {
    const { role } = body(z.object({ role: Role.default("collaborator") }), req);
    const inv = core.createInvitation(user(req).id, param(req, "id"), role, config.inviteTtlHours);
    return { ...inv, inviteUrl: `${config.publicOrigin}/invite/${inv.token}` };
  });

  fastify.delete("/api/invitations/:id", async (req) => {
    core.revokeInvitation(user(req).id, param(req, "id"));
    return { ok: true };
  });

  fastify.get("/api/invitations/:token", async (req) =>
    core.previewInvitation(
      z
        .string()
        .max(200)
        .parse((req.params as { token: string }).token),
    ),
  );

  fastify.post("/api/invitations/:token/accept", async (req) =>
    core.acceptInvitation(
      user(req).id,
      z
        .string()
        .max(200)
        .parse((req.params as { token: string }).token),
    ),
  );

  fastify.delete("/api/workspaces/:id/members/:userId", async (req) => {
    core.removeMember(user(req).id, param(req, "id"), param(req, "userId"));
    return { ok: true };
  });

  // ---------------------------------------------------------- projects

  fastify.post("/api/workspaces/:id/projects", async (req) => {
    const input = body(
      z.object({
        name: Name,
        repoUrl: z.string().trim().max(500).nullish(),
        defaultBranch: BranchName.default("main"),
      }),
      req,
    );
    return core.createProject(user(req).id, param(req, "id"), input);
  });

  fastify.get("/api/projects/:id", async (req) => core.getProject(user(req).id, param(req, "id")));

  fastify.post("/api/projects/:id/workers", async (req) => {
    const input = body(
      z.object({ name: Name, kind: z.enum(["local", "cloud"]).default("local") }),
      req,
    );
    return core.createWorker(user(req).id, param(req, "id"), input);
  });

  fastify.delete("/api/workers/:id", async (req) =>
    core.revokeWorker(user(req).id, param(req, "id")),
  );

  // ---------------------------------------------------------- sessions

  fastify.post("/api/projects/:id/sessions", async (req) => {
    const input = body(
      z.object({
        title: z.string().trim().min(1).max(LIMITS.titleMaxChars),
        prompt: z.string().trim().min(1).max(LIMITS.instructionMaxChars),
        workerId: z.string().max(64),
        executionMode: ExecutionMode,
        permissionPolicy: PermissionPolicy.default("accept_edits_in_worktree"),
        baseBranch: BranchName.optional(),
      }),
      req,
    );
    return core.createSession(user(req).id, param(req, "id"), input);
  });

  fastify.get("/api/sessions/:id", async (req) => core.getSession(user(req).id, param(req, "id")));

  fastify.get("/api/sessions/:id/events", async (req) => {
    const { afterSeq } = z
      .object({ afterSeq: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);
    return { events: core.listEvents(user(req).id, param(req, "id"), afterSeq) };
  });

  fastify.post("/api/sessions/:id/instructions", async (req) => {
    const { text } = body(
      z.object({ text: z.string().max(LIMITS.instructionMaxChars + 1000) }),
      req,
    );
    return core.submitInstruction(user(req).id, param(req, "id"), text);
  });

  fastify.post("/api/instructions/:id/decision", async (req) => {
    const input = body(
      z.object({ approve: z.boolean(), note: z.string().max(1000).optional() }),
      req,
    );
    core.decideInstruction(user(req).id, param(req, "id"), input.approve, input.note);
    return { ok: true };
  });

  fastify.post("/api/permissions/:id/decision", async (req) => {
    const input = body(
      z.object({ allow: z.boolean(), message: z.string().max(1000).optional() }),
      req,
    );
    core.decidePermission(user(req).id, param(req, "id"), input.allow, input.message);
    return { ok: true };
  });

  fastify.post("/api/sessions/:id/interrupt", async (req) => {
    core.interruptSession(user(req).id, param(req, "id"));
    return { ok: true };
  });

  fastify.post("/api/sessions/:id/stop", async (req) =>
    core.stopSession(user(req).id, param(req, "id")),
  );

  fastify.post("/api/sessions/:id/resume", async (req) =>
    core.resumeSession(user(req).id, param(req, "id")),
  );

  fastify.post("/api/sessions/:id/checks", async (req) => {
    core.runChecks(user(req).id, param(req, "id"));
    return { ok: true };
  });

  fastify.post("/api/sessions/:id/changes/refresh", async (req) => {
    core.refreshChanges(user(req).id, param(req, "id"));
    return { ok: true };
  });

  fastify.post("/api/changesets/:id/reviews", async (req) => {
    const input = body(
      z.object({
        decision: z.enum(["approve", "request_changes", "comment"]),
        body: z.string().max(8000).default(""),
      }),
      req,
    );
    core.submitReview(user(req).id, param(req, "id"), input.decision, input.body);
    return { ok: true };
  });

  fastify.post("/api/changesets/:id/merge", async (req) => {
    const input = body(z.object({ confirmSimulated: z.boolean().optional() }), req);
    core.requestMerge(user(req).id, param(req, "id"), input);
    return { ok: true };
  });

  fastify.get("/api/health", async () => ({ ok: true }));

  // --------------------------------------------------------- realtime

  fastify.register(async (scope) => {
    scope.get("/ws", { websocket: true }, (socket, req) => {
      if (!originAllowed(req.headers.origin)) return socket.close(4003, "Origin not allowed");
      const u = auth.userForToken(req.cookies[SESSION_COOKIE]);
      if (!u) return socket.close(4001, "Not signed in");
      hub.attachClient(socket, u.id);
    });

    scope.get("/ws/worker", { websocket: true }, (socket, req) => {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      const worker = token ? core.authenticateWorker(token) : null;
      if (!worker) return socket.close(4001, "Invalid worker token");
      hub.attachWorker(socket, worker.id, worker.project_id);
    });
  });

  // ------------------------------------------------------- web bundle

  const dist = config.webDistDir ? resolve(config.webDistDir) : null;
  if (dist && existsSync(dist)) {
    await fastify.register(fastifyStatic, { root: dist, wildcard: false });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  fastify.addHook("onClose", async () => hub.closeAll());

  return { fastify, core, hub, auth, db };
}
