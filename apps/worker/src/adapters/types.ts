import type { AdapterInfo, PermissionPolicy, SessionEventType } from "@pairloom/shared";

export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  decisionReason?: string;
  signal?: AbortSignal;
}

export type PermissionAnswer = { behavior: "allow" } | { behavior: "deny"; message: string };

export interface TurnOutcome {
  /** Exactly what the provider reported, e.g. "success", "error_max_turns", "interrupted". */
  subtype: string;
  isError: boolean;
}

/** What an adapter may do to the outside world. Everything is mediated by the session manager. */
export interface AgentContext {
  sessionId: string;
  cwd: string;
  title: string;
  permissionPolicy: PermissionPolicy;
  resumeProviderSessionId: string | null;
  emit(type: SessionEventType, payload: Record<string, unknown>): void;
  requestPermission(ask: PermissionAsk): Promise<PermissionAnswer>;
  onProviderSession(providerSessionId: string): void;
  onTurnStart(): void;
  onTurnEnd(outcome: TurnOutcome): void;
  /** The adapter's agent ended for good (process exit, fatal error). */
  onExit(result: { error: string | null }): void;
}

export interface AgentRun {
  send(text: string): void;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  info(): AdapterInfo;
  start(ctx: AgentContext): Promise<AgentRun>;
}
