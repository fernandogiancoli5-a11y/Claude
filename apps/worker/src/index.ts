import { ClaudeSdkAdapter } from "./adapters/claudeSdk.js";
import { SimulatedAdapter } from "./adapters/simulated.js";
import type { AgentAdapter } from "./adapters/types.js";
import { loadWorkerConfig } from "./config.js";
import { Workspace } from "./git.js";
import { HarnessAdapter } from "./harness/agent.js";
import { loadHarnessLimits, loadProviderConfig } from "./harness/config.js";
import { OpenAICompatibleClient } from "./harness/provider.js";
import { ServerLink } from "./link.js";
import { SessionManager } from "./sessions.js";

const config = loadWorkerConfig();
const workspace = new Workspace(config.repoPath, config.worktreesDir);
await workspace.assertRepo();

// The MVP's real agent is Pairloom's own harness over an OpenAI-compatible API (Groq by
// default). The Claude Agent SDK adapter is kept as an explicit opt-in only.
const realKind = process.env.PAIRLOOM_REAL_ADAPTER ?? "llm-harness";
let real: AgentAdapter;
if (realKind === "claude-agent-sdk") {
  real = new ClaudeSdkAdapter(config);
} else if (realKind === "llm-harness") {
  real = new HarnessAdapter(
    new OpenAICompatibleClient(loadProviderConfig()),
    loadHarnessLimits(),
    config.stateDir,
  );
} else {
  throw new Error(`Unknown PAIRLOOM_REAL_ADAPTER '${realKind}'`);
}
const adapters = { real, simulated: new SimulatedAdapter(config.simulatedStepMs) };

let manager: SessionManager;
const link = new ServerLink(
  config.serverUrl,
  config.token,
  config.stateDir,
  () => ({
    workerVersion: "0.2.0",
    adapters: [adapters.real.info(), adapters.simulated.info()],
    liveSessions: manager.liveReports(),
  }),
  (frame) => manager.handle(frame.sessionId, frame.command),
);
manager = new SessionManager(link, workspace, adapters, config.stateDir);

for (const a of Object.values(adapters)) {
  const info = a.info();
  console.log(
    `adapter ${info.kind}: ${info.available ? "available" : "UNAVAILABLE"} — ${info.detail}`,
  );
}
console.log(`repo ${config.repoPath}; worktrees in ${config.worktreesDir}`);
link.start();

const shutdown = async () => {
  console.log("worker shutting down; live sessions will be reported interrupted");
  await manager.stopAll();
  await link.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
