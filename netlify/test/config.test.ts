import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("netlify.toml", () => {
  const toml = read("netlify.toml");

  it("allows exactly the site's inline scripts by hash in its CSP", () => {
    const allowed = [...toml.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1]).sort();
    const pages = ["apps/site/index.html", "apps/site/privacy.html", "apps/site/404.html"];
    const inline = pages
      .flatMap((p) => [...read(p).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!))
      .map((s) => `sha256-${createHash("sha256").update(s).digest("base64")}`);
    expect([...new Set(inline)].sort()).toEqual(allowed);
  });

  it("builds the site with the Supabase privacy text and publishes its output", () => {
    expect(toml).toMatch(/PAIRLOOM_WAITLIST_BACKEND = "supabase"/);
    expect(toml).toMatch(/publish = "apps\/site\/dist"/);
    expect(toml).toMatch(/directory = "netlify\/functions"/);
  });

  it("contains no secret values", () => {
    expect(toml).not.toMatch(
      /sb_secret_|sb_publishable_|eyJ[A-Za-z0-9_-]{10,}|SUPABASE_SECRET_KEY\s*=/,
    );
  });
});
