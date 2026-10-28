import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}
const ToastCtx = createContext<(kind: Toast["kind"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = next.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      kind === "error" ? 8000 : 4000,
    );
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="grow">{t.text}</span>
            <button
              aria-label="Dismiss"
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    info: (text: string) => push("info", text),
    error: (text: string) => push("error", text),
  };
}

// ---------------------------------------------------------------- dialogs

interface DialogRequest {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the dialog asks for text; the label of that field. */
  input?: string;
  resolve: (v: { ok: boolean; text: string }) => void;
}
const DialogCtx = createContext<
  (r: Omit<DialogRequest, "resolve">) => Promise<{ ok: boolean; text: string }>
>(async () => ({ ok: false, text: "" }));

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const [text, setText] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  const open = useCallback(
    (r: Omit<DialogRequest, "resolve">) =>
      new Promise<{ ok: boolean; text: string }>((resolve) => {
        setText("");
        setReq({ ...r, resolve });
      }),
    [],
  );
  useEffect(() => {
    if (req && ref.current && !ref.current.open) ref.current.showModal();
  }, [req]);
  const close = (ok: boolean) => {
    req?.resolve({ ok, text: text.trim() });
    ref.current?.close();
    setReq(null);
  };
  return (
    <DialogCtx.Provider value={open}>
      {children}
      <dialog ref={ref} onCancel={() => close(false)} aria-labelledby="dlg-title">
        {req && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              close(true);
            }}
          >
            <h3 id="dlg-title">{req.title}</h3>
            {req.body && <div className="muted">{req.body}</div>}
            {req.input && (
              <label>
                {req.input}
                <textarea
                  rows={3}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  autoFocus
                />
              </label>
            )}
            <div className="row end">
              <button type="button" onClick={() => close(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className={req.danger ? "danger" : "primary"}
                autoFocus={!req.input}
              >
                {req.confirmLabel}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </DialogCtx.Provider>
  );
}

export function useDialog() {
  const open = useContext(DialogCtx);
  return {
    confirm: async (
      title: string,
      opts: { body?: ReactNode; confirmLabel?: string; danger?: boolean } = {},
    ) => (await open({ title, confirmLabel: opts.confirmLabel ?? "Confirm", ...opts })).ok,
    /** Resolves to null when cancelled, otherwise the (possibly empty) text. */
    ask: async (
      title: string,
      input: string,
      opts: { confirmLabel?: string; danger?: boolean } = {},
    ) => {
      const r = await open({
        title,
        input,
        confirmLabel: opts.confirmLabel ?? "OK",
        danger: opts.danger,
      });
      return r.ok ? r.text : null;
    },
  };
}

// ---------------------------------------------------------------- breadcrumbs

export interface Crumb {
  label: string;
  href?: string;
}
const CrumbCtx = createContext<{ crumbs: Crumb[]; set: (c: Crumb[]) => void }>({
  crumbs: [],
  set: () => {},
});

export function CrumbProvider({ children }: { children: ReactNode }) {
  const [crumbs, set] = useState<Crumb[]>([]);
  return <CrumbCtx.Provider value={{ crumbs, set }}>{children}</CrumbCtx.Provider>;
}

/** Sets the top-bar breadcrumbs and the document title for the current page. */
export function useCrumbs(crumbs: Crumb[] | null) {
  const { set } = useContext(CrumbCtx);
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    if (!crumbs) return;
    set(crumbs);
    const last = crumbs.at(-1)?.label;
    document.title = last ? `${last} · Pairloom` : "Pairloom";
  }, [key]);
}

export function Crumbs() {
  const { crumbs } = useContext(CrumbCtx);
  if (!crumbs.length) return null;
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {crumbs.map((c, i) => (
        <span key={i} className="row" style={{ gap: 6 }}>
          <span className="sep" aria-hidden>
            /
          </span>
          {c.href && i < crumbs.length - 1 ? (
            <a href={c.href}>{c.label}</a>
          ) : (
            <span className="current" aria-current="page">
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------- small pieces

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden>
      <rect width="24" height="24" rx="6" fill="var(--accent)" />
      <path
        d="M7 15.5c0-2.5 2-4 5-4s5-1.5 5-4M7 8.5c0 2.5 2 4 5 4s5 1.5 5 4"
        stroke="var(--accent-fg)"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" /> {label}
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card stack tight" role="alert">
      <h3>Something went wrong</h3>
      <p className="error">{message}</p>
      <div className="row">
        {onRetry && <button onClick={onRetry}>Try again</button>}
        <a className="button" href="#/">
          Go to dashboard
        </a>
      </div>
    </div>
  );
}

const AVATAR_COLORS = ["#4353d6", "#24804a", "#b4531b", "#8a4fd1", "#0f7c8c", "#c2332b", "#6b6b20"];
export function Avatar({ name, id, size }: { name: string; id: string; size?: "lg" }) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const initials = name
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      className={`avatar ${size ?? ""}`}
      style={{ background: AVATAR_COLORS[h % AVATAR_COLORS.length] }}
      title={name}
      aria-hidden
    >
      {initials || "?"}
    </span>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text stays selectable */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Runs an async action with a busy flag; errors become toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast.info(success);
      return r;
    } catch (e) {
      toast.error((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}
