import { useEffect, useState } from "react";
import { get, post } from "./api.js";
import { navigate, useRoute } from "./router.js";
import { useRealtimeOnline } from "./realtime.js";
import { AuthPage } from "./pages/Auth.js";
import { InvitePage } from "./pages/Invite.js";
import { WorkspacesPage } from "./pages/Workspaces.js";
import { WorkspacePage } from "./pages/Workspace.js";
import { ProjectPage } from "./pages/Project.js";
import { SessionPage } from "./pages/Session.js";

export interface Me {
  id: string;
  email: string;
  displayName: string;
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useRoute();

  const refresh = () =>
    get<{ user: Me }>("/api/me")
      .then((r) => setMe(r.user))
      .catch(() => setMe(null));

  useEffect(() => {
    void refresh();
    const on = () => setMe(null);
    window.addEventListener("pl:unauthenticated", on);
    return () => window.removeEventListener("pl:unauthenticated", on);
  }, []);

  if (me === undefined) return <div className="center muted">Loading…</div>;

  const inviteToken = route[0] === "invite" ? route[1] : undefined;
  if (!me) return <AuthPage inviteToken={inviteToken} onAuthed={refresh} />;

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          Pairloom
        </a>
        <ConnectionDot />
        <span className="spacer" />
        <span className="muted">{me.displayName}</span>
        <button
          className="link"
          onClick={async () => {
            await post("/api/auth/logout");
            setMe(null);
            navigate("/");
          }}
        >
          Sign out
        </button>
      </header>
      <main className="content">
        <Routed route={route} me={me} />
      </main>
    </div>
  );
}

function ConnectionDot() {
  const online = useRealtimeOnline();
  return (
    <span
      className={`conn ${online ? "ok" : "bad"}`}
      title={online ? "Realtime connected" : "Realtime reconnecting…"}
    >
      {online ? "live" : "reconnecting…"}
    </span>
  );
}

function Routed({ route, me }: { route: string[]; me: Me }) {
  const [a, b] = route;
  if (a === "invite" && b) return <InvitePage token={b} />;
  if (a === "w" && b) return <WorkspacePage id={b} me={me} />;
  if (a === "p" && b) return <ProjectPage id={b} me={me} />;
  if (a === "s" && b) return <SessionPage id={b} me={me} />;
  return <WorkspacesPage />;
}
