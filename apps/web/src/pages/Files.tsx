import { useEffect, useState } from "react";
import { ApiError, get } from "../api.js";
import { Empty, Loading } from "../ui.js";

interface Listing {
  ref: string;
  commit: string;
  files: Array<{ path: string; size: number }>;
  truncated: boolean;
}
type FileView =
  | { path: string; size: number; content: string }
  | { path: string; size: number; binary: true }
  | { path: string; size: number; tooLarge: true };

/**
 * Read-only browser for a hosted project's committed files: the base branch, or a task's
 * branch as of its last checkpoint (sessionId). `version` re-fetches when it changes.
 */
export function FileBrowser({
  projectId,
  sessionId,
  version,
  emptyHint,
}: {
  projectId: string;
  sessionId?: string;
  version?: unknown;
  emptyHint?: string;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FileView | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const q = sessionId ? `sessionId=${encodeURIComponent(sessionId)}` : "";

  useEffect(() => {
    let live = true;
    get<Listing>(`/api/projects/${projectId}/files?${q}`).then(
      (l) => {
        if (!live) return;
        setListing(l);
        setError(null);
        setSelected((cur) =>
          cur && l.files.some((f) => f.path === cur)
            ? cur
            : (l.files.find((f) => /^readme/i.test(f.path))?.path ?? l.files[0]?.path ?? null),
        );
      },
      (e) => live && setError(e instanceof ApiError && e.status === 404 ? e.message : e.message),
    );
    return () => {
      live = false;
    };
  }, [projectId, q, JSON.stringify(version)]);

  useEffect(() => {
    if (!selected) return setFile(null);
    let live = true;
    setFileError(null);
    get<FileView>(
      `/api/projects/${projectId}/file?path=${encodeURIComponent(selected)}${q ? `&${q}` : ""}`,
    ).then(
      (f) => live && setFile(f),
      (e) => live && setFileError(e.message),
    );
    return () => {
      live = false;
    };
  }, [projectId, q, selected, listing?.commit]);

  if (error) return <Empty title="Files aren't available">{emptyHint ?? error}</Empty>;
  if (!listing) return <Loading label="Loading files…" />;
  if (listing.files.length === 0) return <Empty title="No files yet" />;
  return (
    <div>
      <p
        className="muted small"
        style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)" }}
      >
        <code>{listing.ref}</code> at <code>{listing.commit.slice(0, 8)}</code> ·{" "}
        {listing.files.length} file{listing.files.length === 1 ? "" : "s"}
        {listing.truncated ? " (list truncated)" : ""}
        {sessionId ? " · as of the task's last checkpoint" : " · what has been merged"}
      </p>
      <div className="files-view">
        <nav className="file-list" aria-label="Files">
          {listing.files.map((f) => (
            <button
              key={f.path}
              aria-current={f.path === selected}
              title={f.path}
              onClick={() => setSelected(f.path)}
            >
              {f.path}
            </button>
          ))}
        </nav>
        <div className="file-body" aria-live="polite">
          {fileError ? (
            <p className="error small" style={{ padding: 16 }}>
              {fileError}
            </p>
          ) : !file ? (
            <Loading />
          ) : "content" in file ? (
            <pre>{file.content || " "}</pre>
          ) : (
            <p className="muted small" style={{ padding: 16 }}>
              {"binary" in file
                ? "Binary file — not shown."
                : `Too large to show (${Math.round(file.size / 1024)} KB).`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
