import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { navigate } from "../router.js";

export function WorkspacesPage() {
  const [list, setList] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get("/api/workspaces").then(
      (r) => setList(r.workspaces),
      (e) => setError(e.message),
    );
  }, []);
  return (
    <div className="stack">
      <h2>Workspaces</h2>
      {list.length === 0 && (
        <p className="muted">No workspaces yet. Create one, or open an invite link.</p>
      )}
      <ul className="list">
        {list.map((w) => (
          <li key={w.id}>
            <a href={`#/w/${w.id}`}>{w.name}</a> <span className="badge">{w.role}</span>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const w = await post("/api/workspaces", { name });
            navigate(`/w/${w.id}`);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input
          placeholder="New workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button type="submit">Create workspace</button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
