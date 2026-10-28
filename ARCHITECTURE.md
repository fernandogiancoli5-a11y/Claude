# Pairloom architecture

Pairloom is a multiplayer workspace around an AI coding agent. Several people
watch the same agent session, propose instructions, approve tool use, run the
project's tests, and review the agent's code changes before they are merged.

```
 Browser (React)  ──HTTPS/WSS (cookie)──►  Collaboration server  ◄──WSS (worker token)──  Agent worker
  owner / collaborator / viewer            Fastify + SQLite                              Pairloom harness
                                           authz, event log,                             (tool loop) ──HTTPS──► Groq API
                                           command queue, realtime,                      git worktrees,
                                           heartbeats                                    sandboxed tools
```

The worker always dials **out** to the server. The same worker program runs in a
cloud container (target) or on someone's machine. The collaboration layer cannot
tell the difference and does not need to.

## 1. Components

| Component | Code | Responsibility |
| - | - | - |
| Browser app | `apps/web` | Auth, workspaces, projects, and the session room: activity feed, approvals, instruction composer, "run tests", diff review, merge. No secrets, no direct model calls. |
| Collaboration server | `apps/server` | REST API, cookie auth, server-side authorization, durable event log, durable worker command queue, realtime fan-out, WebSocket heartbeats, startup reconciliation. Serves the built web app. |
| Shared protocol | `packages/shared` | Zod schemas and types for both protocols, statuses, limits. |
| Agent worker | `apps/worker` | Runs sessions through an **adapter**, owns git worktrees, snapshots, test runs, and merges. |
| Sample project | `samples/tiny-cart` | Disposable, dependency-free app we own. `scripts/sample-repo.sh` turns it into a standalone git repo for demos and tests. |

## 2. Agent execution

### Decision (2026-10-27): our own harness over an OpenAI-compatible API, Groq primary

The MVP does not use the Anthropic API. The Claude Agent SDK / Claude Code CLI
can't be pointed at a Groq or OpenAI key, so we use approach **A**: a small tool
loop that Pairloom controls (`apps/worker/src/harness/`). It calls the Chat
Completions API with function tools and enforces every permission and limit
itself.

Evidence (official docs, checked 2026-10-27):

| | Groq `openai/gpt-oss-120b` (chosen) | OpenAI Codex SDK (approach B, rejected for Friday) |
| - | - | - |
| Interface | OpenAI-compatible Chat Completions at `https://api.groq.com/openai/v1`. Tool use via `tools` / `tool_calls`. "All models hosted on Groq support tool use." | `@openai/codex-sdk`, which bundles a Codex runtime. Approvals go through its app server. Per-command programmatic approval is not documented in the SDK page. |
| Model status | Production. 131,072 context, 65,536 max output. No parallel tool calls on gpt-oss (the harness is sequential anyway). | `gpt-5.3-codex` |
| Price (per 1M tokens) | $0.15 input / $0.075 cached / $0.60 output | $1.75 / $0.175 / $14.00 |
| Rate limits | Docs list 30 RPM / 1K RPD / 8K TPM / 200K TPD for gpt-oss-120b. **Could not confirm** whether that is the Free or Developer plan. Your org's real limits are on the console's limits page. 429 carries `retry-after`. | n/a |
| Fit | Thin, provider-neutral, approval-friendly, cheap | Strong agent, but OpenAI-only, heavier, and the approval integration is unproven for Friday |

Other Groq models also support tools. `llama-3.3-70b-versatile` is production.
`qwen/qwen3.8-27b` and `minimaxai/minimax-m2.7` are preview, and preview models
"may be discontinued at short notice". The model is configurable with `LLM_MODEL`.

**Not yet proven:** gpt-oss-120b on Groq has **not** been run against this
harness. No Groq key was available. Whether it reliably completes the sample
task through tool calling is the first thing to establish
(`npm run test:real`). If it doesn't, try `llama-3.3-70b-versatile` on Groq next
(same code, `LLM_MODEL`), then OpenAI (`LLM_PROVIDER=openai`, configuration only
today).

### Adapter boundary

```ts
interface AgentAdapter { info(): AdapterInfo; start(ctx: AgentContext): Promise<AgentRun> }
interface AgentRun     { send(text): void; interrupt(): Promise<void>; stop(): Promise<void> }
```

| Adapter | Kind | Status |
| - | - | - |
| `HarnessAdapter` (`harness/agent.ts`) over `OpenAICompatibleClient` (`harness/provider.ts`) | `llm-harness` | **Default real adapter** |
| `SimulatedAdapter` | `simulated` | Scripted; labelled SIMULATED everywhere; never calls a model |
| `ClaudeSdkAdapter` | `claude-agent-sdk` | Legacy opt-in (`PAIRLOOM_REAL_ADAPTER=claude-agent-sdk`). Not used by the MVP. |

Adding a provider means adding a preset (same wire format) or a new `ModelClient`
implementation. The tool loop, sandbox and limits are provider-agnostic.

### The harness loop

For each approved instruction:

1. Append it to the transcript.
2. Call the model with tools.
3. Stream any text.
4. Execute each tool call, after the permission check, and append the result.
5. Repeat until the model answers without tool calls (`end_turn`) or a limit or error stops it.

The transcript is written to `PAIRLOOM_STATE_DIR/transcripts/<session>.json`
after every step.

`end_turn` means the model stopped calling tools. It does **not** mean the task
succeeded. The UI labels it "unverified until tests and review", and records the
agent's last test exit code. A separate **run tests** button lets reviewers run
the project's configured test command themselves. That command comes from
`.pairloom.json` in the base clone, which the agent cannot edit.

### Tools and permissions

| Tool | Default permission |
| - | - |
| `list_files`, `search`, `read_file` | Automatic. Reading `.env*`, `*.pem`, `*.key`, ssh keys or `.npmrc` asks the host. |
| `write_file`, `edit_file` | Automatic under "accept edits in worktree"; ask under "ask every time" |
| `run_tests` (project's `testCommand`) | Same as edits |
| `delete_file` | **Always asks** |
| `run_command` (argv, no shell) | **Always asks**, unless the exact argv is allowlisted in `.pairloom.json` and the policy accepts edits |

Hard boundaries, regardless of approval:
- Paths resolve inside the session worktree. `..`, absolute paths outside it,
  symlink escapes, writes through symlinks, `.git`, and writes to `.pairloom.json`
  are refused.
- Hard-denied commands: `sudo su doas ssh scp sftp rsync nc ncat telnet curl wget
  shutdown reboot mkfs dd`. Also `git push/remote/checkout/switch/worktree/reset/
  rebase/merge/config/filter-branch/gc/clean`, and `rm` of `/` or `~`.
- Commands run with `shell: false` in their own process group. The whole group is
  killed on timeout (`AGENT_COMMAND_TIMEOUT_SECONDS`) or interrupt. Output is
  capped (32 KB tail).
- The command environment contains only `PATH`, a sandbox `HOME`, `LANG`, `CI=1`.
  **The model API key and the worker token are not visible to anything the agent
  runs.** (This improves on the legacy Claude adapter.) Tests verify it.

**Honest limitation:** this is application-level sandboxing, not OS isolation.
An approved command runs with the worker user's OS permissions. Production
workers must run in a container or VM that only has the project clone, a
persistent state volume, and egress to the model API. That deployment hardening
is not done yet.

### Cost and operational controls

* Limits per task/session: `AGENT_MAX_ITERATIONS_PER_TURN` (25),
  `AGENT_MAX_MODEL_CALLS_PER_SESSION` (80, retries included),
  `AGENT_MAX_TURN_SECONDS` (600), `AGENT_MAX_COST_USD_PER_SESSION` (0.50,
  estimated from reported token usage × published prices).
* No hidden retry loops. At most `LLM_MAX_RETRIES` (1) retry, only for
  429/5xx/network, only if `retry-after` ≤ `LLM_MAX_RETRY_WAIT_SEC` (20). Every
  retry is a counted, visible model call. Auth (401/403) and quota/billing errors
  are never retried. A malformed tool call (`tool_use_failed`) gets one
  corrective re-prompt.
* Every failure becomes a typed `agent.error` plus `agent.result{subtype:"error_provider_<kind>"}`
  with kinds `missing_credentials | auth | rate_limited | quota_or_billing |
  bad_request | tool_call_malformed | context_too_large | server | network |
  timeout | cancelled`. Messages name the env var, never the key.
* A worker without a key reports the real adapter as unavailable. The server
  refuses real sessions on it, and the UI disables the option and says why.
* A non-default `LLM_BASE_URL` is shown as "custom endpoint host:port", never as
  the named provider, and published prices are not applied to it.

## 3. Authentication and authorization

Unchanged from the first slice:
* Email + password (scrypt). Random session tokens stored as SHA-256, in an
  `httpOnly`, `SameSite=Lax` cookie.
* Per-project revocable worker tokens, stored hashed and shown once.
* Roles: owner / collaborator / viewer.
* Non-members get 404.
* Collaborator instructions need owner approval.
* Only owners approve tools, interrupt, stop, resume and merge.
* Collaborators and owners can run tests and review.
* Origin allowlist on mutating requests and WebSocket upgrades.
* Every realtime frame re-checks membership.

## 4. Repository isolation and review

* The worker owns a dedicated clone (`PAIRLOOM_REPO_PATH`). For the MVP that is
  the disposable sample repo.
* Each session gets its own git worktree and branch `pairloom/<id>`.
* At turn end the worker commits a checkpoint and uploads the diff (≤512 KB) as a
  change set. A re-sent snapshot with an unchanged head is ignored.
* Merge requires the owner, at least one standing approval, the latest change
  set, and an unchanged head. It aborts on conflicts. It is local only, **never
  pushed**.

## 5. Realtime and reliability

* Append-only per-session event log with monotonic `seq`. Every event is stamped
  with the session's execution mode (real or simulated).
* Worker → server: at-least-once delivery via a persisted outbox. The server
  dedupes by event UUID.
* Server → worker: persisted commands, resent until acked. The worker remembers
  outcomes, so a lost ack is answered without re-executing.
* Browsers resubscribe with `afterSeq` and dedupe by seq.
* **Heartbeats in both directions.** The worker pings every 15s and reconnects
  after 45s of silence. The server pings every socket every `WS_HEARTBEAT_MS`
  (20s) and terminates sockets that miss a pong. This catches half-open
  connections from dead VMs; before this, such a worker looked "online" forever.
* **Startup reconciliation.** On server start, sessions recorded as live become
  `disconnected` until their worker reconnects and reports them.

## 6. Cloud persistence: what is and isn't true today

| Property | Status | Evidence |
| - | - | - |
| Collaboration state (users, sessions, events, instructions, approvals, change sets) survives browser disconnects and server restarts | **Yes**, SQLite on disk | lifecycle tests; server restart reconciliation test |
| The agent keeps running when every browser closes | **Yes**, it runs in the worker process, not the browser | `agent-scenario.mjs` closes the owner's browser mid-task; the collaborator sees work continue |
| Collaborators reconnect and catch up | **Yes**: replay from `afterSeq` | realtime tests, scenario |
| A crashed or killed worker is reported truthfully | **Yes**: `disconnected` → `interrupted`, pending approvals expire, undelivered instructions fail visibly, no fabricated result | e2e-harness test, scenario (SIGKILL) |
| A running agent process survives a worker crash | **No.** The in-flight turn is lost (model call, half-run command, maybe half-edited files). | by design; documented in UI |
| Recovery after a worker crash | **Partial.** The owner clicks Resume. The worker reloads the saved transcript and worktree from its state volume and continues; the model is told the last turn was cut off. Only works if the **same state volume** is available (same host or a re-attached persistent disk). | e2e-harness and scenario resume steps |
| Cross-host recovery (worker comes back on a fresh machine) | **No.** Transcripts and worktrees are on the worker's disk. Next: put transcripts in the server DB and push branches to a remote. | — |
| Hosted deployment of server + worker | **Not done.** No container image or service definition has been built or run. The worker is a plain long-running Node process, so it can be run under systemd or in a container with a persistent volume. | — |
| Automatic restart of a crashed worker | **No.** Needs a supervisor (systemd `Restart=always`, container restart policy). | — |

## 7. Data model

SQLite (`node:sqlite`) with these tables: `users`, `auth_sessions`,
`workspaces`, `memberships`, `invitations`, `projects`, `workers` (adapters
report includes provider and model), `agent_sessions`, `session_events`,
`instructions`, `permission_requests`, `change_sets`, `reviews`,
`worker_commands`.

## 8. Test layers (kept separate on purpose)

| Layer | What it proves | How |
| - | - | - |
| Unit/integration (server) | authz, lifecycle, heartbeats, reconciliation, dedupe | `npm test` |
| Sandbox/tools | path boundary, permissions, command limits, env hygiene | `npm test` (`tools.test.ts`) |
| **Mocked provider** | harness loop, limits, every error class, interrupt, crash/resume, end-to-end product flow incl. the sample app's real tests | `npm test` (`harness.test.ts`, `e2e-harness.test.ts`), `node scripts/agent-scenario.mjs` (browser) |
| Simulator | collaboration flow without any model | `npm test` (`e2e.test.ts`), `npm run smoke:ui` |
| Legacy Claude SDK | the old adapter still works against a local stub | `npm test` (`claudeAdapter.test.ts`) |
| **Real provider** | a real model completes the sample task; a bad key fails correctly | `GROQ_API_KEY=… PAIRLOOM_REAL_PROVIDER_TEST=1 npm run test:real`; browser: `GROQ_API_KEY=… PROVIDER=groq node scripts/agent-scenario.mjs`. **Not run yet.** |

A mocked endpoint is not proof that a real model can do the work.
