import { useEffect, useState } from "react";
import type { SessionStatus } from "@pairloom/shared";
import { get, post } from "../api.js";
import { navigate } from "../router.js";
import { Empty, ErrorState, Loading, timeAgo, useAction, useCrumbs } from "../ui.js";
import { RoleBadge, StatusBadge } from "./badges.js";
import type { Me } from "../App.js";

interface DashWorkspace {
  id: string;
  name: string;
  role: string;
  memberCount: number;
}
interface DashProject {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  defaultBranch: string;
  createdAt: string;
  sessionCount: number;
  lastActivityAt: string | null;
  pendingApprovals: number;
  openChangeSets: number;
  workerCount: number;
  workersOnline: number;
  latestSession: { id: string; title: string; status: SessionStatus; updatedAt: string } | null;
}

export function HomePage({ me }: { me: Me }) {
  const [data, setData] = useState<{ workspaces: DashWorkspace[]; projects: DashProject[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  useCrumbs([]);
  useEffect(() => {
    document.title = "Dashboard · Pairloom";
  }, []);

  const load = () =>
    get("/api/dashboard").then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(e.message),
    );
  useEffect(() => {
    void load();
    // Counts change as teammates work; refresh when the tab regains focus.
    const on = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Loading />;

  const owned = data.workspaces.filter((w) => w.role === "owner");
  const attention = data.projects.filter((p) => p.pendingApprovals > 0 || p.openChangeSets > 0);
  const firstRun = data.workspaces.length === 0;

  return (
    <div className="stack loose">
      <div className="page-head">
        <div className="title">
          <span className="eyebrow">Dashboard</span>
          <h1>Hi, {me.displayName.replace(/\s*\(.*\)$/, "")}</h1>
          <p className="muted">
            {firstRun
              ? "Set up a team workspace to start building with an agent."
              : `${data.projects.length} project${data.projects.length === 1 ? "" : "s"} across ${data.workspaces.length} team${data.workspaces.length === 1 ? "" : "s"}.`}
          </p>
        </div>
      </div>

      {firstRun ? (
        <FirstRun />
      ) : (
        <>
          {attention.length > 0 && (
            <section className="card attention stack tight" aria-label="Needs attention">
              <h3>Needs attention</h3>
              <ul className="list">
                {attention.map((p) => (
                  <li key={p.id}>
                    <a className="grow" href={`#/p/${p.id}`}>
                      <b>{p.name}</b> <span className="muted small">· {p.workspaceName}</span>
                    </a>
                    {p.pendingApprovals > 0 && (
                      <span className="badge dot tone-warn">
                        {p.pendingApprovals} awaiting approval
                      </span>
                    )}
                    {p.openChangeSets > 0 && (
                      <span className="badge dot tone-busy">
                        {p.openChangeSets} change set{p.openChangeSets === 1 ? "" : "s"} to review
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="stack">
            <div className="row between wrap">
              <h2>Projects</h2>
              {owned.length > 0 && <NewProject workspaces={owned} />}
            </div>
            {data.projects.length === 0 ? (
              <div className="card">
                <Empty title="No projects yet">
                  {owned.length > 0
                    ? "Add a project to connect a repository and start your first agent task."
                    : "An owner of your team hasn't added a project yet."}
                </Empty>
              </div>
            ) : (
              <div className="grid-cards">
                {data.projects.map((p) => (
                  <ProjectCard key={p.id} p={p} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <Teams workspaces={data.workspaces} />
    </div>
  );
}

function ProjectCard({ p }: { p: DashProject }) {
  return (
    <a className="card link-card" href={`#/p/${p.id}`}>
      <div className="row between">
        <div className="stack tight" style={{ gap: 2, minWidth: 0 }}>
          <h3>{p.name}</h3>
          <span className="muted small">
            {p.workspaceName} · base <code>{p.defaultBranch}</code>
          </span>
        </div>
        <RoleBadge role={p.role} />
      </div>
      {p.latestSession ? (
        <div className="row" style={{ minWidth: 0 }}>
          <span
            className="grow small"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {p.latestSession.title}
          </span>
          <StatusBadge status={p.latestSession.status} short />
        </div>
      ) : (
        <span className="muted small">No tasks yet</span>
      )}
      <div className="row wrap small muted">
        <span>
          {p.sessionCount} task{p.sessionCount === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span>
          {p.workerCount === 0
            ? "no worker connected"
            : `${p.workersOnline}/${p.workerCount} worker${p.workerCount === 1 ? "" : "s"} online`}
        </span>
        <span>·</span>
        <span>active {timeAgo(p.lastActivityAt ?? p.createdAt)}</span>
      </div>
    </a>
  );
}

function NewProject({ workspaces }: { workspaces: DashWorkspace[] }) {
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]!.id);
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("main");
  const { busy, run } = useAction();
  if (!open)
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        New project
      </button>
    );
  return (
    <form
      className="card stack"
      style={{ width: "100%" }}
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() =>
          post(`/api/workspaces/${workspaceId}/projects`, {
            name,
            defaultBranch: branch,
            repoUrl: null,
          }),
        );
        if (p) navigate(`/p/${p.id}`);
      }}
    >
      <h3>New project</h3>
      <div className="form-grid">
        <label>
          Team
          <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Base branch
          <input value={branch} onChange={(e) => setBranch(e.target.value)} required />
        </label>
      </div>
      <div className="row end">
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy}>
          Create project
        </button>
      </div>
    </form>
  );
}

function FirstRun() {
  return (
    <section className="card stack">
      <h2>Get started</h2>
      <ol className="steps">
        {[
          ["Create a team workspace", "Your teammates join it through invite links."],
          ["Add a project", "A project points at one git repository and its base branch."],
          [
            "Connect a worker",
            "A small process next to a clone of the repo runs the agent. Pairloom shows you the exact command.",
          ],
          ["Start a task", "Describe what to build; watch, steer, review and merge together."],
        ].map(([t, d], i) => (
          <li key={t}>
            <span className="num">{i + 1}</span>
            <div>
              <b>{t}</b>
              <p className="muted small">{d}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="muted small">Got an invite link from a teammate? Open it to join their team.</p>
    </section>
  );
}

function Teams({ workspaces }: { workspaces: DashWorkspace[] }) {
  const [name, setName] = useState("");
  const { busy, run } = useAction();
  return (
    <section className="card stack">
      <div className="row between">
        <h3>Teams</h3>
      </div>
      {workspaces.length > 0 && (
        <ul className="list">
          {workspaces.map((w) => (
            <li key={w.id}>
              <a className="grow" href={`#/w/${w.id}`}>
                {w.name}
              </a>
              <span className="muted small">
                {w.memberCount} member{w.memberCount === 1 ? "" : "s"}
              </span>
              <RoleBadge role={w.role} />
            </li>
          ))}
        </ul>
      )}
      <form
        className="row wrap"
        onSubmit={async (e) => {
          e.preventDefault();
          const w = await run(() => post("/api/workspaces", { name }));
          if (w) navigate(`/w/${w.id}`);
        }}
      >
        <input
          className="grow"
          style={{ width: "auto" }}
          aria-label="New workspace name"
          placeholder="New workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
        />
        <button type="submit" className={workspaces.length ? "" : "primary"} disabled={busy}>
          Create workspace
        </button>
      </form>
    </section>
  );
}
