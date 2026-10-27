import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
export function assertSafeRef(ref: string) {
  if (!BRANCH_RE.test(ref) || ref.includes("..") || ref.startsWith("-") || ref.endsWith(".lock")) {
    throw new Error(`Unsafe git ref: ${ref}`);
  }
}

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}) {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trimEnd() };
  } catch (err) {
    if (opts.allowFail) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        ok: false,
        stdout: (e.stdout ?? "").trimEnd(),
        stderr: e.stderr ?? "",
        code: e.code,
      };
    }
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(e.stderr || e.message).trim().slice(0, 1000)}`);
  }
}

const AGENT_IDENT = [
  "-c",
  "user.name=Pairloom Agent",
  "-c",
  "user.email=agent@pairloom.invalid",
  "-c",
  "commit.gpgsign=false",
];

export interface ChangeSnapshot {
  baseCommit: string;
  headCommit: string;
  branchName: string;
  files: Array<{ path: string; insertions: number; deletions: number }>;
  diff: string;
  diffTruncated: boolean;
}

/**
 * One isolated git worktree per agent session, on its own branch. The agent
 * never writes to the base branch; merging is a separate, explicit, reviewed step.
 */
export class Workspace {
  constructor(
    readonly repoPath: string,
    readonly worktreesDir: string,
  ) {}

  async assertRepo() {
    const r = await git(this.repoPath, ["rev-parse", "--is-inside-work-tree"], { allowFail: true });
    if (!r.ok) throw new Error(`PAIRLOOM_REPO_PATH is not a git repository: ${this.repoPath}`);
  }

  pathFor(sessionId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error("Unsafe session id");
    return join(this.worktreesDir, sessionId);
  }

  /** Creates the worktree, or reuses it when resuming. Returns the base commit. */
  async ensureWorktree(sessionId: string, branchName: string, baseBranch: string) {
    assertSafeRef(branchName);
    assertSafeRef(baseBranch);
    const path = this.pathFor(sessionId);
    mkdirSync(this.worktreesDir, { recursive: true });
    const baseCommit = (
      await git(this.repoPath, ["rev-parse", "--verify", `${baseBranch}^{commit}`])
    ).stdout;
    if (existsSync(path)) {
      const head = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
      if (head.ok && head.stdout === branchName) {
        const mergeBase = (await git(path, ["merge-base", baseCommit, "HEAD"])).stdout;
        return { path, baseCommit: mergeBase };
      }
      throw new Error(`Worktree path exists but is not on ${branchName}: ${path}`);
    }
    const branchExists = await git(
      this.repoPath,
      ["rev-parse", "--verify", `refs/heads/${branchName}`],
      {
        allowFail: true,
      },
    );
    if (branchExists.ok) {
      await git(this.repoPath, ["worktree", "add", path, branchName]);
    } else {
      await git(this.repoPath, ["worktree", "add", "-b", branchName, path, baseCommit]);
    }
    return { path, baseCommit };
  }

  /** Commits everything in the worktree (if anything changed) and returns the diff vs base. */
  async snapshot(
    path: string,
    branchName: string,
    baseCommit: string,
    message: string,
    maxDiffBytes: number,
  ): Promise<ChangeSnapshot> {
    await git(path, ["add", "-A"]);
    const clean = await git(path, ["diff", "--cached", "--quiet"], { allowFail: true });
    if (!clean.ok) await git(path, [...AGENT_IDENT, "commit", "-q", "--no-verify", "-m", message]);
    const headCommit = (await git(path, ["rev-parse", "HEAD"])).stdout;
    const numstat = (await git(path, ["diff", "--numstat", baseCommit, headCommit])).stdout;
    const files = numstat
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ins, del, ...rest] = line.split("\t");
        return {
          path: rest.join("\t"),
          insertions: ins === "-" ? 0 : Number(ins),
          deletions: del === "-" ? 0 : Number(del),
        };
      });
    let diff = (await git(path, ["diff", "--no-color", baseCommit, headCommit])).stdout;
    let diffTruncated = false;
    if (Buffer.byteLength(diff) > maxDiffBytes) {
      diff = Buffer.from(diff).subarray(0, maxDiffBytes).toString("utf8");
      diffTruncated = true;
    }
    return { baseCommit, headCommit, branchName, files, diff, diffTruncated };
  }

  /**
   * Merges a reviewed branch into the base branch in the worker's own clone.
   * Refuses if the branch moved since review or the clone is dirty. Never pushes.
   */
  async merge(branchName: string, baseBranch: string, expectedHead: string, message: string) {
    assertSafeRef(branchName);
    assertSafeRef(baseBranch);
    const head = (await git(this.repoPath, ["rev-parse", `refs/heads/${branchName}`])).stdout;
    if (head !== expectedHead) {
      throw new Error(
        `Branch moved since review (expected ${expectedHead.slice(0, 10)}, found ${head.slice(0, 10)})`,
      );
    }
    const status = (await git(this.repoPath, ["status", "--porcelain", "--untracked-files=no"]))
      .stdout;
    if (status) throw new Error("Worker repository has uncommitted changes; refusing to merge");
    await git(this.repoPath, ["checkout", "-q", baseBranch]);
    const merged = await git(
      this.repoPath,
      [...AGENT_IDENT, "merge", "--no-ff", "--no-edit", "-m", message, branchName],
      { allowFail: true },
    );
    if (!merged.ok) {
      await git(this.repoPath, ["merge", "--abort"], { allowFail: true });
      throw new Error(
        `Merge failed (conflicts?): ${(merged.stderr || merged.stdout).slice(0, 1000)}`,
      );
    }
    return (await git(this.repoPath, ["rev-parse", "HEAD"])).stdout;
  }
}
