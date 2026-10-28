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
import { rateLimitKey, WAITLIST_RATE_LIMIT, WaitlistInput } from "@pairloom/shared/waitlist";
import { RateLimiter, Waitlist } from "./waitlist.js";
import {
  archiveRef,
  createRepo,
  diffCommits,
  downloadName,
  HostedWorkers,
  listFiles,
  readFile as readRepoFile,
  RepoSetupError,
} from "./hosted.js";

export interface App {
  fastify: FastifyInstance;
  core: Core;
  hub: Hub;
  auth: AuthService;
  db: Db;
  /** Supervisor for Pairloom-hosted workers; null when hosting is off. */
  hosted: HostedWorkers | null;
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
  const waitlist = new Waitlist(db);
  const waitlistLimiter = new RateLimiter(WAITLIST_RATE_LIMIT.max, WAITLIST_RATE_LIMIT.windowMs);
  // Failed password checks, counted three ways over 15 minutes. One address guessing at one
  // account is stopped quickly; an account only locks for everyone after far more failures
  // (guessing spread over many addresses), so a stranger can't trivially lock someone out.
  const lockWindowMs = 15 * 60_000;
  const failures = {
    pair: new RateLimiter(10, lockWindowMs), // one address, one account
    address: new RateLimiter(50, lockWindowMs), // one address, any accounts
    account: new RateLimiter(100, lockWindowMs), // one account, any addresses
  };
  const guarded = async <T>(
    req: FastifyRequest,
    account: string,
    check: () => Promise<T>,
  ): Promise<T> => {
    const ip = rateLimitKey(req.ip) ?? req.ip;
    const keys: Array<[RateLimiter, string]> = [
      [failures.pair, `${account}|${ip}`],
      [failures.address, ip],
      [failures.account, account],
    ];
    if (keys.some(([l, k]) => l.blocked(k)))
      throw new HttpError(429, "Too many failed attempts. Wait 15 minutes and try again.");
    try {
      return await check();
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403))
        for (const [l, k] of keys) l.allow(k);
      throw err;
    }
  };
  const hub = new Hub(core, config.heartbeatMs);
  core.notifier = hub;
  const auth = new AuthService(db, config);
  const hosted = config.hostedWorkers
    ? new HostedWorkers(core, config.hostedDir, (m) => fastify.log.info(m))
    : null;
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
    const u = await guarded(req, `email:${input.email.toLowerCase()}`, () =>
      auth.login(input.email, input.password),
    );
    const s = auth.createSession(u.id);
    auth.setCookie(reply, s.token, s.expiresAt);
    return { user: { id: u.id, email: u.email, displayName: u.display_name } };
  });

  fastify.post("/api/auth/password", async (req) => {
    const u = user(req);
    const input = body(
      z.object({
        currentPassword: z.string().min(1).max(200),
        newPassword: z.string().min(10, "Use at least 10 characters").max(200),
      }),
      req,
    );
    await guarded(req, `user:${u.id}`, () =>
      auth.changePassword(
        u.id,
        input.currentPassword,
        input.newPassword,
        req.cookies[SESSION_COOKIE],
      ),
    );
    return { ok: true };
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

  fastify.get("/api/dashboard", async (req) => core.getDashboard(user(req).id));

  fastify.get("/api/workspaces", async (req) => ({
    workspaces: core.listWorkspaces(user(req).id),
  }));

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

  // What this server offers new projects (the browser adapts its setup flow to it).
  fastify.get("/api/config", async (req) => {
    user(req);
    return { hostedWorkers: Boolean(hosted) };
  });

  fastify.post("/api/workspaces/:id/projects", async (req) => {
    const input = body(
      z.object({
        name: Name,
        repoUrl: z.string().trim().max(500).nullish(),
        defaultBranch: BranchName.default("main"),
        // "external": the team runs its own worker; the others create a Pairloom-hosted repo.
        source: z.enum(["external", "sample", "empty", "git"]).default("external"),
      }),
      req,
    );
    const { source, ...project } = input;
    if (source === "external") return core.createProject(user(req).id, param(req, "id"), project);
    if (!hosted)
      throw new HttpError(400, "This server doesn't host workspaces; connect your own worker");
    if (source === "git" && !project.repoUrl)
      throw new HttpError(400, "Enter the repository's https URL");
    const created = core.createProject(user(req).id, param(req, "id"), project, { hosted: true });
    try {
      const { branch } = await createRepo(
        hosted.repoPath(created.id),
        source === "git"
          ? { kind: "git", url: project.repoUrl! }
          : source === "sample"
            ? { kind: "sample" }
            : { kind: "empty", branch: project.defaultBranch },
      );
      if (branch !== project.defaultBranch) core.setProjectBranch(created.id, branch);
      hosted.ensure(created.hostedWorkerId!, created.id);
      return { ...created, defaultBranch: branch };
    } catch (err) {
      core.discardNewProject(created.id);
      if (err instanceof RepoSetupError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  fastify.get("/api/projects/:id", async (req) => core.getProject(user(req).id, param(req, "id")));

  fastify.post("/api/projects/:id/workers", async (req) => {
    const input = body(
      z.object({ name: Name, kind: z.enum(["local", "cloud"]).default("local") }),
      req,
    );
    return core.createWorker(user(req).id, param(req, "id"), input);
  });

  // Read-only view of a hosted project's repository: the base branch (what has been merged)
  // or one task's branch as of its last checkpoint. Only those refs, never arbitrary ones.
  const fileRef = (req: FastifyRequest) => {
    const q = z
      .object({ sessionId: z.string().max(64).optional(), path: z.string().max(1000).optional() })
      .parse(req.query ?? {});
    const ref = core.projectFileRef(user(req).id, param(req, "id"), q.sessionId);
    if (!hosted || !ref.hosted)
      throw new HttpError(
        404,
        "Files are only browsable for Pairloom-hosted projects",
        "not_hosted",
      );
    return { ...ref, repo: hosted.repoPath(param(req, "id")), path: q.path };
  };
  fastify.get("/api/projects/:id/files", async (req) => {
    const r = fileRef(req);
    try {
      return { ref: r.ref, ...(await listFiles(r.repo, r.ref)) };
    } catch {
      throw new HttpError(404, "That branch has no commits yet");
    }
  });
  fastify.get("/api/projects/:id/file", async (req) => {
    const r = fileRef(req);
    if (!r.path) throw new HttpError(400, "path is required");
    try {
      const f = await readRepoFile(r.repo, r.ref, r.path);
      if (!f) throw new HttpError(404, "No such file");
      return { ref: r.ref, ...f };
    } catch (err) {
      if (err instanceof RepoSetupError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  // Getting work out: the project (or a task's branch) as a .tar.gz, and any change set as a patch.
  fastify.get("/api/projects/:id/archive", async (req, reply) => {
    const r = fileRef(req);
    const project = core.getProject(user(req).id, param(req, "id"));
    const name = downloadName(project.name, r.ref.replace(/\//g, "-"));
    try {
      const { stream } = await archiveRef(r.repo, r.ref, name);
      return reply
        .header("content-type", "application/gzip")
        .header("content-disposition", `attachment; filename="${name}.tar.gz"`)
        .send(stream);
    } catch {
      throw new HttpError(404, "That branch has no commits yet");
    }
  });

  fastify.get("/api/changesets/:id/patch", async (req, reply) => {
    const c = core.changeSetForDownload(user(req).id, param(req, "id"));
    let patch: string | Buffer = c.diff;
    if (hosted && core.projectFileRef(user(req).id, c.project_id).hosted) {
      patch = await diffCommits(hosted.repoPath(c.project_id), c.base_commit, c.head_commit);
    } else if (c.diff_truncated) {
      throw new HttpError(
        409,
        "This diff was too large to keep in full; get it from the worker's repository",
      );
    }
    return reply
      .header("content-type", "text/x-diff; charset=utf-8")
      .header("content-disposition", `attachment; filename="${downloadName(c.title)}.patch"`)
      .send(patch);
  });

  fastify.delete("/api/workers/:id", async (req) => {
    const w = core.revokeWorker(user(req).id, param(req, "id"));
    if (w.hosted) hosted?.stop(w.id);
    return w;
  });

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

  // ------------------------------------------------------- public waitlist

  // Unauthenticated, so it gets its own per-IP limit on top of the honeypot checks.
  fastify.post("/api/waitlist", async (req, reply) => {
    // IPv6 counts per /64 (a client controls the whole prefix); see rateLimitKey.
    if (!waitlistLimiter.allow(rateLimitKey(req.ip) ?? req.ip)) {
      return reply
        .status(429)
        .send({ error: "Too many attempts. Please try again in a few minutes." });
    }
    const input = body(WaitlistInput, req);
    const outcome = waitlist.join(input);
    if (outcome === "joined") fastify.log.info("waitlist signup");
    // Same response for new and existing addresses (and for dropped spam).
    return { ok: true };
  });

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
  const site = config.siteDistDir ? resolve(config.siteDistDir) : null;
  if (site && existsSync(site) && dist && existsSync(dist)) {
    // Public site at "/", web app at "/app/". Invite links keep their /invite/<token> form.
    await fastify.register(fastifyStatic, { root: site, wildcard: false });
    await fastify.register(fastifyStatic, {
      root: dist,
      prefix: "/app/",
      wildcard: false,
      decorateReply: false,
    });
    fastify.get("/app", async (_req, reply) => reply.redirect("/app/"));
    fastify.get("/invite/:token", async (req, reply) =>
      reply.redirect(`/app/#/invite/${encodeURIComponent(param(req, "token"))}`),
    );
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
        return reply.status(404).send({ error: "Not found" });
      }
      if (req.url.startsWith("/app/")) return reply.sendFile("index.html", dist);
      return reply.status(404).sendFile("404.html", site);
    });
  } else if (dist && existsSync(dist)) {
    await fastify.register(fastifyStatic, { root: dist, wildcard: false });
    // The app uses relative asset URLs and hash routes, so it is only ever served at "/".
    fastify.get("/invite/:token", async (req, reply) =>
      reply.redirect(`/#/invite/${encodeURIComponent(param(req, "token"))}`),
    );
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  fastify.addHook("onClose", async () => {
    await hosted?.stopAll();
    hub.closeAll();
  });

  return { fastify, core, hub, auth, db, hosted };
}
