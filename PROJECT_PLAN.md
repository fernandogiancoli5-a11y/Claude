# Pairloom MVP plan

**Deadline:** Friday 30 October 2026, a working, privately deployable MVP.
**First real project:** Rogue.
**Today:** Tuesday 27 October 2026.

## Goal

Two or more people join a shared software project, collaborate around a Claude
Code agent, see its activity live, contribute instructions under controlled
permissions, and review the agent's code changes before they are merged. Agent
sessions should keep running after collaborators close their browsers.

## Architecture in one paragraph

A Fastify + SQLite **collaboration server** owns users, workspaces, roles,
sessions, a durable event log and a durable command queue, and fans events out
over WebSockets. An **agent worker** dials out to the server and runs sessions
through the **Claude Agent SDK** (the officially supported way to drive Claude
Code programmatically), each in its own git worktree. A React **web app** is the
shared room. Real and simulated execution share the whole collaboration path, and
every record is stamped with which one it was. See `ARCHITECTURE.md` for details
and evidence.

## MVP scope (in)

- [x] Email/password accounts, cookie sessions, closeable signup
- [x] Workspaces, owner/collaborator/viewer roles, single-use expiring invite links, member removal
- [x] Projects with base branch; worker registration with one-time tokens; revocation
- [x] Agent sessions: status, timestamps, host, worker, mode, policy, provider session id, branch
- [x] Persistent shared activity log; realtime replay-after-seq; dedupe
- [x] Collaborator instructions → owner approval → delivered to the live agent
- [x] Tool permission requests → owner allow/deny from the browser
- [x] Interrupt, stop, resume; worker online/offline; disconnected vs interrupted
- [x] Isolated worktree per session; per-turn checkpoint commits; diff review; approvals; head-checked local merge
- [x] Real adapter (Claude Agent SDK) and clearly labelled simulated adapter
- [x] Automated tests: authorization, lifecycle, worker protocol, git isolation, real SDK/CLI path, two-person e2e, browser smoke
- [ ] Real-model run against Rogue (needs an API key on the worker)
- [ ] Private deployment on one VM (server + cloud worker), HTTPS
- [ ] Transcript durability across worker hosts (`SessionStore`)

## Daily milestones

| Day | Milestone | Exit check |
| - | - | - |
| **Tue 27** (done) | Research. Stack. Server, worker, web, tests. Simulated and stubbed-real e2e. | `npm run check` green (45 tests); `scripts/ui-smoke.mjs` green |
| **Wed 28** | **Real-model run.** Put an API key on a worker with a dedicated Rogue clone. Run real two-person sessions on Rogue. Record failure modes (long tool runs, large diffs, interrupt during tool, resume). Fix what breaks. Add the `rogue` bootstrap doc. | A real session on Rogue produces a reviewed, merged change; transcript of the run saved |
| **Thu 29** | **Private deployment.** VM with Caddy/TLS, server + cloud worker as systemd services (or the Dockerfiles after verifying them). `OPEN_SIGNUP=false`. Backups of the SQLite file and the worker state dir. Server-side WebSocket pings. Expire stale pending permissions. | Two people on different networks complete the flow on the deployed URL; closing both browsers does not stop the agent |
| **Fri 30** | **Hardening and demo.** `SessionStore` adapter (SQLite/file) if time allows, else document it as a known limit. Push a merged branch to the remote via an explicit owner action (optional). Runbook and demo script. Bug bash with the Rogue team. | Acceptance criteria below all checked on the deployed instance |

## Acceptance criteria (Friday)

1. Owner A and collaborator B, on different machines, sign in to the deployed app; B joined via an invite link.
2. A starts a **real** session on Rogue. Both see the same live activity (assistant text, tool calls, results, status).
3. B proposes an instruction. It reaches the agent only after A approves. B cannot approve tools or merge.
4. The agent asks to run a command. A approves or denies in the browser; a denied command does not run.
5. The agent's edits appear as a real git diff on an isolated branch. B approves, A merges, and the merge commit exists on the worker clone (not pushed).
6. A and B both close their browsers. The agent keeps running on the cloud worker. On return, the activity log shows everything that happened.
7. Killing the worker shows "disconnected" then "interrupted". Nothing is reported as succeeded unless the provider's result says so.
8. A simulated session is unmistakably labelled as simulated everywhere it appears.
9. No secret (API key, worker token, cookie token) is ever visible in the browser or in collaborators' API responses.

## Major risks

| Risk | Impact | Mitigation |
| - | - | - |
| **No API key / account access by Wed** | No real-model demo | Truthful simulated mode keeps everything else demonstrable; the real SDK path is already proven against the real CLI with a protocol stub. Get a Console API key (or Bedrock/Vertex) today. |
| claude.ai subscription auth is not allowed for third-party products | Cannot reuse Pro/Max plans | Use API key billing; set `CLAUDE_MAX_BUDGET_USD` and `CLAUDE_MAX_TURNS` per worker |
| Agent asks for many approvals (Bash) | Host fatigue | Default policy auto-accepts edits inside the worktree; next: allow read-only/test commands via scoped allow rules per project |
| Worker restart loses live agents | Sessions interrupted | Shown truthfully; same-host resume; `SessionStore` for cross-host |
| Single SQLite file / single node | Limited scale, single point of failure | Fine for a private MVP; nightly backups; Postgres migration contained in 3 files |
| Merge conflicts with Rogue's main | Merge fails | Reported as `merge.failed` with git output; agent can rebase in a new turn (manual) |
| `node:sqlite` is experimental in Node 22 | API churn | Pinned Node major; tiny surface (`prepare/run/get/all/exec`) |
| Large repos / long tool output | Big payloads | Diff cap 512 KB, tool payload cap 4 KB/event, text cap 20 KB |

## Explicitly deferred

Billing; multiple concurrent agents per session; multiple workers load-balancing a
project; GitHub OAuth and PR creation; pushing branches; password reset/2FA;
fine-grained per-tool allowlists in the UI; comments on diff lines; notifications
(email/Slack); Managed Agents adapter; `SessionStore` cross-host transcripts (if
not done Friday); Postgres; horizontal scaling; analytics; enterprise SSO/audit
exports; landing page.
