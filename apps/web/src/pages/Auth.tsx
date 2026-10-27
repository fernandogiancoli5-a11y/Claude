import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { navigate } from "../router.js";

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
  const [invite, setInvite] = useState<{ workspaceName: string; role: string } | null>(null);

  useEffect(() => {
    if (inviteToken)
      get(`/api/invitations/${inviteToken}`).then(setInvite, (e) => setError(e.message));
  }, [inviteToken]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
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
    }
  };

  return (
    <div className="auth">
      <h1>Pairloom</h1>
      <p className="muted">A shared room for working with a Claude agent.</p>
      {invite && (
        <p className="notice">
          You're invited to <b>{invite.workspaceName}</b> as <b>{invite.role}</b>.
        </p>
      )}
      <form onSubmit={submit} className="card stack">
        {mode === "signup" && (
          <label>
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              maxLength={100}
            />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password {mode === "signup" && <span className="muted">(10+ characters)</span>}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "signup" ? 10 : 1}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit">{mode === "signup" ? "Create account" : "Sign in"}</button>
        <button
          type="button"
          className="link"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
        >
          {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
