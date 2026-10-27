import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Relative paths in config are relative to the repository root, whatever the cwd. */
const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fromRoot = (p: string) => (p === ":memory:" || isAbsolute(p) ? p : resolve(REPO_ROOT, p));

export interface ServerConfig {
  port: number;
  host: string;
  /** Public origin of the web app, e.g. https://pairloom.internal. Used for invite links and Origin checks. */
  publicOrigin: string;
  /** Extra origins allowed to open browser WebSockets / send mutating requests (dev: Vite). */
  allowedOrigins: string[];
  databasePath: string;
  /** Mark cookies Secure. Must be true behind HTTPS. */
  secureCookies: boolean;
  sessionTtlHours: number;
  inviteTtlHours: number;
  /** Allow anyone to sign up. When false, signup requires a valid invitation token. */
  openSignup: boolean;
  /** Directory with the built web app to serve, if any. */
  webDistDir: string | null;
  /**
   * Directory with the built public site, if any. When set, the site is served at "/"
   * and the web app moves to "/app/"; when unset, the web app stays at "/".
   */
  siteDistDir: string | null;
  /** Interval for server-side WebSocket liveness pings; a socket missing one is dropped. */
  heartbeatMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8787);
  const publicOrigin = env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    publicOrigin,
    allowedOrigins: [
      publicOrigin,
      ...(env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ],
    databasePath: fromRoot(env.DATABASE_PATH ?? "./data/pairloom.sqlite"),
    secureCookies: env.SECURE_COOKIES === "true" || publicOrigin.startsWith("https://"),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 24 * 7),
    inviteTtlHours: Number(env.INVITE_TTL_HOURS ?? 72),
    openSignup: env.OPEN_SIGNUP !== "false",
    webDistDir: env.WEB_DIST_DIR ? fromRoot(env.WEB_DIST_DIR) : null,
    siteDistDir: env.SITE_DIST_DIR ? fromRoot(env.SITE_DIST_DIR) : null,
    heartbeatMs: Number(env.WS_HEARTBEAT_MS ?? 20_000),
  };
}
