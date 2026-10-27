import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PermissionPolicy } from "@pairloom/shared";
import type { ToolSchema } from "./provider.js";

export class ToolError extends Error {}

export const LIMITS = {
  readMaxBytes: 64 * 1024,
  writeMaxBytes: 256 * 1024,
  listMaxEntries: 400,
  searchMaxMatches: 200,
  commandOutputMaxBytes: 32 * 1024,
};

/** Project-level settings read once from `.pairloom.json` at session start (agent cannot change them). */
export interface ProjectSettings {
  testCommand: string[] | null;
  /** Exact argv lists that may run without asking under the accept-edits policy. */
  allowedCommands: string[][];
}

export function loadProjectSettings(root: string): ProjectSettings {
  const file = join(root, ".pairloom.json");
  const fallback: ProjectSettings = { testCommand: null, allowedCommands: [] };
  if (!existsSync(file)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const argv = (v: unknown) =>
      Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")
        ? (v as string[])
        : null;
    const testCommand = argv(raw.testCommand);
    const allowed = Array.isArray(raw.allowedCommands)
      ? (raw.allowedCommands.map(argv).filter(Boolean) as string[][])
      : [];
    return { testCommand, allowedCommands: testCommand ? [testCommand, ...allowed] : allowed };
  } catch {
    return fallback;
  }
}

const SENSITIVE = [
  /(^|\/)\.env(\..*)?$/,
  /\.pem$/,
  /\.key$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
  /(^|\/)\.npmrc$/,
];
const PROTECTED_WRITE = [/^\.pairloom\.json$/];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

/** Commands refused outright, whatever anyone approves. */
const HARD_DENY_ARGV0 = new Set([
  "sudo",
  "su",
  "doas",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "telnet",
  "curl",
  "wget",
  "shutdown",
  "reboot",
  "mkfs",
  "dd",
]);
const HARD_DENY_GIT = new Set([
  "push",
  "remote",
  "checkout",
  "switch",
  "worktree",
  "reset",
  "rebase",
  "merge",
  "config",
  "filter-branch",
  "gc",
  "clean",
]);

/**
 * Every path the agent touches is resolved inside `root`. `..`, absolute paths
 * outside the root, symlinks that point out of it, and `.git` are refused.
 */
export class Sandbox {
  readonly root: string;
  constructor(root: string) {
    this.root = realpathSync(root);
  }

  resolve(p: string, forWrite = false): { abs: string; rel: string } {
    if (typeof p !== "string" || !p.trim()) throw new ToolError("path is required");
    if (p.includes("\0")) throw new ToolError("invalid path");
    const abs = resolve(this.root, p);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ToolError(`Path is outside the project directory: ${p}`);
    }
    if (rel.split(sep).includes(".git")) throw new ToolError("Access to .git is not allowed");
    // Follow symlinks for whatever part of the path exists.
    let probe = abs;
    while (!existsSync(probe) && probe !== this.root) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + sep)) {
      throw new ToolError(`Path escapes the project directory via a symlink: ${p}`);
    }
    if (forWrite && existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
      throw new ToolError(`Refusing to write through a symlink: ${p}`);
    }
    return { abs, rel: rel || "." };
  }

  isSensitive(rel: string) {
    return SENSITIVE.some((r) => r.test(rel));
  }

  async readFile(p: string, offset = 0, limit?: number) {
    const { abs, rel } = this.resolve(p);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new ToolError(`No such file: ${rel}`);
    const buf = await readFile(abs);
    if (buf.includes(0)) throw new ToolError(`${rel} looks binary; not shown`);
    const lines = buf.toString("utf8").split("\n");
    const start = Math.max(0, offset);
    const slice = lines.slice(start, limit ? start + limit : undefined);
    let text = slice.map((l, i) => `${String(start + i + 1).padStart(4)}| ${l}`).join("\n");
    let note = "";
    if (Buffer.byteLength(text) > LIMITS.readMaxBytes) {
      text = text.slice(0, LIMITS.readMaxBytes);
      note = `\n[truncated; ${lines.length} lines total — use offset/limit]`;
    }
    return text + note;
  }

  async writeFile(p: string, content: string) {
    if (typeof content !== "string") throw new ToolError("content must be a string");
    if (Buffer.byteLength(content) > LIMITS.writeMaxBytes) throw new ToolError("content too large");
    const { abs, rel } = this.resolve(p, true);
    if (PROTECTED_WRITE.some((r) => r.test(rel))) throw new ToolError(`${rel} is protected`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return `Wrote ${rel} (${Buffer.byteLength(content)} bytes)`;
  }

  async editFile(p: string, oldString: string, newString: string) {
    if (typeof oldString !== "string" || typeof newString !== "string" || !oldString) {
      throw new ToolError("old_string and new_string are required");
    }
    const { abs, rel } = this.resolve(p, true);
    if (PROTECTED_WRITE.some((r) => r.test(rel))) throw new ToolError(`${rel} is protected`);
    if (!existsSync(abs)) throw new ToolError(`No such file: ${rel}`);
    const text = await readFile(abs, "utf8");
    const count = text.split(oldString).length - 1;
    if (count === 0) throw new ToolError(`old_string not found in ${rel}`);
    if (count > 1)
      throw new ToolError(`old_string matches ${count} times in ${rel}; make it unique`);
    await writeFile(
      abs,
      text.replace(oldString, () => newString),
    );
    return `Edited ${rel}`;
  }

  async deleteFile(p: string) {
    const { abs, rel } = this.resolve(p, true);
    if (PROTECTED_WRITE.some((r) => r.test(rel))) throw new ToolError(`${rel} is protected`);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new ToolError(`No such file: ${rel}`);
    await unlink(abs);
    return `Deleted ${rel}`;
  }

  listFiles(p = ".") {
    const { abs, rel } = this.resolve(p);
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (out.length >= LIMITS.listMaxEntries) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        const r = relative(this.root, full);
        if (entry.isDirectory()) {
          out.push(r + "/");
          walk(full);
        } else out.push(r);
      }
    };
    if (!existsSync(abs)) throw new ToolError(`No such directory: ${rel}`);
    walk(abs);
    return out.length >= LIMITS.listMaxEntries
      ? [...out, "[listing truncated]"].join("\n")
      : out.join("\n") || "(empty)";
  }

  search(pattern: string, p = ".") {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      throw new ToolError("Invalid regular expression");
    }
    const { abs } = this.resolve(p);
    const matches: string[] = [];
    const visit = (file: string) => {
      const st = statSync(file);
      if (st.size > 1024 * 1024) return;
      const buf = readFileSync(file);
      if (buf.includes(0)) return;
      buf
        .toString("utf8")
        .split("\n")
        .forEach((line, i) => {
          if (matches.length < LIMITS.searchMaxMatches && re.test(line)) {
            matches.push(`${relative(this.root, file)}:${i + 1}: ${line.slice(0, 300)}`);
          }
        });
    };
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) visit(full);
      }
    };
    if (statSync(abs).isDirectory()) walk(abs);
    else visit(abs);
    return matches.join("\n") || "No matches";
  }
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  output: string;
}

/** Throws ToolError for commands that are never allowed, regardless of approval. */
export function assertCommandAllowed(argv: string[]) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
    throw new ToolError("argv must be a non-empty array of strings");
  }
  const cmd = argv[0]!.split("/").pop()!;
  if (HARD_DENY_ARGV0.has(cmd)) throw new ToolError(`'${cmd}' is not allowed`);
  if (cmd === "git" && argv[1] && HARD_DENY_GIT.has(argv[1])) {
    throw new ToolError(
      `'git ${argv[1]}' is not allowed (branches, remotes and merges are managed by Pairloom)`,
    );
  }
  if (cmd === "rm" && argv.some((a) => a === "/" || a === "~" || a === "/*")) {
    throw new ToolError("Refusing to remove the filesystem root or home directory");
  }
}

/**
 * Runs argv (no shell) in the project directory with a minimal environment that
 * contains no API keys or worker credentials. The whole process group is killed
 * on timeout or cancellation, and output is capped.
 */
export function runCommand(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal; sandboxHome: string },
): Promise<CommandResult> {
  assertCommandAllowed(argv);
  mkdirSync(opts.sandboxHome, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: opts.sandboxHome,
    LANG: process.env.LANG ?? "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
  };
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let output = "";
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > LIMITS.commandOutputMaxBytes * 2) {
        output = output.slice(-LIMITS.commandOutputMaxBytes);
        truncated = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killGroup();
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null, signal: string | null, extra = "") => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      killGroup(); // reap stragglers that kept the pipes open
      let out =
        output.length > LIMITS.commandOutputMaxBytes
          ? output.slice(-LIMITS.commandOutputMaxBytes)
          : output;
      if (truncated || output.length > LIMITS.commandOutputMaxBytes)
        out = "[output truncated; showing tail]\n" + out;
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        output: out + extra,
      });
    };
    child.on("error", (err) => finish(null, null, `\n[failed to start: ${err.message}]`));
    child.on("close", (code, sig) => finish(code, sig));
  });
}

export type ToolName =
  | "list_files"
  | "read_file"
  | "search"
  | "write_file"
  | "edit_file"
  | "delete_file"
  | "run_tests"
  | "run_command";

export type PermissionClass = "auto" | "ask";

/**
 * Who has to say yes before a tool call runs. Reads are free (except likely
 * secret files); edits follow the session policy; deletes and arbitrary commands
 * always ask the host unless the project explicitly allowlisted the exact argv.
 */
export function classifyToolCall(
  name: ToolName,
  args: Record<string, unknown>,
  policy: PermissionPolicy,
  settings: ProjectSettings,
  sandbox: Sandbox,
): PermissionClass {
  switch (name) {
    case "list_files":
    case "search":
      return "auto";
    case "read_file": {
      const { rel } = sandbox.resolve(String(args.path ?? ""));
      return sandbox.isSensitive(rel) ? "ask" : "auto";
    }
    case "write_file":
    case "edit_file":
      return policy === "accept_edits_in_worktree" ? "auto" : "ask";
    case "delete_file":
      return "ask";
    case "run_tests":
      return policy === "accept_edits_in_worktree" ? "auto" : "ask";
    case "run_command": {
      const argv = args.argv as string[];
      const listed = settings.allowedCommands.some(
        (a) => a.length === argv.length && a.every((x, i) => x === argv[i]),
      );
      return listed && policy === "accept_edits_in_worktree" ? "auto" : "ask";
    }
  }
}

const str = (description: string) => ({ type: "string", description });

export function toolSchemas(settings: ProjectSettings): ToolSchema[] {
  const tools: ToolSchema[] = [
    {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List files under a directory of the project (recursive; skips .git and node_modules).",
        parameters: {
          type: "object",
          properties: { path: str("Directory relative to the project root; default '.'") },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file. Output has line numbers. Use offset/limit for large files.",
        parameters: {
          type: "object",
          properties: {
            path: str("File path relative to the project root"),
            offset: { type: "integer", description: "0-based first line" },
            limit: { type: "integer", description: "Number of lines" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search",
        description: "Search file contents with a JavaScript regular expression.",
        parameters: {
          type: "object",
          properties: {
            pattern: str("Regular expression"),
            path: str("Directory or file; default '.'"),
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or overwrite a file with the full content given.",
        parameters: {
          type: "object",
          properties: {
            path: str("File path relative to the project root"),
            content: str("Complete new file content"),
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Replace one exact, unique occurrence of old_string with new_string in a file.",
        parameters: {
          type: "object",
          properties: {
            path: str("File path relative to the project root"),
            old_string: str("Exact text to replace; must occur exactly once"),
            new_string: str("Replacement text"),
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_file",
        description: "Delete a file. Requires approval from the session host.",
        parameters: { type: "object", properties: { path: str("File path") }, required: ["path"] },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a program in the project directory WITHOUT a shell (no pipes, redirects or globbing). " +
          "Requires approval from the session host unless allowlisted. Network tools, sudo and git branch/remote operations are refused.",
        parameters: {
          type: "object",
          properties: {
            argv: {
              type: "array",
              items: { type: "string" },
              description: 'e.g. ["node", "script.js"]',
            },
          },
          required: ["argv"],
        },
      },
    },
  ];
  if (settings.testCommand) {
    tools.push({
      type: "function",
      function: {
        name: "run_tests",
        description: `Run the project's test suite (${settings.testCommand.join(" ")}). Returns exit code and output.`,
        parameters: { type: "object", properties: {} },
      },
    });
  }
  return tools;
}
