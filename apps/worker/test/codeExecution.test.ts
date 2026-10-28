import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_EXECUTION_DISABLED, codeExecutionAllowed, runCommand } from "../src/harness/tools.js";

const saved = process.env.PAIRLOOM_CODE_EXECUTION;
afterEach(() => {
  if (saved === undefined) delete process.env.PAIRLOOM_CODE_EXECUTION;
  else process.env.PAIRLOOM_CODE_EXECUTION = saved;
});

describe("code execution switch", () => {
  it("is allowed by default (a team's own worker) and off when disabled", () => {
    expect(codeExecutionAllowed({})).toBe(true);
    expect(codeExecutionAllowed({ PAIRLOOM_CODE_EXECUTION: "disabled" })).toBe(false);
  });

  it("refuses to spawn anything when disabled, whatever the command", async () => {
    process.env.PAIRLOOM_CODE_EXECUTION = "disabled";
    const dir = mkdtempSync(join(tmpdir(), "pl-noexec-"));
    const marker = join(dir, "ran");
    await expect(
      runCommand(["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], {
        cwd: dir,
        timeoutMs: 5000,
        signal: new AbortController().signal,
        sandboxHome: join(dir, "home"),
      }),
    ).rejects.toThrow(CODE_EXECUTION_DISABLED);
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });
});
