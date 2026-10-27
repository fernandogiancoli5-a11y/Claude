import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace, assertSafeRef } from "../src/git.js";
import { makeRepo } from "./fixtures.js";

describe("git workspace isolation", () => {
  it("creates an isolated worktree branch, snapshots changes, and merges only the reviewed head", async () => {
    const r = makeRepo();
    const ws = new Workspace(r.repo, r.worktrees);
    const wt = await ws.ensureWorktree("ses_abc", "pairloom/abc", "main");
    expect(existsSync(wt.path)).toBe(true);

    writeFileSync(join(wt.path, "inventory.ts"), "export const max = 10;\n");
    const snap = await ws.snapshot(
      wt.path,
      "pairloom/abc",
      wt.baseCommit,
      "checkpoint",
      1024 * 1024,
    );
    expect(snap.files).toEqual([{ path: "inventory.ts", insertions: 1, deletions: 0 }]);
    expect(snap.diff).toContain("+export const max = 10;");
    // The base branch is untouched by the agent's work.
    expect(existsSync(join(r.repo, "inventory.ts"))).toBe(false);

    // A stale review cannot be merged.
    await expect(ws.merge("pairloom/abc", "main", "0".repeat(40), "m")).rejects.toThrow(
      /moved since review/,
    );

    const mergeCommit = await ws.merge(
      "pairloom/abc",
      "main",
      snap.headCommit,
      "Merge reviewed change",
    );
    expect(mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(r.repo, "inventory.ts"))).toBe(true);
    // Never pushes: there is no remote at all, and merge still succeeded locally.
    expect(r.g("remote")).toBe("");
  });

  it("reuses the worktree when resuming", async () => {
    const r = makeRepo();
    const ws = new Workspace(r.repo, r.worktrees);
    const a = await ws.ensureWorktree("ses_1", "pairloom/one", "main");
    const b = await ws.ensureWorktree("ses_1", "pairloom/one", "main");
    expect(b.path).toBe(a.path);
    expect(b.baseCommit).toBe(a.baseCommit);
  });

  it("refuses to merge into a dirty repository", async () => {
    const r = makeRepo();
    const ws = new Workspace(r.repo, r.worktrees);
    const wt = await ws.ensureWorktree("ses_2", "pairloom/two", "main");
    writeFileSync(join(wt.path, "a.txt"), "a\n");
    const snap = await ws.snapshot(wt.path, "pairloom/two", wt.baseCommit, "c", 1 << 20);
    writeFileSync(join(r.repo, "README.md"), "dirty\n");
    await expect(ws.merge("pairloom/two", "main", snap.headCommit, "m")).rejects.toThrow(
      /uncommitted/,
    );
  });

  it("rejects unsafe refs and session ids", () => {
    for (const bad of ["../x", "-rf", "a..b", "x.lock", "a b", "a;rm"]) {
      expect(() => assertSafeRef(bad)).toThrow();
    }
    const ws = new Workspace("/tmp", "/tmp/wt");
    expect(() => ws.pathFor("../../etc")).toThrow();
  });
});
