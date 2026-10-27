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
    databasePath: env.DATABASE_PATH ?? "./data/pairloom.sqlite",
    secureCookies: env.SECURE_COOKIES === "true" || publicOrigin.startsWith("https://"),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 24 * 7),
    inviteTtlHours: Number(env.INVITE_TTL_HOURS ?? 72),
    openSignup: env.OPEN_SIGNUP !== "false",
    webDistDir: env.WEB_DIST_DIR ?? null,
  };
}
