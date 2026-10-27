import { resolve } from "node:path";

export interface WorkerConfig {
  serverUrl: string;
  token: string;
  /** Dedicated git clone the worker owns (not someone's day-to-day working copy). */
  repoPath: string;
  worktreesDir: string;
  stateDir: string;
  maxTurns: number;
  maxBudgetUsd: number | undefined;
  model: string | undefined;
  /** Delay between simulated steps; 0 in tests. */
  simulatedStepMs: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const required = (key: string) => {
    const v = env[key];
    if (!v) throw new Error(`${key} is required`);
    return v;
  };
  const stateDir = resolve(env.PAIRLOOM_STATE_DIR ?? "./data/worker-state");
  return {
    serverUrl: required("PAIRLOOM_SERVER_URL"),
    token: required("PAIRLOOM_WORKER_TOKEN"),
    repoPath: resolve(required("PAIRLOOM_REPO_PATH")),
    worktreesDir: resolve(env.PAIRLOOM_WORKTREES_DIR ?? "./data/worktrees"),
    stateDir,
    maxTurns: Number(env.CLAUDE_MAX_TURNS ?? 50),
    maxBudgetUsd: env.CLAUDE_MAX_BUDGET_USD ? Number(env.CLAUDE_MAX_BUDGET_USD) : undefined,
    model: env.CLAUDE_MODEL || undefined,
    simulatedStepMs: Number(env.PAIRLOOM_SIMULATED_STEP_MS ?? 600),
  };
}

/**
 * Supported, documented ways for the Agent SDK to authenticate in a product we
 * operate: an API key, Amazon Bedrock, or Google Vertex. claude.ai subscription
 * login is deliberately not used (Anthropic does not permit third-party products
 * to offer it without approval).
 */
export function detectModelCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  if (env.CLAUDE_CODE_USE_BEDROCK === "1") return "Amazon Bedrock";
  if (env.CLAUDE_CODE_USE_VERTEX === "1") return "Google Vertex AI";
  return null;
}

const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "TMPDIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  // Model credentials (documented SDK auth methods only).
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_REGION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

/**
 * Environment for the agent subprocess. Built from an allowlist so the worker's
 * own token and unrelated host secrets never reach the agent's shell.
 */
export function buildAgentEnv(config: WorkerConfig, env: NodeJS.ProcessEnv = process.env) {
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  out.CLAUDE_CONFIG_DIR = resolve(config.stateDir, "claude-config");
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return out;
}
