import { useState } from "react";
import { post } from "../api.js";
import { useAction, useCrumbs } from "../ui.js";
import type { Me } from "../App.js";

export function AccountPage({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const { busy, run } = useAction();
  useCrumbs([{ label: "Account" }]);
  return (
    <div className="stack loose" style={{ maxWidth: 560 }}>
      <div className="stack tight">
        <h1>Your account</h1>
        <p className="muted">
          Signed in as <b>{me.displayName}</b> ({me.email}).
        </p>
      </div>

      <section className="card stack">
        <h3>Change password</h3>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (next !== confirm) return setMismatch(true);
            const ok = await run(
              () => post("/api/auth/password", { currentPassword: current, newPassword: next }),
              "Password changed. Other devices were signed out.",
            );
            if (ok) {
              setCurrent("");
              setNext("");
              setConfirm("");
            }
          }}
        >
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </label>
          <label>
            New password <span className="hint muted">(10+ characters)</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                setMismatch(false);
              }}
              required
            />
          </label>
          <label>
            Repeat new password
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setMismatch(false);
              }}
              required
              aria-invalid={mismatch}
            />
          </label>
          {mismatch && <p className="error small">The new passwords don't match.</p>}
          <div className="row end">
            <button type="submit" className="primary" disabled={busy}>
              Change password
            </button>
          </div>
        </form>
      </section>

      <section className="card row between wrap">
        <div>
          <b>Sign out</b>
          <p className="muted small">Ends this session on this device.</p>
        </div>
        <button onClick={onSignOut}>Sign out</button>
      </section>
    </div>
  );
}
