# Pairloom MVP plan (revised 27 Oct 2026)

**Deadline:** Friday 30 October 2026: a working, testable, privately deployable MVP.

**Revised constraints:**
- No Anthropic API key or paid Anthropic usage.
- Primary model provider: Groq (OpenAI as an alternative).
- Testing uses a disposable sample app we own (`samples/tiny-cart`), not Rogue.
- The target is still cloud-hosted sessions that keep running when browsers close.

## Goal

Two or more people join a shared project and supervise one AI coding agent.
Everyone sees its activity live. Collaborators propose instructions; the host
approves them and approves sensitive tool use. Anyone on the team can run the
project's tests, and the change is reviewed and merged. The agent runs on a
worker, not in anyone's browser.

## What stays (proven in the first slice)

Monorepo, Fastify server, SQLite, shared protocol, auth, roles, invitations,
event log with replay and dedupe, durable command queue, approvals, worktree
isolation, change sets, reviews, head-checked local merge, React session room,
simulator, browser smoke test. The Claude Agent SDK adapter remains as a legacy
opt-in; it is no longer the real path.

## What changed in this revision

- [x] Provider-neutral harness (`apps/worker/src/harness`): our own tool loop over
      OpenAI-compatible Chat Completions. Groq `openai/gpt-oss-120b` is the default.
- [x] Sandboxed tools:
  - project-root boundary (symlinks, `.git`);
  - argv-only commands with timeouts and process-group kill;
  - output caps;
  - command env with no secrets;
  - hard-denied commands;
  - approval for deletes and arbitrary commands.
- [x] Per-session limits: iterations, model calls, wall time, estimated cost.
      No hidden retries; typed provider errors.
- [x] Transcript persisted per step, so the owner can resume after a worker crash
      (same state volume).
- [x] Reviewer-run project tests (`run tests`), independent of what the agent claims.
- [x] Server heartbeats for half-open sockets; startup reconciliation; change-set dedupe.
- [x] Disposable sample app, `scripts/sample-repo.sh`, and a browser scenario covering
      start, stream, closed browser, collaborator instruction, approvals, tests,
      interrupt, worker kill, resume, review, merge.
- [ ] **Run against real Groq.** Needs `GROQ_API_KEY`. This is the top risk.
- [ ] Hosted deployment (server + worker with a persistent volume, supervisor, TLS).

## Daily milestones

| Day | Milestone | Exit check |
| - | - | - |
| **Tue 27** (done) | Provider research and decision; harness, sandbox, limits, recovery; sample app; mocked-provider tests and browser scenario | `npm run check` green (89 tests); `smoke:ui` and `agent-scenario.mjs` (mock) green |
| **Wed 28** | **Real-model validation.** Create a Groq key; check the org's actual limits page. Run `npm run test:real`, then `PROVIDER=groq node scripts/agent-scenario.mjs`. Tune the system prompt and tool descriptions to whatever gpt-oss-120b gets wrong. If it can't reliably finish the sample task, switch to `llama-3.3-70b-versatile` (same code) and re-run. If both fail, evaluate OpenAI. | Real model finishes the discount task, and Pairloom's own test run passes, ≥3 of 5 attempts; cost per task recorded |
| **Thu 29** | **Hosted deployment.** One small VM (or container host): server + worker under systemd (or containers) with `Restart=always`. Worker state and SQLite on persistent disk. Caddy TLS, `OPEN_SIGNUP=false`. Worker runs as an unprivileged user that can only reach the sample clone. Egress limited to the model API if the host allows. | Two people on different networks complete the scenario on the hosted URL. Closing both browsers doesn't stop the agent. `kill -9` of the worker gives "interrupted", then auto-restart, then Resume works. |
| **Fri 30** | **Hardening and demo.** Move transcripts into the server DB (cross-host resume) if time allows, otherwise document it as a limit. Per-project allowlist UI if approvals are noisy. Runbook, demo script, bug bash. | Acceptance criteria below all checked on the hosted instance |

## Acceptance criteria (Friday)

1. Owner A and collaborator B on different machines. B joined by invite.
2. A starts a **real** session (Groq) on the sample repo with the discount task.
   Both see live text, tool calls, and results.
3. A closes the browser mid-task; the agent continues. A returns and sees the full history.
4. B's instruction reaches the agent only after A approves. B can't approve tools or merge.
5. An arbitrary command or delete asks A; a denial means it does not run.
6. B clicks "run tests"; Pairloom runs `npm test` on the branch and shows pass/fail.
7. Interrupt stops the turn. It is reported as interrupted, never as success.
8. Killing the worker shows disconnected, then interrupted. Resume continues from
   the saved transcript. Nothing is marked successful that didn't finish.
9. An invalid or missing key, rate limiting, or a budget cap each produce a clear,
   specific error. There are no retry storms.
10. No secret appears in the browser, the activity log, or agent-run commands.

## Cost estimate (Groq `openai/gpt-oss-120b`: $0.15 in / $0.075 cached / $0.60 out per 1M tokens)

These are estimates, not measurements; the first real run will replace them.

| Scenario | Assumptions | Estimated cost |
| - | - | - |
| One short task (sample discount feature) | ~10 model calls; prompt grows from ~2k to ~8k tokens (≈50k input total); ≈5k output incl. reasoning | 50k×$0.15/M + 5k×$0.60/M ≈ **$0.011** |
| Small test session (5 tasks + error-path checks) | 5× the above, plus a few single-call failure tests | **≈ $0.06** |
| Worst case for one session at default caps | 80 calls × ~30k input + 1k output | ≈ $0.41, and the $0.50 per-session cap stops it before $0.50 + one call |
| Budget for Wed–Fri testing | ~50 tasks plus repeated scenarios | **≈ $1–$3** |

**Rate limits matter more than price.** The documented 8K TPM / 200K TPD (tier
unconfirmed) would allow only about one model call a minute and a handful of
tasks per day for a 5–8k-token agent context. If those are the Free-plan
numbers, a paid Developer plan is needed for usable testing. Check the console
limits page before Wednesday's run. The harness surfaces 429s with the
provider's message and stops rather than looping.

## Major risks

| Risk | Mitigation |
| - | - |
| gpt-oss-120b struggles with multi-step tool use (malformed calls, stopping early) | One corrective re-prompt for malformed calls; iteration and cost caps; independent test runs reveal false claims; fallback order: llama-3.3-70b on Groq → OpenAI |
| Free-tier TPM/TPD too low | Developer plan; context compaction; small sample repo |
| Worker crash loses the in-flight turn | Shown truthfully; Resume from transcript on the same volume; supervisor restarts the worker |
| App-level sandbox is not OS isolation | Approval for all arbitrary commands; hard-deny list; deploy the worker in a container/VM with only the project clone |
| SQLite and transcripts tied to one host | Fine for a private MVP; nightly backups; move transcripts to DB next |

## Explicitly deferred

- Billing.
- Multiple agents per session.
- Load-balancing workers.
- GitHub OAuth, pushing branches, and PRs.
- Password reset and 2FA.
- Per-tool allowlist UI.
- Inline diff comments.
- Notifications.
- Streaming token-by-token output; we stream per step.
- Cross-host transcript storage (unless done Friday).
- An OS-level sandbox per command.
- A second provider integration. OpenAI is configuration only until needed.
- Postgres.
- Landing page.
