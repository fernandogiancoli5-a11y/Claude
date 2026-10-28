import { useEffect, useState } from "react";
import { get, post } from "./api.js";
import { navigate, useRoute } from "./router.js";
import { useRealtimeOnline } from "./realtime.js";
import { AuthPage } from "./pages/Auth.js";
import { InvitePage } from "./pages/Invite.js";
import { HomePage } from "./pages/Home.js";
import { WorkspacePage } from "./pages/Workspace.js";
import { ProjectPage } from "./pages/Project.js";
import { SessionPage } from "./pages/Session.js";
import { AccountPage } from "./pages/Account.js";
import {
  Avatar,
  CrumbProvider,
  Crumbs,
  DialogProvider,
  Loading,
  Logo,
  ToastProvider,
} from "./ui.js";

export interface Me {
  id: string;
  email: string;
  displayName: string;
}

export function App() {
  return (
    <ToastProvider>
      <DialogProvider>
        <CrumbProvider>
          <Shell />
        </CrumbProvider>
      </DialogProvider>
    </ToastProvider>
  );
}

function Shell() {
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

  if (me === undefined) return <Loading label="Loading Pairloom…" />;

  const inviteToken = route[0] === "invite" ? route[1] : undefined;
  if (!me) return <AuthPage inviteToken={inviteToken} onAuthed={refresh} />;

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand" aria-label="Pairloom dashboard">
          <Logo />
          <span>Pairloom</span>
        </a>
        <Crumbs />
        <span className="spacer" />
        <ConnectionDot />
        <div className="user-menu">
          <a
            href="#/account"
            className="row"
            style={{ gap: 8, color: "inherit" }}
            title="Your account"
          >
            <Avatar name={me.displayName} id={me.id} />
            <span className="name">{me.displayName}</span>
          </a>
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
        </div>
      </header>
      <main className="content">
        <Routed
          route={route}
          me={me}
          onSignOut={async () => {
            await post("/api/auth/logout");
            setMe(null);
            navigate("/");
          }}
        />
      </main>
    </div>
  );
}

function ConnectionDot() {
  const online = useRealtimeOnline();
  return (
    <span
      className={`conn ${online ? "ok" : "bad"}`}
      title={online ? "Live updates connected" : "Live updates reconnecting…"}
    >
      ● <span className="label">{online ? "live" : "reconnecting…"}</span>
    </span>
  );
}

function Routed({ route, me, onSignOut }: { route: string[]; me: Me; onSignOut: () => void }) {
  const [a, b] = route;
  if (a === "account") return <AccountPage me={me} onSignOut={onSignOut} />;
  if (a === "invite" && b) return <InvitePage token={b} />;
  if (a === "w" && b) return <WorkspacePage id={b} me={me} />;
  if (a === "p" && b) return <ProjectPage id={b} me={me} routeTab={route[2]} />;
  if (a === "s" && b) return <SessionPage id={b} me={me} />;
  return <HomePage me={me} />;
}
