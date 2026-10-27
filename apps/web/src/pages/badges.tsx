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
