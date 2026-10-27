import { useEffect, useState } from "react";
import { del, get, post } from "../api.js";
import { navigate } from "../router.js";
import type { Me } from "../App.js";

export function WorkspacePage({ id, me }: { id: string; me: Me }) {
  const [ws, setWs] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{
    inviteUrl: string;
    role: string;
    expiresAt: string;
  } | null>(null);
  const [role, setRole] = useState("collaborator");
  const [projectName, setProjectName] = useState("tiny-cart");
  const [branch, setBranch] = useState("main");
  const [repoUrl, setRepoUrl] = useState("");

  const load = () => get(`/api/workspaces/${id}`).then(setWs, (e) => setError(e.message));
  useEffect(() => {
    void load();
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!ws) return <p className="muted">Loading…</p>;
  const isOwner = ws.role === "owner";

  return (
    <div className="stack">
      <h2>
        {ws.name} <span className="badge">{ws.role}</span>
      </h2>

      <section className="card stack">
        <h3>Projects</h3>
        {ws.projects.length === 0 && <p className="muted">No projects yet.</p>}
        <ul className="list">
          {ws.projects.map((p: any) => (
            <li key={p.id}>
              <a href={`#/p/${p.id}`}>{p.name}</a>{" "}
              <span className="muted">base branch {p.defaultBranch}</span>
            </li>
          ))}
        </ul>
        {isOwner && (
          <form
            className="row wrap"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const p = await post(`/api/workspaces/${id}/projects`, {
                  name: projectName,
                  defaultBranch: branch,
                  repoUrl: repoUrl || null,
                });
                navigate(`/p/${p.id}`);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name"
              required
            />
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="Base branch"
              required
            />
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="Repo URL (reference only)"
            />
            <button type="submit">Add project</button>
          </form>
        )}
      </section>

      <section className="card stack">
        <h3>Members</h3>
        <ul className="list">
          {ws.members.map((m: any) => (
            <li key={m.id}>
              {m.displayName} <span className="muted">{m.email}</span>{" "}
              <span className="badge">{m.role}</span>
              {isOwner && m.id !== me.id && (
                <button
                  className="link danger"
                  onClick={async () => {
                    if (!confirm(`Remove ${m.displayName} from this workspace?`)) return;
                    await del(`/api/workspaces/${id}/members/${m.id}`).catch((e) =>
                      setError(e.message),
                    );
                    void load();
                  }}
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {isOwner && (
          <div className="stack">
            <div className="row">
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="collaborator">
                  collaborator — can send instructions (needs owner approval) and review
                </option>
                <option value="viewer">viewer — read only</option>
                <option value="owner">owner — full control</option>
              </select>
              <button
                onClick={async () =>
                  setInvite(await post(`/api/workspaces/${id}/invitations`, { role }))
                }
              >
                Create invite link
              </button>
            </div>
            {invite && (
              <p className="notice">
                Single-use {invite.role} invite (expires{" "}
                {new Date(invite.expiresAt).toLocaleString()}):
                <br />
                <code className="select">{invite.inviteUrl}</code>
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
