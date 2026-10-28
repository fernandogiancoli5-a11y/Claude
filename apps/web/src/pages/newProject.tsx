import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { navigate } from "../router.js";
import { useAction } from "../ui.js";

type Source = "sample" | "empty" | "git" | "external";

const SOURCES: Array<{ id: Source; title: string; text: string; hostedOnly: boolean }> = [
  {
    id: "sample",
    title: "Starter project",
    text: "A small shopping-cart app with tests. The quickest way to try the agent.",
    hostedOnly: true,
  },
  {
    id: "git",
    title: "Import a public Git repository",
    text: "Pairloom clones it (https only). Private repositories aren't supported yet.",
    hostedOnly: true,
  },
  {
    id: "empty",
    title: "Empty repository",
    text: "Start from a README and have the agent build from scratch.",
    hostedOnly: true,
  },
  {
    id: "external",
    title: "Use my own machine (advanced)",
    text: "Run a Pairloom worker next to your own clone; the agent works there.",
    hostedOnly: false,
  },
];

let configCache: Promise<{ hostedWorkers: boolean }> | null = null;
export const serverConfig = () =>
  (configCache ??= get<{ hostedWorkers: boolean }>("/api/config").catch(() => ({
    hostedWorkers: false,
  })));

/** Project creation used by the dashboard and the team page. */
export function NewProjectForm({
  workspaceId,
  workspaces,
  onCancel,
}: {
  workspaceId?: string;
  workspaces?: Array<{ id: string; name: string }>;
  onCancel?: () => void;
}) {
  const [hostedAvailable, setHosted] = useState<boolean | null>(null);
  const [wsId, setWsId] = useState(workspaceId ?? workspaces?.[0]?.id ?? "");
  const [name, setName] = useState("");
  const [source, setSource] = useState<Source>("sample");
  const [gitUrl, setGitUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const { busy, run } = useAction();

  useEffect(() => {
    void serverConfig().then((c) => {
      setHosted(c.hostedWorkers);
      if (!c.hostedWorkers) setSource("external");
    });
  }, []);

  const options = SOURCES.filter((s) => hostedAvailable || !s.hostedOnly);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() =>
          post(`/api/workspaces/${wsId}/projects`, {
            name,
            source,
            defaultBranch: branch,
            repoUrl: source === "git" ? gitUrl : null,
          }),
        );
        if (p) navigate(`/p/${p.id}`);
      }}
    >
      <div className="form-grid">
        {workspaces && workspaces.length > 1 && (
          <label>
            Team
            <select value={wsId} onChange={(e) => setWsId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Project name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </label>
      </div>

      {hostedAvailable === null ? (
        <p className="muted small">Loading options…</p>
      ) : (
        <fieldset className="choices">
          <legend className="small">Where does the code come from?</legend>
          {options.map((o) => (
            <label key={o.id} className={`choice ${source === o.id ? "selected" : ""}`}>
              <input
                type="radio"
                name="source"
                value={o.id}
                checked={source === o.id}
                onChange={() => setSource(o.id)}
              />
              <span>
                <b>{o.title}</b>
                <span className="muted small">{o.text}</span>
              </span>
            </label>
          ))}
          {!hostedAvailable && (
            <p className="muted small">
              This server doesn't host workspaces, so the agent runs on a machine you connect.
            </p>
          )}
        </fieldset>
      )}

      {source === "git" && (
        <label>
          Repository URL
          <input
            type="url"
            placeholder="https://github.com/owner/repo"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            required
          />
        </label>
      )}
      {(source === "empty" || source === "external") && (
        <label>
          Base branch
          <input value={branch} onChange={(e) => setBranch(e.target.value)} required />
        </label>
      )}

      <div className="row end">
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="primary" disabled={busy || hostedAvailable === null}>
          {busy && <span className="spinner" />}
          {busy ? (source === "git" ? "Cloning repository…" : "Setting up…") : "Add project"}
        </button>
      </div>
    </form>
  );
}
