import { isLikelySpam, type WaitlistInput } from "@pairloom/shared/waitlist";
import { newId } from "./crypto.js";
import { type Db, nowIso } from "./db.js";

export { MIN_FILL_MS, WAITLIST_ROLES, WaitlistInput } from "@pairloom/shared/waitlist";

export type WaitlistOutcome = "joined" | "already" | "dropped";

/**
 * Stores early-access signups. Duplicates (any case) are idempotent, and the response
 * to the caller is the same either way so the form cannot be used to test whether an
 * address is already on the list.
 */
export class Waitlist {
  constructor(private db: Db) {}

  join(input: WaitlistInput): WaitlistOutcome {
    if (isLikelySpam(input)) return "dropped";
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

  /** True once `key` has used up its window, without counting this check. */
  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return !!h && h.resetAt > now && h.n >= this.max;
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
