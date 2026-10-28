import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepo, RepoSetupError, validateGitUrl, workerEnv } from "../src/hosted.js";
import { startStubOpenAI, text, toolCalls } from "../../worker/test/stubOpenAI.js";
import { makeApp, signup } from "./helpers.js";

const until = async <T>(
  fn: () => Promise<T | undefined | null | false>,
  ms: number,
  label: string,
) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

describe("hosted repositories", () => {
  it("accepts only public https Git URLs", () => {
    expect(validateGitUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
    for (const bad of [
      "http://github.com/o/r",
      "git@github.com:o/r.git",
      "file:///etc",
      "https://user:pw@github.com/o/r",
      "https://localhost/o/r",
      "https://127.0.0.1/o/r",
      "https://[::1]/o/r",
      "https://10.0.0.5/o/r",
      "https://intranet/o/r",
      "https://git.corp.internal/o/r",
      "not a url",
    ]) {
      expect(() => validateGitUrl(bad), bad).toThrow(RepoSetupError);
    }
  });

  it("creates a starter or empty repository with one initial commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "pl-hosted-"));
    const sample = await createRepo(join(root, "s"), { kind: "sample" });
    expect(sample.branch).toBe("main");
    expect(existsSync(join(root, "s/src/cart.js"))).toBe(true);
    const empty = await createRepo(join(root, "e"), { kind: "empty", branch: "trunk" });
    expect(empty.branch).toBe("trunk");
    const log = execFileSync("git", ["log", "--oneline"], {
      cwd: join(root, "e"),
      encoding: "utf8",
    });
    expect(log.trim().split("\n")).toHaveLength(1);
    await expect(createRepo(join(root, "s"), { kind: "sample" })).rejects.toThrow(/already exists/);
  });

  it("gives the worker only what it needs from the server's environment", () => {
    const env = workerEnv(
      {
        PATH: "/bin",
        GROQ_API_KEY: "gsk_placeholder",
        LLM_MAX_RETRIES: "2",
        DATABASE_PATH: "/secret/db.sqlite",
        PUBLIC_ORIGIN: "https://x",
        SOME_OTHER_SECRET: "nope",
      },
      { serverUrl: "http://127.0.0.1:1", token: "plw_t", dir: "/data/hosted/prj_1" },
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      GROQ_API_KEY: "gsk_placeholder",
      LLM_MAX_RETRIES: "2",
      PAIRLOOM_WORKER_TOKEN: "plw_t",
      PAIRLOOM_REPO_PATH: "/data/hosted/prj_1/repo",
    });
    expect(env.DATABASE_PATH).toBeUndefined();
    expect(env.SOME_OTHER_SECRET).toBeUndefined();
    expect(env.PAIRLOOM_CODE_EXECUTION).toBe("disabled"); // fail closed by default
    const optedIn = workerEnv(
      { PAIRLOOM_HOSTED_CODE_EXECUTION: "unsafe-allow" },
      { serverUrl: "http://127.0.0.1:1", token: "t", dir: "/d" },
    );
    expect(optedIn.PAIRLOOM_CODE_EXECUTION).toBe("enabled");
    for (const v of ["true", "1", "yes", "allow"])
      expect(
        workerEnv({ PAIRLOOM_HOSTED_CODE_EXECUTION: v }, { serverUrl: "x", token: "t", dir: "/d" })
          .PAIRLOOM_CODE_EXECUTION,
      ).toBe("disabled");
  });
});

describe("Pairloom-hosted project, end to end (real worker process, stub model)", () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  let stub: Awaited<ReturnType<typeof startStubOpenAI>>;
  const hostedDir = mkdtempSync(join(tmpdir(), "pl-hosted-e2e-"));
  const saved = { ...process.env };

  beforeAll(async () => {
    // MOCKED model: a scripted OpenAI-compatible stub. Everything else is real: the worker
    // process, git, the sandboxed tools and the project's own test suite.
    stub = await startStubOpenAI(({ n }) => {
      if (n === 1) return toolCalls({ name: "read_file", args: { path: "src/cart.js" } });
      if (n === 2)
        return toolCalls({
          name: "edit_file",
          args: {
            path: "src/cart.js",
            old_string: "export function subtotalCents",
            new_string:
              "export function itemCount(cart) {\n  return cart.items.reduce((n, i) => n + i.quantity, 0);\n}\n\nexport function subtotalCents",
          },
        });
      if (n === 3) return toolCalls({ name: "run_tests", args: {} });
      return text("Added itemCount(cart). I couldn't run the tests here; please review the diff.");
    });
    process.env.LLM_BASE_URL = stub.url;
    process.env.GROQ_API_KEY = "gsk_stub_placeholder";
    process.env.LLM_MAX_RETRIES = "0";
    app = await makeApp({ hostedWorkers: true, hostedDir });
    app.hosted!.start(app.url);
  });
  afterAll(async () => {
    await app.close();
    await stub.close();
    process.env = saved;
  });

  it("creates the repo, runs the agent on its files, and merges the reviewed change", async () => {
    const owner = await signup(app, "owner");
    expect((await owner.req("GET", "/api/config")).body).toEqual({ hostedWorkers: true });
    const ws = (await owner.req("POST", "/api/workspaces", { name: "Team" })).body;
    const created = await owner.req("POST", `/api/workspaces/${ws.id}/projects`, {
      name: "shop",
      source: "sample",
    });
    expect(created.status).toBe(200);
    const projectId = created.body.id as string;

    // The server's own worker comes online and reports the real agent.
    const worker = await until(
      async () => {
        const p = (await owner.req("GET", `/api/projects/${projectId}`)).body;
        const w = p.workers[0];
        return w?.online && w.adapters.length ? w : null;
      },
      30_000,
      "hosted worker online",
    );
    expect(worker.hosted).toBe(true);
    const real = worker.adapters.find((a: any) => a.kind === "llm-harness");
    expect(real.available).toBe(true);
    // Fail closed: hosted workers don't run project code (no isolation from the server).
    expect(real.codeExecution).toBe(false);

    const s = await owner.req("POST", `/api/projects/${projectId}/sessions`, {
      title: "Item count",
      prompt: "Add itemCount(cart) to src/cart.js",
      workerId: worker.id,
      executionMode: "real",
    });
    expect(s.status).toBe(200);
    const sessionId = s.body.id as string;

    const detail = async () => (await owner.req("GET", `/api/sessions/${sessionId}`)).body;
    const final = await until(
      async () => {
        const d = await detail();
        return d.session.status === "idle" && d.changeSet ? d : null;
      },
      45_000,
      "turn finished with changes",
    );
    expect(final.changeSet.diff).toContain("+export function itemCount(cart)");
    const events = (await owner.req("GET", `/api/sessions/${sessionId}/events`)).body.events;
    const result = events.find((e: any) => e.type === "agent.result").payload;
    expect(result).toMatchObject({ subtype: "end_turn", isError: false });
    // The outcome is stored on the task, so lists and reloads show it without the event log.
    expect((await detail()).session.lastOutcome).toBe("end_turn");
    // Code execution is off for hosted workers: the model was never offered the run tools, its
    // attempt to run tests executed nothing, and nothing claims the tests ran.
    const offered = stub.requests[0]!.body.tools.map((t: any) => t.function.name);
    expect(offered).not.toContain("run_tests");
    expect(offered).not.toContain("run_command");
    expect(stub.requests[0]!.body.messages[0].content).toMatch(/cannot run code/);
    expect(result.lastTestRun).toBeNull();
    const attempt = events.find(
      (e: any) =>
        e.type === "agent.tool_result" && /unknown tool 'run_tests'/.test(e.payload.output),
    );
    expect(attempt?.payload.isError).toBe(true);

    // The independent "run tests" button is refused visibly, never shown as running.
    expect((await owner.req("POST", `/api/sessions/${sessionId}/checks`)).status).toBe(200);
    const refused = await until(
      async () =>
        (await owner.req("GET", `/api/sessions/${sessionId}/events`)).body.events.find(
          (e: any) => e.type === "system.notice" && /Tests didn't run/.test(e.payload.message),
        ),
      15_000,
      "checks refusal notice",
    );
    expect(refused.payload.message).toMatch(/disabled on this Pairloom server/);
    expect(
      (await owner.req("GET", `/api/sessions/${sessionId}/events`)).body.events.some(
        (e: any) => e.type === "checks.started",
      ),
    ).toBe(false);

    // Review + merge, then the base branch of the hosted repo has the change.
    const collab = owner; // single-user approval is allowed for owners reviewing
    await collab.req("POST", `/api/changesets/${final.changeSet.id}/reviews`, {
      decision: "approve",
    });
    expect(
      (await owner.req("POST", `/api/changesets/${final.changeSet.id}/merge`, {})).status,
    ).toBe(200);
    await until(async () => (await detail()).changeSet?.status === "merged", 20_000, "merged");
    // A merged task is done: further instructions are refused, not stacked on merged history.
    const late = await owner.req("POST", `/api/sessions/${sessionId}/instructions`, {
      text: "one more thing",
    });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/merged/);
    const repo = app.hosted!.repoPath(projectId);
    const onMain = execFileSync("git", ["show", "main:src/cart.js"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(onMain).toContain("export function itemCount(cart)");
    expect(readFileSync(join(repo, ".git/HEAD"), "utf8")).toContain("main");

    // Members can browse the merged result and the task's branch; nothing else.
    const files = (await owner.req("GET", `/api/projects/${projectId}/files`)).body;
    expect(files.ref).toBe("main");
    expect(files.files.map((f: any) => f.path)).toEqual(
      expect.arrayContaining(["README.md", "src/cart.js", "test/cart.test.js"]),
    );
    const merged = (await owner.req("GET", `/api/projects/${projectId}/file?path=src/cart.js`))
      .body;
    expect(merged.content).toContain("export function itemCount(cart)");
    const onBranch = (
      await owner.req(
        "GET",
        `/api/projects/${projectId}/file?path=src/cart.js&sessionId=${sessionId}`,
      )
    ).body;
    expect(onBranch.ref).toBe(final.session.branchName);
    expect(onBranch.content).toContain("export function itemCount(cart)");
    for (const bad of ["../../etc/passwd", "/etc/passwd", "src/../../x", "a//b"]) {
      const r = await owner.req(
        "GET",
        `/api/projects/${projectId}/file?path=${encodeURIComponent(bad)}`,
      );
      expect(r.status, bad).toBe(400);
    }
    expect((await owner.req("GET", `/api/projects/${projectId}/file?path=nope.txt`)).status).toBe(
      404,
    );
    expect(
      (await owner.req("GET", `/api/projects/${projectId}/files?sessionId=ses_unknown`)).status,
    ).toBe(404);
    const outsider = await signup(app, "outsider");
    expect((await outsider.req("GET", `/api/projects/${projectId}/files`)).status).toBe(404);

    // Getting the work out: the merged project as a .tar.gz, and the change as an applicable patch.
    const archive = await app.fastify.inject({
      method: "GET",
      url: `/api/projects/${projectId}/archive`,
      headers: { cookie: owner.cookie },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.headers["content-disposition"]).toMatch(
      /attachment; filename="shop-main\.tar\.gz"/,
    );
    const out = mkdtempSync(join(tmpdir(), "pl-archive-"));
    execFileSync("tar", ["-xz", "-C", out], { input: archive.rawPayload });
    expect(readFileSync(join(out, "shop-main/src/cart.js"), "utf8")).toContain("itemCount");
    expect(existsSync(join(out, "shop-main/.git"))).toBe(false);
    const patch = await app.fastify.inject({
      method: "GET",
      url: `/api/changesets/${final.changeSet.id}/patch`,
      headers: { cookie: owner.cookie },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.body).toContain("+export function itemCount(cart)");
    const fresh = mkdtempSync(join(tmpdir(), "pl-apply-"));
    execFileSync("git", ["clone", "-q", repo, fresh]);
    execFileSync("git", ["checkout", "-q", final.changeSet.baseCommit], { cwd: fresh });
    execFileSync("git", ["apply", "--check", "-"], { cwd: fresh, input: patch.rawPayload });
    expect((await outsider.req("GET", `/api/projects/${projectId}/archive`)).status).toBe(404);
    expect((await outsider.req("GET", `/api/changesets/${final.changeSet.id}/patch`)).status).toBe(
      404,
    );

    // A project on the team's own worker: files aren't on this server, and the API says so.
    const ext = (
      await owner.req("POST", `/api/workspaces/${ws.id}/projects`, { name: "own-machine" })
    ).body;
    const extFiles = await owner.req("GET", `/api/projects/${ext.id}/files`);
    expect(extFiles.status).toBe(404);
    expect(extFiles.body.code).toBe("not_hosted");
  }, 120_000);

  it("rolls back the project when the repository can't be created", async () => {
    const owner = await signup(app, "owner2");
    const ws = (await owner.req("POST", "/api/workspaces", { name: "Team 2" })).body;
    const bad = await owner.req("POST", `/api/workspaces/${ws.id}/projects`, {
      name: "nope",
      source: "git",
      repoUrl: "https://127.0.0.1/private/repo",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/public Git host/);
    const dash = (await owner.req("GET", "/api/dashboard")).body;
    expect(dash.projects).toEqual([]);
  });

  it("stops a hosted worker when it is revoked", async () => {
    const owner = await signup(app, "owner3");
    const ws = (await owner.req("POST", "/api/workspaces", { name: "Team 3" })).body;
    const p = (
      await owner.req("POST", `/api/workspaces/${ws.id}/projects`, { name: "x", source: "empty" })
    ).body;
    const w = await until(
      async () =>
        (await owner.req("GET", `/api/projects/${p.id}`)).body.workers.find((x: any) => x.online),
      30_000,
      "online",
    );
    await owner.req("DELETE", `/api/workers/${w.id}`);
    await until(
      async () => !(await owner.req("GET", `/api/projects/${p.id}`)).body.workers[0].online,
      15_000,
      "offline after revoke",
    );
  }, 60_000);
});

describe("import limits", () => {
  it("default to 200 MB / 20,000 files / 120 s and accept env overrides", async () => {
    const { importLimits } = await import("../src/hosted.js");
    expect(importLimits({})).toEqual({ maxMb: 200, maxFiles: 20_000, timeoutMs: 120_000 });
    expect(
      importLimits({
        PAIRLOOM_IMPORT_MAX_MB: "50",
        PAIRLOOM_IMPORT_MAX_FILES: "abc",
        PAIRLOOM_IMPORT_TIMEOUT_SECONDS: "30",
      }),
    ).toEqual({ maxMb: 50, maxFiles: 20_000, timeoutMs: 30_000 });
  });
});
