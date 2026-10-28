// Runs the collaboration server and the Vite dev server together.
// Pairloom-hosted workspaces are on by default here, so projects created in the browser get a
// repository and an agent worker without any setup (set PAIRLOOM_HOSTED_WORKERS=false to turn
// that off). A worker on another machine still runs separately (`npm run dev:worker`).
import { spawn } from "node:child_process";

const procs = [
  ["server", ["run", "dev:server"]],
  ["web", ["run", "dev:web"]],
].map(([name, args]) => {
  const env = { PAIRLOOM_HOSTED_WORKERS: "true", ...process.env };
  const p = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"], env });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((l) => `[${name}] ${l}`)
      .join("\n") + "\n";
  p.stdout.on("data", (c) => process.stdout.write(prefix(c)));
  p.stderr.on("data", (c) => process.stderr.write(prefix(c)));
  p.on("exit", (code) => {
    console.log(`[${name}] exited with ${code}`);
    for (const other of procs) other.kill();
    process.exit(code ?? 0);
  });
  return p;
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => procs.forEach((p) => p.kill(sig)));
