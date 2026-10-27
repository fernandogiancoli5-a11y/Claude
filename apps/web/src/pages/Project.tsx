import { useEffect, useState } from "react";
import type { AgentSessionDTO, WorkerDTO } from "@pairloom/shared";
import { del, get, post } from "../api.js";
import { navigate } from "../router.js";
import { realtime, useRealtime } from "../realtime.js";
import { ModeBadge, StatusBadge, WorkerBadge } from "./badges.js";
import type { Me } from "../App.js";

export function ProjectPage({ id }: { id: string; me: Me }) {
  const [project, setProject] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ token: string; worker: WorkerDTO } | null>(null);
  const [workerName, setWorkerName] = useState("my-laptop");

  const load = () => get(`/api/projects/${id}`).then(setProject, (e) => setError(e.message));
  useEffect(() => {
    void load();
    return realtime.subscribeProject(id);
  }, [id]);

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

  if (error) return <p className="error">{error}</p>;
  if (!project) return <p className="muted">Loading…</p>;
  const isOwner = project.role === "owner";

  return (
    <div className="stack">
      <p>
        <a href={`#/w/${project.workspaceId}`}>← workspace</a>
      </p>
      <h2>
        {project.name} <span className="muted">base {project.defaultBranch}</span>
      </h2>

      <section className="card stack">
        <h3>Agent workers</h3>
        <p className="muted small">
          A worker is a process that runs agent sessions in its own git clone. It dials out to this
          server, so it can run in the cloud or on a teammate's machine. Collaborators never get
          shell access to it.
        </p>
        {project.workers.length === 0 && <p className="muted">No workers registered.</p>}
        <ul className="list">
          {project.workers.map((w: WorkerDTO) => (
            <li key={w.id}>
              <b>{w.name}</b> <span className="badge">{w.kind}</span> <WorkerBadge worker={w} />
              <ul className="adapters">
                {w.adapters.map((a) => (
                  <li key={a.kind} className={a.available ? "" : "muted"}>
                    {a.kind === "simulated"
                      ? "Simulator"
                      : `Real agent (${a.kind === "llm-harness" ? `${a.provider ?? ""} ${a.model ?? ""}`.trim() : "Claude Agent SDK"})`}
                    : {a.available ? "available" : "unavailable"} — {a.detail}
                  </li>
                ))}
                {w.adapters.length === 0 && <li className="muted">Never connected yet.</li>}
              </ul>
              {isOwner && !w.revoked && (
                <button
                  className="link danger"
                  onClick={async () => {
                    if (!confirm("Revoke this worker's token? It will be disconnected.")) return;
                    await del(`/api/workers/${w.id}`);
                    void load();
                  }}
                >
                  revoke
                </button>
              )}
            </li>
          ))}
        </ul>
        {isOwner && (
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              setNewToken(
                await post(`/api/projects/${id}/workers`, { name: workerName, kind: "local" }),
              );
              void load();
            }}
          >
            <input value={workerName} onChange={(e) => setWorkerName(e.target.value)} required />
            <button type="submit">Register worker</button>
          </form>
        )}
        {newToken && (
          <div className="notice">
            <p>
              Worker token for <b>{newToken.worker.name}</b> — shown once. Put it in the worker's
              environment, not in chat or git:
            </p>
            <pre className="select">{`PAIRLOOM_SERVER_URL=${location.origin}
PAIRLOOM_WORKER_TOKEN=${newToken.token}
PAIRLOOM_REPO_PATH=/path/to/dedicated/clone/of/${project.name}
GROQ_API_KEY=<your Groq key, only for real agent sessions>
npm run dev:worker`}</pre>
            <button className="link" onClick={() => setNewToken(null)}>
              I've saved it
            </button>
          </div>
        )}
      </section>

      {isOwner && <NewSession project={project} />}

      <section className="card stack">
        <h3>Sessions</h3>
        {project.sessions.length === 0 && <p className="muted">No sessions yet.</p>}
        <ul className="list">
          {project.sessions.map((s: AgentSessionDTO) => (
            <li key={s.id}>
              <a href={`#/s/${s.id}`}>{s.title}</a> <StatusBadge status={s.status} />{" "}
              <ModeBadge mode={s.executionMode} />{" "}
              <span className="muted small">
                host {s.hostName} · {new Date(s.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function NewSession({ project }: { project: any }) {
  const workers: WorkerDTO[] = project.workers.filter((w: WorkerDTO) => !w.revoked);
  const [workerId, setWorkerId] = useState(workers[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"real" | "simulated">("real");
  const [policy, setPolicy] = useState("accept_edits_in_worktree");
  const [error, setError] = useState<string | null>(null);
  const worker = workers.find((w) => w.id === workerId);
  const realAdapter = worker?.adapters.find((a) => a.kind !== "simulated");
  const realUnavailable = realAdapter ? !realAdapter.available : false;

  useEffect(() => {
    if (!workerId && workers[0]) setWorkerId(workers[0].id);
  }, [workers.length]);

  if (workers.length === 0) return null;
  return (
    <section className="card stack">
      <h3>Start a session</h3>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const s = await post(`/api/projects/${project.id}/sessions`, {
              title,
              prompt,
              workerId,
              executionMode: mode,
              permissionPolicy: policy,
            });
            navigate(`/s/${s.id}`);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input
          placeholder="Title, e.g. Fix inventory overflow"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <textarea
          placeholder="First instruction for the agent"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          required
        />
        <div className="row wrap">
          <label>
            Worker{" "}
            <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} {w.online ? "(online)" : "(offline)"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Execution{" "}
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
            Tool approvals{" "}
            <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
              <option value="accept_edits_in_worktree">
                Auto-accept file edits in the isolated worktree; ask for everything else
              </option>
              <option value="ask_every_time">
                Ask the host for every tool that needs approval
              </option>
            </select>
          </label>
        </div>
        {realUnavailable && mode === "real" && <p className="error">{realAdapter?.detail}</p>}
        {worker && !worker.online && (
          <p className="notice">This worker is offline. The session will start when it connects.</p>
        )}
        {error && <p className="error">{error}</p>}
        <button type="submit">Start session</button>
      </form>
    </section>
  );
}

function upsert<T extends { id: string }>(list: T[], item: T, prepend = false): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}
