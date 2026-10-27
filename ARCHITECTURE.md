# Pairloom architecture

Pairloom is a multiplayer workspace around a Claude coding agent. Several people
watch the same agent session, propose instructions, approve tool use, and review
the agent's code changes before they are merged.

```
 Browser (React)  ──HTTPS/WSS (cookie)──►  Collaboration server  ◄──WSS (worker token)──  Agent worker
  owner / collaborator / viewer            Fastify + SQLite                              Claude Agent SDK
                                           authz, event log,                             + Claude Code CLI
                                           command queue, realtime                       git worktrees
```

The worker always dials **out** to the server. The same worker program runs in a
cloud container (target) or on a teammate's machine (local companion). The
collaboration layer cannot tell the difference and does not need to.

## 1. Components

| Component | Code | Responsibility |
| - | - | - |
| Browser app | `apps/web` | React SPA. Auth screens, workspace and project management, the session room (activity feed, approvals, instruction composer, diff review, merge). It has no secrets and makes no direct agent calls. |
| Collaboration server | `apps/server` | REST API, cookie auth, server-side authorization for every operation, the durable session event log, the durable worker command queue, and realtime fan-out to browsers and workers. Also serves the built web app. |
| Shared protocol | `packages/shared` | Zod schemas and types for the worker↔server and browser↔server protocols, statuses, limits. |
| Agent worker | `apps/worker` | Connects to the server with a worker token and runs agent sessions through an **adapter**: `ClaudeSdkAdapter` (real) or `SimulatedAdapter` (scripted). Owns git worktrees, snapshots, and merges. |

## 2. Agent execution adapter (the critical decision)

### What the official interface supports (verified 2026-10-27)

Sources: the Agent SDK overview, TypeScript reference, permissions, user input,
sessions and hosting pages at `code.claude.com/docs/en/agent-sdk/*`, the Managed
Agents docs at `platform.claude.com/docs/en/managed-agents/*`, and the
type definitions shipped in `@anthropic-ai/claude-agent-sdk@0.3.311`.

| Need | Supported mechanism | Status |
| - | - | - |
| Launch Claude Code programmatically | `query({ prompt, options })` spawns the bundled `claude` CLI (2.1.311) as a subprocess. | **Proven here.** Tests run the real SDK and CLI. |
| Feed instructions from remote people into a live session | Streaming input mode: `prompt` is an `AsyncIterable<SDKUserMessage>`. We push one message per approved instruction. | **Proven** (two-turn e2e test). |
| Observe activity | `SDKMessage` stream: `system/init` (session id, model, CLI version), `assistant` (text and tool_use blocks), `user` (tool_result), `result` (`success` / `error_*`, cost, turns), `system/api_retry`. | **Proven.** |
| Human tool approval from a browser | `canUseTool(toolName, input, {signal, title, …})` → `{behavior:'allow'|'deny'}`. Docs: "The callback can stay pending indefinitely." | **Proven**: an allowed Bash call runs; a denied one does not. |
| Interrupt / stop | `Query.interrupt()` (streaming mode only), `Query.close()`, `abortController`. | Interrupt is used for credential failures (tested). Host-initiated interrupt against a real model is untested. |
| Resume after restart | `options.resume = <session_id>`. Transcripts are on worker disk (`CLAUDE_CONFIG_DIR/projects`). `SessionStore` mirrors transcripts to shared storage for cross-host resume. | Same-host resume is wired, not yet exercised against a real model. `SessionStore` is **not** implemented yet. |
| Authentication | `ANTHROPIC_API_KEY`, Amazon Bedrock, or Google Vertex. "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." | **Provider-dependent.** Pairloom only uses API key / Bedrock / Vertex. Subscription login is not used. |
| Anthropic-hosted alternative | **Managed Agents** (beta header `managed-agents-2026-04-01`): server-side sessions with persisted event history, SSE streaming, `user.message` steering, `user.interrupt`, tool confirmations, cloud or self-hosted sandboxes. | **Requires an experiment.** It is a different harness from Claude Code (no CLAUDE.md/skills parity guaranteed). Candidate future adapter. |

Two behaviours found by running the real CLI shaped the code:

1. On HTTP 401 the CLI emits `system/api_retry` and retries **10 times with backoff
   (~2+ minutes)** before giving up. The adapter surfaces every retry as a
   visible notice, and on a repeated 401/403 it reports "credential rejected" and
   interrupts, rather than appearing to "work" for minutes.
2. `bypassPermissions` cannot run as root outside a recognised sandbox, and allow
   rules silently bypass `canUseTool`. So we never use `bypassPermissions`. Bash
   always reaches the host.

### Options compared

| | Cloud-hosted isolated worker | Local companion | **Hybrid (chosen)** |
| - | - | - | - |
| Survives browsers closing | Yes | Only while the laptop is awake | Yes when the worker is in the cloud |
| Friday feasibility | Needs a VM/container plus a dedicated repo clone and API key: hours, not days | Works today on any machine with git and Node | Same binary for both, so Friday can ship with either |
| Repo access | Deploy key / token in the container | User's existing checkout (we require a dedicated clone) | Either |
| Credentials | Org API key in the container | Teammate's own key | Per worker |
| Risk | Infra setup, secrets handling | Contradicts the long-term "no awake laptop" goal | Must keep the protocol host-agnostic (it is) |

**Recommendation.** One worker program and one protocol, deployed first as a
**cloud worker** on the same private VM as the server, with a dedicated clone of
Rogue and an org API key. The agent then keeps running when every browser closes.
That is the persistence target, and it costs only a long-running process. The
same worker can run as a local companion when someone wants the agent on their
own machine. Managed Agents is the candidate next adapter if we want Anthropic to
host the sandbox. It stays out of the Friday path because it is a beta API
and a different harness.

### Adapter boundary

```ts
interface AgentAdapter { info(): AdapterInfo; start(ctx: AgentContext): Promise<AgentRun> }
interface AgentRun     { send(text): void; interrupt(): Promise<void>; stop(): Promise<void> }
// ctx: emit(event), requestPermission(ask) → allow|deny, onTurnStart/End, onExit, onProviderSession
```

The worker reports each adapter's availability (for example "no ANTHROPIC_API_KEY
on worker"). The server refuses to create a real session on a worker whose real
adapter is unavailable. The UI disables that option and says why.

## 3. Authentication

* Email + password (scrypt, 16-byte salt). Sessions are random 256-bit tokens in
  an `httpOnly`, `SameSite=Lax` cookie (`Secure` when served over HTTPS). Only the
  SHA-256 of a token is stored. Expired sessions are deleted on use.
* Signup can be closed (`OPEN_SIGNUP=false`) so only invite holders can register.
* Worker auth: a per-worker bearer token (`plw_…`), shown once and stored as a
  SHA-256 hash. It is bound to one project and can be revoked, which disconnects
  the worker.
* Deferred: GitHub OAuth, password reset, 2FA.

## 4. Authorization (server-side, every request)

Roles per workspace: **owner**, **collaborator**, **viewer**.

| Action | viewer | collaborator | owner |
| - | - | - | - |
| Read workspace, project, session, events, diff | ✓ | ✓ | ✓ |
| Propose an instruction | | ✓ (pending until an owner approves) | ✓ (delivered immediately) |
| Review a change set | | ✓ | ✓ |
| Approve/deny tool use, approve/reject instructions | | | ✓ |
| Start/stop/interrupt/resume sessions, register workers | | | ✓ |
| Invite, remove members, create projects | | | ✓ |
| Merge (requires ≥1 standing approval, latest change set, explicit confirmation if simulated) | | | ✓ |

Rules:
* Non-members get **404**, never 403, so ids don't leak existence.
* Insufficient role gets 403.
* Workers can only append agent/worker event types, and only to sessions assigned
  to them. They cannot author instructions, approvals, or reviews.
* Realtime frames re-check membership on every send. Removing a member stops
  their stream immediately.
* `Origin` allowlist on mutating HTTP requests and on browser WebSocket upgrades
  (CSRF and cross-site WebSocket hijacking).

Collaborators never get a terminal. The only path from a person to the agent is
an approved instruction (text, ≤8000 chars, 20 per minute per user). The only
path to a side effect is a tool call the agent proposes and an owner approves
(or that the session policy auto-approves: file edits inside the worktree).

## 5. Repository access and change isolation

* The worker owns a **dedicated clone** (`PAIRLOOM_REPO_PATH`). It must not be
  anyone's day-to-day working copy.
* Each session gets its own `git worktree` on branch `pairloom/<id>`, created from
  the base branch. Agents never share a working directory.
* At the end of each turn the worker commits everything in the worktree
  ("checkpoint") and uploads `git diff base..head` (≤512 KB) and numstat as a
  **change set**. Older open change sets are marked superseded.
* Merge is a separate command. The worker refuses it when:
  - the branch head differs from the reviewed `headCommit`;
  - the clone is dirty;
  - the agent is mid-turn.
  It merges with `--no-ff` locally and aborts on conflicts. **Nothing is ever
  pushed**; pushing and opening PRs is a deferred, explicit feature.
* Agent deny rules: `git push/remote/checkout/switch/worktree/reset --hard/merge/rebase`
  and `sudo`. Pattern rules are best-effort, which is why Bash always needs host
  approval.
* Agent subprocess env is an **allowlist** (PATH, HOME, proxy/CA vars, model
  credentials). The worker token and other host secrets never reach the agent's
  shell. Note that the model API key is visible to the agent's shell. Hardening:
  route the model through a key-injecting proxy (`ANTHROPIC_BASE_URL`), as the
  hosting docs recommend.

## 6. Realtime events and reliability

* **Event log.** Every session has an append-only log with a per-session
  monotonically increasing `seq`. Each event is stamped with the session's
  `executionMode`, so simulated activity can never be presented as real.
* **Worker → server.** At-least-once delivery. The worker generates a UUID per
  event, keeps unacked events in a persisted outbox, and resends after reconnect.
  The server stores `event_uid` under a UNIQUE constraint, drops duplicates, and
  acks.
* **Server → worker.** Commands (start, message, permission decision, interrupt,
  stop, refresh, merge) are persisted with UUIDs and resent until acked. The
  worker remembers processed command ids and outcomes, so a lost ack is answered
  with the original result instead of re-executing. Commands for one session run
  strictly in order.
* **Browser.** `subscribe_session{afterSeq}` replays history and then streams
  live. On reconnect the client resubscribes from its last seq and dedupes by seq.
* **Heartbeats.** The worker pings every 15s and reconnects after 45s of silence,
  with exponential backoff to 30s.

## 7. Session lifecycle and persistence

`pending → starting → idle ⇄ running ⇄ awaiting_approval → stopping → stopped`,
plus `disconnected`, `interrupted`, `completed`, `failed`.

* Worker socket drops → live sessions become **disconnected**. The agent may still
  be running, and the UI says so.
* Worker reconnects and reports the session live → its real status is restored.
* Worker reconnects **without** the session (process restarted) → **interrupted**.
  Pending approvals expire and undelivered commands fail visibly. The UI states
  that the live agent was lost, and that a stored transcript is history, not a
  live agent.
* **Resume** (owner) sends a new `start` with `resume: <provider session id>` in the
  same worktree. That works only if that worker still has the transcript on disk.
  Cross-host resume needs `SessionStore` (next step).
* A worker can never revive a session the server has already ended.
* "Success" is shown only as the provider's own `result.subtype` / `is_error`.
  Change sets come from real `git diff` output, never from the agent's
  description.

## 8. Data model (SQLite, `apps/server/src/db.ts`)

`users`, `auth_sessions`, `workspaces`, `memberships`, `invitations` (hashed,
single-use, expiring, revocable), `projects`, `workers` (hashed token, last
adapters report, revocation), `agent_sessions` (status, mode, policy, host, worker,
provider session id, branch, timestamps, error), `session_events`, `instructions`,
`permission_requests`, `change_sets`, `reviews`, `worker_commands`.

SQLite uses Node's built-in `node:sqlite`, so there are no native build steps.
That suits a single-node private deployment. All SQL lives in `core.ts`, `auth.ts`
and `db.ts`, which contains a later move to Postgres.

## 9. Security boundaries (summary)

| Boundary | Enforcement |
| - | - |
| Browser ↔ server | Cookie session, Origin allowlist, zod validation, body limit 1 MB, role checks in `Core` |
| Server ↔ worker | Per-project revocable worker token; worker scoped to its own sessions and event types |
| Worker ↔ agent | Allowlisted env, isolated worktree, `acceptEdits` limited to the worktree, deny rules, host approval for everything else, `maxTurns`/`maxBudgetUsd` caps |
| Agent ↔ repository | Branch per session; merge only after review, head-checked, local, never pushed |
| Secrets | Never sent to the browser; worker tokens shown once; model keys only in the worker env |
