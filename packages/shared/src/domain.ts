import { z } from "zod";

/** Workspace roles. Owners host sessions, approve instructions/tools, and merge. */
export const Role = z.enum(["owner", "collaborator", "viewer"]);
export type Role = z.infer<typeof Role>;

/**
 * Whether a session talks to a real model or to the scripted simulator.
 * This is stored on the session and stamped on every event so the UI can never
 * blur the two.
 */
export const ExecutionMode = z.enum(["real", "simulated"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

/**
 * Agent session lifecycle.
 *
 * - pending:      created in the collaboration layer, start command not yet acknowledged
 * - starting:     worker accepted the start command and is preparing the worktree/agent
 * - running:      the agent is working on a turn
 * - awaiting_approval: the agent is blocked on a tool-permission decision
 * - idle:         the agent finished a turn and is live, waiting for the next instruction
 * - disconnected: the worker connection dropped; the agent process may still be alive
 * - interrupted:  the worker reconnected without this session live (process lost).
 *                 The transcript may be resumable on that worker, but no live agent exists.
 * - stopping / stopped: user-requested shutdown
 * - completed:    reserved for sessions ended by the agent itself
 * - failed:       the adapter reported an error that ended the session
 */
export const SessionStatus = z.enum([
  "pending",
  "starting",
  "running",
  "awaiting_approval",
  "idle",
  "disconnected",
  "interrupted",
  "stopping",
  "stopped",
  "completed",
  "failed",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["stopped", "completed", "failed"];
/** Statuses in which a live agent process is believed to exist on the worker. */
export const LIVE_STATUSES: readonly SessionStatus[] = [
  "starting",
  "running",
  "awaiting_approval",
  "idle",
];

/** Tool-permission policy the host chooses when starting a session. */
export const PermissionPolicy = z.enum([
  /** Edits inside the isolated worktree are auto-approved; everything else asks the host. */
  "accept_edits_in_worktree",
  /** Every tool call that needs approval asks the host. */
  "ask_every_time",
]);
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const AdapterKind = z.enum(["claude-agent-sdk", "simulated"]);
export type AdapterKind = z.infer<typeof AdapterKind>;

export const AdapterInfo = z.object({
  kind: AdapterKind,
  available: z.boolean(),
  /** Human-readable reason, e.g. "ANTHROPIC_API_KEY not set on worker". Never a secret. */
  detail: z.string().max(500),
  version: z.string().max(100).optional(),
});
export type AdapterInfo = z.infer<typeof AdapterInfo>;

/** Event types recorded in a session's activity log. */
export const SessionEventType = z.enum([
  "session.created",
  "session.status",
  "agent.init",
  "agent.text",
  "agent.tool_use",
  "agent.tool_result",
  "agent.result",
  "agent.error",
  "instruction.submitted",
  "instruction.approved",
  "instruction.rejected",
  "instruction.delivered",
  "permission.requested",
  "permission.decided",
  "changes.updated",
  "review.submitted",
  "merge.requested",
  "merge.completed",
  "merge.failed",
  "system.notice",
]);
export type SessionEventType = z.infer<typeof SessionEventType>;

export type ActorKind = "user" | "agent" | "worker" | "system";

export interface SessionEvent {
  sessionId: string;
  seq: number;
  type: SessionEventType;
  actorKind: ActorKind;
  actorUserId: string | null;
  actorName: string | null;
  executionMode: ExecutionMode;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentSessionDTO {
  id: string;
  projectId: string;
  workerId: string;
  hostUserId: string;
  hostName: string;
  title: string;
  status: SessionStatus;
  executionMode: ExecutionMode;
  permissionPolicy: PermissionPolicy;
  providerSessionId: string | null;
  branchName: string;
  baseBranch: string;
  lastSeq: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface WorkerDTO {
  id: string;
  projectId: string;
  name: string;
  kind: "local" | "cloud";
  online: boolean;
  lastSeenAt: string | null;
  adapters: AdapterInfo[];
  revoked: boolean;
}

export const LIMITS = {
  instructionMaxChars: 8000,
  titleMaxChars: 200,
  /** Max unified diff bytes a worker may upload per change set. */
  diffMaxBytes: 512 * 1024,
  /** Max chars of tool input/output kept in the activity log per event. */
  toolPayloadMaxChars: 4000,
  agentTextMaxChars: 20000,
  instructionsPerMinutePerUser: 20,
} as const;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}
