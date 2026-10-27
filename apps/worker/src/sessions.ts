import { randomUUID } from "node:crypto";
import {
  type ExecutionMode,
  LIMITS,
  type LiveSessionReport,
  type SessionCommand,
  type SessionEventType,
  type SessionStatus,
} from "@pairloom/shared";
import type { Workspace } from "./git.js";
import type { ServerLink } from "./link.js";
import type { AgentAdapter, AgentRun, PermissionAnswer, PermissionAsk } from "./adapters/types.js";

interface LiveSession {
  id: string;
  executionMode: ExecutionMode;
  run: AgentRun | null;
  status: SessionStatus;
  providerSessionId: string | null;
  worktreePath: string;
  baseCommit: string;
  branchName: string;
  turns: number;
  stopping: boolean;
  lastEmittedHead: string | null;
  pending: Map<string, (a: PermissionAnswer) => void>;
}

type Emitter = Pick<ServerLink, "emit">;

/**
 * Owns live agent runs on this worker. Commands for one session are processed
 * strictly in order; different sessions run independently.
 */
export class SessionManager {
  private sessions = new Map<string, LiveSession>();
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private link: Emitter,
    private workspace: Workspace,
    private adapters: Record<ExecutionMode, AgentAdapter>,
  ) {}

  liveReports(): LiveSessionReport[] {
    return [...this.sessions.values()]
      .filter((s) => s.run && !s.stopping)
      .map((s) => ({ sessionId: s.id, status: s.status, providerSessionId: s.providerSessionId }));
  }

  get(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  handle(sessionId: string, command: SessionCommand): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.dispatch(sessionId, command));
    this.chains.set(sessionId, next);
    return next;
  }

  private emit(sessionId: string, type: SessionEventType, payload: Record<string, unknown>) {
    this.link.emit(sessionId, type, payload);
  }

  private setStatus(
    s: LiveSession,
    status: SessionStatus,
    extra: { error?: string; detail?: string } = {},
  ) {
    if (s.status === status && !extra.error) return;
    s.status = status;
    this.emit(s.id, "session.status", {
      status,
      providerSessionId: s.providerSessionId,
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
    });
  }

  private requireLive(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s?.run || s.stopping) throw new Error("Session is not live on this worker");
    return s;
  }

  private async dispatch(sessionId: string, command: SessionCommand) {
    switch (command.kind) {
      case "start":
        return this.start(sessionId, command);
      case "message": {
        const s = this.requireLive(sessionId);
        s.run!.send(`[Message from ${command.authorName} via Pairloom]\n${command.text}`);
        return;
      }
      case "permission_decision": {
        const s = this.sessions.get(sessionId);
        const resolve = s?.pending.get(command.requestId);
        // Already resolved (aborted/interrupted): nothing to do, and that is not an error.
        if (!s || !resolve) return;
        s.pending.delete(command.requestId);
        resolve(
          command.behavior === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: command.message ?? `Denied by ${command.decidedBy}` },
        );
        if (s.pending.size === 0 && s.status === "awaiting_approval") this.setStatus(s, "running");
        return;
      }
      case "interrupt": {
        const s = this.requireLive(sessionId);
        this.denyAllPending(s, "Interrupted by the session host");
        await s.run!.interrupt();
        return;
      }
      case "stop": {
        const s = this.sessions.get(sessionId);
        if (!s?.run) {
          // Nothing live here; report the terminal state so the server can settle.
          this.emit(sessionId, "session.status", {
            status: "stopped",
            detail: "No live agent on worker",
          });
          return;
        }
        s.stopping = true;
        this.setStatus(s, "stopping");
        this.denyAllPending(s, "Session is stopping");
        await s.run.stop();
        return;
      }
      case "refresh_changes": {
        const s = this.sessions.get(sessionId);
        if (s) return this.snapshot(s, true);
        const wt = await this.workspace.ensureWorktree(
          sessionId,
          command.branchName,
          command.baseBranch,
        );
        const snap = await this.workspace.snapshot(
          wt.path,
          command.branchName,
          wt.baseCommit,
          `pairloom: checkpoint (${sessionId})`,
          LIMITS.diffMaxBytes,
        );
        this.emit(sessionId, "changes.updated", { ...snap });
        return;
      }
      case "merge": {
        const s = this.sessions.get(sessionId);
        if (s && s.status === "running")
          throw new Error("Agent is mid-turn; wait for it to finish");
        try {
          const mergeCommit = await this.workspace.merge(
            command.branchName,
            command.baseBranch,
            command.expectedHeadCommit,
            `Merge ${command.branchName} (Pairloom session ${sessionId}, approved by ${command.approvedBy})`,
          );
          this.emit(sessionId, "merge.completed", {
            changeSetId: command.changeSetId,
            mergeCommit,
          });
        } catch (err) {
          this.emit(sessionId, "merge.failed", {
            changeSetId: command.changeSetId,
            error: (err as Error).message.slice(0, 2000),
          });
        }
        return;
      }
    }
  }

  private async start(sessionId: string, cmd: Extract<SessionCommand, { kind: "start" }>) {
    const existing = this.sessions.get(sessionId);
    if (existing?.run && !existing.stopping) return; // idempotent
    const adapter = this.adapters[cmd.executionMode];
    const info = adapter.info();
    if (!info.available) throw new Error(info.detail);

    const wt = await this.workspace.ensureWorktree(sessionId, cmd.branchName, cmd.baseBranch);
    const s: LiveSession = {
      id: sessionId,
      executionMode: cmd.executionMode,
      run: null,
      status: "pending",
      providerSessionId: cmd.resumeProviderSessionId,
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      branchName: cmd.branchName,
      turns: 0,
      stopping: false,
      lastEmittedHead: null,
      pending: new Map(),
    };
    this.sessions.set(sessionId, s);
    this.setStatus(s, "starting", {
      detail: cmd.resumeProviderSessionId
        ? `Resuming provider session ${cmd.resumeProviderSessionId} in ${wt.path}`
        : `Worktree ready at ${cmd.branchName}`,
    });

    try {
      s.run = await adapter.start({
        sessionId,
        cwd: wt.path,
        title: cmd.title,
        permissionPolicy: cmd.permissionPolicy,
        resumeProviderSessionId: cmd.resumeProviderSessionId,
        emit: (type, payload) => this.emit(sessionId, type, payload),
        requestPermission: (ask) => this.requestPermission(s, ask),
        onProviderSession: (id) => {
          s.providerSessionId = id;
        },
        onTurnStart: () => {
          if (!s.stopping) this.setStatus(s, s.pending.size ? "awaiting_approval" : "running");
        },
        onTurnEnd: () => {
          s.turns += 1;
          if (!s.stopping) this.setStatus(s, "idle");
          void this.snapshot(s, false).catch((err) =>
            this.emit(sessionId, "system.notice", {
              level: "error",
              message: `Could not snapshot changes: ${(err as Error).message}`,
            }),
          );
        },
        onExit: ({ error }) => this.onExit(s, error),
      });
    } catch (err) {
      this.sessions.delete(sessionId);
      throw err;
    }
    if (s.status === "starting") this.setStatus(s, "idle");
  }

  private onExit(s: LiveSession, error: string | null) {
    this.denyAllPending(s, "Agent exited");
    s.run = null;
    if (s.stopping) this.setStatus(s, "stopped");
    else if (error) {
      this.emit(s.id, "agent.error", { message: error.slice(0, 4000) });
      this.setStatus(s, "failed", { error: error.slice(0, 4000) });
    } else this.setStatus(s, "completed", { detail: "Agent process ended" });
  }

  private requestPermission(s: LiveSession, ask: PermissionAsk): Promise<PermissionAnswer> {
    const requestId = randomUUID();
    return new Promise<PermissionAnswer>((resolve) => {
      s.pending.set(requestId, resolve);
      ask.signal?.addEventListener("abort", () => {
        if (s.pending.delete(requestId)) resolve({ behavior: "deny", message: "Request aborted" });
      });
      this.emit(s.id, "permission.requested", {
        requestId,
        toolName: ask.toolName,
        input: ask.input,
        ...(ask.title ? { title: ask.title.slice(0, 1000) } : {}),
        ...(ask.decisionReason ? { decisionReason: ask.decisionReason.slice(0, 1000) } : {}),
      });
      this.setStatus(s, "awaiting_approval");
    });
  }

  private denyAllPending(s: LiveSession, message: string) {
    for (const [, resolve] of s.pending) resolve({ behavior: "deny", message });
    s.pending.clear();
  }

  private async snapshot(s: LiveSession, force: boolean) {
    const tag = s.executionMode === "simulated" ? " [simulated]" : "";
    const snap = await this.workspace.snapshot(
      s.worktreePath,
      s.branchName,
      s.baseCommit,
      `pairloom: checkpoint after turn ${s.turns}${tag} (${s.id})`,
      LIMITS.diffMaxBytes,
    );
    if (!force && snap.headCommit === s.lastEmittedHead) return;
    if (!force && snap.files.length === 0 && s.lastEmittedHead === null) return;
    s.lastEmittedHead = snap.headCommit;
    this.emit(s.id, "changes.updated", { ...snap });
  }

  async stopAll() {
    for (const s of this.sessions.values()) {
      if (s.run) {
        s.stopping = true;
        await s.run.stop().catch(() => {});
      }
    }
  }
}
