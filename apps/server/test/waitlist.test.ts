import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/waitlist.js";
import { makeApp, ORIGIN } from "./helpers.js";

let app: Awaited<ReturnType<typeof makeApp>>;
beforeEach(async () => {
  app = await makeApp();
});
afterEach(async () => {
  await app.close();
});

let ip = 0;
const join_ = (payload: unknown, remoteAddress = `10.0.0.${++ip}`) =>
  app.fastify.inject({
    method: "POST",
    url: "/api/waitlist",
    headers: { origin: ORIGIN },
    remoteAddress,
    payload: payload as object,
  });
const rows = () =>
  app.db.prepare("SELECT email, role FROM waitlist ORDER BY created_at").all() as Array<{
    email: string;
    role: string | null;
  }>;

describe("public waitlist", () => {
  it("stores a normalized address once; duplicates get the same response", async () => {
    const first = await join_({ email: "  Ada@Example.com ", role: "engineer", elapsedMs: 4000 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    const again = await join_({ email: "ada@example.COM", elapsedMs: 4000 });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(rows()).toEqual([{ email: "ada@example.com", role: "engineer" }]);
  });

  it("rejects invalid input with a 400 and stores nothing", async () => {
    for (const payload of [
      { email: "not-an-email", elapsedMs: 4000 },
      { email: "", elapsedMs: 4000 },
      { email: `${"a".repeat(250)}@x.io`, elapsedMs: 4000 },
      { email: "ok@example.com", role: "admin", elapsedMs: 4000 },
      {},
    ]) {
      expect((await join_(payload)).statusCode).toBe(400);
    }
    expect(rows()).toEqual([]);
  });

  it("silently drops honeypot and instant submissions", async () => {
    expect(
      (await join_({ email: "bot1@example.com", website: "http://spam", elapsedMs: 4000 })).json(),
    ).toEqual({ ok: true });
    expect((await join_({ email: "bot2@example.com", elapsedMs: 50 })).json()).toEqual({
      ok: true,
    });
    expect(rows()).toEqual([]);
  });

  it("rate-limits repeated attempts from one address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push(
        (await join_({ email: `p${i}@example.com`, elapsedMs: 4000 }, "10.9.9.9")).statusCode,
      );
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(
      (await join_({ email: "other@example.com", elapsedMs: 4000 }, "10.9.9.10")).statusCode,
    ).toBe(200);
  });

  it("refuses cross-site posts and never exposes the list", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/waitlist",
      headers: { origin: "https://evil.example" },
      payload: { email: "x@example.com", elapsedMs: 4000 },
    });
    expect(res.statusCode).toBe(403);
    expect((await app.fastify.inject({ method: "GET", url: "/api/waitlist" })).statusCode).toBe(
      404,
    );
  });
});

describe("rate limiter", () => {
  it("resets after its window", () => {
    const r = new RateLimiter(2, 1000);
    expect([r.allow("k", 0), r.allow("k", 1), r.allow("k", 2)]).toEqual([true, true, false]);
    expect(r.allow("k", 1001)).toBe(true);
  });
});

describe("serving the public site", () => {
  it("serves the site at / and the app at /app/, keeping invite links working", async () => {
    const root = mkdtempSync(join(tmpdir(), "pl-site-"));
    const site = join(root, "site");
    const web = join(root, "web");
    mkdirSync(site);
    mkdirSync(web);
    writeFileSync(join(site, "index.html"), "<h1>site</h1>");
    writeFileSync(join(site, "404.html"), "<h1>missing</h1>");
    writeFileSync(join(web, "index.html"), "<h1>app</h1>");
    const s = await makeApp({ siteDistDir: site, webDistDir: web });
    try {
      const get = (url: string) => s.fastify.inject({ method: "GET", url });
      expect((await get("/")).body).toContain("site");
      expect((await get("/app/")).body).toContain("app");
      expect((await get("/app/anything")).body).toContain("app");
      const inv = await get("/invite/abc_DEF-1");
      expect(inv.statusCode).toBe(302);
      expect(inv.headers.location).toBe("/app/#/invite/abc_DEF-1");
      const missing = await get("/nope");
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toContain("missing");
      expect((await get("/api/nope")).json()).toEqual({ error: "Not found" });
    } finally {
      await s.close();
    }
  });
});
