import { createHmac } from "node:crypto";
import { isLikelySpam, rateLimitKey, WaitlistInput } from "@pairloom/shared/waitlist";

/**
 * POST /api/waitlist on Netlify: same contract as the Fastify endpoint (apps/server).
 * Storage is Supabase, reached only from here with the project's secret key; see
 * supabase/migrations/0001_waitlist.sql. Dependencies are injected so tests can mock them.
 */

export interface WaitlistEnv {
  SUPABASE_URL?: string;
  /** Supabase secret key (sb_secret_…) or legacy service_role key. Server-side only. */
  SUPABASE_SECRET_KEY?: string;
  /** Random secret mixed into IP hashes so stored hashes can't be reversed by brute force. */
  WAITLIST_IP_SALT?: string;
}

export interface Deps {
  env: WaitlistEnv;
  fetch: typeof fetch;
  /** Client IP as seen by Netlify's edge (context.ip). */
  clientIp: string | undefined;
  log?: (message: string) => void;
}

const MAX_BODY_BYTES = 4096;
const DB_TIMEOUT_MS = 8000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const ok = () => json(200, { ok: true });
const unavailable = () =>
  json(503, { error: "The waitlist is temporarily unavailable. Please try again later." });

/** Salted one-way hash of a rate-limit key (see rateLimitKey); never the raw IP. */
export function hashClientIp(key: string, salt: string): string {
  return createHmac("sha256", salt).update(key).digest("hex");
}

export async function handleWaitlist(req: Request, deps: Deps): Promise<Response> {
  const log = deps.log ?? (() => {});
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  // Same-origin only: the site posts to its own /api/waitlist.
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin)
    return json(403, { error: "Origin not allowed" });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "Request too large" });
  let body: unknown;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json(400, { error: "Invalid request" });
  }
  const parsed = WaitlistInput.safeParse(body);
  if (!parsed.success) return json(400, { error: "Invalid request" });
  const input = parsed.data;

  // Spam is answered like a real signup and never stored.
  if (isLikelySpam(input)) return ok();

  const { SUPABASE_URL, SUPABASE_SECRET_KEY, WAITLIST_IP_SALT } = deps.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !WAITLIST_IP_SALT) {
    log("waitlist: storage not configured (SUPABASE_URL, SUPABASE_SECRET_KEY, WAITLIST_IP_SALT)");
    return unavailable();
  }
  // IPv6 counts per /64 and mapped IPv4 per address, so clients can't rotate past the limit.
  const clientKey = rateLimitKey(deps.clientIp);
  if (!clientKey) {
    log("waitlist: no usable client IP");
    return unavailable();
  }

  let res: Response;
  try {
    res = await deps.fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/join_waitlist`, {
      method: "POST",
      // New Supabase keys go on the apikey header, not Authorization: Bearer.
      headers: { apikey: SUPABASE_SECRET_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        p_email: input.email,
        p_role: input.role ?? null,
        p_ip_hash: hashClientIp(clientKey, WAITLIST_IP_SALT),
      }),
      signal: AbortSignal.timeout(DB_TIMEOUT_MS),
    });
  } catch (err) {
    log(`waitlist: storage unreachable (${(err as Error).name})`);
    return unavailable();
  }

  // Only an explicit result from the database counts as a signup; anything else is a failure.
  let result: unknown = null;
  if (res.ok) result = await res.json().catch(() => null);
  if (result === "joined" || result === "already") {
    log(`waitlist: ${result}`); // never the address or IP
    return ok(); // identical for new and existing addresses
  }
  if (result === "rate_limited") {
    return json(429, { error: "Too many attempts. Please try again in a few minutes." });
  }
  log(`waitlist: storage error (HTTP ${res.status})`);
  return unavailable();
}

/** Daily keep-alive: one tiny database call so a quiet waitlist still shows activity. */
export async function keepAlive(deps: Pick<Deps, "env" | "fetch">): Promise<void> {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = deps.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error("keepalive: storage not configured");
  const res = await deps.fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/keepalive`, {
    method: "POST",
    headers: { apikey: SUPABASE_SECRET_KEY, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(DB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`keepalive: database returned HTTP ${res.status}`);
}
