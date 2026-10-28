// End-to-end scenario for the REAL agent harness, driven through the browser by two users.
//
//   npm run build
//   node scripts/agent-scenario.mjs                      # PROVIDER=mock (default): scripted local model stub
//   GROQ_API_KEY=... PROVIDER=groq node scripts/agent-scenario.mjs   # real Groq model, spends money
//
// Steps: workspace + project, connect the disposable sample repo (samples/tiny-cart),
// start a real-mode session with a feature task, stream progress to both browsers,
// close the owner's browser mid-task (agent keeps going), collaborator instruction +
// host approval, run the project's tests independently, interrupt, kill the worker
// (disconnected -> interrupted), restart + resume from the saved transcript, review, merge.
//
// PROVIDER=mock proves the product plumbing only. It is NOT evidence about a real model.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const PROVIDER = process.env.PROVIDER ?? "mock";
if (!["mock", "groq"].includes(PROVIDER)) throw new Error("PROVIDER must be mock or groq");
if (PROVIDER === "groq" && !process.env.GROQ_API_KEY) {
  console.error("PROVIDER=groq needs GROQ_API_KEY in the environment. Not running.");
  process.exit(2);
}
const root = resolve(new URL("..", import.meta.url).pathname);
const shots = resolve(process.argv[2] ?? join(root, "data", `scenario-${PROVIDER}`));
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "pairloom-scenario-"));
const port = 9000 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const children = [];
const step = (msg) => console.log(`✓ ${msg}`);
const note = (msg) => console.log(`  · ${msg}`);

// Network settings the worker's own env allowlist also passes through (apps/worker/src/config.ts),
// so a real provider is reachable behind a proxy or TLS-inspecting gateway.
const NETWORK_ENV = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
];
const networkEnv = Object.fromEntries(
  NETWORK_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);

function run(name, args, env) {
  const p = spawn("npx", ["tsx", ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_NO_WARNINGS: "1",
      ...networkEnv,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  p.stdout.on("data", (c) => process.env.VERBOSE && process.stdout.write(`[${name}] ${c}`));
  p.stderr.on("data", (c) => process.env.VERBOSE && process.stderr.write(`[${name}] ${c}`));
  children.push(p);
  return p;
}
const killGroup = (child, signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {}
};
async function waitFor(fn, label, ms = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------- mock model
const DISCOUNT_FN = `export function applyDiscount(cart, code) {
  const rates = { SAVE10: 10 };
  if (!(code in rates)) throw new Error(\`Unknown discount code: \${code}\`);
  return Math.floor((subtotalCents(cart) * (100 - rates[code])) / 100);
}
`;
const DISCOUNT_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, applyDiscount, createCart } from "../src/cart.js";

test("SAVE10 takes 10% off, rounding down", () => {
  assert.equal(applyDiscount(addItem(createCart(), { sku: "a", priceCents: 999 }), "SAVE10"), 899);
});
test("unknown codes throw", () => assert.throws(() => applyDiscount(createCart(), "NOPE")));
`;
function startMockModel() {
  const call = (name, args) => ({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `c${Math.random().toString(36).slice(2, 8)}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1500, completion_tokens: 120 },
  });
  const say = (content) => ({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1500, completion_tokens: 60 },
  });
  const script = [
    [call("read_file", { path: "src/cart.js" }), 1500],
    [
      call("edit_file", {
        path: "src/cart.js",
        old_string: "export function subtotalCents",
        new_string: DISCOUNT_FN + "\nexport function subtotalCents",
      }),
      1500,
    ],
    [call("write_file", { path: "test/discount.test.js", content: DISCOUNT_TEST }), 1500],
    [call("run_command", { argv: ["node", "-e", "console.log('style check ok')"] }), 500],
    [call("run_tests", {}), 500],
    [say("[MOCK MODEL] Implemented applyDiscount (SAVE10) with tests; npm test passed."), 300],
    [
      call("edit_file", {
        path: "src/cart.js",
        old_string: "{ SAVE10: 10 }",
        new_string: "{ SAVE10: 10, SAVE20: 20 }",
      }),
      500,
    ],
    [call("run_tests", {}), 300],
    [say("[MOCK MODEL] Added SAVE20."), 300],
    [say("[MOCK MODEL] (slow answer, should be interrupted)"), 30000],
    [say("[MOCK MODEL] (never delivered: worker killed)"), 60000],
    [
      say(
        "[MOCK MODEL] Resumed from the saved transcript. Code unchanged since the last checkpoint.",
      ),
      300,
    ],
  ];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const [body, delay] = script.shift() ?? [say("[MOCK MODEL] script exhausted"), 0];
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }, delay);
    });
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ url: `http://127.0.0.1:${server.address().port}/v1`, server }),
    ),
  );
}

let failed = false;
let mock = null;
try {
  if (!existsSync(join(root, "apps/web/dist/index.html")))
    throw new Error("Run `npm run build` first");
  if (PROVIDER === "mock") mock = await startMockModel();
  run("server", ["apps/server/src/index.ts"], {
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_ORIGIN: origin,
    DATABASE_PATH: join(tmp, "db.sqlite"),
    WEB_DIST_DIR: join(root, "apps/web/dist"),
    LOG_LEVEL: "warn",
  });
  await waitFor(() => fetch(`${origin}/api/health`).then((r) => r.ok), "server up");
  const repo = join(tmp, "sample-repo");
  execFileSync("bash", [join(root, "scripts/sample-repo.sh"), repo]);
  step(`server up; disposable sample repo at ${repo} (provider: ${PROVIDER})`);

  const browser = await chromium.launch();
  const newPage = async () =>
    (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  let ownerCtxPage = await newPage();
  let owner = ownerCtxPage;
  const collab = await newPage();

  await owner.goto(origin);
  await owner.getByRole("button", { name: "Need an account? Sign up" }).click();
  await owner.getByLabel("Display name").fill("Ana (owner)");
  await owner.getByLabel("Email").fill("ana@example.com");
  await owner.getByLabel(/Password/).fill("correct horse battery");
  await owner.getByRole("button", { name: "Create account" }).click();
  await owner.getByPlaceholder("New workspace name").fill("Demo team");
  await owner.getByRole("button", { name: "Create workspace" }).click();
  await owner.getByLabel("Project name").fill("tiny-cart");
  await owner.getByRole("button", { name: "Add project" }).click();
  await owner.getByRole("button", { name: "Register worker" }).click();
  const token = (await owner.locator("pre.select").innerText()).match(
    /PAIRLOOM_WORKER_TOKEN=(\S+)/,
  )[1];
  await owner.getByRole("button", { name: "I've saved it" }).click();
  const projectUrl = owner.url();

  const workerEnv = {
    PAIRLOOM_SERVER_URL: origin,
    PAIRLOOM_WORKER_TOKEN: token,
    PAIRLOOM_REPO_PATH: repo,
    PAIRLOOM_WORKTREES_DIR: join(tmp, "worktrees"),
    PAIRLOOM_STATE_DIR: join(tmp, "worker-state"),
    LLM_PROVIDER: "groq",
    GROQ_API_KEY: PROVIDER === "mock" ? "gsk_mock_not_a_real_key" : process.env.GROQ_API_KEY,
    ...(mock ? { LLM_BASE_URL: mock.url } : {}),
    AGENT_MAX_MODEL_CALLS_PER_SESSION: "40",
    AGENT_MAX_COST_USD_PER_SESSION: "0.25",
    AGENT_MAX_TURN_SECONDS: "300",
    // Optional overrides: low-tier provider accounts hit per-minute token limits, and every
    // retry counts toward the model-call cap.
    ...Object.fromEntries(
      ["LLM_MAX_RETRIES", "LLM_MAX_RETRY_WAIT_SEC", "AGENT_MAX_MODEL_CALLS_PER_SESSION"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    ),
  };
  const startWorker = () => run("worker", ["apps/worker/src/index.ts"], workerEnv);
  let worker = startWorker();
  await waitFor(() => owner.getByText("online", { exact: true }).isVisible(), "worker online");
  await waitFor(
    () =>
      owner
        .getByText(/Real agent \(gpt-oss-120b (via Groq|on a custom endpoint)\): available/)
        .isVisible(),
    "real adapter available",
  );
  step("worker connected; real agent (groq openai/gpt-oss-120b) reported available");

  await owner.getByRole("link", { name: "Demo team" }).first().click();
  await owner.getByRole("button", { name: "Create invite link" }).click();
  const inviteUrl = await owner.locator("code.select").innerText();
  await collab.goto(inviteUrl);
  await collab.getByLabel("Display name").fill("Bea (collaborator)");
  await collab.getByLabel("Email").fill("bea@example.com");
  await collab.getByLabel(/Password/).fill("another long password");
  await collab.getByRole("button", { name: "Create account" }).click();
  await waitFor(() => collab.getByText("Demo team").isVisible(), "collaborator joined");
  step("collaborator joined via invite");

  // Start a real-mode session with the feature task from samples/tiny-cart/README.md.
  await owner.goto(projectUrl);
  await owner.getByPlaceholder(/Title/).fill("Add discount codes");
  await owner
    .getByPlaceholder("First instruction for the agent")
    .fill(
      "Add applyDiscount(cart, code) to src/cart.js. Code SAVE10 takes 10% off the subtotal (round down to whole cents); unknown codes throw an Error. Add tests in test/discount.test.js and make sure npm test passes.",
    );
  await owner.getByLabel("Execution").selectOption("real");
  await owner.getByRole("button", { name: "Start task" }).click();
  await waitFor(() => owner.getByText(/Real AI agent session/).isVisible(), "real banner");
  const sessionUrl = owner.url();
  step("real-mode session started");

  await collab.goto(sessionUrl);
  await waitFor(
    () => collab.getByText(/ready · gpt-oss-120b (via Groq|on a custom endpoint)/).isVisible(),
    "collab sees agent init",
  );

  // Owner closes their browser mid-task; the agent keeps working on the worker.
  await owner.context().close();
  step("owner closed their browser while the agent works");
  await waitFor(
    () =>
      collab
        .getByText(/uses (read_file|list_files|search|edit_file|write_file)/)
        .first()
        .isVisible(),
    "collab sees tool activity",
    120000,
  );
  step("collaborator keeps seeing live agent activity");

  owner = await newPage();
  await owner.goto(origin);
  await owner.getByLabel("Email").fill("ana@example.com");
  await owner.getByLabel(/Password/).fill("correct horse battery");
  await owner.getByRole("button", { name: "Sign in" }).click();
  await owner.goto(sessionUrl);
  step("owner signed back in; session history intact");

  // Approve whatever the agent asks until the turn ends (mock: exactly one run_command).
  const finishTurn = async (page, n, ms = 240000) => {
    const start = Date.now();
    let approvals = 0;
    while (Date.now() - start < ms) {
      const done = await page
        .getByText(/agent finished its turn|turn failed|turn stopped by a limit|turn interrupted/)
        .count();
      if (done >= n) return approvals;
      const allow = page.getByRole("button", { name: "Allow once" }).first();
      if (await allow.isVisible().catch(() => false)) {
        await allow.click();
        approvals++;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`turn ${n} did not end in time`);
  };
  const approvals1 = await finishTurn(owner, 1);
  await owner.screenshot({ path: join(shots, "1-first-turn.png"), fullPage: true });
  const turn1Failed = await owner.getByText(/turn failed|turn stopped by a limit/).count();
  if (turn1Failed) throw new Error("first turn failed; see screenshot 1-first-turn.png");
  step(`turn 1 finished (${approvals1} host approval(s))`);
  await waitFor(
    () =>
      collab
        .getByText(/changes: \d+ file/)
        .first()
        .isVisible(),
    "collab sees change set",
  );

  // Collaborator instruction -> host approval.
  await collab
    .getByPlaceholder(/Propose an instruction/)
    .fill("Also support SAVE20 for 20% off, with a test.");
  await collab.getByRole("button", { name: "Propose instruction" }).click();
  await waitFor(
    () => owner.getByRole("button", { name: "Approve & send" }).isVisible(),
    "owner sees proposal",
  );
  await owner.getByRole("button", { name: "Approve & send" }).click();
  await finishTurn(owner, 2);
  step("collaborator instruction approved by host and completed");

  // Independent verification: reviewers run the project's own tests.
  await waitFor(
    async () => !(await collab.getByRole("button", { name: "run tests" }).isDisabled()),
    "run tests enabled",
  );
  await collab.getByRole("button", { name: "run tests" }).click();
  await waitFor(
    () => collab.getByText(/Project tests (passed|FAILED)/).isVisible(),
    "checks result",
    120000,
  );
  const passed = await collab.getByText(/Project tests passed/).count();
  step(`project tests run by Pairloom: ${passed ? "PASSED" : "FAILED"}`);
  if (!passed) throw new Error("project tests failed after the agent's change");

  // Cancellation.
  await owner
    .getByPlaceholder(/Instruction for the agent/)
    .fill("Explain every function in src/cart.js in detail.");
  await owner.getByRole("button", { name: "Send to agent" }).click();
  await waitFor(
    () => owner.getByRole("button", { name: "Interrupt turn" }).isEnabled(),
    "interrupt enabled",
  );
  await owner.getByRole("button", { name: "Interrupt turn" }).click();
  await finishTurn(owner, 3, 60000);
  const interrupted = await owner.getByText(/turn interrupted/).count();
  if (PROVIDER === "mock" && !interrupted)
    throw new Error("expected the slow mock turn to be interrupted");
  step(
    interrupted
      ? "turn interrupted and reported as interrupted"
      : "turn finished before the interrupt landed (real model was fast)",
  );

  // Worker crash during a turn, then restart + resume.
  await owner
    .getByPlaceholder(/Instruction for the agent/)
    .fill("Update README.md to document applyDiscount.");
  await owner.getByRole("button", { name: "Send to agent" }).click();
  await waitFor(() => owner.getByText("agent working").isVisible(), "turn running", 20000);
  killGroup(worker, "SIGKILL");
  await waitFor(
    () => collab.getByText("worker disconnected").first().isVisible(),
    "disconnected visible",
    60000,
  );
  step("worker killed mid-turn: collaborator sees 'worker disconnected'");
  worker = startWorker();
  await waitFor(
    () => collab.getByText(/interrupted — live agent lost/).isVisible(),
    "interrupted visible",
    60000,
  );
  await collab.screenshot({ path: join(shots, "2-interrupted.png"), fullPage: true });
  step("restarted worker reports it lost the live agent: status 'interrupted' (no fake result)");
  await owner.getByRole("button", { name: "Resume" }).click();
  await waitFor(
    () => owner.getByText(/resumed from saved transcript/).isVisible(),
    "resumed",
    60000,
  );
  await owner
    .getByPlaceholder(/Instruction for the agent/)
    .fill("Where were we? Finish documenting applyDiscount in README.md if needed.");
  await owner.getByRole("button", { name: "Send to agent" }).click();
  await finishTurn(owner, 4);
  step("resumed from the saved transcript and completed a turn");

  // Review + merge.
  await collab.getByRole("button", { name: "Approve", exact: true }).click();
  await waitFor(
    async () => owner.getByRole("button", { name: /Merge into main/ }).isEnabled(),
    "merge enabled",
  );
  await owner.getByRole("button", { name: /Merge into main/ }).click();
  await waitFor(() => collab.getByText(/merged as/).isVisible(), "merged", 60000);
  await collab.screenshot({ path: join(shots, "3-merged.png"), fullPage: true });
  const merged = readFileSync(join(repo, "src/cart.js"), "utf8");
  if (!/applyDiscount/.test(merged)) throw new Error("merged code lacks applyDiscount");
  const verify = execFileSync("npm", ["test"], { cwd: repo, encoding: "utf8" });
  note(
    verify
      .split("\n")
      .filter((l) => /^# (pass|fail)/.test(l))
      .join(" "),
  );
  step("reviewed change merged into the sample repo's main branch; tests pass there too");

  await browser.close();
  console.log(`\nScenario (${PROVIDER}) passed. Screenshots in ${shots}`);
  if (PROVIDER === "mock")
    console.log("NOTE: mock provider — this verifies the product, not a real model.");
} catch (err) {
  failed = true;
  console.error(`Scenario (${PROVIDER}) FAILED:`, err);
} finally {
  for (const c of children) killGroup(c, "SIGTERM");
  mock?.server.close();
  process.exit(failed ? 1 : 0);
}
