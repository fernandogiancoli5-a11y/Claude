import type { ExecutionMode, SessionStatus, WorkerDTO } from "@pairloom/shared";

const STATUS_LABEL: Record<SessionStatus, string> = {
  pending: "waiting for worker",
  starting: "starting",
  running: "agent working",
  awaiting_approval: "needs approval",
  idle: "idle — ready for instructions",
  disconnected: "worker disconnected",
  interrupted: "interrupted — live agent lost",
  stopping: "stopping",
  stopped: "stopped",
  completed: "agent exited",
  failed: "failed",
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function ModeBadge({ mode }: { mode: ExecutionMode }) {
  return mode === "real" ? (
    <span className="badge mode-real">REAL agent</span>
  ) : (
    <span className="badge mode-sim">SIMULATED</span>
  );
}

export function WorkerBadge({ worker }: { worker: WorkerDTO }) {
  if (worker.revoked) return <span className="badge status-failed">revoked</span>;
  return worker.online ? (
    <span className="badge status-idle">online</span>
  ) : (
    <span className="badge status-disconnected" title={worker.lastSeenAt ?? ""}>
      offline
      {worker.lastSeenAt ? ` · last seen ${new Date(worker.lastSeenAt).toLocaleTimeString()}` : ""}
    </span>
  );
}
