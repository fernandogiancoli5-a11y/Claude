import { useEffect, useState } from "react";
import { del, get, post } from "../api.js";
import { navigate } from "../router.js";
import {
  Avatar,
  CopyButton,
  Empty,
  ErrorState,
  Loading,
  useAction,
  useCrumbs,
  useDialog,
} from "../ui.js";
import { RoleBadge } from "./badges.js";
import { NewProjectForm } from "./newProject.js";
import type { Me } from "../App.js";

const ROLE_HELP: Record<string, string> = {
  collaborator: "Proposes instructions (the host approves them), reviews and runs tests",
  viewer: "Read only: watches tasks and changes",
  owner: "Full control: projects, workers, approvals and merges",
};

export function WorkspacePage({ id, me }: { id: string; me: Me }) {
  const [ws, setWs] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get(`/api/workspaces/${id}`).then(setWs, (e) => setError(e.message));
  useEffect(() => {
    setWs(null);
    void load();
  }, [id]);
  useCrumbs(ws ? [{ label: ws.name, href: `#/w/${id}` }] : null);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!ws) return <Loading />;
  const isOwner = ws.role === "owner";

  return (
    <div className="stack loose">
      <div className="page-head">
        <div className="title">
          <h1>{ws.name}</h1>
          <p className="muted">
            You're {ws.role === "owner" ? "an" : "a"} <b>{ws.role}</b>. {ROLE_HELP[ws.role]}.
          </p>
        </div>
      </div>

      <div className="workspace-grid">
        <section className="card flush">
          <div className="card-head">
            <h3 className="grow">Projects</h3>
          </div>
          {ws.projects.length === 0 ? (
            <Empty title="No projects yet">
              {isOwner
                ? "Add a project for each repository your team works on."
                : "An owner will add projects here."}
            </Empty>
          ) : (
            <div>
              {ws.projects.map((p: any) => (
                <a key={p.id} className="task-row" href={`#/p/${p.id}`}>
                  <div className="meta">
                    <b>{p.name}</b>
                    <span className="muted small">
                      base branch <code>{p.defaultBranch}</code>
                    </span>
                  </div>
                </a>
              ))}
            </div>
          )}
          {isOwner && <AddProject workspaceId={id} />}
        </section>

        <Members ws={ws} me={me} isOwner={isOwner} reload={load} />
      </div>
    </div>
  );
}

function AddProject({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="composer">
      <NewProjectForm workspaceId={workspaceId} />
    </div>
  );
}

function Members({
  ws,
  me,
  isOwner,
  reload,
}: {
  ws: any;
  me: Me;
  isOwner: boolean;
  reload: () => void;
}) {
  const [role, setRole] = useState("collaborator");
  const [invite, setInvite] = useState<{
    inviteUrl: string;
    role: string;
    expiresAt: string;
  } | null>(null);
  const { busy, run } = useAction();
  const dialog = useDialog();
  return (
    <section className="card flush">
      <div className="card-head">
        <h3 className="grow">Members</h3>
        <span className="muted small">{ws.members.length}</span>
      </div>
      <div className="card-body stack">
        <ul className="list">
          {ws.members.map((m: any) => (
            <li key={m.id}>
              <Avatar name={m.displayName} id={m.id} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div>
                  {m.displayName} {m.id === me.id && <span className="muted small">(you)</span>}
                </div>
                <div className="muted small">{m.email}</div>
              </div>
              <RoleBadge role={m.role} />
              {isOwner && m.id !== me.id && (
                <button
                  className="link danger small"
                  aria-label={`Remove ${m.displayName}`}
                  onClick={async () => {
                    const ok = await dialog.confirm(`Remove ${m.displayName}?`, {
                      body: "They lose access to every project in this team immediately.",
                      confirmLabel: "Remove",
                      danger: true,
                    });
                    if (!ok) return;
                    await run(
                      () => del(`/api/workspaces/${ws.id}/members/${m.id}`),
                      "Member removed",
                    );
                    reload();
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>

        {isOwner && (
          <div className="stack tight">
            <h4>Invite someone</h4>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {Object.entries(ROLE_HELP).map(([r, help]) => (
                  <option key={r} value={r}>
                    {r} — {help.toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <button
                disabled={busy}
                onClick={async () => {
                  const r = await run(() => post(`/api/workspaces/${ws.id}/invitations`, { role }));
                  if (r) setInvite(r);
                }}
              >
                Create invite link
              </button>
            </div>
            {invite && (
              <div className="callout info stack tight">
                <span className="small">
                  Single-use <b>{invite.role}</b> link, expires{" "}
                  {new Date(invite.expiresAt).toLocaleString()}. Send it privately.
                </span>
                <div className="row">
                  <code className="select grow">{invite.inviteUrl}</code>
                  <CopyButton text={invite.inviteUrl} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
