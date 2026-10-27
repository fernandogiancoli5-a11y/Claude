import { useEffect, useMemo, useRef, useState } from "react";
import { LIMITS, type SessionEvent, type SessionStatus, TERMINAL_STATUSES } from "@pairloom/shared";
import { ApiError, get, post } from "../api.js";
import { realtime, useRealtime } from "../realtime.js";
import { ErrorState, Loading, useCrumbs, useDialog, useToast } from "../ui.js";
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

/**
 * While the agent may still change the branch, the change set on screen is not final:
 * the worker only reports idle after recording the turn's checkpoint.
 */
const CHANGES_IN_FLUX: SessionStatus[] = [
  "pending",
  "starting",
  "running",
  "awaiting_approval",
  "stopping",
  "disconnected",
];

type Act = (fn: () => Promise<unknown>, success?: string) => Promise<void>;

export function SessionPage({ id, me }: { id: string; me: Me }) {
  const [detail, setDetail] = useState<any>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const refetchTimer = useRef<number | null>(null);
  const toast = useToast();

  const load = () => get(`/api/sessions/${id}`).then(setDetail, (e) => setError(e.message));
  const scheduleRefetch = () => {
    if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => void load(), 120);
  };

  useEffect(() => {
    setEvents([]);
    setDetail(null);
    lastSeq.current = 0;
    void load();
    return realtime.subscribeSession(id, () => lastSeq.current);
  }, [id]);
  useCrumbs(
    detail
      ? [
          { label: detail.project?.name ?? "Project", href: `#/p/${detail.session.projectId}` },
          { label: detail.session.title },
        ]
      : null,
  );

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

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!detail) return <Loading />;
  const { session, role, worker } = detail;
  const isOwner = role === "owner";
  const canInstruct = role !== "viewer";
  const ended = TERMINAL_STATUSES.includes(session.status);
  const simulated = session.executionMode === "simulated";
  const initPayload = [...events].reverse().find((e) => e.type === "agent.init")?.payload as any;
  const agentModel = initPayload?.model
    ? `${initPayload.provider ? `${initPayload.provider} ` : ""}${initPayload.model}`
    : null;

  // Every action refreshes afterwards, success or not: a 409 usually means the state moved on.
  const act: Act = async (fn, success) => {
    try {
      await fn();
      if (success) toast.info(success);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      scheduleRefetch();
    }
  };

  return (
    <div className="stack">
      {simulated ? (
        <div className="banner sim">
          SIMULATED SESSION — no AI model is being called. Activity and file changes are produced by
          a scripted simulator to exercise the collaboration flow.
        </div>
      ) : (
        <div className="banner real">
          Real AI agent session{agentModel ? ` (${agentModel})` : ""} on worker “{worker?.name}”.
          Its output is unverified until the tests run and a human reviews the diff.
        </div>
      )}

      <div className="page-head">
        <div className="title">
          <h1>{session.title}</h1>
          <div className="row wrap small muted">
            <StatusBadge status={session.status} />
            <ModeBadge mode={session.executionMode} />
            {worker && <WorkerBadge worker={worker} />}
            <span>
              Host {session.hostName} · branch <code>{session.branchName}</code> from{" "}
              <code>{session.baseBranch}</code>
            </span>
          </div>
        </div>
        {isOwner && (
          <div className="row wrap">
            {session.status === "interrupted" && (
              <button
                className="primary"
                onClick={() => act(() => post(`/api/sessions/${id}/resume`), "Resume requested")}
              >
                Resume
              </button>
            )}
            <button
              disabled={!["running", "awaiting_approval", "disconnected"].includes(session.status)}
              onClick={() => act(() => post(`/api/sessions/${id}/interrupt`))}
              title="Stop the current turn; the session stays open for more instructions"
            >
              Interrupt turn
            </button>
            <StopButton id={id} ended={ended} act={act} />
          </div>
        )}
      </div>

      {session.status === "interrupted" && (
        <p className="callout warn">
          The worker lost this agent's live process. The conversation below is history, not a live
          agent.
          {session.executionMode === "real" && session.providerSessionId
            ? isOwner
              ? " Resume continues it from the transcript saved on the worker."
              : " The host can resume it from the transcript saved on the worker."
            : ""}
        </p>
      )}
      {session.status === "disconnected" && (
        <p className="callout warn">
          The worker is unreachable. The agent may still be running; updates resume when it
          reconnects.
        </p>
      )}
      {session.status === "pending" && worker && !worker.online && (
        <p className="callout warn">
          Waiting for worker “{worker.name}” to connect. The task starts as soon as it does.
        </p>
      )}
      {session.error && <p className="callout danger">Error: {session.error}</p>}

      <div className="workspace-grid">
        <section className="card flush">
          <div className="card-head">
            <h3 className="grow">Activity</h3>
            <span className="muted small">{events.length} events</span>
          </div>
          <Activity events={events} />
          {canInstruct && !ended && (
            <Composer sessionId={id} isOwner={isOwner} onSent={scheduleRefetch} />
          )}
          {role === "viewer" && (
            <p className="composer muted small">You're a viewer: you can watch but not instruct.</p>
          )}
          {ended && canInstruct && (
            <p className="composer muted small">
              This task has ended; it no longer takes instructions.
            </p>
          )}
        </section>
        <div className="stack">
          <Approvals detail={detail} isOwner={isOwner} act={act} />
          <Review
            events={events}
            detail={detail}
            isOwner={isOwner}
            canReview={canInstruct}
            act={act}
            sessionId={id}
            me={me}
          />
        </div>
      </div>
    </div>
  );
}

function StopButton({ id, ended, act }: { id: string; ended: boolean; act: Act }) {
  const dialog = useDialog();
  return (
    <button
      className="danger"
      disabled={ended}
      onClick={async () => {
        const ok = await dialog.confirm("Stop this task?", {
          body: "The agent process ends and no more instructions can be sent. Its changes stay available for review.",
          confirmLabel: "Stop task",
          danger: true,
        });
        if (ok) await act(() => post(`/api/sessions/${id}/stop`), "Task stopped");
      }}
    >
      Stop task
    </button>
  );
}

// ------------------------------------------------------------------ activity

/** Bookkeeping events stay visible but de-emphasised; people's actions stand out. */
const QUIET = new Set([
  "session.status",
  "instruction.delivered",
  "changes.updated",
  "permission.decided",
  "agent.tool_result",
  "checks.started",
]);
const HUMAN = new Set([
  "instruction.submitted",
  "instruction.approved",
  "instruction.rejected",
  "review.submitted",
  "merge.requested",
]);

function Activity({ events }: { events: SessionEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240)
      el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <div className="feed card-body" ref={ref} aria-live="polite" aria-relevant="additions">
      {events.map((e) => (
        <EventRow key={e.seq} e={e} />
      ))}
      {events.length === 0 && <p className="muted">Waiting for the first activity…</p>}
    </div>
  );
}

function toolSummary(name: string, input: unknown): string {
  let args: any = input;
  if (typeof input === "string") {
    try {
      args = JSON.parse(input);
    } catch {
      return input;
    }
  }
  if (args && typeof args === "object") {
    if (Array.isArray(args.argv)) return args.argv.join(" ");
    if (typeof args.path === "string" && args.path) return args.path;
    if (typeof args.pattern === "string") return `/${args.pattern}/`;
    if (name === "run_tests" || name === "list_files") return "";
  }
  return JSON.stringify(args ?? "");
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
  const time = new Date(e.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const body = (() => {
    switch (e.type) {
      case "session.created":
        return `started the task (${p.executionMode}, ${p.permissionPolicy === "ask_every_time" ? "asks for every tool" : "auto-accepts edits"})`;
      case "session.status":
        return `status → ${p.status}${p.detail ? ` — ${p.detail}` : ""}${p.error ? ` — ${p.error}` : ""}`;
      case "agent.init":
        return p.simulated
          ? "simulator ready (no model)"
          : `agent ready · ${p.provider ? `${p.provider} ` : ""}${p.model}${p.claudeCodeVersion ? ` · Claude Code ${p.claudeCodeVersion}` : ""}${p.resumed ? " · resumed from saved transcript" : ""}`;
      case "agent.text":
        return <div className="agent-text">{p.text ?? p.preview}</div>;
      case "agent.tool_use": {
        const summary = toolSummary(p.toolName, p.input);
        return (
          <span>
            uses <b className="tool-chip">{p.toolName}</b>{" "}
            {summary && <span className="tool-arg mono">{summary}</span>}
          </span>
        );
      }
      case "agent.tool_result":
        return (
          <details>
            <summary className={p.isError ? "error" : ""}>
              {p.isError ? "tool error / denied" : "tool output"}
            </summary>
            <pre>{p.output}</pre>
          </details>
        );
      case "agent.result":
        return (
          <span className={p.isError ? "error" : ""}>
            <b>{resultLabel(p.subtype)}</b> <code>{p.subtype}</code>
            {p.message ? ` — ${p.message}` : ""}
            <span className="muted small">
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
          </span>
        );
      case "checks.started":
        return `running project tests: ${(p.command ?? []).join(" ")}`;
      case "checks.completed":
        return (
          <details>
            <summary className={p.passed ? "ok" : "error"}>
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
            asks to use <b className="tool-chip">{p.toolName}</b>{" "}
            {p.title ?? <code className="clip">{JSON.stringify(p.input)}</code>}
          </span>
        );
      case "permission.decided":
        return `${p.behavior === "allow" ? "allowed" : "denied"} ${p.toolName}`;
      case "changes.updated":
        return `changes: ${p.files?.length ?? 0} file(s) at ${String(p.headCommit).slice(0, 8)}`;
      case "review.submitted":
        return `review: ${p.decision === "approve" ? "approved" : p.decision === "request_changes" ? "requested changes" : "commented"}${p.body ? ` — ${p.body}` : ""}`;
      case "merge.requested":
        return "requested merge";
      case "merge.completed":
        return (
          <span className="ok">
            merged as {String(p.mergeCommit).slice(0, 8)} (local, not pushed)
          </span>
        );
      case "merge.failed":
        return <span className="error">merge failed: {p.error}</span>;
      case "system.notice":
        return <span className={p.level === "error" ? "error" : ""}>{p.message}</span>;
      default:
        return JSON.stringify(p);
    }
  })();
  const cls = QUIET.has(e.type) ? "quiet" : HUMAN.has(e.type) ? "human" : "";
  return (
    <div className={`event ${cls}`}>
      <span className="when">{time}</span>
      <span className="what">
        <span className="who">{who}</span> {body}
      </span>
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
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await post(`/api/sessions/${sessionId}/instructions`, { text });
      setText("");
      if (!isOwner) toast.info("Proposed — the host will approve or reject it.");
      onSent();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        aria-label={isOwner ? "Instruction for the agent" : "Proposed instruction"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
        rows={3}
        maxLength={LIMITS.instructionMaxChars}
        placeholder={
          isOwner
            ? "Instruction for the agent (sent immediately)"
            : "Propose an instruction (the host approves before it reaches the agent)"
        }
        required
      />
      <div className="row between">
        <span className="muted tiny">Ctrl/⌘ + Enter to send</span>
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          {isOwner ? "Send to agent" : "Propose instruction"}
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ approvals

function Approvals({ detail, isOwner, act }: { detail: any; isOwner: boolean; act: Act }) {
  const dialog = useDialog();
  const pendingPerms = detail.permissionRequests.filter((p: any) => p.status === "pending");
  const pendingIns = detail.instructions.filter((i: any) => i.status === "pending_approval");
  if (!pendingPerms.length && !pendingIns.length) return null;
  return (
    <section className="card attention stack" aria-label="Waiting for the host">
      <h3>Waiting for the host</h3>
      {pendingPerms.map((p: any) => (
        <div key={p.id} className="approval">
          <div>
            Agent wants to use <b className="tool-chip">{p.toolName}</b>
            {p.title && <div className="small">{p.title}</div>}
          </div>
          <pre className="clip">{JSON.stringify(p.input, null, 2)}</pre>
          {isOwner ? (
            <div className="row">
              <button
                className="primary"
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
                className="primary"
                onClick={() =>
                  act(() => post(`/api/instructions/${i.id}/decision`, { approve: true }))
                }
              >
                Approve & send
              </button>
              <button
                className="danger"
                onClick={async () => {
                  const note = await dialog.ask(
                    "Reject this instruction?",
                    "Reason (optional, shown to the team)",
                    {
                      confirmLabel: "Reject",
                      danger: true,
                    },
                  );
                  if (note === null) return;
                  await act(() =>
                    post(`/api/instructions/${i.id}/decision`, {
                      approve: false,
                      note: note || undefined,
                    }),
                  );
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

// ------------------------------------------------------------------ review

function Review({
  events,
  detail,
  isOwner,
  canReview,
  act,
  sessionId,
  me,
}: {
  events: SessionEvent[];
  detail: any;
  isOwner: boolean;
  canReview: boolean;
  act: Act;
  sessionId: string;
  me: Me;
}) {
  const cs = detail.changeSet;
  const status: SessionStatus = detail.session.status;
  const [body, setBody] = useState("");
  const dialog = useDialog();

  const inFlux = CHANGES_IN_FLUX.includes(status);
  // Tests count for these changes only if they ran after the latest checkpoint was recorded.
  const lastChanges = [...events].reverse().find((e) => e.type === "changes.updated");
  const lastChecks = [...events]
    .reverse()
    .find((e) => e.type === "checks.completed" || e.type === "checks.started");
  const checksRunning = lastChecks?.type === "checks.started";
  const checksCurrent =
    lastChecks?.type === "checks.completed" && (!lastChanges || lastChecks.seq > lastChanges.seq);
  const checksPassed = checksCurrent && (lastChecks!.payload as any).passed;

  const reviews: any[] = cs?.reviews ?? [];
  const approvals = useMemo(() => {
    // A later "request changes" from the same reviewer withdraws their approval (as on the server).
    const latest = new Map<string, any>();
    for (const r of reviews)
      if (r.decision !== "comment") latest.set(r.reviewerId ?? r.reviewerName, r);
    return [...latest.values()].filter((r) => r.decision === "approve");
  }, [cs]);
  const myLatest = [...reviews]
    .reverse()
    .find((r) => r.reviewerId === me.id && r.decision !== "comment");
  const open = cs?.status === "open";

  const review = (decision: "approve" | "request_changes") =>
    act(
      async () => {
        await post(`/api/changesets/${cs.id}/reviews`, { decision, body });
        setBody("");
      },
      decision === "approve" ? "Approved" : "Changes requested",
    );

  const merge = () =>
    act(async () => {
      try {
        await post(`/api/changesets/${cs.id}/merge`, {});
      } catch (e) {
        if (e instanceof ApiError && e.code === "confirm_simulated") {
          const ok = await dialog.confirm("Merge simulated changes?", {
            body: "These changes came from the SIMULATOR, not an AI agent. Merge them into the worker's base branch anyway?",
            confirmLabel: "Merge anyway",
            danger: true,
          });
          if (ok) await post(`/api/changesets/${cs.id}/merge`, { confirmSimulated: true });
        } else throw e;
      }
    });

  const mergeBlocker = !open
    ? null
    : inFlux
      ? "The agent is still working; its changes may change."
      : approvals.length < 1
        ? "Needs at least one approving review."
        : null;

  return (
    <section className="card flush">
      <div className="card-head">
        <h3 className="grow">Changes for review</h3>
        {canReview && (
          <button
            className="small"
            disabled={inFlux || checksRunning}
            title="Run the project's configured test command on this branch, independent of the agent"
            onClick={() => act(() => post(`/api/sessions/${sessionId}/checks`))}
          >
            {checksRunning && <span className="spinner" />}
            run tests
          </button>
        )}
      </div>
      <div className="card-body stack">
        {lastChecks && (
          <p
            className={`small ${lastChecks.type === "checks.completed" && !(lastChecks.payload as any).passed ? "error" : ""}`}
          >
            {checksRunning
              ? "Project tests running…"
              : `Project tests ${(lastChecks.payload as any).passed ? "passed" : "FAILED"} at ${new Date(lastChecks.createdAt).toLocaleTimeString()} (run by Pairloom, not reported by the agent)`}
          </p>
        )}

        {!cs ? (
          <p className="muted">
            {inFlux
              ? "The agent's edits appear here when its turn ends."
              : "No changes yet. The agent's edits appear here after each turn."}
          </p>
        ) : (
          <>
            {cs.executionMode === "simulated" && (
              <p className="banner sim small">Produced by the SIMULATOR, not an AI agent.</p>
            )}
            {open && (
              <ul className="checklist" aria-label="Merge readiness">
                <Check
                  ok={!inFlux}
                  label={
                    inFlux
                      ? "Agent is working — changes not final"
                      : "Agent's turn finished; changes are final"
                  }
                />
                <Check
                  ok={!!checksPassed}
                  bad={checksCurrent && !checksPassed}
                  label={
                    checksCurrent
                      ? checksPassed
                        ? "Tests passed on these changes"
                        : "Tests failed on these changes"
                      : "Tests not run on these changes yet (optional)"
                  }
                />
                <Check
                  ok={approvals.length > 0}
                  label={
                    approvals.length
                      ? `Approved by ${approvals.map((r) => r.reviewerName).join(", ")}`
                      : "No approving review yet"
                  }
                />
              </ul>
            )}
            <p className="small muted">
              <code>{cs.branchName}</code> {cs.baseCommit.slice(0, 8)}..{cs.headCommit.slice(0, 8)}{" "}
              · status <b>{cs.status}</b>
              {cs.mergeCommit && (
                <>
                  {" "}
                  · merged <code>{cs.mergeCommit.slice(0, 8)}</code> locally on the worker (not
                  pushed)
                </>
              )}
            </p>
            {cs.mergeError && <p className="callout danger small">{cs.mergeError}</p>}
            <ul className="files">
              {cs.files.map((f: any) => (
                <li key={f.path}>
                  <code>{f.path}</code> <span className="add">+{f.insertions}</span>
                  <span className="del">-{f.deletions}</span>
                </li>
              ))}
            </ul>
            <Diff text={cs.diff} />
            {cs.diffTruncated && <p className="callout warn small">Diff truncated for display.</p>}

            {reviews.length > 0 && (
              <div className="stack tight">
                {reviews.map((r: any) => (
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
            )}

            {open && canReview && (
              <div className="stack tight">
                <textarea
                  rows={2}
                  aria-label="Review comment"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Review comment (optional)"
                />
                {inFlux && <p className="muted small">Review opens when the agent's turn ends.</p>}
                <div className="row wrap">
                  <button
                    disabled={inFlux || myLatest?.decision === "approve"}
                    title={
                      myLatest?.decision === "approve" ? "You already approved these changes" : ""
                    }
                    onClick={() => review("approve")}
                  >
                    Approve
                  </button>
                  <button disabled={inFlux} onClick={() => review("request_changes")}>
                    Request changes
                  </button>
                  {isOwner && (
                    <button
                      className="primary"
                      disabled={!!mergeBlocker}
                      title={mergeBlocker ?? ""}
                      onClick={merge}
                    >
                      Merge into {detail.session.baseBranch}
                    </button>
                  )}
                </div>
                {isOwner && mergeBlocker && <p className="muted small">{mergeBlocker}</p>}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Check({ ok, bad, label }: { ok: boolean; bad?: boolean; label: string }) {
  return (
    <li className={bad ? "bad" : ok ? "yes" : "no"}>
      <span className="mark" aria-hidden>
        {bad ? "✕" : ok ? "✓" : "○"}
      </span>
      <span>{label}</span>
    </li>
  );
}

function Diff({ text }: { text: string }) {
  if (!text) return <p className="muted small">No differences from base.</p>;
  return (
    <div className="diff" role="region" aria-label="Diff">
      {text.split("\n").map((line, i) => {
        const cls =
          line.startsWith("diff ") ||
          line.startsWith("+++") ||
          line.startsWith("---") ||
          line.startsWith("index ")
            ? "f"
            : line.startsWith("+")
              ? "a"
              : line.startsWith("-")
                ? "d"
                : line.startsWith("@@")
                  ? "h"
                  : "";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function resultLabel(subtype: string): string {
  if (subtype === "end_turn") return "finished its turn (unverified until tests and review):";
  if (subtype === "success") return "turn ended:";
  if (subtype === "interrupted") return "turn interrupted:";
  if (subtype.startsWith("error_max") || subtype === "error_budget")
    return "turn stopped by a limit:";
  if (subtype.startsWith("error_provider")) return "turn failed (model provider error):";
  return "turn failed:";
}
