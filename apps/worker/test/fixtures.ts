import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerConfig } from "../src/config.js";

/** A throwaway repo standing in for Rogue: one commit on `main`. */
export function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "pairloom-test-"));
  const repo = join(root, "repo");
  const g = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "dev@example.com");
  g("config", "user.name", "Dev");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# Rogue\n");
  g("add", "-A");
  g("commit", "-q", "-m", "initial");
  return { root, repo, worktrees: join(root, "worktrees"), state: join(root, "state"), g };
}

export function workerConfig(r: ReturnType<typeof makeRepo>, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    serverUrl: "",
    token: "",
    repoPath: r.repo,
    worktreesDir: r.worktrees,
    stateDir: r.state,
    maxTurns: 5,
    maxBudgetUsd: undefined,
    model: undefined,
    simulatedStepMs: 0,
    ...overrides,
  };
}

/**
 * Point the real adapter at a local protocol stub and strip any credentials or
 * proxy settings inherited from the machine running the tests.
 */
export function isolateModelEnv(stubUrl: string | null) {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC")) delete process.env[k];
  }
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  process.env.NO_PROXY = "127.0.0.1,localhost";
  if (stubUrl) {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-stub-not-a-real-key";
    process.env.ANTHROPIC_BASE_URL = stubUrl;
  }
}

export async function until<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 20000,
  label = "condition",
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
