import { z } from "zod";
import { AdapterInfo, ExecutionMode, PermissionPolicy, SessionEventType, SessionStatus } from "./domain.js";

/**
 * Worker <-> collaboration server protocol (WebSocket, JSON text frames).
 *
 * The worker always dials out to the server, so the same protocol works for a
 * cloud container and for a local companion behind NAT.
 *
 * Reliability model:
 * - Every worker->server event carries a worker-generated UUID. The server stores
 *   it under a UNIQUE constraint and acks it; the worker keeps unacked events in
 *   an outbox and resends them after reconnecting. Duplicates are dropped.
 * - Every server->worker command is persisted and carries a UUID. The server
 *   resends unacked commands on reconnect; the worker remembers processed ids.
 */
export const WORKER_PROTOCOL_VERSION = 1;

export const LiveSessionReport = z.object({
  sessionId: z.string(),
  status: SessionStatus,
  providerSessionId: z.string().nullable(),
});
export type LiveSessionReport = z.infer<typeof LiveSessionReport>;

export const WorkerHello = z.object({
  t: z.literal("hello"),
  protocol: z.literal(WORKER_PROTOCOL_VERSION),
  workerVersion: z.string().max(50),
  adapters: z.array(AdapterInfo).max(10),
  liveSessions: z.array(LiveSessionReport).max(100),
});

export const WorkerEvent = z.object({
  t: z.literal("event"),
  id: z.string().uuid(),
  sessionId: z.string().max(64),
  type: SessionEventType,
  payload: z.record(z.string(), z.unknown()),
});
export type WorkerEvent = z.infer<typeof WorkerEvent>;

export const WorkerCommandAck = z.object({
  t: z.literal("command_ack"),
  id: z.string().uuid(),
  ok: z.boolean(),
  error: z.string().max(2000).optional(),
});

export const WorkerToServer = z.discriminatedUnion("t", [
  WorkerHello,
  WorkerEvent,
  WorkerCommandAck,
  z.object({ t: z.literal("ping") }),
]);
export type WorkerToServer = z.infer<typeof WorkerToServer>;

export const StartCommand = z.object({
  kind: z.literal("start"),
  executionMode: ExecutionMode,
  permissionPolicy: PermissionPolicy,
  title: z.string(),
  baseBranch: z.string(),
  branchName: z.string(),
  /** When set, resume this provider (Claude) session instead of starting fresh. */
  resumeProviderSessionId: z.string().nullable(),
});

export const MessageCommand = z.object({
  kind: z.literal("message"),
  instructionId: z.string(),
  authorName: z.string(),
  text: z.string(),
});

export const PermissionDecisionCommand = z.object({
  kind: z.literal("permission_decision"),
  requestId: z.string(),
  behavior: z.enum(["allow", "deny"]),
  message: z.string().optional(),
  decidedBy: z.string(),
});

export const MergeCommand = z.object({
  kind: z.literal("merge"),
  changeSetId: z.string(),
  branchName: z.string(),
  baseBranch: z.string(),
  expectedHeadCommit: z.string(),
  approvedBy: z.string(),
});

export const SessionCommand = z.discriminatedUnion("kind", [
  StartCommand,
  MessageCommand,
  PermissionDecisionCommand,
  z.object({ kind: z.literal("interrupt") }),
  z.object({ kind: z.literal("stop") }),
  z.object({ kind: z.literal("refresh_changes"), branchName: z.string(), baseBranch: z.string() }),
  MergeCommand,
]);
export type SessionCommand = z.infer<typeof SessionCommand>;

export const ServerToWorker = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    workerId: z.string(),
    projectId: z.string(),
  }),
  z.object({ t: z.literal("ack"), id: z.string() }),
  z.object({
    t: z.literal("command"),
    id: z.string().uuid(),
    sessionId: z.string(),
    command: SessionCommand,
  }),
  z.object({ t: z.literal("pong") }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);
export type ServerToWorker = z.infer<typeof ServerToWorker>;

/** Payload shapes for worker-originated events the server interprets. */
export const StatusPayload = z.object({
  status: SessionStatus,
  providerSessionId: z.string().nullable().optional(),
  error: z.string().max(4000).nullable().optional(),
  detail: z.string().max(2000).optional(),
});

export const PermissionRequestedPayload = z.object({
  requestId: z.string().max(100),
  toolName: z.string().max(200),
  input: z.record(z.string(), z.unknown()),
  title: z.string().max(1000).optional(),
  decisionReason: z.string().max(1000).optional(),
});

export const ChangesUpdatedPayload = z.object({
  baseCommit: z.string().max(64),
  headCommit: z.string().max(64),
  branchName: z.string().max(200),
  files: z
    .array(
      z.object({
        path: z.string().max(1000),
        insertions: z.number().int(),
        deletions: z.number().int(),
      }),
    )
    .max(2000),
  diff: z.string(),
  diffTruncated: z.boolean(),
});
export type ChangesUpdatedPayload = z.infer<typeof ChangesUpdatedPayload>;

export const MergeResultPayload = z.object({
  changeSetId: z.string(),
  mergeCommit: z.string().optional(),
  error: z.string().max(4000).optional(),
});
