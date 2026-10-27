// Browser smoke test of the real UI: two users in separate browser contexts,
// a real server serving the built web app, and a real worker using the
// SIMULATED adapter against a throwaway git repo.
//
//   npm run build && node scripts/ui-smoke.mjs [screenshotDir]
//
// Exits non-zero on failure. Screenshots are written for human review.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
// Playwright is provided by the environment (or install it); not a project dependency.
const { chromium } = createRequire(import.meta.url)("playwright");

const root = resolve(new URL("..", import.meta.url).pathname);
const shots = resolve(process.argv[2] ?? join(root, "data", "ui-smoke"));
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "pairloom-smoke-"));
const port = 8900 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const children = [];

function run(name, args, env) {
  const p = spawn("npx", ["tsx", ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so npx's child node process is killed too
  });
  p.stdout.on("data", (c) => process.env.SMOKE_VERBOSE && process.stdout.write(`[${name}] ${c}`));
  p.stderr.on("data", (c) => process.env.SMOKE_VERBOSE && process.stderr.write(`[${name}] ${c}`));
  children.push(p);
  return p;
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

async function waitFor(fn, label, ms = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const step = (msg) => console.log(`✓ ${msg}`);
let failed = false;
try {
  if (!existsSync(join(root, "apps/web/dist/index.html")))
    throw new Error("Run `npm run build` first");
  run("server", ["apps/server/src/index.ts"], {
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_ORIGIN: origin,
    DATABASE_PATH: join(tmp, "db.sqlite"),
    WEB_DIST_DIR: join(root, "apps/web/dist"),
    LOG_LEVEL: "warn",
  });
  await waitFor(() => fetch(`${origin}/api/health`).then((r) => r.ok), "server up");
  step("server up");

  const repo = join(tmp, "repo");
  execFileSync("bash", [join(root, "scripts/sample-repo.sh"), repo]);

  const browser = await chromium.launch();
  const ownerCtx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const collabCtx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const owner = await ownerCtx.newPage();
  const collab = await collabCtx.newPage();

  // Owner signs up, creates workspace + project + worker.
  await owner.goto(origin);
  await owner.getByRole("button", { name: "Need an account? Sign up" }).click();
  await owner.getByLabel("Display name").fill("Ana (owner)");
  await owner.getByLabel("Email").fill("ana@example.com");
  await owner.getByLabel(/Password/).fill("correct horse battery");
  await owner.getByRole("button", { name: "Create account" }).click();
  await owner.getByPlaceholder("New workspace name").fill("Demo team");
  await owner.getByRole("button", { name: "Create workspace" }).click();
  await owner.getByRole("button", { name: "Add project" }).click();
  await owner.getByRole("button", { name: "Register worker" }).click();
  const tokenText = await owner.locator("pre.select").innerText();
  const token = tokenText.match(/PAIRLOOM_WORKER_TOKEN=(\S+)/)[1];
  step("owner created workspace, project and worker token");

  run("worker", ["apps/worker/src/index.ts"], {
    PAIRLOOM_SERVER_URL: origin,
    PAIRLOOM_WORKER_TOKEN: token,
    PAIRLOOM_REPO_PATH: repo,
    PAIRLOOM_WORKTREES_DIR: join(tmp, "worktrees"),
    PAIRLOOM_STATE_DIR: join(tmp, "worker-state"),
    PAIRLOOM_SIMULATED_STEP_MS: "200",
  });
  await owner.getByRole("button", { name: "I've saved it" }).click();
  await waitFor(
    () => owner.getByText("online", { exact: true }).isVisible(),
    "worker online in UI",
  );
  step("worker shows online via realtime update");
  const projectUrl = owner.url();

  // Invite collaborator.
  await owner.getByRole("link", { name: "← workspace" }).click();
  await owner.getByRole("button", { name: "Create invite link" }).click();
  const inviteUrl = await owner.locator("code.select").innerText();
  await collab.goto(inviteUrl);
  await collab.getByLabel("Display name").fill("Bea (collaborator)");
  await collab.getByLabel("Email").fill("bea@example.com");
  await collab.getByLabel(/Password/).fill("another long password");
  await collab.getByRole("button", { name: "Create account" }).click();
  await waitFor(() => collab.getByText("Demo team").isVisible(), "collaborator joined");
  step("collaborator joined through invite link");

  // Owner starts a SIMULATED session (no API key in this smoke test).
  await owner.goto(projectUrl);
  await owner.getByPlaceholder(/Title/).fill("Cap inventory size");
  await owner
    .getByPlaceholder("First instruction for the agent")
    .fill("Add a capacity limit to addItem");
  const execSelect = owner.getByLabel("Execution");
  await waitFor(
    () => execSelect.locator("option[value=real]").evaluate((o) => o.disabled),
    "real disabled without key",
  ).catch(async (e) => {
    console.error(await owner.locator("form").last().innerHTML());
    throw e;
  });
  await execSelect.selectOption("simulated");
  await owner.getByRole("button", { name: "Start session" }).click();
  await waitFor(() => owner.getByText(/SIMULATED SESSION/).isVisible(), "simulated banner");
  const sessionUrl = owner.url();
  step("real mode disabled (no key); simulated session started with banner");

  // Collaborator opens the same session and sees the same activity.
  await collab.goto(sessionUrl);
  await waitFor(() => collab.getByText(/SIMULATED SESSION/).isVisible(), "collab sees banner");
  await waitFor(
    () => owner.getByRole("button", { name: "Allow once" }).isVisible(),
    "permission prompt (owner)",
  );
  await waitFor(
    () => collab.getByText("Only an owner can approve tool use.").isVisible(),
    "collab cannot approve",
  );
  await owner.screenshot({ path: join(shots, "1-owner-approval.png"), fullPage: true });
  await owner.getByRole("button", { name: "Allow once" }).click();
  step("owner approved tool use; collaborator saw it read-only");

  await waitFor(
    () =>
      collab
        .getByText(/changes: 1 file/)
        .first()
        .isVisible(),
    "collab sees change set",
  );
  step("change set from worktree visible to collaborator in realtime");

  // Collaborator proposes an instruction; owner approves it.
  await collab.getByPlaceholder(/Propose an instruction/).fill("Also add a test for the limit");
  await collab.getByRole("button", { name: "Propose instruction" }).click();
  await waitFor(
    () => owner.getByRole("button", { name: "Approve & send" }).isVisible(),
    "owner sees proposal",
  );
  await owner.getByRole("button", { name: "Approve & send" }).click();
  await waitFor(
    () => owner.getByRole("button", { name: "Allow once" }).isVisible(),
    "second permission",
  );
  await owner.getByRole("button", { name: "Allow once" }).click();
  await waitFor(
    () => collab.getByText("instruction delivered to agent").first().isVisible(),
    "delivered",
  );
  await waitFor(
    () =>
      collab
        .getByText(/changes: 1 file/)
        .nth(1)
        .isVisible(),
    "second change set",
  );
  step("collaborator instruction approved by host and delivered");

  // Collaborator reviews, owner merges.
  await collab.getByRole("button", { name: "Approve", exact: true }).click();
  await waitFor(
    async () => owner.getByRole("button", { name: /Merge into main/ }).isEnabled(),
    "merge enabled",
  );
  owner.once("dialog", (d) => d.accept());
  await owner.getByRole("button", { name: /Merge into main/ }).click();
  await waitFor(() => collab.getByText(/merged as/).isVisible(), "merged visible to collaborator");
  await collab.screenshot({ path: join(shots, "2-collaborator-merged.png"), fullPage: true });
  const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: repo, encoding: "utf8" });
  if (!log.includes("approved by Ana")) throw new Error(`unexpected merge commit: ${log}`);
  step(`merged locally on worker: ${log.trim()}`);

  // Worker drop is visible.
  killGroup(
    children.find((c) => c.spawnargs.includes("apps/worker/src/index.ts")),
    "SIGKILL",
  );
  await waitFor(
    () =>
      collab
        .getByText(/worker disconnected|offline/)
        .first()
        .isVisible(),
    "worker drop visible",
  );
  step("worker disconnect shown to collaborator");
  await collab.screenshot({ path: join(shots, "3-worker-disconnected.png"), fullPage: true });

  await browser.close();
  console.log(`\nUI smoke passed. Screenshots in ${shots}`);
} catch (err) {
  failed = true;
  console.error("UI smoke FAILED:", err);
} finally {
  for (const c of children) killGroup(c, "SIGTERM");
  process.exit(failed ? 1 : 0);
}
