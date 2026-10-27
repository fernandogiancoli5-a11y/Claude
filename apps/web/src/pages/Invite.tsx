import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { navigate } from "../router.js";

export function InvitePage({ token }: { token: string }) {
  const [info, setInfo] = useState<{ workspaceName: string; role: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get(`/api/invitations/${token}`).then(setInfo, (e) => setError(e.message));
  }, [token]);
  if (error) return <p className="error">{error}</p>;
  if (!info) return <p className="muted">Loading invitation…</p>;
  return (
    <div className="card stack narrow">
      <h2>Join {info.workspaceName}</h2>
      <p>
        You'll join as <b>{info.role}</b>.
      </p>
      <button
        onClick={async () => {
          try {
            const r = await post(`/api/invitations/${token}/accept`);
            navigate(`/w/${r.workspaceId}`);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Accept invitation
      </button>
    </div>
  );
}
