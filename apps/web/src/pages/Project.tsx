import { useEffect, useState } from "react";
import type { AgentSessionDTO, WorkerDTO } from "@pairloom/shared";
import { del, get, post } from "../api.js";
import { navigate } from "../router.js";
import { realtime, useRealtime } from "../realtime.js";
import {
  Avatar,
  CopyButton,
  Empty,
  ErrorState,
  Loading,
  timeAgo,
  useAction,
  useCrumbs,
  useDialog,
} from "../ui.js";
import { ModeBadge, RoleBadge, StatusBadge, WorkerBadge } from "./badges.js";
import type { Me } from "../App.js";

type Tab = "tasks" | "team" | "setup";

export function ProjectPage({ id }: { id: string; me: Me }) {
  const [project, setProject] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);

  const load = () => get(`/api/projects/${id}`).then(setProject, (e) => setError(e.message));
  useEffect(() => {
    setProject(null);
    setTab(null);
    void load();
    return realtime.subscribeProject(id);
  }, [id]);
  useCrumbs(
    project
      ? [
          { label: project.workspaceName, href: `#/w/${project.workspaceId}` },
          { label: project.name, href: `#/p/${id}` },
        ]
      : null,
  );

  useRealtime(
    (m) => {
      if (m.t === "worker" && m.worker.projectId === id) {
        setProject((p: any) => p && { ...p, workers: upsert(p.workers, m.worker) });
      }
      if (m.t === "session" && m.session.projectId === id) {
        setProject((p: any) => p && { ...p, sessions: upsert(p.sessions, m.session, true) });
      }
    },
    [id],
  );

  // Pick the opening tab once per project; later changes (e.g. a worker connecting) don't
  // move the user. First run: nothing can happen until a worker exists, so lead with setup.
  useEffect(() => {
    if (!project || tab) return;
    const hasWorker = project.workers.some((w: WorkerDTO) => !w.revoked);
    setTab(!hasWorker && project.role === "owner" ? "setup" : "tasks");
  }, [project, tab]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!project) return <Loading />;
  const isOwner = project.role === "owner";
  const activeWorkers = project.workers.filter((w: WorkerDTO) => !w.revoked);
  const current: Tab = tab ?? "tasks";

  return (
    <div className="stack">
      <div className="page-head">
        <div className="title">
          <span className="eyebrow">Project</span>
          <h1>{project.name}</h1>
          <p className="muted small">
            Team <a href={`#/w/${project.workspaceId}`}>{project.workspaceName}</a> · base branch{" "}
            <code>{project.defaultBranch}</code> · you're <RoleBadge role={project.role} />
          </p>
        </div>
        <div className="avatars" aria-label={`${project.members.length} members`}>
          {project.members.slice(0, 6).map((m: any) => (
            <Avatar key={m.id} id={m.id} name={m.displayName} />
          ))}
        </div>
      </div>

      <div className="tabs" role="tablist">
        {(
          [
            ["tasks", "Tasks", project.sessions.length],
            ["team", "Team", project.members.length],
            ["setup", "Workers", activeWorkers.length],
          ] as const
        ).map(([t, label, n]) => (
          <button key={t} role="tab" aria-selected={current === t} onClick={() => setTab(t)}>
            {label} <span className="count">{n}</span>
          </button>
        ))}
      </div>

      {current === "tasks" && (
        <div className="split">
          <TaskList sessions={project.sessions} />
          <div className="stack">
            {isOwner ? (
              activeWorkers.length ? (
                <NewTask project={project} />
              ) : (
                <div className="card stack tight">
                  <h3>Connect a worker first</h3>
                  <p className="muted small">
                    Tasks run on a worker next to a clone of the repository.
                  </p>
                  <button onClick={() => setTab("setup")}>Set up a worker</button>
                </div>
              )
            ) : (
              <div className="card stack tight">
                <h3>How you can help</h3>
                <p className="muted small">
                  {project.role === "viewer"
                    ? "Viewers can watch tasks and changes as they happen."
                    : "Open a task to follow the agent live, propose instructions, run the tests and review its changes. An owner starts tasks."}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {current === "team" && <TeamTab project={project} />}
      {current === "setup" && <Workers project={project} isOwner={isOwner} reload={load} />}
    </div>
  );
}

function TaskList({ sessions }: { sessions: AgentSessionDTO[] }) {
  return (
    <section className="card flush">
      <div className="card-head">
        <h3 className="grow">Tasks</h3>
      </div>
      {sessions.length === 0 ? (
        <Empty title="No tasks yet">
          Each task is an agent session on its own git branch. Its activity, approvals and changes
          stay here for the whole team.
        </Empty>
      ) : (
        <div>
          {sessions.map((s) => (
            <a key={s.id} className="task-row" href={`#/s/${s.id}`}>
              <div className="meta">
                <b>{s.title}</b>
                <span className="muted small">
                  {s.hostName} · started {timeAgo(s.createdAt)} · updated {timeAgo(s.updatedAt)}
                </span>
              </div>
              {s.executionMode === "simulated" && <ModeBadge mode={s.executionMode} />}
              <StatusBadge status={s.status} short />
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function NewTask({ project }: { project: any }) {
  const workers: WorkerDTO[] = project.workers.filter((w: WorkerDTO) => !w.revoked);
  const [workerId, setWorkerId] = useState(workers[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"real" | "simulated">("real");
  const [policy, setPolicy] = useState("accept_edits_in_worktree");
  const { busy, run } = useAction();
  const worker = workers.find((w) => w.id === workerId);
  const realAdapter = worker?.adapters.find((a) => a.kind !== "simulated");
  // Unknown until the worker first connects; only a worker that reports no real agent rules it out.
  const realUnavailable = realAdapter ? !realAdapter.available : false;

  useEffect(() => {
    if (!workers.some((w) => w.id === workerId) && workers[0]) setWorkerId(workers[0].id);
  }, [workers.length]);
  useEffect(() => {
    // Default to the real agent whenever this worker can run it; the simulator stays opt-in.
    setMode(realUnavailable ? "simulated" : "real");
  }, [workerId, realUnavailable]);

  return (
    <form
      className="card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const s = await run(() =>
          post(`/api/projects/${project.id}/sessions`, {
            title,
            prompt,
            workerId,
            executionMode: mode,
            permissionPolicy: policy,
          }),
        );
        if (s) navigate(`/s/${s.id}`);
      }}
    >
      <h3>New task</h3>
      <label>
        Title
        <input
          placeholder="Title, e.g. Add discount codes"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
        />
      </label>
      <label>
        What should the agent do?
        <textarea
          placeholder="First instruction for the agent"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          required
        />
      </label>
      <label>
        Worker
        <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
          {workers.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} {w.online ? "(online)" : "(offline)"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Execution
        <select value={mode} onChange={(e) => setMode(e.target.value as "real" | "simulated")}>
          <option value="real" disabled={realUnavailable}>
            Real AI agent
            {realAdapter?.model ? ` (${realAdapter.provider} ${realAdapter.model})` : ""}
            {realUnavailable ? " — unavailable on this worker" : ""}
          </option>
          <option value="simulated">SIMULATED (no AI, scripted demo)</option>
        </select>
      </label>
      <label>
        Tool approvals
        <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="accept_edits_in_worktree">
            Auto-accept file edits on the task branch; ask for everything else
          </option>
          <option value="ask_every_time">Ask me for every tool that needs approval</option>
        </select>
      </label>
      {mode === "real" && realUnavailable && (
        <p className="callout warn small">{realAdapter?.detail}</p>
      )}
      {worker && !worker.online && (
        <p className="callout warn small">
          This worker is offline. The task starts when it connects.
        </p>
      )}
      <button
        type="submit"
        className="primary"
        disabled={busy || (mode === "real" && realUnavailable)}
      >
        Start task
      </button>
    </form>
  );
}

function TeamTab({ project }: { project: any }) {
  return (
    <section className="card stack">
      <div className="row between wrap">
        <h3>People on this project</h3>
        <a href={`#/w/${project.workspaceId}`}>
          {project.role === "owner" ? "Invite or manage members →" : "View team →"}
        </a>
      </div>
      <p className="muted small">
        Everyone in <b>{project.workspaceName}</b> can open this project. Owners start tasks and
        approve; collaborators propose instructions and review; viewers watch.
      </p>
      <ul className="list">
        {project.members.map((m: any) => (
          <li key={m.id}>
            <Avatar id={m.id} name={m.displayName} />
            <span className="grow">{m.displayName}</span>
            <RoleBadge role={m.role} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Workers({
  project,
  isOwner,
  reload,
}: {
  project: any;
  isOwner: boolean;
  reload: () => void;
}) {
  const [newToken, setNewToken] = useState<{ token: string; worker: WorkerDTO } | null>(null);
  const [workerName, setWorkerName] = useState("my-laptop");
  const { busy, run } = useAction();
  const dialog = useDialog();
  const setup = newToken
    ? `PAIRLOOM_SERVER_URL=${location.origin}
PAIRLOOM_WORKER_TOKEN=${newToken.token}
PAIRLOOM_REPO_PATH=/path/to/dedicated/clone/of/${project.name}
GROQ_API_KEY=<your Groq key, only for real agent sessions>
npm run dev:worker`
    : "";
  return (
    <div className="split">
      <section className="card flush">
        <div className="card-head">
          <h3 className="grow">Workers</h3>
        </div>
        <div className="card-body stack">
          <p className="muted small">
            A worker runs the agent in its own clone of the repository and dials out to Pairloom, so
            it can live on a teammate's machine or a server. Collaborators never get shell access to
            it.
          </p>
          {project.workers.length === 0 ? (
            <Empty title="No workers yet">
              {isOwner ? "Register one to get a setup command." : "An owner needs to connect one."}
            </Empty>
          ) : (
            <ul className="list">
              {project.workers.map((w: WorkerDTO) => (
                <li key={w.id} style={{ alignItems: "flex-start" }}>
                  <div className="grow stack tight" style={{ gap: 4 }}>
                    <div className="row wrap">
                      <b>{w.name}</b> <WorkerBadge worker={w} />
                    </div>
                    <ul className="adapters">
                      {w.adapters.map((a) => (
                        <li key={a.kind} className={a.available ? "" : "muted"}>
                          {a.kind === "simulated"
                            ? "Simulator"
                            : `Real agent (${a.kind === "llm-harness" ? `${a.provider ?? ""} ${a.model ?? ""}`.trim() : "Claude Agent SDK"})`}
                          : {a.available ? "available" : "unavailable"} — {a.detail}
                        </li>
                      ))}
                      {w.adapters.length === 0 && (
                        <li className="muted">Waiting for its first connection…</li>
                      )}
                    </ul>
                  </div>
                  {isOwner && !w.revoked && (
                    <button
                      className="link danger small"
                      onClick={async () => {
                        const ok = await dialog.confirm(`Revoke worker “${w.name}”?`, {
                          body: "Its token stops working and it disconnects. Running tasks on it are interrupted.",
                          confirmLabel: "Revoke",
                          danger: true,
                        });
                        if (ok) await run(() => del(`/api/workers/${w.id}`), "Worker revoked");
                        reload();
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {isOwner && (
        <section className="card stack">
          <h3>Connect a worker</h3>
          {newToken ? (
            <div className="stack tight">
              <p className="small">
                Token for <b>{newToken.worker.name}</b> — shown once. Put it in the worker's
                environment, never in chat or git:
              </p>
              <pre className="select callout">{setup}</pre>
              <div className="row">
                <CopyButton text={setup} label="Copy setup" />
                <button className="primary" onClick={() => setNewToken(null)}>
                  I've saved it
                </button>
              </div>
            </div>
          ) : (
            <form
              className="stack tight"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await run(() =>
                  post(`/api/projects/${project.id}/workers`, { name: workerName, kind: "local" }),
                );
                if (r) setNewToken(r);
                reload();
              }}
            >
              <label>
                Worker name
                <input
                  value={workerName}
                  onChange={(e) => setWorkerName(e.target.value)}
                  required
                />
              </label>
              <button type="submit" disabled={busy}>
                Register worker
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}

function upsert<T extends { id: string }>(list: T[], item: T, prepend = false): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}
