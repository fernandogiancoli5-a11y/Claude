import { z } from "zod";
import { newId } from "./crypto.js";
import { type Db, nowIso } from "./db.js";

export const WAITLIST_ROLES = ["engineer", "founder", "product", "student", "other"] as const;

export const WaitlistInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(WAITLIST_ROLES).optional(),
  /** Honeypot: hidden from people, filled in by naive bots. */
  website: z.string().max(500).optional(),
  /** Milliseconds between the form rendering and submit; bots submit instantly. */
  elapsedMs: z.number().int().nonnegative().optional(),
});

/** Faster than a person can type an email address. */
export const MIN_FILL_MS = 1500;

export type WaitlistOutcome = "joined" | "already" | "dropped";

/**
 * Stores early-access signups. Duplicates (any case) are idempotent, and the response
 * to the caller is the same either way so the form cannot be used to test whether an
 * address is already on the list.
 */
export class Waitlist {
  constructor(private db: Db) {}

  join(input: z.infer<typeof WaitlistInput>): WaitlistOutcome {
    // Spam signals are accepted silently: telling a bot it was caught only teaches it.
    if (input.website || (input.elapsedMs !== undefined && input.elapsedMs < MIN_FILL_MS)) {
      return "dropped";
    }
    const r = this.db
      .prepare(
        "INSERT INTO waitlist (id, email, role, created_at) VALUES (?,?,?,?) ON CONFLICT(email) DO NOTHING",
      )
      .run(newId("wl"), input.email, input.role ?? null, nowIso());
    return r.changes === 1 ? "joined" : "already";
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM waitlist").get() as { n: number }).n;
  }
}

/** Fixed-window limiter per key, in memory (one server process). */
export class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      if (this.hits.size > 10_000) this.sweep(now);
      this.hits.set(key, { n: 1, resetAt: now + this.windowMs });
      return true;
    }
    h.n += 1;
    return h.n <= this.max;
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
