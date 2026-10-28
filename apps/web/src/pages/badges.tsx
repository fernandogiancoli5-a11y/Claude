import type { ExecutionMode, SessionStatus, WorkerDTO } from "@pairloom/shared";

const STATUS: Record<SessionStatus, { label: string; tone: string }> = {
  pending: { label: "waiting for worker", tone: "warn" },
  starting: { label: "starting", tone: "busy" },
  running: { label: "agent working", tone: "busy" },
  awaiting_approval: { label: "needs approval", tone: "warn" },
  idle: { label: "idle — ready for instructions", tone: "ok" },
  disconnected: { label: "worker disconnected", tone: "warn" },
  interrupted: { label: "interrupted — live agent lost", tone: "bad" },
  stopping: { label: "stopping", tone: "busy" },
  stopped: { label: "stopped", tone: "" },
  completed: { label: "agent exited", tone: "" },
  failed: { label: "failed", tone: "bad" },
};

/** Short labels for compact lists; the full label stays in the task header. */
const SHORT: Partial<Record<SessionStatus, string>> = {
  idle: "ready",
  interrupted: "interrupted",
  disconnected: "worker offline",
};

export function StatusBadge({ status, short }: { status: SessionStatus; short?: boolean }) {
  const s = STATUS[status] ?? { label: status, tone: "" };
  return <span className={`badge dot tone-${s.tone}`}>{(short && SHORT[status]) || s.label}</span>;
}

/** Flags a task whose latest agent turn ended without finishing (time, step or token limit, error). */
export function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome || outcome === "end_turn" || outcome === "success") return null;
  const label =
    outcome === "interrupted"
      ? "interrupted"
      : outcome.startsWith("error_provider")
        ? "model error"
        : "unfinished";
  return (
    <span className="badge tone-warn" title={`The agent's last turn ended with ${outcome}`}>
      {label}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: ExecutionMode }) {
  return mode === "real" ? (
    <span className="badge">REAL agent</span>
  ) : (
    <span className="badge tone-sim">SIMULATED</span>
  );
}

export function RoleBadge({ role }: { role: string }) {
  return <span className={`badge ${role === "owner" ? "tone-busy" : ""}`}>{role}</span>;
}

export function WorkerBadge({ worker }: { worker: WorkerDTO }) {
  if (worker.revoked) return <span className="badge dot tone-bad">revoked</span>;
  return worker.online ? (
    <span className="badge dot tone-ok">online</span>
  ) : (
    <span className="badge dot" title={worker.lastSeenAt ?? ""}>
      offline
      {worker.lastSeenAt ? ` · last seen ${new Date(worker.lastSeenAt).toLocaleTimeString()}` : ""}
    </span>
  );
}

/** Friendly model name, e.g. "gpt-oss-120b via Groq", never a raw endpoint address. */
export function modelLabel(provider?: string, model?: string): string | null {
  if (!model) return null;
  const short = model.split("/").pop();
  if (!provider) return short ?? model;
  if (provider.startsWith("custom endpoint")) return `${short} on a custom endpoint`;
  return `${short} via ${provider[0]!.toUpperCase()}${provider.slice(1)}`;
}
