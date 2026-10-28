# Pairloom

A multiplayer workspace around an AI coding agent. Several people share one agent
session:
- everyone sees its activity live;
- collaborators propose instructions that the host approves;
- the host approves sensitive tool use from the browser;
- anyone on the team can run the project's tests;
- the agent's changes are reviewed as a real git diff before they are merged.

The agent runs on a **worker** process, not in anyone's browser, so closing the
browser does not stop it.

Other docs:
- `PROJECT_PLAN.md`: scope, milestones to Friday 30 Oct, acceptance criteria, cost estimate, risks.
- `ARCHITECTURE.md`: components, the provider decision and evidence, sandbox and
  permissions, and what persistence does and doesn't cover today.

> **Real vs simulated vs mocked.**
> - **Real** sessions use Pairloom's own agent harness against a model API.
>   Groq `openai/gpt-oss-120b` is the default and needs `GROQ_API_KEY` on the worker.
> - **Simulated** sessions call no model. They are labelled SIMULATED everywhere.
> - Automated tests use a **mocked provider** (a scripted local endpoint). That
>   proves the product plumbing, not model quality.
>
> **No real-provider run has happened yet.**

## Layout

```
apps/server       Fastify API + realtime hub + SQLite (node:sqlite)
apps/worker       Worker: harness (tool loop, sandbox, provider client), simulator, git worktrees
apps/web          React UI (Vite)
packages/shared   Protocol schemas and types
samples/tiny-cart Disposable sample app used for demos and tests (no dependencies)
scripts/          dev runner, sample repo, browser smoke test, agent scenario
```

## Local development

Requires Node 22.13+ and git.

```bash
npm install
cp .env.example .env                 # server settings (no secrets needed locally)
npm run dev                          # server on :8787 + web on :5173
```

1. Put a free Groq key in `.env` (`GROQ_API_KEY=…`, from console.groq.com) so the agent can
   run. Without it, only clearly labelled SIMULATED tasks are available.
2. Open http://localhost:5173, create an account and a team, then **New project → Starter
   project** (or import a public Git repository, or start empty). Pairloom creates the
   repository under `data/hosted/` and starts the project's agent worker itself.
3. Start a task, e.g. "Add `itemCount(cart)` to `src/cart.js` with a test". Watch it work,
   review the diff, approve and merge. The **Files** tab shows what's merged.

**Hosted mode is restricted on purpose.** Hosted workers never run project code (tests or
commands): nothing isolates that code from the server's secrets, database and other projects,
and command filtering is not isolation. The agent reads and edits files and you review its diff;
to run tests, use **Use my own machine**, where the worker runs on your hardware. (An operator
can set `PAIRLOOM_HOSTED_CODE_EXECUTION=unsafe-allow` on a private machine with only trusted
projects; don't on any shared or public server.)
4. Invite a teammate from the team page (use a private window to play them).

To run the agent on your own machine instead (e.g. against a private repository), choose
**Use my own machine** when creating the project and follow the worker setup it shows
(`npm run dev:worker` with `.env.worker`).

## Checks

```bash
npm run check                         # typecheck + 89 tests (no network, no paid APIs) + prettier
npm run smoke:ui                      # two browsers, simulated agent, full flow
npm run build && node scripts/agent-scenario.mjs   # two browsers, REAL harness + MOCKED model
```

Real-provider checks. These spend money, only a few cents per run:

```bash
GROQ_API_KEY=... PAIRLOOM_REAL_PROVIDER_TEST=1 npm run test:real
GROQ_API_KEY=... PROVIDER=groq node scripts/agent-scenario.mjs
```

## Public site and waitlist

`apps/site` is the public marketing page with the early-access waitlist (plain HTML/CSS/TS,
no third-party scripts). Signups go to `POST /api/waitlist` on the Pairloom server and are stored
in the same SQLite database (`waitlist` table: email, optional role, timestamp; no IP or tracking
data). Duplicates are idempotent, and honeypot/too-fast submissions and more than 5 attempts per IP
per 10 minutes are rejected.

```bash
npm run dev                 # server + app
npm run dev:site            # site on :5174, proxying /api to the server
npm run smoke:site          # build + browser test of the site and a real signup (throwaway DB)
npm run waitlist:export     # CSV of signups from data/pairloom.sqlite (server-side only)
node scripts/site-screenshots.mjs   # re-capture the product screenshots (simulator, no model calls)
```

For a $0 deployment of just the site and waitlist (Netlify + Supabase), see
`docs/DEPLOY_FREE.md`. The site's "Sign in" link only appears when `PAIRLOOM_APP_URL` is set.

To serve it, build with `PAIRLOOM_CONTACT_EMAIL=you@yourdomain npm run build` and set
`SITE_DIST_DIR=./apps/site/dist` next to `WEB_DIST_DIR`: the site is then served at `/`, the app at
`/app/`, and invite links (`/invite/<token>`) redirect into the app.

## Deploying privately (not yet done; see Thursday in PROJECT_PLAN.md)

- **Server:** `npm ci && npm run build`. Set `PUBLIC_ORIGIN=https://…`,
  `WEB_DIST_DIR=./apps/web/dist` and `OPEN_SIGNUP=false`. Run `npm start` behind
  TLS, with WebSocket upgrade enabled for `/ws`.
- **Worker:** a dedicated clone, `.env.worker` with the server URL, worker token
  and `GROQ_API_KEY`, and `PAIRLOOM_STATE_DIR` on a persistent volume. Run
  `npm run start -w @pairloom/worker` under a supervisor with automatic restart,
  as an unprivileged user in a container or VM that only contains the project.
- **Backups:** `data/pairloom.sqlite` and the worker state directory.
