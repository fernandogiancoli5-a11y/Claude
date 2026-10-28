import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Sandbox,
  assertCommandAllowed,
  classifyToolCall,
  loadProjectSettings,
  runCommand,
} from "../src/harness/tools.js";

function project() {
  const root = mkdtempSync(join(tmpdir(), "pl-sandbox-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.js"), "export const a = 1;\n");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  writeFileSync(
    join(root, ".pairloom.json"),
    JSON.stringify({ testCommand: ["npm", "test"], allowedCommands: [["node", "--test"]] }),
  );
  return { root, sandbox: new Sandbox(root), home: join(root, "..", "home-" + Date.now()) };
}

describe("filesystem boundary", () => {
  it("refuses paths outside the project, .git, and symlink escapes", async () => {
    const { root, sandbox } = project();
    expect(() => sandbox.resolve("../outside.txt")).toThrow(/outside/);
    expect(() => sandbox.resolve("/etc/passwd")).toThrow(/outside/);
    expect(() => sandbox.resolve("src/../../x")).toThrow(/outside/);
    expect(() => sandbox.resolve(".git/config")).toThrow(/\.git/);
    symlinkSync("/etc", join(root, "etc-link"));
    expect(() => sandbox.resolve("etc-link/passwd")).toThrow(/symlink/);
    await expect(sandbox.readFile("etc-link/hostname")).rejects.toThrow(/symlink/);
    symlinkSync(join(root, "src", "a.js"), join(root, "inner-link.js"));
    await expect(sandbox.writeFile("inner-link.js", "x")).rejects.toThrow(/symlink/);
    expect(sandbox.resolve("src/a.js").rel).toBe(join("src", "a.js"));
  });

  it("protects .pairloom.json from the agent and hides .git from listings", async () => {
    const { sandbox } = project();
    await expect(sandbox.writeFile(".pairloom.json", "{}")).rejects.toThrow(/protected/);
    expect(sandbox.listFiles()).not.toContain(".git");
  });

  it("edit_file requires a unique match", async () => {
    const { sandbox } = project();
    await sandbox.writeFile("b.txt", "x x\n");
    await expect(sandbox.editFile("b.txt", "x", "y")).rejects.toThrow(/2 times/);
    await expect(sandbox.editFile("b.txt", "zzz", "y")).rejects.toThrow(/not found/);
    await sandbox.editFile("b.txt", "x x", "y");
    expect(await sandbox.readFile("b.txt")).toContain("y");
  });
});

describe("permission classification", () => {
  it("auto-allows reads, follows policy for edits/tests, and always asks for deletes and arbitrary commands", () => {
    const { root, sandbox } = project();
    const settings = loadProjectSettings(root);
    const c = (name: any, args: any, policy: any = "accept_edits_in_worktree") =>
      classifyToolCall(name, args, policy, settings, sandbox);
    expect(c("read_file", { path: "src/a.js" })).toBe("auto");
    expect(c("read_file", { path: ".env" })).toBe("ask");
    expect(c("write_file", { path: "x" })).toBe("auto");
    expect(c("write_file", { path: "x" }, "ask_every_time")).toBe("ask");
    expect(c("run_tests", {})).toBe("auto");
    expect(c("run_tests", {}, "ask_every_time")).toBe("ask");
    expect(c("delete_file", { path: "src/a.js" })).toBe("ask");
    expect(c("run_command", { argv: ["node", "--test"] })).toBe("auto");
    expect(c("run_command", { argv: ["node", "--test", "--x"] })).toBe("ask");
    expect(c("run_command", { argv: ["rm", "-rf", "src"] })).toBe("ask");
    expect(c("run_command", { argv: ["node", "--test"] }, "ask_every_time")).toBe("ask");
  });

  it("hard-denies dangerous commands regardless of approval", () => {
    for (const argv of [
      ["sudo", "ls"],
      ["git", "push"],
      ["/usr/bin/ssh", "host"],
      ["git", "remote", "add"],
      ["rm", "-rf", "/"],
      ["curl", "https://example.com"],
      ["wget", "x"],
    ]) {
      expect(() => assertCommandAllowed(argv), argv.join(" ")).toThrow();
    }
    expect(() => assertCommandAllowed([])).toThrow();
    expect(() => assertCommandAllowed(["git", "status"])).not.toThrow();
  });
});

describe("bounded command execution", () => {
  it("does not pass API keys or worker credentials to commands", async () => {
    const { root, home } = project();
    process.env.GROQ_API_KEY = "gsk_should_never_leak";
    process.env.PAIRLOOM_WORKER_TOKEN = "plw_should_never_leak";
    const r = await runCommand(["node", "-e", "console.log(JSON.stringify(process.env))"], {
      cwd: root,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      sandboxHome: home,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("should_never_leak");
    expect(r.output).toContain('"CI":"1"');
  });

  it("kills the whole process group on timeout", async () => {
    const { root, home } = project();
    const started = Date.now();
    // A child that spawns a grandchild; both must die.
    const r = await runCommand(
      [
        "node",
        "-e",
        "require('child_process').spawn('sleep',['30'],{stdio:'inherit'}); setInterval(()=>{},1000)",
      ],
      { cwd: root, timeoutMs: 300, signal: new AbortController().signal, sandboxHome: home },
    );
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("cancels on abort and caps output", async () => {
    const { root, home } = project();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runCommand(
      ["node", "-e", "setInterval(()=>process.stdout.write('x'.repeat(10000)),1)"],
      {
        cwd: root,
        timeoutMs: 20_000,
        signal: ac.signal,
        sandboxHome: home,
      },
    );
    expect(r.cancelled).toBe(true);
    expect(r.output.length).toBeLessThan(40_000);
    expect(r.output).toContain("truncated");
  });

  it("reports a missing program as a failure, not success", async () => {
    const { root, home } = project();
    const r = await runCommand(["definitely-not-a-program-xyz"], {
      cwd: root,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      sandboxHome: home,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("failed to start");
  });
});
