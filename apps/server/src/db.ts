import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Loaded via require so bundler-based tooling (Vite/Vitest) does not try to resolve
// the comparatively new `node:sqlite` builtin as a package.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * SQLite via Node's built-in driver: zero native dependencies, one file, good
 * enough for a single-node private deployment. All SQL lives in store.ts so a
 * move to Postgres is contained.
 */
export type Db = DatabaseSyncType;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE memberships (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','collaborator','viewer')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );

  CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('owner','collaborator','viewer')),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_by TEXT REFERENCES users(id),
    accepted_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    repo_url TEXT,
    default_branch TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE workers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local','cloud')),
    token_hash TEXT NOT NULL UNIQUE,
    adapters_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL REFERENCES workers(id),
    host_user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    execution_mode TEXT NOT NULL CHECK (execution_mode IN ('real','simulated')),
    permission_policy TEXT NOT NULL,
    provider_session_id TEXT,
    branch_name TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX agent_sessions_project ON agent_sessions(project_id, created_at);
  CREATE INDEX agent_sessions_worker ON agent_sessions(worker_id, status);

  CREATE TABLE session_events (
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    event_uid TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_user_id TEXT,
    execution_mode TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE instructions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','rejected','delivered','failed')),
    decided_by TEXT REFERENCES users(id),
    decided_at TEXT,
    decision_note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX instructions_session ON instructions(session_id, created_at);

  CREATE TABLE permission_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_json TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','allowed','denied','expired')),
    decided_by TEXT REFERENCES users(id),
    decided_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, request_id)
  );

  CREATE TABLE change_sets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    base_commit TEXT NOT NULL,
    head_commit TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    files_json TEXT NOT NULL,
    diff TEXT NOT NULL,
    diff_truncated INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','superseded','merging','merged','merge_failed')),
    execution_mode TEXT NOT NULL,
    merge_commit TEXT,
    merge_error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
    reviewer_id TEXT NOT NULL REFERENCES users(id),
    decision TEXT NOT NULL CHECK (decision IN ('approve','request_changes','comment')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE worker_commands (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    command_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','acked','failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    acked_at TEXT
  );
  CREATE INDEX worker_commands_pending ON worker_commands(worker_id, status, created_at);
  `,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as
    | { version: number }
    | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      version += 1;
      db.prepare("UPDATE schema_version SET version = ?").run(version);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
