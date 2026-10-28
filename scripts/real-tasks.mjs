// Runs a few REAL model tasks on a Pairloom-hosted starter project and records what happened:
// outcome, duration, model calls, tokens, rate-limit waits, and whether the resulting code is
// right. Uses the configured provider (GROQ_API_KEY); costs free-tier quota, so tasks run one
// at a time and only the handful listed below. Never prints the key.
//
// Correctness is checked by downloading the task's branch and running the sample project's
// own tests HERE (a developer machine, on the throwaway sample), never on the hosted server.
//
//   npm run build && node scripts/real-tasks.mjs [taskName...]
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is not set: no real model available, nothing run.");
  process.exit(2);
}
const root = resolve(new URL("..", import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), "pairloom-real-"));
const port = 8600 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const pass = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

/** Runs the branch's own tests plus an extra check script; returns "ok" or what failed. */
function verify(dir, extra) {
  try {
    execFileSync("node", ["--test"], { cwd: dir, stdio: "pipe", timeout: 30000 });
  } catch (e) {
    return `project tests fail: ${String(e.stdout ?? "").match(/not ok .*/)?.[0] ?? "see output"}`;
  }
  if (!extra) return "ok";
  writeFileSync(join(dir, "check.mjs"), extra);
  try {
    execFileSync("node", ["check.mjs"], { cwd: dir, stdio: "pipe", timeout: 10000 });
    return "ok";
  } catch (e) {
    return `check failed: ${
      String(e.stderr ?? "")
        .split("\n")
        .find((l) => /Error/.test(l)) ?? ""
    }`;
  }
}

const TASKS = [
  {
    name: "one file",
    prompt:
      "Add an exported function itemCount(cart) to src/cart.js that returns the total quantity of all items in the cart (the sum of each item's quantity). Change nothing else.",
    files: ["src/cart.js"],
    check: `import assert from "node:assert/strict";
import { createCart, addItem, itemCount } from "./src/cart.js";
const c = createCart();
assert.equal(itemCount(c), 0);
addItem(c, { sku: "a", name: "A", priceCents: 100 }, 2);
addItem(c, { sku: "b", name: "B", priceCents: 50 }, 3);
assert.equal(itemCount(c), 5);`,
  },
  {
    name: "two files",
    prompt:
      "Add an exported clearCart(cart) to src/cart.js that removes every item and returns the cart, then add a test for it in test/cart.test.js.",
    files: ["src/cart.js", "test/cart.test.js"],
    check: `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCart, addItem, clearCart } from "./src/cart.js";
const c = createCart();
addItem(c, { sku: "a", name: "A", priceCents: 100 }, 2);
assert.equal(clearCart(c), c);
assert.equal(c.items.length, 0);
assert.match(readFileSync("test/cart.test.js", "utf8"), /clearCart/);`,
  },
  {
    // Step limit forced low so the first turn can't finish; then the UI's "continue" text.
    name: "continue",
    prompt:
      "Add an exported function cartIsEmpty(cart) to src/cart.js that returns true when the cart has no items, and add a test for it in test/cart.test.js.",
    files: ["src/cart.js", "test/cart.test.js"],
    env: { AGENT_MAX_ITERATIONS_PER_TURN: "4" },
    continueAfterUnfinished: true,
    check: `import assert from "node:assert/strict";
import { createCart, addItem, cartIsEmpty } from "./src/cart.js";
const c = createCart();
assert.equal(cartIsEmpty(c), true);
addItem(c, { sku: "a", name: "A", priceCents: 100 }, 1);
assert.equal(cartIsEmpty(c), false);`,
  },
];

async function main() {
  const only = process.argv.slice(2);
  const results = [];
  for (const task of TASKS.filter((t) => !only.length || only.includes(t.name))) {
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
        DATABASE_PATH: join(tmp, `${results.length}.sqlite`),
        PAIRLOOM_HOSTED_WORKERS: "true",
        PAIRLOOM_HOSTED_DIR: join(tmp, `hosted-${results.length}`),
        LOG_LEVEL: "warn",
        GROQ_API_KEY: process.env.GROQ_API_KEY,
        ...Object.fromEntries(pass.filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
        ...(task.env ?? {}),
      },
    });
    let log = "";
    server.stdout.on("data", (c) => (log += c));
    server.stderr.on("data", (c) => (log += c));
    try {
      const r = await runTask(task);
      results.push(r);
      // A provider refusal for the daily allowance means further runs only burn requests.
      if (r.turns.some((t) => /per day/.test(t.message ?? ""))) {
        console.log("Daily allowance exhausted; stopping real-model runs here.");
        break;
      }
    } catch (e) {
      results.push({ task: task.name, outcome: `script error: ${e.message}`, turns: [] });
      console.log(log.slice(-1500));
    } finally {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {}
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  console.log("\nREAL model runs (provider: Groq via GROQ_API_KEY)");
  console.table(
    results.map((r) => ({
      task: r.task,
      outcomes: r.turns.map((t) => t.subtype).join(" → ") || r.outcome,
      finished: r.finished,
      seconds: r.seconds,
      modelCalls: r.turns.reduce((n, t) => n + (t.modelCallsThisTurn ?? 0), 0),
      tokens: r.turns.reduce((n, t) => n + (t.tokensThisTurn ?? 0), 0),
      estimated: r.turns.some((t) => t.usageEstimated),
      rateLimitWaits: r.rateLimitWaits,
      files: r.files?.join(" "),
      code: r.code,
    })),
  );
  for (const r of results) {
    for (const [i, s] of (r.summaries ?? []).entries())
      console.log(`- ${r.task} turn ${i + 1} summary: ${s}`);
    for (const t of r.turns) if (t.message) console.log(`- ${r.task} ${t.subtype}: ${t.message}`);
  }
}

async function runTask(task) {
  let cookie = "";
  const api = async (method, path, body, raw = false) => {
    const res = await fetch(origin + path, {
      method,
      headers: { origin, cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    if (raw) return Buffer.from(await res.arrayBuffer());
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error ?? ""}`);
    return json;
  };
  const until = async (fn, ms, label) => {
    const t = Date.now();
    for (;;) {
      const v = await fn().catch(() => null);
      if (v) return v;
      if (Date.now() - t > ms) throw new Error(`timeout: ${label}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  await until(() => fetch(`${origin}/api/health`).then((r) => r.ok), 30000, "server");
  await api("POST", "/api/auth/signup", {
    email: "real@example.com",
    password: "correct horse battery",
    displayName: "Real Run",
  });
  const ws = await api("POST", "/api/workspaces", { name: "Real runs" });
  const project = await api("POST", `/api/workspaces/${ws.id}/projects`, {
    name: "cart",
    source: "sample",
  });
  const worker = await until(
    async () =>
      ((await api("GET", `/api/projects/${project.id}`)).workers ?? []).find((w) => w.online),
    60000,
    "hosted worker online",
  );
  const started = Date.now();
  const session = await api("POST", `/api/projects/${project.id}/sessions`, {
    title: task.name,
    prompt: task.prompt,
    workerId: worker.id,
    executionMode: "real",
  });
  const sid = session.id ?? session.session?.id;
  const events = () => api("GET", `/api/sessions/${sid}/events`).then((b) => b.events);
  const results = async () => (await events()).filter((e) => e.type === "agent.result");
  const idleWithResults = (n) =>
    until(
      async () => {
        const d = await api("GET", `/api/sessions/${sid}`);
        return d.session.status === "idle" && (await results()).length >= n ? d : null;
      },
      11 * 60_000,
      `turn ${n}`,
    );
  let detail = await idleWithResults(1);
  const first = (await results())[0].payload;
  if (task.continueAfterUnfinished && first.isError) {
    // Same text the UI's "Ask the agent to continue" button sends.
    const edited = first.filesEdited ?? [];
    await api("POST", `/api/sessions/${sid}/instructions`, {
      text:
        "Continue where you left off and finish the task. " +
        (edited.length
          ? `You already changed ${edited.join(", ")}; those edits are in place, so don't redo them. `
          : "") +
        "Do only what is still missing, then reply with a summary.",
    });
    detail = await idleWithResults(2);
  }
  const all = await events();
  const turns = all.filter((e) => e.type === "agent.result").map((e) => e.payload);
  const last = turns.at(-1);
  const diff = detail.changeSet?.diff ?? "";
  const files = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  let code = "no change set";
  if (detail.changeSet) {
    const dir = join(tmp, `${task.name.replace(/\W/g, "-")}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const tgz = await api(
      "GET",
      `/api/projects/${project.id}/archive?sessionId=${sid}`,
      null,
      true,
    );
    writeFileSync(join(dir, "branch.tgz"), tgz);
    execFileSync("tar", ["-xzf", "branch.tgz", "--strip-components=1"], { cwd: dir });
    code = verify(dir, task.check);
    const unexpected = files.filter((f) => !task.files.includes(f));
    if (unexpected.length) code += `; unexpected files: ${unexpected.join(", ")}`;
  }
  return {
    task: task.name,
    finished: !last.isError,
    seconds: Math.round((Date.now() - started) / 1000),
    rateLimitWaits: all.filter(
      (e) => e.type === "system.notice" && /^Waiting \d+s/.test(e.payload.message),
    ).length,
    files,
    code,
    turns,
    summaries: all
      .filter((e) => e.type === "agent.text")
      .map((e) => e.payload.text.replace(/\s+/g, " ").slice(0, 280))
      .slice(-2),
  };
}

await main();
