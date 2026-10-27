import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AdapterInfo } from "@pairloom/shared";
import type { AgentAdapter, AgentContext, AgentRun } from "./types.js";

const BANNER = "[SIMULATED — no AI model was called]";

/**
 * Scripted stand-in for development and demos when no model credential is
 * available. It exercises the real collaboration path (approvals, worktree,
 * diff, review, merge) but every event is labelled simulated and it never
 * claims to have done AI work. It does not execute any shell command.
 */
export class SimulatedAdapter implements AgentAdapter {
  constructor(private stepMs: number) {}

  info(): AdapterInfo {
    return {
      kind: "simulated",
      available: true,
      detail:
        "Scripted simulator: writes a notes file in the worktree; never calls a model or runs commands",
    };
  }

  async start(ctx: AgentContext): Promise<AgentRun> {
    const queue: string[] = [];
    let busy = false;
    let interrupted = false;
    let stopped = false;
    let turn = 0;
    const sleep = () => new Promise((r) => setTimeout(r, this.stepMs));

    ctx.emit("agent.init", {
      simulated: true,
      providerSessionId: null,
      model: "none (simulated)",
      cwd: ctx.cwd,
    });

    const runTurn = async (text: string) => {
      turn += 1;
      interrupted = false;
      await sleep();
      ctx.emit("agent.text", { text: `${BANNER} Received instruction: “${text.slice(0, 500)}”` });
      await sleep();
      if (interrupted || stopped) return finish("interrupted", true);

      const ask = await ctx.requestPermission({
        toolName: "Bash",
        input: {
          command: "echo simulated-check",
          description: "Simulated check (will NOT be executed)",
        },
        title: `${BANNER} Simulated agent asks to run: echo simulated-check`,
      });
      if (interrupted || stopped) return finish("interrupted", true);
      ctx.emit("agent.tool_result", {
        toolUseId: `sim-${turn}`,
        isError: ask.behavior === "deny",
        output:
          ask.behavior === "allow"
            ? `${BANNER} Approved. Nothing was executed.`
            : `${BANNER} Denied: ${ask.message}`,
      });

      const rel = ".pairloom/simulated-notes.md";
      ctx.emit("agent.tool_use", {
        toolUseId: `sim-w-${turn}`,
        toolName: "Write (simulated)",
        input: rel,
      });
      mkdirSync(join(ctx.cwd, ".pairloom"), { recursive: true });
      appendFileSync(
        join(ctx.cwd, rel),
        `## Simulated turn ${turn}\n\nInstruction: ${text}\n\n_Written by the Pairloom simulator, not by an AI agent._\n\n`,
      );
      await sleep();
      ctx.emit("agent.text", {
        text: `${BANNER} Appended a note to ${rel}. A real agent would have worked on the request.`,
      });
      finish("success", false);
    };

    const finish = (subtype: string, isError: boolean) => {
      ctx.emit("agent.result", {
        subtype,
        isError,
        simulated: true,
        numTurns: 1,
        totalCostUsd: 0,
        result: subtype === "success" ? `${BANNER} Simulated turn finished.` : undefined,
      });
      ctx.onTurnEnd({ subtype, isError });
    };

    const pump = async () => {
      if (busy) return;
      busy = true;
      while (queue.length && !stopped) await runTurn(queue.shift()!);
      busy = false;
    };

    return {
      send: (text) => {
        queue.push(text);
        ctx.onTurnStart();
        void pump();
      },
      interrupt: async () => {
        interrupted = true;
      },
      stop: async () => {
        stopped = true;
        ctx.onExit({ error: null });
      },
    };
  }
}
