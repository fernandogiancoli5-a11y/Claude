import { z } from "zod";

/**
 * Early-access waitlist rules, shared by the Fastify server (POST /api/waitlist) and the
 * Netlify function, so both deployments accept and reject exactly the same requests.
 */

export const WAITLIST_ROLES = ["engineer", "founder", "product", "student", "other"] as const;

export const WaitlistInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(WAITLIST_ROLES).optional(),
  /** Honeypot: hidden from people, filled in by naive bots. */
  website: z.string().max(500).optional(),
  /** Milliseconds between the form rendering and submit; bots submit instantly. */
  elapsedMs: z.number().int().nonnegative().optional(),
});
export type WaitlistInput = z.infer<typeof WaitlistInput>;

/** Faster than a person can type an email address. */
export const MIN_FILL_MS = 1500;

/** Per-client limit on signup attempts. */
export const WAITLIST_RATE_LIMIT = { max: 5, windowMs: 10 * 60_000 } as const;

/**
 * Spam signals. Callers accept these silently (same response as a real signup) and store
 * nothing: telling a bot it was caught only teaches it.
 */
export function isLikelySpam(input: WaitlistInput): boolean {
  return Boolean(input.website) || (input.elapsedMs !== undefined && input.elapsedMs < MIN_FILL_MS);
}

/**
 * The identity a rate limit should count. IPv6 clients normally control a whole /64, so
 * counting full addresses would let one client rotate past any limit; IPv4-mapped IPv6
 * (::ffff:1.2.3.4) is the same client as 1.2.3.4. Returns null for anything unparseable.
 */
export function rateLimitKey(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const raw = ip
    .trim()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!
    .toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(
    raw.replace(/^::/, "0:"),
  );
  const v4 = mapped ? mapped[1]! : raw;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    return v4.split(".").every((o) => Number(o) <= 255)
      ? `4:${v4.split(".").map(Number).join(".")}`
      : null;
  }
  if (!raw.includes(":") || !/^[0-9a-f:.]+$/.test(raw)) return null;
  // Expand "::" and keep the first four 16-bit groups (the /64 network prefix).
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // An embedded IPv4 tail counts as two groups.
  const groupsIn = (parts: string[]) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const missing = 8 - groupsIn(head) - groupsIn(tail);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const prefix = groups.slice(0, 4);
  if (prefix.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return `6:${prefix.map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
