import { type ChildProcess, execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Pairloom-hosted workspaces: the server keeps a real git repository per project and runs the
 * ordinary worker (apps/worker) for it as a supervised child process, so a team can give the
 * agent work straight from the browser. The worker code is unchanged; it connects back to this
 * server over the normal worker WebSocket with a token that is re-issued on every start and
 * never stored in plaintext.
 *
 * The agent reads and edits files on the server's machine inside the worker's sandbox. Hosted
 * workers never run project code or tests (see workerEnv): there is no OS-level isolation
 * here, so that stays off unless an operator explicitly opts in on a private machine.
 */

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SAMPLE_DIR = join(REPO_ROOT, "samples/tiny-cart");
const GIT_TIMEOUT_MS = 120_000;

export type RepoSource =
  { kind: "sample" } | { kind: "empty"; branch: string } | { kind: "git"; url: string };

export class RepoSetupError extends Error {}

/**
 * Only public https remotes: no credentials in the URL, no local or private-network hosts, and
 * git's other transports disabled, so a project can't be pointed at the server's own network.
 */
export function validateGitUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new RepoSetupError("Enter a full https:// Git URL, e.g. https://github.com/owner/repo");
  }
  if (u.protocol !== "https:") throw new RepoSetupError("Only https:// Git URLs are supported");
  if (u.username || u.password)
    throw new RepoSetupError("Don't put credentials in the URL; only public repositories work");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isIP(host) !== 0
  ) {
    throw new RepoSetupError("Use a public Git host name (not an IP address or local host)");
  }
  return u.toString();
}

/** Caps for importing a public repository; override with PAIRLOOM_IMPORT_* env vars. */
export function importLimits(env: NodeJS.ProcessEnv = process.env) {
  const n = (key: string, fallback: number) => {
    const v = Number(env[key]);
    return env[key] && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    maxMb: n("PAIRLOOM_IMPORT_MAX_MB", 200),
    maxFiles: n("PAIRLOOM_IMPORT_MAX_FILES", 20_000),
    timeoutMs: n("PAIRLOOM_IMPORT_TIMEOUT_SECONDS", 120) * 1000,
  };
}

const git = (cwd: string, args: string[], timeout = GIT_TIMEOUT_MS) =>
  execFileP(
    "git",
    [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "user.name=Pairloom",
      "-c",
      "user.email=workspace@pairloom.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" },
    },
  );

/** Creates the project's repository at `dir`; returns its default branch. */
export async function createRepo(
  dir: string,
  source: RepoSource,
  limits = importLimits(),
): Promise<{ branch: string }> {
  if (existsSync(dir)) throw new RepoSetupError("Workspace directory already exists");
  mkdirSync(dir, { recursive: true });
  try {
    if (source.kind === "git") {
      const url = validateGitUrl(source.url);
      try {
        await git(
          dir,
          ["clone", "--quiet", "--depth", "200", "--no-tags", url, "."],
          limits.timeoutMs,
        );
      } catch (err) {
        const stderr = String((err as { stderr?: string }).stderr ?? "");
        // Hosts answer a missing or private repo with a credentials prompt, which we refuse.
        if (/askpass|could not read Username|Authentication failed|not found/i.test(stderr)) {
          throw new RepoSetupError(
            "That repository doesn't exist or isn't public. Pairloom can only import public repositories.",
          );
        }
        if ((err as { killed?: boolean }).killed) {
          throw new RepoSetupError(
            `Cloning took longer than ${Math.round(limits.timeoutMs / 1000)}s and was stopped. ` +
              "Very large repositories can't be imported here; try a smaller one.",
          );
        }
        const msg = stderr.split("\n").find((l) => /fatal|error/i.test(l));
        throw new RepoSetupError(
          `Couldn't clone that repository${msg ? `: ${msg.replace(/^fatal:\s*/i, "").slice(0, 200)}` : ""}. Check that it is public and the URL is right.`,
        );
      }
      const head = await git(dir, ["symbolic-ref", "--short", "HEAD"]).catch(() => null);
      const branch = head?.stdout.trim();
      if (!branch) throw new RepoSetupError("The repository has no default branch to work from");
      const hasCommit = await git(dir, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
      if (!hasCommit) throw new RepoSetupError("The repository is empty");
      // Checked after the clone (sizes are only known then); the clone timeout bounds the rest.
      const tree = await git(dir, ["ls-tree", "-r", "-l", "HEAD"]);
      let files = 0;
      let bytes = 0;
      for (const line of tree.stdout.split("\n")) {
        const m = /^\d+ blob \w+\s+(\d+)\t/.exec(line);
        if (m) {
          files++;
          bytes += Number(m[1]);
        }
      }
      const mb = bytes / 1024 / 1024;
      if (files > limits.maxFiles || mb > limits.maxMb) {
        throw new RepoSetupError(
          `That repository is too big to import here (${files} files, ${mb.toFixed(0)} MB; ` +
            `the limit is ${limits.maxFiles} files and ${limits.maxMb} MB).`,
        );
      }
      return { branch };
    }
    const branch = source.kind === "sample" ? "main" : source.branch;
    if (source.kind === "sample") {
      cpSync(SAMPLE_DIR, dir, {
        recursive: true,
        filter: (src) => !src.includes("node_modules"),
      });
    } else {
      writeFileSync(
        join(dir, "README.md"),
        "# New project\n\nCreated in Pairloom. Ask the agent to start building.\n",
      );
    }
    await git(dir, ["init", "--quiet", "-b", branch]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "--quiet", "-m", "Initial commit"]);
    return { branch };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Environment the worker child needs; never the server's own secrets (e.g. DATABASE_PATH). */
const WORKER_ENV_PASSTHROUGH =
  /^(PATH|HOME|LANG|LC_ALL|TMPDIR|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|GROQ_API_KEY|OPENAI_API_KEY|LLM_[A-Z_]+|AGENT_[A-Z_]+|PAIRLOOM_REAL_ADAPTER|PAIRLOOM_SIMULATED_STEP_MS)$/;

export function workerEnv(
  base: NodeJS.ProcessEnv,
  vars: { serverUrl: string; token: string; dir: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base))
    if (v !== undefined && WORKER_ENV_PASSTHROUGH.test(k)) env[k] = v;
  return {
    ...env,
    NODE_NO_WARNINGS: "1",
    PAIRLOOM_SERVER_URL: vars.serverUrl,
    PAIRLOOM_WORKER_TOKEN: vars.token,
    PAIRLOOM_REPO_PATH: join(vars.dir, "repo"),
    PAIRLOOM_WORKTREES_DIR: join(vars.dir, "worktrees"),
    PAIRLOOM_STATE_DIR: join(vars.dir, "state"),
    // Fail closed: project code (tests, commands) must not run on the server, because nothing
    // here isolates it from the server's secrets, data or other projects. Only an operator who
    // explicitly accepts that risk on a private machine can opt in.
    PAIRLOOM_CODE_EXECUTION:
      base.PAIRLOOM_HOSTED_CODE_EXECUTION === "unsafe-allow" ? "enabled" : "disabled",
  };
}

export interface HostedWorkerSource {
  /** Hosted, non-revoked workers to run: id and project. */
  listHostedWorkers(): Array<{ id: string; projectId: string }>;
  /** Issues a fresh token (only its hash is stored) for the next start. */
  rotateWorkerToken(workerId: string): string;
}

interface Child {
  proc: ChildProcess | null;
  restarts: number;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

/** Keeps one worker process per hosted worker running, restarting with backoff. */
export class HostedWorkers {
  private children = new Map<string, Child>();
  private serverUrl: string | null = null;

  constructor(
    private source: HostedWorkerSource,
    readonly baseDir: string,
    private log: (msg: string) => void,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  dirFor(projectId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error("Unsafe project id");
    return join(this.baseDir, projectId);
  }

  repoPath(projectId: string) {
    return join(this.dirFor(projectId), "repo");
  }

  /** Called once the server is listening; starts every hosted worker. */
  start(serverUrl: string) {
    this.serverUrl = serverUrl;
    for (const w of this.source.listHostedWorkers()) this.ensure(w.id, w.projectId);
  }

  ensure(workerId: string, projectId: string) {
    const existing = this.children.get(workerId);
    if (existing && !existing.stopped) return;
    const child: Child = { proc: null, restarts: 0, timer: null, stopped: false };
    this.children.set(workerId, child);
    if (this.serverUrl) this.spawn(workerId, projectId, child);
  }

  stop(workerId: string) {
    const c = this.children.get(workerId);
    if (!c) return;
    c.stopped = true;
    if (c.timer) clearTimeout(c.timer);
    c.proc?.kill("SIGTERM");
    this.children.delete(workerId);
  }

  async stopAll() {
    const procs = [...this.children.values()].map((c) => c.proc).filter(Boolean) as ChildProcess[];
    for (const id of [...this.children.keys()]) this.stop(id);
    await Promise.all(
      procs.map(
        (p) =>
          new Promise<void>((done) => {
            if (p.exitCode !== null || p.signalCode !== null) return done();
            const t = setTimeout(() => {
              p.kill("SIGKILL");
              done();
            }, 5000);
            p.once("exit", () => {
              clearTimeout(t);
              done();
            });
          }),
      ),
    );
  }

  private spawn(workerId: string, projectId: string, child: Child) {
    if (child.stopped || !this.serverUrl) return;
    const dir = this.dirFor(projectId);
    if (!existsSync(join(dir, "repo"))) {
      this.log(`hosted worker ${workerId}: repository missing at ${dir}; not starting`);
      return;
    }
    const token = this.source.rotateWorkerToken(workerId);
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "apps/worker/src/index.ts")],
      {
        cwd: REPO_ROOT,
        env: workerEnv(this.env, { serverUrl: this.serverUrl, token, dir }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.proc = proc;
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean))
        this.log(`[hosted ${projectId}] ${line}`);
    };
    proc.stdout?.on("data", relay);
    proc.stderr?.on("data", relay);
    proc.on("exit", (code, signal) => {
      if (child.proc === proc) child.proc = null;
      if (child.stopped) return;
      child.restarts += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(child.restarts - 1, 5));
      this.log(
        `hosted worker for ${projectId} exited (${signal ?? code}); restarting in ${delay / 1000}s`,
      );
      child.timer = setTimeout(() => this.spawn(workerId, projectId, child), delay);
    });
  }
}

// ------------------------------------------------------------- read-only file browsing

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 256 * 1024;

const readGit = (cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024) =>
  execFileP("git", args, { cwd, timeout: 15_000, maxBuffer, encoding: "buffer" });

/** Files at a ref (committed state only), with sizes. */
export async function listFiles(repo: string, ref: string) {
  const commit = (await readGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout
    .toString()
    .trim();
  const out = (
    await readGit(repo, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit])
  ).stdout.toString();
  const files: Array<{ path: string; size: number }> = [];
  for (const entry of out.split("\0")) {
    // "<mode> <type> <object> <size>\t<path>"
    const m = /^\d+ blob [0-9a-f]+\s+(\d+|-)\t(.+)$/s.exec(entry);
    if (m) files.push({ path: m[2]!, size: Number(m[1]) || 0 });
  }
  return { commit, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

export function assertSafeRepoPath(path: string) {
  if (
    !path ||
    path.length > 1000 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new RepoSetupError("Invalid file path");
  }
}

/** One file's content at a ref; binary and oversized files are reported, not returned. */
export async function readFile(repo: string, ref: string, path: string) {
  assertSafeRepoPath(path);
  const spec = `${ref}:${path}`;
  const size = await readGit(repo, ["cat-file", "-s", spec]).then(
    (r) => Number(r.stdout.toString().trim()),
    () => null,
  );
  if (size === null) return null;
  if (size > MAX_FILE_BYTES) return { path, size, tooLarge: true as const };
  const buf = (await readGit(repo, ["cat-file", "blob", spec], MAX_FILE_BYTES + 1024)).stdout;
  if (buf.includes(0)) return { path, size, binary: true as const };
  return { path, size, content: buf.toString("utf8") };
}

// ------------------------------------------------------------- downloads

/** A .tar.gz of the committed tree at `ref` (never the working copy, never .git). */
export async function archiveRef(repo: string, ref: string, prefix: string) {
  const commit = (await readGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout
    .toString()
    .trim();
  const proc = spawn("git", ["archive", "--format=tar.gz", `--prefix=${prefix}/`, commit], {
    cwd: repo,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { commit, stream: proc.stdout! };
}

/** The complete diff between two commits (the stored one may be truncated for display). */
export async function diffCommits(repo: string, base: string, head: string) {
  if (!/^[0-9a-f]{7,64}$/.test(base) || !/^[0-9a-f]{7,64}$/.test(head))
    throw new RepoSetupError("Invalid commit");
  return (await readGit(repo, ["diff", "--binary", `${base}..${head}`], 64 * 1024 * 1024)).stdout;
}

/** Safe file-name stem for downloads. */
export function downloadName(...parts: string[]) {
  return (
    parts
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "pairloom"
  );
}
