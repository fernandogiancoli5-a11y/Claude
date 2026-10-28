// Captures genuine screenshots of the Pairloom app for the public site (apps/site/public/screens).
// Two real users, a real server and a real worker running the SIMULATED adapter (no model calls);
// the site's captions say so.
//
//   npm run build -w @pairloom/web && node scripts/site-screenshots.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const root = resolve(new URL("..", import.meta.url).pathname);
const out = join(root, "apps/site/public/screens");
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "pairloom-shots-"));
const port = 8700 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const children = [];
const run = (args, env) => {
  const p = spawn("npx", ["tsx", ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1", ...env },
    stdio: "ignore",
    detached: true,
  });
  children.push(p);
};
const waitFor = async (fn, label, ms = 20000) => {
  const start = Date.now();
  for (;;) {
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

try {
  run(["apps/server/src/index.ts"], {
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_ORIGIN: origin,
    DATABASE_PATH: join(tmp, "db.sqlite"),
    WEB_DIST_DIR: join(root, "apps/web/dist"),
    LOG_LEVEL: "warn",
  });
  await waitFor(() => fetch(`${origin}/api/health`).then((r) => r.ok), "server");
  const repo = join(tmp, "repo");
  execFileSync("bash", [join(root, "scripts/sample-repo.sh"), repo]);

  const browser = await chromium.launch();
  const ctx = (scheme) =>
    browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
  const owner = await (await ctx("light")).newPage();
  const collab = await (await ctx("light")).newPage();
  const shot = async (page, name) => {
    await page
      .locator(".toast")
      .waitFor({ state: "detached", timeout: 10000 })
      .catch(() => {});
    await page.screenshot({ path: join(out, `${name}.jpg`), type: "jpeg", quality: 82 });
  };

  await owner.goto(origin);
  await owner.getByRole("button", { name: "Need an account? Sign up" }).click();
  await owner.getByLabel("Display name").fill("Ana Ruiz");
  await owner.getByLabel("Email").fill("ana@example.com");
  await owner.getByLabel(/Password/).fill("correct horse battery");
  await owner.getByRole("button", { name: "Create account" }).click();
  await owner.getByPlaceholder("New workspace name").fill("Storefront team");
  await owner.getByRole("button", { name: "Create workspace" }).click();
  await owner.getByLabel("Project name").fill("tiny-cart");
  await owner.getByRole("button", { name: "Add project" }).click();
  await owner.getByRole("button", { name: "Register worker" }).click();
  const token = (await owner.locator("pre.select").innerText()).match(
    /PAIRLOOM_WORKER_TOKEN=(\S+)/,
  )[1];
  run(["apps/worker/src/index.ts"], {
    PAIRLOOM_SERVER_URL: origin,
    PAIRLOOM_WORKER_TOKEN: token,
    PAIRLOOM_REPO_PATH: repo,
    PAIRLOOM_WORKTREES_DIR: join(tmp, "worktrees"),
    PAIRLOOM_STATE_DIR: join(tmp, "worker-state"),
    PAIRLOOM_SIMULATED_STEP_MS: "200",
  });
  await owner.getByRole("button", { name: "I've saved it" }).click();
  await waitFor(() => owner.getByText("online", { exact: true }).isVisible(), "worker online");
  const projectUrl = owner.url();

  await owner.getByRole("link", { name: "Storefront team" }).first().click();
  await owner.getByRole("button", { name: "Create invite link" }).click();
  const inviteUrl = await owner.locator("code.select").innerText();
  await collab.goto(inviteUrl);
  await collab.getByLabel("Display name").fill("Bea Okafor");
  await collab.getByLabel("Email").fill("bea@example.com");
  await collab.getByLabel(/Password/).fill("another long password");
  await collab.getByRole("button", { name: "Create account" }).click();
  await waitFor(() => collab.getByText("Storefront team").first().isVisible(), "joined");

  await owner.goto(projectUrl);
  await owner.getByPlaceholder(/Title/).fill("Cap inventory size");
  await owner
    .getByPlaceholder("First instruction for the agent")
    .fill("Add a capacity limit to addItem");
  await owner.getByLabel("Execution").selectOption("simulated");
  await owner.getByRole("button", { name: "Start task" }).click();
  await waitFor(() => owner.getByText(/SIMULATED SESSION/).isVisible(), "session");
  const sessionUrl = owner.url();
  await collab.goto(sessionUrl);
  await waitFor(() => owner.getByRole("button", { name: "Allow once" }).isVisible(), "approval");
  await collab.getByPlaceholder(/Propose an instruction/).fill("Also add a test for the limit");
  await collab.getByRole("button", { name: "Propose instruction" }).click();
  await waitFor(
    () => owner.getByRole("button", { name: "Approve & send" }).isVisible(),
    "proposal",
  );
  await owner.waitForTimeout(400);
  await shot(owner, "approvals");

  await owner.getByRole("button", { name: "Allow once" }).click();
  await owner.getByRole("button", { name: "Approve & send" }).click();
  // Approve whatever the agent asks for until its turn ends with both changes recorded.
  await waitFor(
    async () => {
      const allow = owner.getByRole("button", { name: "Allow once" });
      if (await allow.isVisible()) {
        await allow.click();
        await allow.waitFor({ state: "hidden" }); // one click per request
      }
      return (
        (await collab.getByText(/changes: 1 file/).count()) >= 2 &&
        !(await collab.getByRole("button", { name: "run tests" }).isDisabled())
      );
    },
    "second turn finished",
    60000,
  );
  await collab.getByRole("button", { name: "run tests" }).click();
  await waitFor(
    () => collab.getByText(/Project tests (passed|FAILED)/).isVisible(),
    "checks",
    60000,
  );
  await collab.getByRole("button", { name: "Approve", exact: true }).click();
  await waitFor(
    () => owner.getByRole("button", { name: /Merge into main/ }).isEnabled(),
    "merge ready",
  );
  await owner.waitForTimeout(400);
  await shot(owner, "review");

  await owner.goto(origin + "/#/");
  await owner.getByRole("heading", { name: "Projects" }).waitFor();
  await owner.waitForTimeout(300);
  await shot(owner, "dashboard");
  console.log(`screenshots written to ${out}`);
  await browser.close();
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {}
  }
}
