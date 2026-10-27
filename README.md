# Pairloom

A multiplayer workspace around a Claude coding agent. Several people share one
agent session: everyone sees its activity live, collaborators propose
instructions that the host approves, the host approves tool use from the browser,
and the agent's changes are reviewed as a real git diff before they are merged.

- `PROJECT_PLAN.md`: scope, milestones to Friday 30 Oct, acceptance criteria, risks, deferred work
- `ARCHITECTURE.md`: components, the Claude Agent SDK evidence, the security and reliability model

> **Real vs simulated.** Real sessions run Claude Code through the official
> Claude Agent SDK and need a model credential (API key, Bedrock or Vertex) **on
> the worker**. Without one, only *simulated* sessions are available. They
> exercise the same collaboration flow, write a clearly labelled notes file, and
> carry a SIMULATED label on every event, change set, and screen.

## Layout

```
apps/server   Fastify API + realtime hub + SQLite (node:sqlite)
apps/worker   Agent worker: Claude Agent SDK adapter, simulator, git worktrees
apps/web      React UI (Vite)
packages/shared  Protocol schemas and types
scripts/      dev runner, demo repo, browser smoke test
```

## Requirements

Node 22.13+ (uses the built-in `node:sqlite`) and git. Playwright/Chromium only for the UI smoke test.

## Local development

```bash
npm install
cp .env.example .env                 # server settings (no secrets needed locally)
npm run dev                          # server on :8787 + web on :5173
```

Open http://localhost:5173 and create an account, a workspace and a project, then
**Register worker**. Copy the token it shows once into the worker env:

```bash
cp .env.worker.example .env.worker   # set PAIRLOOM_WORKER_TOKEN and PAIRLOOM_REPO_PATH
npm run demo:repo                    # optional: throwaway repo at ./data/demo-repo
npm run dev:worker
```

Invite a second person from the workspace page (single-use link). Use a private
window to act as them.

### Running a real agent on Rogue

1. Make a **dedicated** clone for the worker. It creates branches and worktrees
   there and merges reviewed changes into the base branch locally:
   `git clone <rogue-url> ~/pairloom/rogue`
2. In `.env.worker`, set `PAIRLOOM_REPO_PATH=~/pairloom/rogue` (absolute path)
   and `ANTHROPIC_API_KEY=…`. Keep `CLAUDE_MAX_BUDGET_USD` set.
3. Start the worker. The project page shows "Real agent (Claude Agent SDK): available".
4. Start a session with execution "Real Claude agent".

Merges are local to the worker's clone and are **never pushed**. Pushing is a
deliberate future feature.

## Checks

```bash
npm run check        # typecheck + tests + prettier
npm test             # vitest: 45 tests
npm run smoke:ui     # builds the web app, then drives two browsers through the full flow
```

The worker tests run the **real** Claude Agent SDK and bundled Claude Code CLI
against a local stub of the Messages API. The stub returns fixed replies, so these
tests prove the integration (spawn, streaming, approvals, tool execution,
error reporting), not model quality.

## Deploying privately (single VM)

1. `npm ci && npm run build`
2. Server env: `PUBLIC_ORIGIN=https://pairloom.example.internal`,
   `WEB_DIST_DIR=./apps/web/dist`, `OPEN_SIGNUP=false` after the first owner signs
   up, `TRUST_PROXY=true` behind a reverse proxy. Run `npm start` under systemd.
   Put Caddy or nginx in front for TLS, with WebSocket upgrade enabled for `/ws`.
3. Cloud worker on the same VM (or another box): a dedicated clone, `.env.worker`
   with the server URL, worker token and API key. Run `npm run start -w @pairloom/worker`
   under systemd. Agents keep running when every browser is closed.
4. Back up `data/pairloom.sqlite` and the worker's `data/worker-state` (holds the
   event outbox and Claude transcripts used for resume).

Container images are not provided yet. The Thursday milestone covers verifying a deployment recipe.
