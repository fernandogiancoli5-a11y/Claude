import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { navigate } from "../router.js";
import { Logo } from "../ui.js";

const FEATURES = [
  {
    icon: "◎",
    title: "One agent, the whole team watching",
    text: "Everyone sees the agent's work stream live, from any browser. Closing yours doesn't stop it.",
  },
  {
    icon: "✓",
    title: "Humans stay in charge",
    text: "Teammates propose instructions; the host approves them and any risky tool use before it runs.",
  },
  {
    icon: "⇄",
    title: "Real diffs, real tests, real review",
    text: "Changes land on an isolated git branch. Run the project's tests yourself, review the diff, then merge.",
  },
];

export function AuthPage({
  inviteToken,
  onAuthed,
}: {
  inviteToken?: string;
  onAuthed: () => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">(inviteToken ? "signup" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ workspaceName: string; role: string } | null>(null);

  useEffect(() => {
    document.title = "Pairloom — build software with an AI agent, together";
    if (inviteToken)
      get(`/api/invitations/${inviteToken}`).then(setInvite, (e) => setError(e.message));
  }, [inviteToken]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        const r = await post("/api/auth/signup", { email, password, displayName, inviteToken });
        if (r.joined) navigate(`/w/${r.joined.workspaceId}`);
      } else {
        await post("/api/auth/login", { email, password });
        if (inviteToken) navigate(`/invite/${inviteToken}`);
      }
      onAuthed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <section className="pitch">
        <div className="brand">
          <Logo />
          <span>Pairloom</span>
        </div>
        <div className="stack">
          <h1>Build software with an AI agent — together.</h1>
          <p className="lede">
            A shared workspace where your team supervises one coding agent: watch it work, steer it,
            approve what it does, and review its changes before they ship.
          </p>
        </div>
        <div className="features">
          {FEATURES.map((f) => (
            <div key={f.title} className="feature">
              <span className="icon" aria-hidden>
                {f.icon}
              </span>
              <div>
                <b>{f.title}</b>
                <p className="muted small">{f.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="stack">
          <div className="stack tight">
            <h2>{mode === "signup" ? "Create your account" : "Welcome back"}</h2>
            <p className="muted small">
              {mode === "signup"
                ? "Start a team workspace, or join one you were invited to."
                : "Sign in to your workspaces."}
            </p>
          </div>
          {invite && (
            <p className="callout info">
              You're invited to <b>{invite.workspaceName}</b> as <b>{invite.role}</b>.
              {mode === "login" && " Sign in to accept."}
            </p>
          )}
          <form onSubmit={submit}>
            {mode === "signup" && (
              <label>
                Display name
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                  maxLength={100}
                  autoComplete="name"
                />
              </label>
            )}
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label>
              Password {mode === "signup" && <span className="hint muted">(10+ characters)</span>}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === "signup" ? 10 : 1}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </label>
            {error && (
              <p className="callout danger" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="primary" disabled={busy}>
              {busy && <span className="spinner" />}
              {mode === "signup" ? "Create account" : "Sign in"}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setError(null);
                setMode(mode === "login" ? "signup" : "login");
              }}
            >
              {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
            </button>
            {mode === "login" && (
              <p className="muted small">
                Forgot your password? Pairloom doesn't send email yet, so ask the person who runs
                your Pairloom server to reset it for you.
              </p>
            )}
          </form>
        </div>
      </section>
    </div>
  );
}
