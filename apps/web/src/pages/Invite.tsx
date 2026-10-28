import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { navigate } from "../router.js";
import { ErrorState, Loading, useAction, useCrumbs } from "../ui.js";

export function InvitePage({ token }: { token: string }) {
  const [info, setInfo] = useState<{ workspaceName: string; role: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  useCrumbs([{ label: "Invitation" }]);
  useEffect(() => {
    get(`/api/invitations/${token}`).then(setInfo, (e) => setError(e.message));
  }, [token]);
  if (error) return <ErrorState message={error} />;
  if (!info) return <Loading label="Loading invitation…" />;
  return (
    <div className="card stack" style={{ maxWidth: 480, margin: "40px auto" }}>
      <h2>Join {info.workspaceName}</h2>
      <p className="muted">
        You'll join as <b>{info.role}</b> and see every project in this team.
      </p>
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            const r = await run(() => post(`/api/invitations/${token}/accept`));
            if (r) navigate(`/w/${r.workspaceId}`);
          }}
        >
          Accept invitation
        </button>
        <a className="button" href="#/">
          Not now
        </a>
      </div>
    </div>
  );
}
