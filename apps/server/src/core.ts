import { randomUUID } from "node:crypto";
import {
  type AdapterInfo,
  type AgentSessionDTO,
  ChangesUpdatedPayload,
  type ExecutionMode,
  LIMITS,
  LIVE_STATUSES,
  type LiveSessionReport,
  MergeResultPayload,
  PermissionRequestedPayload,
  type PermissionPolicy,
  type Role,
  type SessionCommand,
  type SessionEvent,
  type SessionEventType,
  type SessionStatus,
  StatusPayload,
  TERMINAL_STATUSES,
  type WorkerDTO,
  type WorkerEvent,
  truncate,
} from "@pairloom/shared";
import { type Db, nowIso, tx } from "./db.js";
import { newId, newSecret, newWorkerToken, sha256 } from "./crypto.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, collaborator: 1, owner: 2 };

/** Hooks the realtime layer implements. Core never talks to sockets directly. */
export interface Notifier {
  sessionEvent(workspaceId: string, event: SessionEvent): void;
  sessionUpdated(workspaceId: string, session: AgentSessionDTO): void;
  workerUpdated(workspaceId: string, worker: WorkerDTO): void;
  /** Returns true if the worker is connected and the frame was written. */
  sendToWorker(workerId: string, frame: unknown): boolean;
  isWorkerOnline(workerId: string): boolean;
  /** Drop realtime subscriptions a user may no longer hold. */
  membershipRevoked(workspaceId: string, userId: string): void;
}

export const nullNotifier: Notifier = {
  sessionEvent() {},
  sessionUpdated() {},
  workerUpdated() {},
  sendToWorker: () => false,
  isWorkerOnline: () => false,
  membershipRevoked() {},
};

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
}

interface SessionRow {
  id: string;
  project_id: string;
  worker_id: string;
  host_user_id: string;
  title: string;
  status: SessionStatus;
  execution_mode: ExecutionMode;
  permission_policy: PermissionPolicy;
  provider_session_id: string | null;
  branch_name: string;
  base_branch: string;
  last_seq: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  workspace_id: string;
  host_name: string;
}

interface WorkerRow {
  id: string;
  project_id: string;
  name: string;
  kind: "local" | "cloud";
  adapters_json: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  workspace_id: string;
}

/** Event types a worker is allowed to append. Everything else is server-authored. */
const WORKER_EVENT_TYPES = new Set<SessionEventType>([
  "session.status",
  "agent.init",
  "agent.text",
  "agent.tool_use",
  "agent.tool_result",
  "agent.result",
  "agent.error",
  "permission.requested",
  "changes.updated",
  "merge.completed",
  "merge.failed",
  "checks.started",
  "checks.completed",
  "system.notice",
]);

export class Core {
  private instructionTimestamps = new Map<string, number[]>();

  constructor(
    readonly db: Db,
    public notifier: Notifier = nullNotifier,
  ) {}

  // ---------------------------------------------------------------- users

  getUser(id: string): UserRow | undefined {
    return this.db.prepare("SELECT id, email, display_name FROM users WHERE id = ?").get(id) as
      UserRow | undefined;
  }

  // ----------------------------------------------------------- membership

  roleOf(userId: string, workspaceId: string): Role | null {
    const row = this.db
      .prepare("SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?")
      .get(workspaceId, userId) as { role: Role } | undefined;
    return row?.role ?? null;
  }

  /** Throws 404 for non-members (no existence leak) and 403 for insufficient role. */
  requireRole(userId: string, workspaceId: string, min: Role): Role {
    const role = this.roleOf(userId, workspaceId);
    if (!role) throw new HttpError(404, "Not found");
    if (ROLE_RANK[role] < ROLE_RANK[min]) {
      throw new HttpError(403, `Requires ${min} role`, "forbidden");
    }
    return role;
  }

  createWorkspace(userId: string, name: string) {
    const id = newId("ws");
    const now = nowIso();
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?,?,?,?)")
        .run(id, name, userId, now);
      this.db
        .prepare(
          "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)",
        )
        .run(id, userId, "owner", now);
    });
    return { id, name };
  }

  listWorkspaces(userId: string) {
    return this.db
      .prepare(
        `SELECT w.id, w.name, m.role FROM workspaces w
         JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at`,
      )
      .all(userId);
  }

  getWorkspace(userId: string, workspaceId: string) {
    const role = this.requireRole(userId, workspaceId, "viewer");
    const ws = this.db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(workspaceId);
    const members = this.db
      .prepare(
        `SELECT u.id, u.display_name AS displayName, u.email, m.role FROM memberships m
         JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`,
      )
      .all(workspaceId);
    const projects = this.db
      .prepare(
        `SELECT id, name, repo_url AS repoUrl, default_branch AS defaultBranch
         FROM projects WHERE workspace_id = ? ORDER BY created_at`,
      )
      .all(workspaceId);
    return { ...(ws as object), role, members, projects };
  }

  createInvitation(userId: string, workspaceId: string, role: Role, ttlHours: number) {
    this.requireRole(userId, workspaceId, "owner");
    const token = newSecret(24);
    const id = newId("inv");
    const now = new Date();
    const expires = new Date(now.getTime() + ttlHours * 3600_000);
    this.db
      .prepare(
        `INSERT INTO invitations (id, workspace_id, token_hash, role, created_by, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, workspaceId, sha256(token), role, userId, now.toISOString(), expires.toISOString());
    return { id, token, role, expiresAt: expires.toISOString() };
  }

  revokeInvitation(userId: string, invitationId: string) {
    const inv = this.db
      .prepare("SELECT workspace_id FROM invitations WHERE id = ?")
      .get(invitationId) as { workspace_id: string } | undefined;
    if (!inv) throw new HttpError(404, "Not found");
    this.requireRole(userId, inv.workspace_id, "owner");
    this.db
      .prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(nowIso(), invitationId);
  }

  private findUsableInvitation(token: string) {
    const inv = this.db
      .prepare(
        `SELECT i.*, w.name AS workspace_name FROM invitations i
         JOIN workspaces w ON w.id = i.workspace_id WHERE token_hash = ?`,
      )
      .get(sha256(token)) as
      | {
          id: string;
          workspace_id: string;
          workspace_name: string;
          role: Role;
          expires_at: string;
          accepted_at: string | null;
          revoked_at: string | null;
        }
      | undefined;
    if (!inv || inv.revoked_at || inv.accepted_at) {
      throw new HttpError(404, "Invitation not found or already used");
    }
    if (new Date(inv.expires_at).getTime() < Date.now()) {
      throw new HttpError(410, "Invitation expired", "invite_expired");
    }
    return inv;
  }

  previewInvitation(token: string) {
    const inv = this.findUsableInvitation(token);
    return { workspaceName: inv.workspace_name, role: inv.role, expiresAt: inv.expires_at };
  }

  isInvitationUsable(token: string): boolean {
    try {
      this.findUsableInvitation(token);
      return true;
    } catch {
      return false;
    }
  }

  acceptInvitation(userId: string, token: string) {
    return tx(this.db, () => {
      const inv = this.findUsableInvitation(token);
      const existing = this.roleOf(userId, inv.workspace_id);
      if (!existing) {
        this.db
          .prepare(
            "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)",
          )
          .run(inv.workspace_id, userId, inv.role, nowIso());
      }
      // Single use: consumed even if the user was already a member.
      this.db
        .prepare("UPDATE invitations SET accepted_by = ?, accepted_at = ? WHERE id = ?")
        .run(userId, nowIso(), inv.id);
      return { workspaceId: inv.workspace_id, role: existing ?? inv.role };
    });
  }

  removeMember(actorId: string, workspaceId: string, targetUserId: string) {
    this.requireRole(actorId, workspaceId, "owner");
    const targetRole = this.roleOf(targetUserId, workspaceId);
    if (!targetRole) throw new HttpError(404, "Not found");
    if (targetRole === "owner") {
      const owners = this.db
        .prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'")
        .get(workspaceId) as { n: number };
      if (owners.n <= 1) throw new HttpError(409, "Cannot remove the last owner");
    }
    this.db
      .prepare("DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?")
      .run(workspaceId, targetUserId);
    this.notifier.membershipRevoked(workspaceId, targetUserId);
  }

  // ------------------------------------------------------------- projects

  createProject(
    userId: string,
    workspaceId: string,
    input: { name: string; repoUrl?: string | null; defaultBranch: string },
  ) {
    this.requireRole(userId, workspaceId, "owner");
    const id = newId("prj");
    this.db
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, repo_url, default_branch, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        workspaceId,
        input.name,
        input.repoUrl ?? null,
        input.defaultBranch,
        userId,
        nowIso(),
      );
    return { id, ...input };
  }

  private projectRow(projectId: string) {
    const p = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
      | {
          id: string;
          workspace_id: string;
          name: string;
          repo_url: string | null;
          default_branch: string;
        }
      | undefined;
    if (!p) throw new HttpError(404, "Not found");
    return p;
  }

  /**
   * Everything the home screen needs, scoped by SQL to the caller's memberships:
   * a project the caller cannot see is never selected.
   */
  getDashboard(userId: string) {
    const workspaces = this.db
      .prepare(
        `SELECT w.id, w.name, m.role,
           (SELECT COUNT(*) FROM memberships m2 WHERE m2.workspace_id = w.id) AS memberCount
         FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
         WHERE m.user_id = ? ORDER BY w.created_at`,
      )
      .all(userId) as Array<{ id: string; name: string; role: Role; memberCount: number }>;
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.workspace_id AS workspaceId, w.name AS workspaceName, m.role,
           p.default_branch AS defaultBranch, p.created_at AS createdAt,
           (SELECT COUNT(*) FROM agent_sessions s WHERE s.project_id = p.id) AS sessionCount,
           (SELECT MAX(s.updated_at) FROM agent_sessions s WHERE s.project_id = p.id) AS lastActivityAt,
           (SELECT COUNT(*) FROM instructions i JOIN agent_sessions s ON s.id = i.session_id
              WHERE s.project_id = p.id AND i.status = 'pending_approval') +
           (SELECT COUNT(*) FROM permission_requests r JOIN agent_sessions s ON s.id = r.session_id
              WHERE s.project_id = p.id AND r.status = 'pending') AS pendingApprovals,
           (SELECT COUNT(*) FROM change_sets c JOIN agent_sessions s ON s.id = c.session_id
              WHERE s.project_id = p.id AND c.status = 'open') AS openChangeSets
         FROM projects p
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN memberships m ON m.workspace_id = p.workspace_id AND m.user_id = ?
         ORDER BY COALESCE(lastActivityAt, p.created_at) DESC`,
      )
      .all(userId) as Array<Record<string, any>>;
    const latest = this.db.prepare(
      `SELECT id, title, status, execution_mode AS executionMode, updated_at AS updatedAt
       FROM agent_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`,
    );
    const projects = rows.map((r) => {
      const workers = this.listWorkers(r.id).filter((w) => !w.revoked);
      return {
        ...r,
        latestSession: latest.get(r.id) ?? null,
        workerCount: workers.length,
        workersOnline: workers.filter((w) => w.online).length,
      };
    });
    return { workspaces, projects };
  }

  getProject(userId: string, projectId: string) {
    const p = this.projectRow(projectId);
    const role = this.requireRole(userId, p.workspace_id, "viewer");
    return {
      id: p.id,
      workspaceId: p.workspace_id,
      name: p.name,
      repoUrl: p.repo_url,
      defaultBranch: p.default_branch,
      role,
      workspaceName: (
        this.db.prepare("SELECT name FROM workspaces WHERE id = ?").get(p.workspace_id) as {
          name: string;
        }
      ).name,
      members: this.db
        .prepare(
          `SELECT u.id, u.display_name AS displayName, m.role FROM memberships m
           JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`,
        )
        .all(p.workspace_id),
      workers: this.listWorkers(p.id),
      sessions: this.listSessions(p.id),
    };
  }

  // -------------------------------------------------------------- workers

  /** Returns the plaintext token exactly once. */
  createWorker(
    userId: string,
    projectId: string,
    input: { name: string; kind: "local" | "cloud" },
  ) {
    const p = this.projectRow(projectId);
    this.requireRole(userId, p.workspace_id, "owner");
    const id = newId("wkr");
    const token = newWorkerToken();
    this.db
      .prepare(
        `INSERT INTO workers (id, project_id, name, kind, token_hash, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, projectId, input.name, input.kind, sha256(token), userId, nowIso());
    return { worker: this.workerDto(this.workerRow(id)!), token };
  }

  revokeWorker(userId: string, workerId: string) {
    const w = this.workerRow(workerId);
    if (!w) throw new HttpError(404, "Not found");
    this.requireRole(userId, w.workspace_id, "owner");
    this.db.prepare("UPDATE workers SET revoked_at = ? WHERE id = ?").run(nowIso(), workerId);
    this.notifier.sendToWorker(workerId, { t: "error", message: "Worker token revoked" });
    return this.workerDto(this.workerRow(workerId)!);
  }

  authenticateWorker(token: string): WorkerRow | null {
    const w = this.db
      .prepare(
        `SELECT w.*, p.workspace_id FROM workers w JOIN projects p ON p.id = w.project_id
         WHERE w.token_hash = ?`,
      )
      .get(sha256(token)) as WorkerRow | undefined;
    if (!w || w.revoked_at) return null;
    return w;
  }

  private workerRow(workerId: string): WorkerRow | undefined {
    return this.db
      .prepare(
        `SELECT w.*, p.workspace_id FROM workers w JOIN projects p ON p.id = w.project_id
         WHERE w.id = ?`,
      )
      .get(workerId) as WorkerRow | undefined;
  }

  workerDto(w: WorkerRow): WorkerDTO {
    return {
      id: w.id,
      projectId: w.project_id,
      name: w.name,
      kind: w.kind,
      online: !w.revoked_at && this.notifier.isWorkerOnline(w.id),
      lastSeenAt: w.last_seen_at,
      adapters: JSON.parse(w.adapters_json) as AdapterInfo[],
      revoked: Boolean(w.revoked_at),
    };
  }

  listWorkers(projectId: string): WorkerDTO[] {
    const rows = this.db
      .prepare(
        `SELECT w.*, p.workspace_id FROM workers w JOIN projects p ON p.id = w.project_id
         WHERE w.project_id = ? ORDER BY w.created_at`,
      )
      .all(projectId) as unknown as WorkerRow[];
    return rows.map((w) => this.workerDto(w));
  }

  // ------------------------------------------------------------- sessions

  private sessionRow(sessionId: string): SessionRow {
    const s = this.db
      .prepare(
        `SELECT s.*, p.workspace_id, u.display_name AS host_name FROM agent_sessions s
         JOIN projects p ON p.id = s.project_id JOIN users u ON u.id = s.host_user_id
         WHERE s.id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    if (!s) throw new HttpError(404, "Not found");
    return s;
  }

  sessionDto(s: SessionRow): AgentSessionDTO {
    return {
      id: s.id,
      projectId: s.project_id,
      workerId: s.worker_id,
      hostUserId: s.host_user_id,
      hostName: s.host_name,
      title: s.title,
      status: s.status,
      executionMode: s.execution_mode,
      permissionPolicy: s.permission_policy,
      providerSessionId: s.provider_session_id,
      branchName: s.branch_name,
      baseBranch: s.base_branch,
      lastSeq: s.last_seq,
      error: s.error,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      endedAt: s.ended_at,
    };
  }

  listSessions(projectId: string): AgentSessionDTO[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, p.workspace_id, u.display_name AS host_name FROM agent_sessions s
         JOIN projects p ON p.id = s.project_id JOIN users u ON u.id = s.host_user_id
         WHERE s.project_id = ? ORDER BY s.created_at DESC`,
      )
      .all(projectId) as unknown as SessionRow[];
    return rows.map((s) => this.sessionDto(s));
  }

  /** Access check for anything addressed by session id. */
  requireSession(userId: string, sessionId: string, min: Role) {
    const s = this.sessionRow(sessionId);
    const role = this.requireRole(userId, s.workspace_id, min);
    return { session: s, role };
  }

  getSession(userId: string, sessionId: string) {
    const { session, role } = this.requireSession(userId, sessionId, "viewer");
    const project = this.db
      .prepare(
        `SELECT p.id, p.name, w.id AS workspaceId, w.name AS workspaceName
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = ?`,
      )
      .get(session.project_id);
    return {
      session: this.sessionDto(session),
      role,
      project,
      instructions: this.db
        .prepare(
          `SELECT i.id, i.text, i.status, i.created_at AS createdAt, i.decision_note AS decisionNote,
                  u.display_name AS authorName, i.author_id AS authorId
           FROM instructions i JOIN users u ON u.id = i.author_id
           WHERE i.session_id = ? ORDER BY i.created_at`,
        )
        .all(sessionId),
      permissionRequests: this.db
        .prepare(
          `SELECT id, request_id AS requestId, tool_name AS toolName, input_json AS inputJson,
                  title, status, created_at AS createdAt
           FROM permission_requests WHERE session_id = ? ORDER BY created_at`,
        )
        .all(sessionId)
        .map((r) => {
          const { inputJson, ...rest } = r as { inputJson: string };
          return { ...rest, input: JSON.parse(inputJson) };
        }),
      changeSet: this.latestChangeSet(sessionId),
      worker: (() => {
        const w = this.workerRow(session.worker_id);
        return w ? this.workerDto(w) : null;
      })(),
    };
  }

  listEvents(userId: string, sessionId: string, afterSeq: number, limit = 500): SessionEvent[] {
    this.requireSession(userId, sessionId, "viewer");
    return this.eventsAfter(sessionId, afterSeq, limit);
  }

  eventsAfter(sessionId: string, afterSeq: number, limit = 500): SessionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, u.display_name AS actor_name FROM session_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.session_id = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as Array<Record<string, string | number | null>>;
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      seq: r.seq as number,
      type: r.type as SessionEventType,
      actorKind: r.actor_kind as SessionEvent["actorKind"],
      actorUserId: (r.actor_user_id as string | null) ?? null,
      actorName: (r.actor_name as string | null) ?? null,
      executionMode: r.execution_mode as ExecutionMode,
      payload: JSON.parse(r.payload_json as string),
      createdAt: r.created_at as string,
    }));
  }

  createSession(
    userId: string,
    projectId: string,
    input: {
      title: string;
      prompt: string;
      workerId: string;
      executionMode: ExecutionMode;
      permissionPolicy: PermissionPolicy;
      baseBranch?: string;
    },
  ) {
    const p = this.projectRow(projectId);
    this.requireRole(userId, p.workspace_id, "owner");
    const w = this.workerRow(input.workerId);
    if (!w || w.project_id !== projectId) throw new HttpError(400, "Worker not in this project");
    if (w.revoked_at) throw new HttpError(409, "Worker is revoked");
    const adapters = JSON.parse(w.adapters_json) as AdapterInfo[];
    const adapter =
      input.executionMode === "simulated"
        ? adapters.find((a) => a.kind === "simulated")
        : adapters.find((a) => a.kind !== "simulated");
    // Unknown adapter state (worker never connected) is allowed: the start command
    // will fail truthfully on the worker if the adapter is unavailable.
    if (adapter && !adapter.available) {
      throw new HttpError(
        409,
        `Worker cannot run ${input.executionMode} sessions: ${adapter.detail}`,
        "adapter_unavailable",
      );
    }
    const id = newId("ses");
    const now = nowIso();
    const branchName = `pairloom/${id.slice(4, 16)}`;
    const baseBranch = input.baseBranch ?? p.default_branch;
    this.db
      .prepare(
        `INSERT INTO agent_sessions (id, project_id, worker_id, host_user_id, title, status,
           execution_mode, permission_policy, branch_name, base_branch, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        projectId,
        w.id,
        userId,
        input.title,
        "pending",
        input.executionMode,
        input.permissionPolicy,
        branchName,
        baseBranch,
        now,
        now,
      );
    this.appendEvent(id, {
      type: "session.created",
      actorKind: "user",
      actorUserId: userId,
      payload: {
        title: input.title,
        executionMode: input.executionMode,
        permissionPolicy: input.permissionPolicy,
        branchName,
        baseBranch,
      },
    });
    this.enqueueCommand(id, {
      kind: "start",
      executionMode: input.executionMode,
      permissionPolicy: input.permissionPolicy,
      title: input.title,
      baseBranch,
      branchName,
      resumeProviderSessionId: null,
    });
    // The host's initial prompt is an instruction from an owner: approved immediately.
    this.submitInstruction(userId, id, input.prompt);
    this.emitSession(id);
    return this.sessionDto(this.sessionRow(id));
  }

  // --------------------------------------------------------------- events

  /** Appends an event with a fresh seq. Returns null if `uid` was already recorded. */
  appendEvent(
    sessionId: string,
    e: {
      uid?: string;
      type: SessionEventType;
      actorKind: SessionEvent["actorKind"];
      actorUserId?: string | null;
      payload: Record<string, unknown>;
    },
  ): SessionEvent | null {
    const uid = e.uid ?? randomUUID();
    const inserted = tx(this.db, () => {
      const dup = this.db.prepare("SELECT 1 FROM session_events WHERE event_uid = ?").get(uid);
      if (dup) return null;
      const s = this.db
        .prepare("SELECT last_seq, execution_mode FROM agent_sessions WHERE id = ?")
        .get(sessionId) as { last_seq: number; execution_mode: ExecutionMode } | undefined;
      if (!s) throw new HttpError(404, "Not found");
      const seq = s.last_seq + 1;
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO session_events (session_id, seq, event_uid, type, actor_kind, actor_user_id,
             execution_mode, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          sessionId,
          seq,
          uid,
          e.type,
          e.actorKind,
          e.actorUserId ?? null,
          s.execution_mode,
          JSON.stringify(e.payload),
          now,
        );
      this.db
        .prepare("UPDATE agent_sessions SET last_seq = ?, updated_at = ? WHERE id = ?")
        .run(seq, now, sessionId);
      return seq;
    });
    if (inserted === null) return null;
    const event = this.eventsAfter(sessionId, inserted - 1, 1)[0]!;
    const s = this.sessionRow(sessionId);
    this.notifier.sessionEvent(s.workspace_id, event);
    return event;
  }

  private emitSession(sessionId: string) {
    const s = this.sessionRow(sessionId);
    this.notifier.sessionUpdated(s.workspace_id, this.sessionDto(s));
  }

  private setStatus(
    sessionId: string,
    status: SessionStatus,
    extra: { error?: string | null; providerSessionId?: string | null } = {},
  ) {
    const now = nowIso();
    const ended = TERMINAL_STATUSES.includes(status) ? now : null;
    this.db
      .prepare(
        `UPDATE agent_sessions SET status = ?, updated_at = ?,
           error = CASE WHEN ? THEN ? ELSE error END,
           provider_session_id = COALESCE(?, provider_session_id),
           ended_at = COALESCE(?, ended_at)
         WHERE id = ?`,
      )
      .run(
        status,
        now,
        extra.error !== undefined ? 1 : 0,
        extra.error ?? null,
        extra.providerSessionId ?? null,
        ended,
        sessionId,
      );
    this.emitSession(sessionId);
  }

  private systemStatus(sessionId: string, status: SessionStatus, detail: string) {
    this.setStatus(sessionId, status);
    this.appendEvent(sessionId, {
      type: "session.status",
      actorKind: "system",
      payload: { status, detail },
    });
  }

  // ------------------------------------------------------------- commands

  enqueueCommand(sessionId: string, command: SessionCommand) {
    const s = this.sessionRow(sessionId);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO worker_commands (id, worker_id, session_id, command_json, status, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, s.worker_id, sessionId, JSON.stringify(command), "pending", nowIso());
    this.notifier.sendToWorker(s.worker_id, { t: "command", id, sessionId, command });
    return id;
  }

  pendingCommands(workerId: string) {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, command_json FROM worker_commands
         WHERE worker_id = ? AND status = 'pending' ORDER BY created_at, rowid`,
      )
      .all(workerId) as Array<{ id: string; session_id: string; command_json: string }>;
    return rows.map((r) => ({
      t: "command" as const,
      id: r.id,
      sessionId: r.session_id,
      command: JSON.parse(r.command_json) as SessionCommand,
    }));
  }

  private cancelPendingCommands(sessionId: string, reason: string) {
    const rows = this.db
      .prepare(
        "SELECT id, command_json FROM worker_commands WHERE session_id = ? AND status = 'pending'",
      )
      .all(sessionId) as Array<{ id: string; command_json: string }>;
    for (const r of rows) this.failCommand(r.id, sessionId, JSON.parse(r.command_json), reason);
  }

  private failCommand(id: string, sessionId: string, command: SessionCommand, error: string) {
    this.db
      .prepare("UPDATE worker_commands SET status = 'failed', error = ?, acked_at = ? WHERE id = ?")
      .run(error, nowIso(), id);
    if (command.kind === "message") {
      this.db
        .prepare("UPDATE instructions SET status = 'failed', decision_note = ? WHERE id = ?")
        .run(error, command.instructionId);
      this.appendEvent(sessionId, {
        type: "system.notice",
        actorKind: "system",
        payload: { level: "error", message: `Instruction not delivered: ${error}` },
      });
    }
  }

  // ----------------------------------------------------- worker lifecycle

  onWorkerHello(workerId: string, adapters: AdapterInfo[], live: LiveSessionReport[]) {
    this.db
      .prepare("UPDATE workers SET adapters_json = ?, last_seen_at = ? WHERE id = ?")
      .run(JSON.stringify(adapters), nowIso(), workerId);
    const liveById = new Map(live.map((l) => [l.sessionId, l]));
    const sessions = this.db
      .prepare("SELECT id, status FROM agent_sessions WHERE worker_id = ?")
      .all(workerId) as Array<{ id: string; status: SessionStatus }>;
    for (const s of sessions) {
      const report = liveById.get(s.id);
      const believedLive =
        LIVE_STATUSES.includes(s.status) || s.status === "disconnected" || s.status === "stopping";
      if (report) {
        if (TERMINAL_STATUSES.includes(s.status)) {
          // The server already ended it (e.g. stopped while offline): tell the worker.
          this.enqueueCommand(s.id, { kind: "stop" });
        } else if (report.status !== s.status) {
          this.setStatus(s.id, report.status, { providerSessionId: report.providerSessionId });
          this.appendEvent(s.id, {
            type: "session.status",
            actorKind: "worker",
            payload: { status: report.status, detail: "Worker reconnected; agent still live" },
          });
        }
      } else if (believedLive) {
        // Truthful: the transcript may exist on the worker, but the live process is gone.
        this.expirePendingPermissions(s.id);
        this.cancelPendingCommands(s.id, "Agent process no longer live on worker");
        this.systemStatus(
          s.id,
          s.status === "stopping" ? "stopped" : "interrupted",
          "Worker reconnected without this agent process. The live session was lost; " +
            "it can be resumed from its saved transcript if the worker still has it.",
        );
      }
    }
    this.emitWorker(workerId);
    return this.pendingCommands(workerId);
  }

  onWorkerDisconnected(workerId: string) {
    this.db.prepare("UPDATE workers SET last_seen_at = ? WHERE id = ?").run(nowIso(), workerId);
    const sessions = this.db
      .prepare("SELECT id, status FROM agent_sessions WHERE worker_id = ?")
      .all(workerId) as Array<{ id: string; status: SessionStatus }>;
    for (const s of sessions) {
      if (LIVE_STATUSES.includes(s.status)) {
        this.systemStatus(
          s.id,
          "disconnected",
          "Worker connection lost. The agent may still be running; waiting for reconnect.",
        );
      }
    }
    this.emitWorker(workerId);
  }

  emitWorker(workerId: string) {
    const w = this.workerRow(workerId);
    if (w) this.notifier.workerUpdated(w.workspace_id, this.workerDto(w));
  }

  onCommandAck(workerId: string, commandId: string, ok: boolean, error?: string) {
    const row = this.db
      .prepare(
        "SELECT session_id, command_json, status FROM worker_commands WHERE id = ? AND worker_id = ?",
      )
      .get(commandId, workerId) as
      { session_id: string; command_json: string; status: string } | undefined;
    if (!row || row.status !== "pending") return; // unknown or duplicate ack
    const command = JSON.parse(row.command_json) as SessionCommand;
    if (!ok) {
      this.failCommand(commandId, row.session_id, command, error ?? "Worker rejected command");
      if (command.kind === "start") {
        this.setStatus(row.session_id, "failed", { error: error ?? "Start failed" });
        this.appendEvent(row.session_id, {
          type: "session.status",
          actorKind: "worker",
          payload: { status: "failed", detail: error ?? "Start failed" },
        });
      }
      if (command.kind === "merge") {
        this.db
          .prepare("UPDATE change_sets SET status = 'merge_failed', merge_error = ? WHERE id = ?")
          .run(error ?? "Merge rejected", command.changeSetId);
      }
      return;
    }
    this.db
      .prepare("UPDATE worker_commands SET status = 'acked', acked_at = ? WHERE id = ?")
      .run(nowIso(), commandId);
    if (command.kind === "message") {
      this.db
        .prepare(
          "UPDATE instructions SET status = 'delivered' WHERE id = ? AND status = 'approved'",
        )
        .run(command.instructionId);
      this.appendEvent(row.session_id, {
        type: "instruction.delivered",
        actorKind: "worker",
        payload: { instructionId: command.instructionId },
      });
    }
  }

  ingestWorkerEvent(workerId: string, ev: WorkerEvent): "ok" | "duplicate" {
    const s = this.sessionRow(ev.sessionId);
    if (s.worker_id !== workerId) throw new HttpError(403, "Session not assigned to this worker");
    if (!WORKER_EVENT_TYPES.has(ev.type)) throw new HttpError(400, `Event type not allowed`);
    const payload = this.sanitizeWorkerPayload(ev);
    const appended = this.appendEvent(s.id, {
      uid: ev.id,
      type: ev.type,
      actorKind:
        ev.type.startsWith("agent.") || ev.type === "permission.requested" ? "agent" : "worker",
      payload,
    });
    if (!appended) return "duplicate";
    this.applyWorkerEvent(s, ev.type, payload);
    return "ok";
  }

  private sanitizeWorkerPayload(ev: WorkerEvent): Record<string, unknown> {
    switch (ev.type) {
      case "session.status":
        return StatusPayload.parse(ev.payload);
      case "permission.requested": {
        const p = PermissionRequestedPayload.parse(ev.payload);
        const input = truncate(JSON.stringify(p.input), LIMITS.toolPayloadMaxChars);
        return { ...p, input: safeParse(input) };
      }
      case "changes.updated": {
        const p = ChangesUpdatedPayload.parse(ev.payload);
        const tooBig = Buffer.byteLength(p.diff) > LIMITS.diffMaxBytes;
        return {
          ...p,
          diff: tooBig ? p.diff.slice(0, LIMITS.diffMaxBytes) : p.diff,
          diffTruncated: p.diffTruncated || tooBig,
        };
      }
      case "merge.completed":
      case "merge.failed":
        return MergeResultPayload.parse(ev.payload);
      default: {
        const json = JSON.stringify(ev.payload);
        if (json.length > LIMITS.agentTextMaxChars * 2) {
          return { truncated: true, preview: json.slice(0, LIMITS.agentTextMaxChars) };
        }
        return ev.payload;
      }
    }
  }

  private applyWorkerEvent(
    s: SessionRow,
    type: SessionEventType,
    payload: Record<string, unknown>,
  ) {
    switch (type) {
      case "session.status": {
        const p = payload as {
          status: SessionStatus;
          providerSessionId?: string | null;
          error?: string | null;
        };
        // A worker cannot revive a session the server already ended.
        const current = this.sessionRow(s.id).status;
        if (TERMINAL_STATUSES.includes(current)) return;
        this.setStatus(s.id, p.status, {
          providerSessionId: p.providerSessionId ?? null,
          ...(p.error !== undefined ? { error: p.error } : {}),
        });
        if (TERMINAL_STATUSES.includes(p.status) || p.status === "interrupted") {
          this.expirePendingPermissions(s.id);
        }
        return;
      }
      case "agent.init": {
        const id = payload.providerSessionId;
        if (typeof id === "string") {
          this.db
            .prepare("UPDATE agent_sessions SET provider_session_id = ? WHERE id = ?")
            .run(id, s.id);
          this.emitSession(s.id);
        }
        return;
      }
      case "permission.requested": {
        const p = payload as {
          requestId: string;
          toolName: string;
          input: unknown;
          title?: string;
        };
        this.db
          .prepare(
            `INSERT OR IGNORE INTO permission_requests (id, session_id, request_id, tool_name,
               input_json, title, status, created_at) VALUES (?,?,?,?,?,?,?,?)`,
          )
          .run(
            newId("perm"),
            s.id,
            p.requestId,
            p.toolName,
            JSON.stringify(p.input),
            p.title ?? null,
            "pending",
            nowIso(),
          );
        return;
      }
      case "changes.updated": {
        const p = payload as ChangesUpdatedPayload;
        // Same commit as the newest change set (e.g. re-sent after a worker restart):
        // nothing changed, and superseding it would orphan its reviews or an in-flight merge.
        const latest = this.db
          .prepare(
            `SELECT base_commit, head_commit FROM change_sets WHERE session_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(s.id) as { base_commit: string; head_commit: string } | undefined;
        if (latest && latest.head_commit === p.headCommit && latest.base_commit === p.baseCommit)
          return;
        tx(this.db, () => {
          this.db
            .prepare(
              "UPDATE change_sets SET status = 'superseded' WHERE session_id = ? AND status = 'open'",
            )
            .run(s.id);
          this.db
            .prepare(
              `INSERT INTO change_sets (id, session_id, base_commit, head_commit, branch_name,
                 files_json, diff, diff_truncated, status, execution_mode, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              newId("chg"),
              s.id,
              p.baseCommit,
              p.headCommit,
              p.branchName,
              JSON.stringify(p.files),
              p.diff,
              p.diffTruncated ? 1 : 0,
              "open",
              s.execution_mode,
              nowIso(),
            );
        });
        return;
      }
      case "merge.completed":
      case "merge.failed": {
        const p = payload as { changeSetId: string; mergeCommit?: string; error?: string };
        this.db
          .prepare(
            `UPDATE change_sets SET status = ?, merge_commit = ?, merge_error = ?
             WHERE id = ? AND session_id = ?`,
          )
          .run(
            type === "merge.completed" ? "merged" : "merge_failed",
            p.mergeCommit ?? null,
            p.error ?? null,
            p.changeSetId,
            s.id,
          );
        return;
      }
      default:
        return;
    }
  }

  private expirePendingPermissions(sessionId: string) {
    this.db
      .prepare(
        "UPDATE permission_requests SET status = 'expired' WHERE session_id = ? AND status = 'pending'",
      )
      .run(sessionId);
  }

  // --------------------------------------------------------- instructions

  submitInstruction(userId: string, sessionId: string, rawText: string) {
    const { session, role } = this.requireSession(userId, sessionId, "collaborator");
    const text = rawText.trim();
    if (!text) throw new HttpError(400, "Instruction is empty");
    if (text.length > LIMITS.instructionMaxChars) {
      throw new HttpError(413, `Instruction exceeds ${LIMITS.instructionMaxChars} characters`);
    }
    if (TERMINAL_STATUSES.includes(session.status)) {
      throw new HttpError(409, `Session is ${session.status}`);
    }
    this.rateLimit(userId);
    const id = newId("ins");
    const autoApproved = role === "owner";
    this.db
      .prepare(
        `INSERT INTO instructions (id, session_id, author_id, text, status, decided_by, decided_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        sessionId,
        userId,
        text,
        autoApproved ? "approved" : "pending_approval",
        autoApproved ? userId : null,
        autoApproved ? nowIso() : null,
        nowIso(),
      );
    this.appendEvent(sessionId, {
      type: "instruction.submitted",
      actorKind: "user",
      actorUserId: userId,
      payload: { instructionId: id, text, requiresApproval: !autoApproved },
    });
    if (autoApproved) this.deliverInstruction(sessionId, id, userId, text);
    return { id, status: autoApproved ? "approved" : "pending_approval" };
  }

  decideInstruction(userId: string, instructionId: string, approve: boolean, note?: string) {
    const ins = this.db
      .prepare("SELECT session_id, author_id, text, status FROM instructions WHERE id = ?")
      .get(instructionId) as
      { session_id: string; author_id: string; text: string; status: string } | undefined;
    if (!ins) throw new HttpError(404, "Not found");
    const { session } = this.requireSession(userId, ins.session_id, "owner");
    if (ins.status !== "pending_approval") throw new HttpError(409, `Instruction is ${ins.status}`);
    if (approve && TERMINAL_STATUSES.includes(session.status)) {
      throw new HttpError(409, `Session is ${session.status}`);
    }
    this.db
      .prepare(
        "UPDATE instructions SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?",
      )
      .run(approve ? "approved" : "rejected", userId, nowIso(), note ?? null, instructionId);
    this.appendEvent(ins.session_id, {
      type: approve ? "instruction.approved" : "instruction.rejected",
      actorKind: "user",
      actorUserId: userId,
      payload: { instructionId, note: note ?? null },
    });
    if (approve) this.deliverInstruction(ins.session_id, instructionId, ins.author_id, ins.text);
  }

  private deliverInstruction(
    sessionId: string,
    instructionId: string,
    authorId: string,
    text: string,
  ) {
    const authorName = this.getUser(authorId)?.display_name ?? "unknown";
    this.enqueueCommand(sessionId, { kind: "message", instructionId, authorName, text });
  }

  private rateLimit(userId: string) {
    const now = Date.now();
    const recent = (this.instructionTimestamps.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LIMITS.instructionsPerMinutePerUser) {
      throw new HttpError(429, "Too many instructions; slow down");
    }
    recent.push(now);
    this.instructionTimestamps.set(userId, recent);
  }

  // ---------------------------------------------------------- permissions

  decidePermission(userId: string, permissionId: string, allow: boolean, message?: string) {
    const p = this.db
      .prepare(
        "SELECT session_id, request_id, tool_name, status FROM permission_requests WHERE id = ?",
      )
      .get(permissionId) as
      { session_id: string; request_id: string; tool_name: string; status: string } | undefined;
    if (!p) throw new HttpError(404, "Not found");
    this.requireSession(userId, p.session_id, "owner");
    if (p.status !== "pending") throw new HttpError(409, `This request was already ${p.status}`);
    this.db
      .prepare(
        "UPDATE permission_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?",
      )
      .run(allow ? "allowed" : "denied", userId, nowIso(), permissionId);
    const user = this.getUser(userId)!;
    this.appendEvent(p.session_id, {
      type: "permission.decided",
      actorKind: "user",
      actorUserId: userId,
      payload: {
        requestId: p.request_id,
        toolName: p.tool_name,
        behavior: allow ? "allow" : "deny",
      },
    });
    this.enqueueCommand(p.session_id, {
      kind: "permission_decision",
      requestId: p.request_id,
      behavior: allow ? "allow" : "deny",
      message: allow ? undefined : (message ?? `Denied by ${user.display_name}`),
      decidedBy: user.display_name,
    });
  }

  // ------------------------------------------------------------- controls

  interruptSession(userId: string, sessionId: string) {
    const { session } = this.requireSession(userId, sessionId, "owner");
    if (!LIVE_STATUSES.includes(session.status) && session.status !== "disconnected") {
      throw new HttpError(409, `Session is ${session.status}`);
    }
    this.enqueueCommand(sessionId, { kind: "interrupt" });
    this.appendEvent(sessionId, {
      type: "system.notice",
      actorKind: "user",
      actorUserId: userId,
      payload: { level: "info", message: "Interrupt requested" },
    });
  }

  stopSession(userId: string, sessionId: string) {
    const { session } = this.requireSession(userId, sessionId, "owner");
    if (TERMINAL_STATUSES.includes(session.status)) return this.sessionDto(session);
    const workerOnline = this.notifier.isWorkerOnline(session.worker_id);
    const mayHaveProcess =
      LIVE_STATUSES.includes(session.status) || session.status === "disconnected";
    if (mayHaveProcess) {
      this.enqueueCommand(sessionId, { kind: "stop" });
      this.systemStatus(
        sessionId,
        "stopping",
        workerOnline
          ? "Stop requested"
          : "Stop requested; will be delivered when the worker reconnects",
      );
    } else {
      this.cancelPendingCommands(sessionId, "Session stopped before it started");
      this.expirePendingPermissions(sessionId);
      this.systemStatus(sessionId, "stopped", "Stopped (no live agent process)");
    }
    return this.sessionDto(this.sessionRow(sessionId));
  }

  resumeSession(userId: string, sessionId: string) {
    const { session } = this.requireSession(userId, sessionId, "owner");
    if (session.status !== "interrupted") {
      throw new HttpError(409, "Only interrupted sessions can be resumed");
    }
    if (session.execution_mode === "real" && !session.provider_session_id) {
      throw new HttpError(409, "No provider session id recorded; cannot resume transcript");
    }
    this.systemStatus(sessionId, "pending", "Resume requested");
    this.enqueueCommand(sessionId, {
      kind: "start",
      executionMode: session.execution_mode,
      permissionPolicy: session.permission_policy,
      title: session.title,
      baseBranch: session.base_branch,
      branchName: session.branch_name,
      resumeProviderSessionId: session.provider_session_id,
    });
    return this.sessionDto(this.sessionRow(sessionId));
  }

  refreshChanges(userId: string, sessionId: string) {
    const { session } = this.requireSession(userId, sessionId, "collaborator");
    this.enqueueCommand(sessionId, {
      kind: "refresh_changes",
      branchName: session.branch_name,
      baseBranch: session.base_branch,
    });
  }

  /** Runs the project's configured test command in the session's worktree on the worker. */
  runChecks(userId: string, sessionId: string) {
    const { session } = this.requireSession(userId, sessionId, "collaborator");
    this.enqueueCommand(sessionId, {
      kind: "run_checks",
      branchName: session.branch_name,
      baseBranch: session.base_branch,
    });
  }

  /**
   * Called once at server start. No worker is connected yet, so nothing can be
   * known to be live: mark live sessions disconnected until their worker says otherwise.
   */
  reconcileOnStartup() {
    const rows = this.db.prepare(`SELECT id, status FROM agent_sessions`).all() as Array<{
      id: string;
      status: SessionStatus;
    }>;
    let n = 0;
    for (const s of rows) {
      if (LIVE_STATUSES.includes(s.status)) {
        this.systemStatus(
          s.id,
          "disconnected",
          "Server restarted; waiting for the worker to reconnect and report this session.",
        );
        n++;
      }
    }
    return n;
  }

  // -------------------------------------------------------------- reviews

  latestChangeSet(sessionId: string) {
    const c = this.db
      .prepare(
        `SELECT * FROM change_sets WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as Record<string, string | number | null> | undefined;
    if (!c) return null;
    const reviews = this.db
      .prepare(
        `SELECT r.id, r.decision, r.body, r.created_at AS createdAt, u.display_name AS reviewerName,
                r.reviewer_id AS reviewerId
         FROM reviews r JOIN users u ON u.id = r.reviewer_id
         WHERE r.change_set_id = ? ORDER BY r.created_at`,
      )
      .all(c.id as string);
    return {
      id: c.id as string,
      baseCommit: c.base_commit as string,
      headCommit: c.head_commit as string,
      branchName: c.branch_name as string,
      files: JSON.parse(c.files_json as string),
      diff: c.diff as string,
      diffTruncated: Boolean(c.diff_truncated),
      status: c.status as string,
      executionMode: c.execution_mode as ExecutionMode,
      mergeCommit: c.merge_commit as string | null,
      mergeError: c.merge_error as string | null,
      createdAt: c.created_at as string,
      reviews,
    };
  }

  private changeSetRow(changeSetId: string) {
    const c = this.db
      .prepare(
        "SELECT id, session_id, head_commit, status, execution_mode FROM change_sets WHERE id = ?",
      )
      .get(changeSetId) as
      | {
          id: string;
          session_id: string;
          head_commit: string;
          status: string;
          execution_mode: ExecutionMode;
        }
      | undefined;
    if (!c) throw new HttpError(404, "Not found");
    return c;
  }

  submitReview(
    userId: string,
    changeSetId: string,
    decision: "approve" | "request_changes" | "comment",
    body: string,
  ) {
    const c = this.changeSetRow(changeSetId);
    this.requireSession(userId, c.session_id, "collaborator");
    if (c.status !== "open") throw new HttpError(409, `Change set is ${c.status}`);
    this.db
      .prepare(
        "INSERT INTO reviews (id, change_set_id, reviewer_id, decision, body, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(newId("rev"), changeSetId, userId, decision, body.slice(0, 8000), nowIso());
    this.appendEvent(c.session_id, {
      type: "review.submitted",
      actorKind: "user",
      actorUserId: userId,
      payload: { changeSetId, decision, body: body.slice(0, 2000) },
    });
  }

  requestMerge(userId: string, changeSetId: string, opts: { confirmSimulated?: boolean } = {}) {
    const c = this.changeSetRow(changeSetId);
    const { session } = this.requireSession(userId, c.session_id, "owner");
    if (c.status !== "open") throw new HttpError(409, `Change set is ${c.status}`);
    const latest = this.latestChangeSet(c.session_id);
    if (latest?.id !== c.id) throw new HttpError(409, "A newer change set exists");
    const approvals = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM reviews r WHERE r.change_set_id = ? AND r.decision = 'approve'
         AND NOT EXISTS (SELECT 1 FROM reviews r2 WHERE r2.change_set_id = r.change_set_id
           AND r2.reviewer_id = r.reviewer_id AND r2.decision = 'request_changes'
           AND r2.created_at > r.created_at)`,
      )
      .get(changeSetId) as { n: number };
    if (approvals.n < 1) throw new HttpError(409, "Merge requires at least one approving review");
    if (c.execution_mode === "simulated" && !opts.confirmSimulated) {
      throw new HttpError(
        409,
        "This change set came from a SIMULATED agent; confirm explicitly",
        "confirm_simulated",
      );
    }
    this.db.prepare("UPDATE change_sets SET status = 'merging' WHERE id = ?").run(changeSetId);
    const user = this.getUser(userId)!;
    this.appendEvent(c.session_id, {
      type: "merge.requested",
      actorKind: "user",
      actorUserId: userId,
      payload: { changeSetId, headCommit: c.head_commit },
    });
    this.enqueueCommand(c.session_id, {
      kind: "merge",
      changeSetId,
      branchName: session.branch_name,
      baseBranch: session.base_branch,
      expectedHeadCommit: c.head_commit,
      approvedBy: user.display_name,
    });
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { truncated: json };
  }
}
