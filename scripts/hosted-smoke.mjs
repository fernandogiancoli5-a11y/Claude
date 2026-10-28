// Browser test of the new-user journey on a Pairloom-hosted project: sign up, create a starter
// project (the server creates the repo and runs its worker), give the agent a task, watch it,
// review with a teammate, merge, and find the change in the project's files after a reload.
// The MODEL is a local scripted stub (no paid calls); the server, worker, git, sandboxed tools
// and the project's own tests are real.
//
// Hosted workers run with code execution disabled (fail closed), so no tests run here.
//
//   npm run build && node scripts/hosted-smoke.mjs [screenshotDir]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const root = resolve(new URL("..", import.meta.url).pathname);
const shots = resolve(process.argv[2] ?? join(root, "data", "hosted-smoke"));
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "pairloom-hosted-"));
const step = (m) => console.log(`✓ ${m}`);
// REAL_MODEL=1 sends the task to the configured provider (GROQ_API_KEY) instead of the stub.
const REAL = process.env.REAL_MODEL === "1";
if (REAL && !process.env.GROQ_API_KEY) {
  console.error("REAL_MODEL=1 needs GROQ_API_KEY");
  process.exit(2);
}
const waitFor = async (fn, label, ms = 30000) => {
  const start = Date.now();
  for (;;) {
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

// Scripted OpenAI-compatible model: read, edit, run tests, summarize.
let calls = 0;
const reply = (message, finish) => ({
  id: "stub",
  object: "chat.completion",
  model: "stub",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
});
const tool = (name, args) =>
  reply(
    {
      content: null,
      tool_calls: [
        { id: `c${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    "tool_calls",
  );
const model = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    calls++;
    const msgs = JSON.parse(b).messages;
    const users = msgs.filter((m) => m.role === "user").map((m) => String(m.content));
    const lastUser = users.at(-1) ?? "";
    const turn = msgs.filter((m) => m.role === "assistant").length;
    // "Broken" task: an edit that leaves src/cart.js unparseable (as a real model did).
    if (users.some((u) => u.includes("BROKEN"))) {
      const body =
        msgs.at(-1).role === "user"
          ? tool("edit_file", {
              path: "src/cart.js",
              old_string: "export function subtotalCents(cart) {\n",
              new_string:
                "export function subtotalCents(cart) {\n}\n\nexport function itemCount(cart) {\n  return 0;\n}\n",
            })
          : reply({ content: "Added itemCount." }, "stop");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    // "Slow" task: one edit, then keeps calling tools until the turn's time limit stops it.
    if (users.some((u) => u.includes("SLOW"))) {
      const body = lastUser.includes("Continue where you left off")
        ? reply({ content: "The note is in place; nothing else to do." }, "stop")
        : msgs.at(-1).role === "user"
          ? tool("write_file", { path: "NOTES.md", content: "partial work\n" })
          : tool("list_files", { path: `src${turn}` });
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }, 500);
      return;
    }
    const body =
      turn === 0
        ? tool("read_file", { path: "src/cart.js" })
        : turn === 1
          ? tool("edit_file", {
              path: "src/cart.js",
              old_string: "export function subtotalCents",
              new_string:
                "export function itemCount(cart) {\n  return cart.items.reduce((n, i) => n + i.quantity, 0);\n}\n\nexport function subtotalCents",
            })
          : reply(
              { content: "Added itemCount(cart) to src/cart.js. I couldn't run the tests here." },
              "stop",
            );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));

const port = 8500 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const server = spawn("node", ["--import", "tsx", "apps/server/src/index.ts"], {
  cwd: root,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_NO_WARNINGS: "1",
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_ORIGIN: origin,
    DATABASE_PATH: join(tmp, "db.sqlite"),
    WEB_DIST_DIR: join(root, "apps/web/dist"),
    PAIRLOOM_HOSTED_WORKERS: "true",
    ...(REAL
      ? Object.fromEntries(
          [
            "GROQ_API_KEY",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
          ]
            .filter((k) => process.env[k])
            .map((k) => [k, process.env[k]]),
        )
      : {
          LLM_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
          GROQ_API_KEY: "gsk_stub_placeholder_not_a_real_key",
        }),
    LOG_LEVEL: "warn",
    // Short turn limit so the stub's slow task times out quickly; the real model gets the default.
    ...(REAL ? {} : { AGENT_MAX_TURN_SECONDS: "8" }),
  },
});
let serverLog = "";
server.stdout.on("data", (c) => (serverLog += c));
server.stderr.on("data", (c) => (serverLog += c));

const browser = await chromium.launch();
let lastPage;
try {
  await waitFor(() => fetch(`${origin}/api/health`).then((r) => r.ok), "server");
  const ctx = (w = 1366) => browser.newContext({ viewport: { width: w, height: 900 } });
  const owner = await (await ctx()).newPage();
  lastPage = owner;
  const errors = [];
  owner.on("pageerror", (e) => errors.push(e.message));

  await owner.goto(origin);
  await owner.getByRole("button", { name: "Need an account? Sign up" }).click();
  await owner.getByLabel("Display name").fill("Ana Ruiz");
  await owner.getByLabel("Email").fill("ana@example.com");
  await owner.getByLabel(/Password/).fill("correct horse battery");
  await owner.getByRole("button", { name: "Create account" }).click();
  // First screen for a new user leads with the one next action.
  await owner.getByRole("heading", { name: "Create your team" }).waitFor();
  await owner.screenshot({ path: join(shots, "0-first-screen.png") });
  await owner.getByPlaceholder("New workspace name").fill("Shop team");
  await owner.getByRole("button", { name: "Create workspace" }).click();
  step("signed up and created a team");

  // New project: the Starter option is offered and selected by default.
  await owner.getByLabel("Project name").fill("shop");
  await waitFor(() => owner.getByLabel(/Starter project/).isChecked(), "starter option");
  await owner.screenshot({ path: join(shots, "1-new-project.png") });
  await owner.getByRole("button", { name: "Add project" }).click();
  await owner.getByText("Workspace ready").waitFor({ timeout: 30000 });
  const projectUrl = owner.url();
  step("starter project created; its hosted workspace became ready (no worker setup)");

  await owner.getByPlaceholder(/Title/).fill("Item count");
  await owner
    .getByPlaceholder("First instruction for the agent")
    .fill("Add itemCount(cart) to src/cart.js and make sure the tests pass.");
  await owner.getByRole("button", { name: "Start task" }).click();
  // Longer than the worker's own 10-minute turn limit: the worker ends the turn, not this script.
  const turnMs = REAL ? 660000 : 30000;
  const started = Date.now();
  await owner
    .getByText(/uses (edit_file|write_file)/)
    .first()
    .waitFor({ timeout: turnMs });
  await owner
    .getByText(/finished its turn|turn failed|turn stopped by a limit/)
    .first()
    .waitFor({ timeout: turnMs });
  if (await owner.getByText(/turn failed|turn stopped by a limit/).count())
    throw new Error("agent turn did not finish cleanly");
  await owner.locator(".diff .a", { hasText: "itemCount" }).first().waitFor();
  if (REAL)
    console.log(
      `  real model's summary: ${(await owner.locator(".agent-text").last().innerText()).slice(0, 400)}`,
    );
  const sessionUrl = owner.url();
  await owner.screenshot({ path: join(shots, "2-task-done.png"), fullPage: true });
  // Hosted workers don't run project code: the page must say tests can't run here.
  await owner.getByText(/Tests can't run on this server/).waitFor();
  if (await owner.getByRole("button", { name: "run tests" }).count())
    throw new Error("run tests button shown although this server can't run code");
  step(
    `real-mode task: agent read and edited the files; diff shown; no test run claimed (${Math.round((Date.now() - started) / 1000)}s)`,
  );

  // Teammate joins and approves.
  await owner.goto(projectUrl);
  await owner.getByRole("link", { name: "Shop team" }).first().click();
  await owner.getByRole("button", { name: "Create invite link" }).click();
  const inviteUrl = await owner.locator("code.select").innerText();
  const bea = await (await ctx(390)).newPage();
  await bea.goto(inviteUrl);
  await bea.getByLabel("Display name").fill("Bea Okafor");
  await bea.getByLabel("Email").fill("bea@example.com");
  await bea.getByLabel(/Password/).fill("another long password");
  await bea.getByRole("button", { name: "Create account" }).click();
  // Signed in and on the team page (the invite page also names the team, so wait for the URL).
  await waitFor(() => /#\/w\//.test(bea.url()), "teammate on team page");
  await bea.getByRole("heading", { name: "Shop team" }).waitFor();
  await bea.goto(sessionUrl);
  await bea.getByRole("button", { name: "Approve", exact: true }).click();
  step("teammate joined by invite (phone width) and approved the change");

  await owner.goto(sessionUrl);
  await waitFor(
    () => owner.getByRole("button", { name: /Merge into main/ }).isEnabled(),
    "merge enabled",
  );
  await owner.getByRole("button", { name: /Merge into main/ }).click();
  await owner
    .getByText(/merged as/)
    .first()
    .waitFor({ timeout: 20000 });
  // A merged task is done: no instruction box or interrupt, and nothing implies a GitHub push.
  await owner.getByText(/These changes are merged, so this task is done/).waitFor();
  if (await owner.getByPlaceholder(/Instruction for the agent/).count())
    throw new Error("instruction box still shown on a merged task");
  if (await owner.getByRole("button", { name: "Interrupt turn" }).count())
    throw new Error("interrupt shown on a merged task");
  await owner
    .getByText(/into Pairloom's copy \(not pushed to GitHub\)/)
    .first()
    .waitFor();
  await owner.screenshot({ path: join(shots, "2b-merged.png"), fullPage: true });
  step("owner merged; merged task shows as done, with hosted wording");

  // The change persists: reload the project, open Files, read the file.
  await owner.goto(projectUrl);
  await owner.reload();
  await owner.getByRole("tab", { name: /Files/ }).click();
  await owner.getByRole("button", { name: "src/cart.js" }).click();
  await owner.locator(".file-body pre", { hasText: "itemCount" }).waitFor();
  // The tab is part of the URL, so a reload keeps the user where they were.
  if (!/#\/p\/[^/]+\/files$/.test(owner.url()))
    throw new Error(`files tab not in URL: ${owner.url()}`);
  await owner.reload();
  await owner.getByRole("button", { name: "src/cart.js" }).click();
  await owner.locator(".file-body pre", { hasText: "itemCount" }).waitFor();
  await owner.screenshot({ path: join(shots, "3-files-after-merge.png"), fullPage: true });
  await owner.getByRole("tab", { name: /Tasks/ }).click();
  await owner.getByText("Item count").waitFor();
  step("after reload: task history kept and merged code visible in Files");

  if (!REAL) {
    // A turn that edits a file but never finishes: the page must say so, keep the edit, and
    // offer an explicit continue (nothing reruns by itself).
    await owner.goto(projectUrl);
    await owner.getByRole("tab", { name: /Tasks/ }).click();
    await owner.getByPlaceholder(/Title/).fill("Slow task");
    await owner.getByPlaceholder("First instruction for the agent").fill("SLOW: add a note");
    await owner.getByRole("button", { name: "Start task" }).click();
    await owner.getByText(/The agent is working/).waitFor({ timeout: 15000 });
    await owner.reload();
    await owner.getByText(/The agent is working/).waitFor({ timeout: 15000 });
    await owner
      .getByText(/didn't finish/)
      .first()
      .waitFor({ timeout: 30000 });
    await owner.getByText(/ran past its time limit/).waitFor();
    await owner.getByText(/Agent's last turn didn't finish \(ran out of time\)/).waitFor();
    await owner.locator(".diff .a", { hasText: "partial work" }).first().waitFor();
    if (await owner.getByText(/finished its turn \(unverified/).count())
      throw new Error("timed-out turn shown as finished");
    await owner.screenshot({ path: join(shots, "4-turn-timed-out.png"), fullPage: true });
    await owner.getByRole("button", { name: "Ask the agent to continue" }).click();
    await owner
      .getByText(/finished its turn/)
      .first()
      .waitFor({ timeout: 30000 });
    await waitFor(async () => !(await owner.getByText(/didn't finish/).count()), "failure cleared");
    step("timed-out turn: shown as unfinished, partial edit kept, explicit continue finished it");

    // An edit that breaks the file must be flagged to reviewers, not just to the model.
    await owner.goto(projectUrl);
    await owner.getByRole("tab", { name: /Tasks/ }).click();
    await owner.getByPlaceholder(/Title/).fill("Broken edit");
    await owner.getByPlaceholder("First instruction for the agent").fill("BROKEN: add itemCount");
    await owner.getByRole("button", { name: "Start task" }).click();
    await owner
      .getByText(/finished its turn/)
      .first()
      .waitFor({ timeout: 30000 });
    await owner
      .getByText(
        /src\/cart\.js looks broken: it didn't parse after the agent's last edit \(line \d+/,
      )
      .waitFor({ timeout: 15000 });
    await owner.screenshot({ path: join(shots, "4b-broken-edit.png"), fullPage: true });
    step("an edit that breaks the file is flagged in the review checklist");
  }

  // Layout evidence: tablet, phone and dark mode, signed in as the owner.
  const cookies = await owner.context().cookies();
  for (const [name, width, scheme] of [
    ["tablet", 820, "light"],
    ["phone", 390, "light"],
    ["desktop-dark", 1366, "dark"],
    ["phone-dark", 390, "dark"],
  ]) {
    const c = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
    await c.addCookies(cookies);
    const pg = await c.newPage();
    pg.on("pageerror", (e) => errors.push(e.message));
    for (const [label, url] of [
      ["task", sessionUrl],
      ["project", projectUrl],
    ]) {
      await pg.goto(url);
      await pg.locator("h1").first().waitFor();
      await pg.waitForTimeout(300);
      const overflow = await pg.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1) throw new Error(`${name} ${label}: page scrolls sideways by ${overflow}px`);
      await pg.screenshot({ path: join(shots, `5-${label}-${name}.png`), fullPage: true });
    }
    await c.close();
  }
  step("tablet, phone and dark-mode layouts render without sideways scrolling");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  const how = REAL ? "REAL model via the configured provider" : `model stubbed: ${calls} calls`;
  console.log(`\nHosted smoke passed (${how}). Screenshots in ${shots}`);
} catch (e) {
  console.error("Hosted smoke FAILED:", e);
  console.error(serverLog.slice(-3000));
  if (lastPage) {
    await lastPage.screenshot({ path: join(shots, "failure.png"), fullPage: true }).catch(() => {});
    const text = await lastPage
      .locator("main")
      .innerText()
      .catch(() => "");
    console.error("--- page text at failure ---\n" + text.slice(-2500));
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  model.close();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
}
