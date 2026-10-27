// Browser test of the public site and its waitlist against a real server in site mode
// (site at "/", app at "/app/") with a throwaway database.
//
//   npm run build && node scripts/site-smoke.mjs [screenshotDir]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const { chromium } = createRequire(import.meta.url)("playwright");

const root = resolve(new URL("..", import.meta.url).pathname);
const shots = resolve(process.argv[2] ?? join(root, "data", "site-smoke"));
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "pairloom-site-"));
const dbPath = join(tmp, "db.sqlite");
const port = 8600 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const step = (m) => console.log(`✓ ${m}`);
const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};
const rows = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT email, role FROM waitlist ORDER BY created_at").all();
  } finally {
    db.close();
  }
};

const server = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
  cwd: root,
  detached: true,
  stdio: "ignore",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_NO_WARNINGS: "1",
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_ORIGIN: origin,
    DATABASE_PATH: dbPath,
    WEB_DIST_DIR: join(root, "apps/web/dist"),
    SITE_DIST_DIR: join(root, "apps/site/dist"),
    LOG_LEVEL: "warn",
  },
});

try {
  for (const d of ["apps/web/dist/index.html", "apps/site/dist/index.html"])
    assert(existsSync(join(root, d)), `${d} exists (run npm run build)`);
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) break;
    } catch {}
    if (i > 100) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
  step("server up in site mode");

  const browser = await chromium.launch();
  const errors = [];
  const open = async (viewport, scheme = "light") => {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    return page;
  };

  for (const [name, viewport] of [
    ["desktop", { width: 1366, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const page = await open(viewport);
    await page.goto(origin);
    assert(
      (await page.getByRole("heading", { level: 1 }).innerText()).includes("Build with AI"),
      "headline",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert(overflow <= 0, `${name}: no horizontal scroll (overflow ${overflow}px)`);
    // Load every lazy image, then check none is broken.
    await page.evaluate(async () => {
      for (const img of document.images) {
        img.loading = "eager";
        img.scrollIntoView();
        await new Promise((r) => setTimeout(r, 50));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState("networkidle");
    const broken = await page.evaluate(() =>
      [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src),
    );
    assert(broken.length === 0, `${name}: images load (${broken})`);
    await page.screenshot({ path: join(shots, `${name}-top.png`) });
    // Scroll through like a visitor so scroll-triggered reveals have run, then capture.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
    });
    await page.waitForTimeout(900);
    const hidden = await page.evaluate(
      () =>
        [...document.querySelectorAll(".reveal")].filter((e) => getComputedStyle(e).opacity !== "1")
          .length,
    );
    assert(hidden === 0, `${name}: all sections revealed after scrolling (${hidden} hidden)`);
    await page.screenshot({ path: join(shots, `${name}-full.png`), fullPage: true });
    step(`${name}: renders, no horizontal scroll, all screenshots load`);
    await page.context().close();
  }

  // Signup flow (desktop): client validation, success, duplicate.
  const page = await open({ width: 1366, height: 900 });
  await page.goto(origin);
  const hero = page.locator("form[data-waitlist]").first();
  await hero.getByLabel("Work email").fill("not-an-email");
  await hero.getByRole("button", { name: "Join the waitlist" }).click();
  assert(
    (await hero.locator("[data-status]").innerText()).includes("doesn't look like an email"),
    "invalid email message",
  );
  assert(
    (await hero.getByLabel("Work email").getAttribute("aria-invalid")) === "true",
    "aria-invalid",
  );
  assert(rows().length === 0, "nothing stored for invalid input");
  step("invalid email rejected in the browser with a clear message");

  await page.waitForTimeout(1600); // a person takes longer than the bot threshold
  await hero.getByLabel("Work email").fill("  Ada.Lovelace@Example.com ");
  await hero.getByRole("button", { name: "Join the waitlist" }).click();
  await page.getByText("You're on the list.").first().waitFor();
  assert(
    (await page.locator(".success").first().innerText()).includes("Ada.Lovelace@Example.com"),
    "success names the address",
  );
  assert(
    JSON.stringify(rows()) === JSON.stringify([{ email: "ada.lovelace@example.com", role: null }]),
    `stored once: ${JSON.stringify(rows())}`,
  );
  await page.screenshot({ path: join(shots, "success.png") });
  step("valid signup stored (normalized) and confirmed");

  // Same person again via the bottom form, with a role: same friendly success, no duplicate row.
  const again = await open({ width: 1366, height: 900 });
  await again.goto(`${origin}/#join`);
  await again.waitForTimeout(1600);
  const cta = again.locator("#join form[data-waitlist]");
  await cta.getByLabel("Work email").fill("ada.lovelace@EXAMPLE.com");
  await cta.getByLabel(/I'm mostly/).selectOption("engineer");
  await cta.getByRole("button", { name: "Join the waitlist" }).click();
  await again.getByText("You're on the list.").first().waitFor();
  assert(rows().length === 1, `duplicate not stored: ${JSON.stringify(rows())}`);
  step("duplicate signup accepted gracefully, not stored twice");

  // Keyboard-only signup on mobile: Tab to the field, type, Enter.
  const kb = await open({ width: 390, height: 844 });
  await kb.goto(origin);
  await kb.waitForTimeout(1600);
  await kb.getByLabel("Work email").first().focus();
  await kb.keyboard.type("grace@example.org");
  await kb.keyboard.press("Enter");
  await kb.getByText("You're on the list.").first().waitFor();
  assert(rows().length === 2, "keyboard signup stored");
  await kb.screenshot({ path: join(shots, "mobile-success.png") });
  step("keyboard-only signup on a phone works");

  // Bot-like submission (instant, honeypot filled) is silently dropped.
  const bot = await fetch(`${origin}/api/waitlist`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: "bot@example.com", website: "x", elapsedMs: 10 }),
  });
  assert(bot.status === 200 && rows().length === 2, "bot dropped");
  step("honeypot/instant submissions dropped without storing");

  // Other routes.
  const nav = await open({ width: 1366, height: 900 });
  await nav.goto(`${origin}/privacy.html`);
  await nav.getByRole("heading", { name: "The waitlist, plainly." }).waitFor();
  await nav.goto(`${origin}/app/`);
  await nav.getByRole("button", { name: "Sign in" }).waitFor();
  const inv = await fetch(`${origin}/invite/abc123`, { redirect: "manual" });
  assert(
    inv.status === 302 && inv.headers.get("location") === "/app/#/invite/abc123",
    "invite redirect",
  );
  const missing = await fetch(`${origin}/no-such-page`);
  assert(missing.status === 404 && (await missing.text()).includes("doesn't exist"), "404 page");
  step("privacy page, app at /app/, invite redirect and 404 work");

  const dark = await open({ width: 1366, height: 900 }, "dark");
  await dark.goto(origin);
  await dark.waitForTimeout(800);
  await dark.screenshot({ path: join(shots, "dark-top.png") });
  step("dark mode renders");

  const real = errors.filter((e) => !/401/.test(e));
  assert(real.length === 0, `no console errors: ${real.join(" | ")}`);
  step("no console or page errors");
  await browser.close();
  console.log(`\nSite smoke passed. Screenshots in ${shots}`);
} catch (e) {
  console.error("Site smoke FAILED:", e);
  process.exitCode = 1;
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
}
