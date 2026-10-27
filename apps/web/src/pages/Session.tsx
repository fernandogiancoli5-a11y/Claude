import { useEffect, useMemo, useRef, useState } from "react";
import { LIMITS, type SessionEvent, TERMINAL_STATUSES } from "@pairloom/shared";
import { ApiError, get, post } from "../api.js";
import { realtime, useRealtime } from "../realtime.js";
import { ModeBadge, StatusBadge, WorkerBadge } from "./badges.js";
import type { Me } from "../App.js";

const REFETCH_ON = new Set([
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
  "session.status",
  "system.notice",
]);

export function SessionPage({ id, me }: { id: string; me: Me }) {
  const [detail, setDetail] = useState<any>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const refetchTimer = useRef<number | null>(null);

  const load = () => get(`/api/sessions/${id}`).then(setDetail, (e) => setError(e.message));
  const scheduleRefetch = () => {
    if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => void load(), 120);
  };

  useEffect(() => {
    setEvents([]);
    lastSeq.current = 0;
    void load();
    return realtime.subscribeSession(id, () => lastSeq.current);
  }, [id]);

  useRealtime(
    (m) => {
      if (m.t === "event" && m.event.sessionId === id) {
        // Dedupe by seq: replays after reconnect may overlap what we already have.
        if (m.event.seq <= lastSeq.current) return;
        lastSeq.current = m.event.seq;
        setEvents((prev) => [...prev, m.event]);
        if (REFETCH_ON.has(m.event.type)) scheduleRefetch();
      }
      if (m.t === "session" && m.session.id === id) {
        setDetail((d: any) => d && { ...d, session: m.session });
      }
      if (m.t === "worker")
        setDetail((d: any) => (d && d.worker?.id === m.worker.id ? { ...d, worker: m.worker } : d));
      if (m.t === "error" && m.code === "revoked")
        setError("Your access to this workspace was removed.");
    },
    [id],
  );

  if (error) return <p className="error">{error}</p>;
  if (!detail) return <p className="muted">Loading…</p>;
  const { session, role, worker } = detail;
  const isOwner = role === "owner";
  const canInstruct = role !== "viewer";
  const ended = TERMINAL_STATUSES.includes(session.status);
  const simulated = session.executionMode === "simulated";
  const initPayload = [...events].reverse().find((e) => e.type === "agent.init")?.payload as any;
  const agentModel = initPayload?.model
    ? `${initPayload.provider ? `${initPayload.provider} ` : ""}${initPayload.model}`
    : null;
  const lastChecks = [...events]
    .reverse()
    .find((e) => e.type === "checks.completed" || e.type === "checks.started");

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      scheduleRefetch();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <p>
        <a href={`#/p/${session.projectId}`}>← project</a>
      </p>
      {simulated ? (
        <div className="banner sim">
          SIMULATED SESSION — no AI model is being called. Activity and file changes are produced by
          a scripted simulator to exercise the collaboration flow.
        </div>
      ) : (
        <div className="banner real">
          Real AI agent session
          {agentModel ? ` (${agentModel})` : ""} running on worker “{worker?.name}”. Its output is
          unverified until the tests run and a human reviews the diff.
        </div>
      )}
      <div className="row wrap">
        <h2 className="grow">{session.title}</h2>
        <StatusBadge status={session.status} />
        <ModeBadge mode={session.executionMode} />
        {worker && <WorkerBadge worker={worker} />}
      </div>
      <p className="muted small">
        Host {session.hostName} · branch <code>{session.branchName}</code> from{" "}
        <code>{session.baseBranch}</code>
        {session.providerSessionId && (
          <>
            {" "}
            · agent session <code>{session.providerSessionId}</code>
          </>
        )}
      </p>
      {session.status === "interrupted" && (
        <p className="notice">
          The worker lost this agent's live process. The stored conversation is history, not a live
          agent.
          {isOwner &&
            session.executionMode === "real" &&
            session.providerSessionId &&
            " You can resume it from the saved transcript on the worker."}
        </p>
      )}
      {session.status === "disconnected" && (
        <p className="notice">
          The worker is unreachable. The agent may still be running; updates will resume when it
          reconnects.
        </p>
      )}
      {session.error && <p className="error">Error: {session.error}</p>}
      {isOwner && (
        <div className="row">
          <button
            disabled={!["running", "awaiting_approval", "disconnected"].includes(session.status)}
            onClick={() => act(() => post(`/api/sessions/${id}/interrupt`))}
          >
            Interrupt turn
          </button>
          <button
            className="danger"
            disabled={ended}
            onClick={() =>
              confirm("Stop this session? The agent process will be ended.") &&
              act(() => post(`/api/sessions/${id}/stop`))
            }
          >
            Stop session
          </button>
          {session.status === "interrupted" && (
            <button onClick={() => act(() => post(`/api/sessions/${id}/resume`))}>Resume</button>
          )}
        </div>
      )}

      <div className="columns">
        <div className="stack">
          <Activity events={events} />
          {canInstruct && !ended && (
            <Composer sessionId={id} isOwner={isOwner} onSent={scheduleRefetch} />
          )}
          {role === "viewer" && <p className="muted small">You're a viewer: read only.</p>}
        </div>
        <div className="stack">
          <Approvals detail={detail} isOwner={isOwner} act={act} me={me} />
          <Changes
            lastChecks={lastChecks}
            detail={detail}
            isOwner={isOwner}
            canReview={canInstruct}
            act={act}
            sessionId={id}
          />
        </div>
      </div>
    </div>
  );
}

function Activity({ events }: { events: SessionEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200)
      el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <section className="card">
      <h3>Activity</h3>
      <div className="feed" ref={ref}>
        {events.map((e) => (
          <EventRow key={e.seq} e={e} />
        ))}
        {events.length === 0 && <p className="muted">No activity yet.</p>}
      </div>
    </section>
  );
}

function EventRow({ e }: { e: SessionEvent }) {
  const p = e.payload as any;
  const who =
    e.actorName ??
    (e.actorKind === "agent"
      ? e.executionMode === "simulated"
        ? "simulator"
        : "agent"
      : e.actorKind);
  const time = new Date(e.createdAt).toLocaleTimeString();
  const body = (() => {
    switch (e.type) {
      case "session.created":
        return `started session (${p.executionMode}, ${p.permissionPolicy})`;
      case "session.status":
        return `status → ${p.status}${p.detail ? ` — ${p.detail}` : ""}${p.error ? ` — ${p.error}` : ""}`;
      case "agent.init":
        return p.simulated
          ? "simulator ready (no model)"
          : `agent ready · ${p.provider ? `${p.provider} ` : ""}${p.model}${p.claudeCodeVersion ? ` · Claude Code ${p.claudeCodeVersion}` : ""}${p.resumed ? " · resumed from saved transcript" : ""}`;
      case "agent.text":
        return <div className="agent-text">{p.text ?? p.preview}</div>;
      case "agent.tool_use":
        return (
          <span>
            uses <b>{p.toolName}</b> <code className="clip">{String(p.input ?? "")}</code>
          </span>
        );
      case "agent.tool_result":
        return (
          <details>
            <summary className={p.isError ? "error" : ""}>
              {p.isError ? "tool error / denied" : "tool result"}
            </summary>
            <pre>{p.output}</pre>
          </details>
        );
      case "agent.result":
        return (
          <span className={p.isError ? "error" : ""}>
            {resultLabel(p.subtype)} <code>{p.subtype}</code>
            {p.message ? ` — ${p.message}` : ""}
            {p.lastTestRun
              ? ` · agent's last test run: exit ${p.lastTestRun.exitCode}${p.lastTestRun.timedOut ? " (timed out)" : ""}`
              : ""}
            {typeof p.totalCostUsd === "number" && !p.simulated
              ? ` · ≈$${p.totalCostUsd.toFixed(4)}${p.costIsEstimate ? " est." : ""}`
              : ""}
            {p.modelCallsThisTurn
              ? ` · ${p.modelCallsThisTurn} model calls`
              : p.numTurns
                ? ` · ${p.numTurns} steps`
                : ""}
          </span>
        );
      case "checks.started":
        return `running project tests: ${(p.command ?? []).join(" ")}`;
      case "checks.completed":
        return (
          <details>
            <summary className={p.passed ? "" : "error"}>
              project tests {p.passed ? "PASSED" : p.timedOut ? "TIMED OUT" : "FAILED"} (exit{" "}
              {String(p.exitCode)})
            </summary>
            <pre>{p.output}</pre>
          </details>
        );
      case "agent.error":
        return <span className="error">{p.message}</span>;
      case "instruction.submitted":
        return (
          <span>
            {p.requiresApproval ? "proposed" : "sent"}: <i>“{p.text}”</i>
          </span>
        );
      case "instruction.approved":
        return "approved an instruction";
      case "instruction.rejected":
        return `rejected an instruction${p.note ? `: ${p.note}` : ""}`;
      case "instruction.delivered":
        return "instruction delivered to agent";
      case "permission.requested":
        return (
          <span>
            asks to use <b>{p.toolName}</b>:{" "}
            {p.title ?? <code className="clip">{JSON.stringify(p.input)}</code>}
          </span>
        );
      case "permission.decided":
        return `${p.behavior === "allow" ? "allowed" : "denied"} ${p.toolName}`;
      case "changes.updated":
        return `changes: ${p.files?.length ?? 0} file(s) at ${String(p.headCommit).slice(0, 8)}`;
      case "review.submitted":
        return `review: ${p.decision}${p.body ? ` — ${p.body}` : ""}`;
      case "merge.requested":
        return "requested merge";
      case "merge.completed":
        return `merged as ${String(p.mergeCommit).slice(0, 8)} (local, not pushed)`;
      case "merge.failed":
        return <span className="error">merge failed: {p.error}</span>;
      case "system.notice":
        return <span className={p.level === "error" ? "error" : ""}>{p.message}</span>;
      default:
        return JSON.stringify(p);
    }
  })();
  return (
    <div className={`event ev-${e.type.replace(".", "-")}`}>
      <span className="when">{time}</span> <span className="who">{who}</span>{" "}
      <span className="what">{body}</span>
    </div>
  );
}

function Composer({
  sessionId,
  isOwner,
  onSent,
}: {
  sessionId: string;
  isOwner: boolean;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await post(`/api/sessions/${sessionId}/instructions`, { text });
          setText("");
          onSent();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={LIMITS.instructionMaxChars}
        placeholder={
          isOwner
            ? "Instruction for the agent (sent immediately)"
            : "Propose an instruction (the host approves before it reaches the agent)"
        }
        required
      />
      {error && <p className="error">{error}</p>}
      <button type="submit">{isOwner ? "Send to agent" : "Propose instruction"}</button>
    </form>
  );
}

function Approvals({
  detail,
  isOwner,
  act,
}: {
  lastChecks?: SessionEvent;
  detail: any;
  isOwner: boolean;
  act: (f: () => Promise<unknown>) => void;
  me: Me;
}) {
  const pendingPerms = detail.permissionRequests.filter((p: any) => p.status === "pending");
  const pendingIns = detail.instructions.filter((i: any) => i.status === "pending_approval");
  if (!pendingPerms.length && !pendingIns.length) return null;
  return (
    <section className="card stack attention">
      <h3>Waiting for the host</h3>
      {pendingPerms.map((p: any) => (
        <div key={p.id} className="approval">
          <div>
            Agent wants to use <b>{p.toolName}</b>
            {p.title && <div className="small">{p.title}</div>}
            <pre className="clip">{JSON.stringify(p.input, null, 2)}</pre>
          </div>
          {isOwner ? (
            <div className="row">
              <button
                onClick={() =>
                  act(() => post(`/api/permissions/${p.id}/decision`, { allow: true }))
                }
              >
                Allow once
              </button>
              <button
                className="danger"
                onClick={() =>
                  act(() => post(`/api/permissions/${p.id}/decision`, { allow: false }))
                }
              >
                Deny
              </button>
            </div>
          ) : (
            <p className="muted small">Only an owner can approve tool use.</p>
          )}
        </div>
      ))}
      {pendingIns.map((i: any) => (
        <div key={i.id} className="approval">
          <div>
            <b>{i.authorName}</b> proposes: <i>“{i.text}”</i>
          </div>
          {isOwner ? (
            <div className="row">
              <button
                onClick={() =>
                  act(() => post(`/api/instructions/${i.id}/decision`, { approve: true }))
                }
              >
                Approve & send
              </button>
              <button
                className="danger"
                onClick={() => {
                  const note = prompt("Reason (optional)") ?? undefined;
                  act(() => post(`/api/instructions/${i.id}/decision`, { approve: false, note }));
                }}
              >
                Reject
              </button>
            </div>
          ) : (
            <p className="muted small">Waiting for an owner to approve.</p>
          )}
        </div>
      ))}
    </section>
  );
}

function Changes({
  lastChecks,
  detail,
  isOwner,
  canReview,
  act,
  sessionId,
}: {
  lastChecks?: SessionEvent;
  detail: any;
  isOwner: boolean;
  canReview: boolean;
  act: (f: () => Promise<unknown>) => void;
  sessionId: string;
}) {
  const cs = detail.changeSet;
  const [body, setBody] = useState("");
  const approvals = useMemo(
    () => (cs?.reviews ?? []).filter((r: any) => r.decision === "approve").length,
    [cs],
  );
  return (
    <section className="card stack">
      <div className="row">
        <h3 className="grow">Changes for review</h3>
        {canReview && (
          <button
            className="link"
            disabled={detail.session.status === "running" || lastChecks?.type === "checks.started"}
            title="Run the project's configured test command on this branch, independent of the agent"
            onClick={() => act(() => post(`/api/sessions/${sessionId}/checks`))}
          >
            run tests
          </button>
        )}
        {canReview && (
          <button
            className="link"
            onClick={() => act(() => post(`/api/sessions/${sessionId}/changes/refresh`))}
          >
            refresh
          </button>
        )}
      </div>
      {lastChecks && (
        <p
          className={`small ${lastChecks.type === "checks.completed" && !(lastChecks.payload as any).passed ? "error" : ""}`}
        >
          {lastChecks.type === "checks.started"
            ? "Project tests running…"
            : `Project tests ${(lastChecks.payload as any).passed ? "passed" : "FAILED"} at ${new Date(lastChecks.createdAt).toLocaleTimeString()} (run by Pairloom, not reported by the agent)`}
        </p>
      )}
      {!cs && (
        <p className="muted">No changes yet. The agent's edits appear here after each turn.</p>
      )}
      {cs && (
        <>
          {cs.executionMode === "simulated" && (
            <p className="banner sim small">Produced by the SIMULATOR, not an AI agent.</p>
          )}
          <p className="small">
            <code>{cs.branchName}</code> {cs.baseCommit.slice(0, 8)}..{cs.headCommit.slice(0, 8)} ·
            status <b>{cs.status}</b>
            {cs.mergeCommit && (
              <>
                {" "}
                · merged <code>{cs.mergeCommit.slice(0, 8)}</code> locally on the worker (not
                pushed)
              </>
            )}
          </p>
          {cs.mergeError && <p className="error">{cs.mergeError}</p>}
          <ul className="files">
            {cs.files.map((f: any) => (
              <li key={f.path}>
                <code>{f.path}</code> <span className="add">+{f.insertions}</span>{" "}
                <span className="del">-{f.deletions}</span>
              </li>
            ))}
          </ul>
          <Diff text={cs.diff} />
          {cs.diffTruncated && <p className="notice small">Diff truncated for display.</p>}
          <div className="stack">
            {cs.reviews.map((r: any) => (
              <div key={r.id} className="small">
                <b>{r.reviewerName}</b>{" "}
                {r.decision === "approve"
                  ? "approved"
                  : r.decision === "request_changes"
                    ? "requested changes"
                    : "commented"}
                {r.body && `: ${r.body}`}
              </div>
            ))}
          </div>
          {cs.status === "open" && canReview && (
            <div className="stack">
              <textarea
                rows={2}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Review comment"
              />
              <div className="row wrap">
                <button
                  onClick={() =>
                    act(async () => {
                      await post(`/api/changesets/${cs.id}/reviews`, { decision: "approve", body });
                      setBody("");
                    })
                  }
                >
                  Approve
                </button>
                <button
                  onClick={() =>
                    act(async () => {
                      await post(`/api/changesets/${cs.id}/reviews`, {
                        decision: "request_changes",
                        body,
                      });
                      setBody("");
                    })
                  }
                >
                  Request changes
                </button>
                {isOwner && (
                  <button
                    className="primary"
                    disabled={approvals < 1}
                    title={approvals < 1 ? "Needs at least one approving review" : ""}
                    onClick={() =>
                      act(async () => {
                        try {
                          await post(`/api/changesets/${cs.id}/merge`, {});
                        } catch (e) {
                          if (e instanceof ApiError && e.code === "confirm_simulated") {
                            if (
                              confirm(
                                "These changes came from the SIMULATOR, not an AI agent. Merge into the worker's base branch anyway?",
                              )
                            ) {
                              await post(`/api/changesets/${cs.id}/merge`, {
                                confirmSimulated: true,
                              });
                            }
                          } else throw e;
                        }
                      })
                    }
                  >
                    Merge into {detail.session.baseBranch}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Diff({ text }: { text: string }) {
  if (!text) return <p className="muted small">No differences from base.</p>;
  return (
    <pre className="diff">
      {text.split("\n").map((line, i) => {
        const cls =
          line.startsWith("+++") || line.startsWith("---")
            ? "meta"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : line.startsWith("@@")
                  ? "hunk"
                  : line.startsWith("diff ")
                    ? "meta"
                    : "";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function resultLabel(subtype: string): string {
  if (subtype === "end_turn") return "agent finished its turn (unverified until tests and review):";
  if (subtype === "success") return "turn ended:";
  if (subtype === "interrupted") return "turn interrupted:";
  if (subtype.startsWith("error_max") || subtype === "error_budget")
    return "turn stopped by a limit:";
  if (subtype.startsWith("error_provider")) return "turn failed (model provider error):";
  return "turn failed:";
}
