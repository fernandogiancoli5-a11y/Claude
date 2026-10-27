import { ClaudeSdkAdapter } from "./adapters/claudeSdk.js";
import { SimulatedAdapter } from "./adapters/simulated.js";
import { loadWorkerConfig } from "./config.js";
import { Workspace } from "./git.js";
import { ServerLink } from "./link.js";
import { SessionManager } from "./sessions.js";

const config = loadWorkerConfig();
const workspace = new Workspace(config.repoPath, config.worktreesDir);
await workspace.assertRepo();

const adapters = {
  real: new ClaudeSdkAdapter(config),
  simulated: new SimulatedAdapter(config.simulatedStepMs),
};

let manager: SessionManager;
const link = new ServerLink(
  config.serverUrl,
  config.token,
  config.stateDir,
  () => ({
    workerVersion: "0.1.0",
    adapters: [adapters.real.info(), adapters.simulated.info()],
    liveSessions: manager.liveReports(),
  }),
  (frame) => manager.handle(frame.sessionId, frame.command),
);
manager = new SessionManager(link, workspace, adapters);

for (const a of Object.values(adapters)) {
  const info = a.info();
  console.log(`adapter ${info.kind}: ${info.available ? "available" : "UNAVAILABLE"} — ${info.detail}`);
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
