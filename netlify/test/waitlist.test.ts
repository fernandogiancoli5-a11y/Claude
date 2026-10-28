import { describe, expect, it } from "vitest";
import { MIN_FILL_MS, rateLimitKey } from "@pairloom/shared/waitlist";
import { handleWaitlist, hashClientIp, keepAlive, type Deps } from "../lib/waitlist.js";

// Placeholder values only; no real credentials.
const ENV = {
  SUPABASE_URL: "https://project-ref.supabase.test/",
  SUPABASE_SECRET_KEY: "sb_secret_test_placeholder",
  WAITLIST_IP_SALT: "test-salt",
};
const SITE = "https://pairloom.example.test";
const IP = "203.0.113.7";

/** A mocked Supabase RPC endpoint that records calls and returns a scripted response. */
function supabase(reply: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetchMock = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return reply();
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchMock };
}
const rpc =
  (value: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });

function post(body: unknown, headers: Record<string, string> = { origin: SITE }) {
  return new Request(`${SITE}/api/waitlist`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const human = { email: " Ada@Example.com ", role: "engineer", elapsedMs: 4000 };

async function run(req: Request, db: ReturnType<typeof supabase>, overrides: Partial<Deps> = {}) {
  const logs: string[] = [];
  const res = await handleWaitlist(req, {
    env: ENV,
    fetch: db.fetch,
    clientIp: IP,
    log: (m) => logs.push(m),
    ...overrides,
  });
  return { status: res.status, body: await res.json(), logs };
}

describe("Netlify waitlist function", () => {
  it("stores a valid signup through the server-only RPC and confirms it", async () => {
    const db = supabase(rpc("joined"));
    const r = await run(post(human), db);
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(db.calls).toHaveLength(1);
    const call = db.calls[0]!;
    expect(call.url).toBe("https://project-ref.supabase.test/rest/v1/rpc/join_waitlist");
    expect(call.body).toEqual({
      p_email: "ada@example.com",
      p_role: "engineer",
      p_ip_hash: hashClientIp(rateLimitKey(IP)!, ENV.WAITLIST_IP_SALT),
    });
    // The raw IP never leaves the function; the key goes on the apikey header only.
    expect(JSON.stringify(call.body)).not.toContain(IP);
    expect(call.body.p_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    const headers = call.init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ENV.SUPABASE_SECRET_KEY);
    expect(headers.authorization ?? headers.Authorization).toBeUndefined();
  });

  it("answers a duplicate exactly like a new signup", async () => {
    const fresh = await run(post(human), supabase(rpc("joined")));
    const dup = await run(post({ ...human, email: "ADA@example.com" }), supabase(rpc("already")));
    expect(dup.status).toBe(fresh.status);
    expect(dup.body).toEqual(fresh.body);
  });

  it("rejects invalid input with 400 without touching the database", async () => {
    for (const body of [
      { email: "not-an-email", elapsedMs: 4000 },
      { email: "", elapsedMs: 4000 },
      { email: `${"a".repeat(250)}@x.io`, elapsedMs: 4000 },
      { email: "ok@example.com", role: "admin", elapsedMs: 4000 },
      {},
      "{not json",
    ]) {
      const db = supabase(rpc("joined"));
      expect((await run(post(body), db)).status).toBe(400);
      expect(db.calls).toHaveLength(0);
    }
  });

  it("silently drops honeypot and too-fast submissions without storing them", async () => {
    for (const body of [
      { email: "bot@example.com", website: "http://spam.example", elapsedMs: 4000 },
      { email: "bot@example.com", elapsedMs: MIN_FILL_MS - 1 },
    ]) {
      const db = supabase(rpc("joined"));
      const r = await run(post(body), db);
      expect(r).toMatchObject({ status: 200, body: { ok: true } });
      expect(db.calls).toHaveLength(0);
    }
  });

  it("returns 429 when the database reports the client is rate-limited", async () => {
    const r = await run(post(human), supabase(rpc("rate_limited")));
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/Too many attempts/);
  });

  it("never reports success when storage fails", async () => {
    const outages: Array<[string, Partial<Deps> | (() => Response | Promise<Response>)]> = [
      ["network error", () => Promise.reject(new TypeError("fetch failed"))],
      ["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
      ["paused/unavailable project", rpc({ message: "project paused" }, 503)],
      ["server error", rpc({ message: "internal" }, 500)],
      ["auth failure (bad key)", rpc({ message: "Invalid API key" }, 401)],
      ["constraint violation", rpc({ code: "23514" }, 400)],
      ["unexpected body", rpc({ something: "else" })],
      ["empty body", () => new Response("", { status: 200 })],
    ];
    for (const [label, reply] of outages) {
      const r = await run(post(human), supabase(reply as () => Response));
      expect(r.status, label).toBe(503);
      expect(r.body.ok, label).toBeUndefined();
    }
  });

  it("fails closed when not configured or the client IP is unknown", async () => {
    for (const env of [{}, { ...ENV, SUPABASE_SECRET_KEY: "" }, { ...ENV, WAITLIST_IP_SALT: "" }]) {
      const db = supabase(rpc("joined"));
      expect((await run(post(human), db, { env })).status).toBe(503);
      expect(db.calls).toHaveLength(0);
    }
    const db = supabase(rpc("joined"));
    expect((await run(post(human), db, { clientIp: undefined })).status).toBe(503);
    expect(db.calls).toHaveLength(0);
  });

  it("rate-limits IPv6 clients per /64 and mapped IPv4 per address", async () => {
    const hashFor = async (ip: string) => {
      const db = supabase(rpc("joined"));
      await run(post(human), db, { clientIp: ip });
      return db.calls[0]!.body.p_ip_hash as string;
    };
    expect(await hashFor("2001:db8:1:2::aaaa")).toBe(await hashFor("2001:db8:1:2:ffff::1"));
    expect(await hashFor("2001:db8:1:2::aaaa")).not.toBe(await hashFor("2001:db8:1:3::aaaa"));
    expect(await hashFor("::ffff:203.0.113.7")).toBe(await hashFor("203.0.113.7"));
    // An unparseable client IP fails closed instead of sharing or skipping the limit.
    const db = supabase(rpc("joined"));
    expect((await run(post(human), db, { clientIp: "not-an-ip" })).status).toBe(503);
    expect(db.calls).toHaveLength(0);
  });

  it("refuses other origins, methods and oversized bodies", async () => {
    const db = supabase(rpc("joined"));
    expect((await run(post(human, { origin: "https://evil.example" }), db)).status).toBe(403);
    expect((await run(new Request(`${SITE}/api/waitlist`), db)).status).toBe(405);
    expect((await run(post("x".repeat(5000)), db)).status).toBe(413);
    expect(db.calls).toHaveLength(0);
  });

  it("never logs the address, the IP or the secret", async () => {
    for (const reply of [rpc("joined"), rpc("x", 500), () => Promise.reject(new Error("boom"))]) {
      const r = await run(post(human), supabase(reply as () => Response));
      const logged = r.logs.join("\n");
      for (const secret of ["ada@example.com", IP, ENV.SUPABASE_SECRET_KEY, ENV.WAITLIST_IP_SALT])
        expect(logged).not.toContain(secret);
    }
  });

  it("hashes are salted: the same IP gives different hashes under different salts", () => {
    expect(hashClientIp(IP, "a")).not.toBe(hashClientIp(IP, "b"));
    expect(hashClientIp(IP, "a")).toBe(hashClientIp(IP, "a"));
  });
});

describe("keep-alive", () => {
  it("calls the keepalive RPC with the server key", async () => {
    const db = supabase(rpc(0));
    await keepAlive({ env: ENV, fetch: db.fetch });
    expect(db.calls[0]!.url).toBe("https://project-ref.supabase.test/rest/v1/rpc/keepalive");
  });
  it("fails loudly (so Netlify logs it) when the database does not answer", async () => {
    await expect(keepAlive({ env: ENV, fetch: supabase(rpc({}, 503)).fetch })).rejects.toThrow(
      /HTTP 503/,
    );
    await expect(keepAlive({ env: {}, fetch: supabase(rpc(0)).fetch })).rejects.toThrow(
      /not configured/,
    );
  });
});
