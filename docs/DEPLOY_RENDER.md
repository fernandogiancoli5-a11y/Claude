# Deploying Pairloom on Render

`render.yaml` defines one Render web service that serves everything from a single origin:

| Path              | What                                                 |
| ----------------- | ---------------------------------------------------- |
| `/`               | Public site and early-access waitlist (`apps/site`)  |
| `/app/`           | The Pairloom web app (`apps/web`)                    |
| `/api/*`          | API, including `POST /api/waitlist`                  |
| `/ws`, `/ws/worker` | WebSockets for browsers and agent workers          |
| `/invite/<token>` | Redirects into the app                               |

All data (accounts, teams, tasks, waitlist) is in one SQLite file on a Render persistent disk.
Agent **workers do not run on Render**; they run next to a clone of the repository (a teammate's
machine or your own server) and dial out to the service over `wss://`.

## Before you start

- **A paid instance is required.** Render free instances cannot attach a persistent disk and
  their filesystem is wiped on every restart and spin-down, which would erase all data.
- **Choose a contact address** for the privacy page (access/deletion requests). It is entered
  privately in the Dashboard, never committed.
- The Blueprint uses the repository's default branch unless you pick another when creating it.
  Commit and push the deployment files first (`render.yaml`, `.node-version`, this file).

## Setup (one time)

1. Render Dashboard → **New → Blueprint** → connect the GitHub repository → select the branch.
2. Render reads `render.yaml` and asks for the two `sync: false` values:
   - `PUBLIC_ORIGIN`: the exact URL people will open, with no trailing slash. For the default
     domain this is `https://<service-name>.onrender.com` (the service is named `pairloom`; if
     that subdomain is taken Render adds a suffix, so check the URL shown on the service page and
     correct this value if needed). Use your custom domain here if you add one.
   - `PAIRLOOM_CONTACT_EMAIL`: your contact address. It is read **at build time**.
3. Review the plan (0.5 CPU / 512 MB) and the 1 GB disk, then create. Nothing is billed until you
   confirm this step.
4. `autoDeployTrigger` is `off`: start the first deploy with **Manual Deploy → Deploy latest
   commit**. Watch the log for `npm ci`, both Vite builds, then the server starting.
5. Open `https://…/api/health` (`{"ok":true}`), `/`, `/privacy.html` and `/app/`.
6. Create the first owner account at `/app/` (sign-up is open at this point).
7. **Close sign-up:** set `OPEN_SIGNUP=false` in the service's Environment tab and save (this
   restarts the service). From then on, new accounts need an invite link; the waitlist is
   unaffected. Leaving it `true` lets anyone on the internet create an account.
8. Optional: add a custom domain, then update `PUBLIC_ORIGIN` to it and redeploy.
9. Connect a worker from any machine with a clone of the repo:
   `PAIRLOOM_SERVER_URL=https://<your origin>` plus the token from **Project → Workers →
   Register worker** (see the main README). The worker converts the URL to `wss://`.

## Environment variables

| Variable                 | Value on Render                       | Why                                                                   |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------- |
| `NODE_VERSION`           | `22.22.0` (also `.node-version`)      | Needs ≥ 22.13 for `node:sqlite`; pinned so Render doesn't pick the newest major |
| `PORT`                   | `10000`                               | Render's default routed port                                          |
| `HOST`                   | `0.0.0.0`                             | Required by Render; the server's default is `127.0.0.1`               |
| `PUBLIC_ORIGIN`          | **set privately** (`https://…`)       | Invite links, Secure cookies, Origin check for API and WebSockets     |
| `DATABASE_PATH`          | `/var/data/pairloom.sqlite`           | On the disk mounted at `/var/data`; anywhere else is wiped on deploy  |
| `WEB_DIST_DIR`           | `./apps/web/dist`                     | Built app                                                             |
| `SITE_DIST_DIR`          | `./apps/site/dist`                    | Built site; also moves the app to `/app/`                             |
| `TRUST_PROXY`            | `true`                                | Client IPs come from Render's proxy headers (rate limiting)           |
| `OPEN_SIGNUP`            | `true`, then `false` after step 6     | Invite-only accounts once the owner exists                            |
| `PAIRLOOM_CONTACT_EMAIL` | **set privately**                     | Privacy page contact; build time                                      |
| `LOG_LEVEL`              | `info`                                |                                                                       |

Render sets `NODE_ENV=production` at runtime only, so the build still installs the dev
dependencies it needs (`tsx`, `vite`, `typescript`).

**Setting a private value later:** service → **Environment** → edit → **Save, rebuild and
deploy** (for `PAIRLOOM_CONTACT_EMAIL`, which is baked into the site at build) or **Save and
deploy** (runtime values). Values entered there are stored by Render, not in git. Never put real
values in `render.yaml`, `.env.example` or commits.

## Operating it

- **Waitlist export:** service → **Shell**:
  `node scripts/waitlist-export.mjs /var/data/pairloom.sqlite > /tmp/waitlist.csv`, then copy
  it out (or just print it). The list is never exposed over HTTP.
- **Backups:** Render snapshots the disk daily and keeps snapshots for 7 days, but restoring
  rolls back the whole disk and Render warns that database files restored from a snapshot can be
  inconsistent. Take your own consistent copy from the Shell with
  `sqlite3 /var/data/pairloom.sqlite ".backup /var/data/backup.sqlite"` (if the `sqlite3` CLI is
  available) or the Node equivalent, and download it regularly.
- **Deleting a waitlist entry:** in the Shell,
  `node -e 'const{DatabaseSync}=require("node:sqlite");new DatabaseSync("/var/data/pairloom.sqlite").prepare("DELETE FROM waitlist WHERE email=?").run(process.argv[1])' person@example.com`.

## What to expect and what can break

- **Short downtime on every deploy.** With a disk, Render stops the old instance before starting
  the new one (no zero-downtime deploys), so each deploy is unavailable for a few seconds. Open
  browser and worker WebSockets drop and reconnect; the UI shows "reconnecting…".
- **Live agent turns are lost on deploy only if they run on the server** — they don't: agents run
  on workers. A worker that loses its connection keeps its agent running and resyncs; sessions it
  reports lost become "interrupted" and can be resumed.
- **Single instance.** A disk cannot be shared, so the service cannot scale out. SQLite is
  single-writer anyway; scaling beyond one instance would need a different database.
- **Migrations run automatically at startup**, inside a transaction, forward-only. A failed
  migration rolls back and the new instance never becomes healthy. Because a disk means the old
  instance is stopped first, the site is down until you fix it or roll back to the previous
  deploy from the Dashboard — check the deploy log. Rolling back to older code after a migration is safe for the current schema
  (older code ignores newer tables), but take a backup before deploys that change the schema.
- **Client IP for rate limiting.** `TRUST_PROXY=true` makes the server use the first
  `X-Forwarded-For` entry. Render staff state that entry is the real client IP; community reports
  say client-supplied values are not stripped. After deploying, check that the waitlist limit
  (5 attempts per 10 minutes per IP) applies to you and cannot be bypassed by sending your own
  `X-Forwarded-For`. If it can, the honeypot and timing checks still apply; tell me and the server
  can be changed to use a fixed proxy hop count instead.
- **`PUBLIC_ORIGIN` must match exactly.** A mismatch (http vs https, trailing slash, the wrong
  subdomain) makes every sign-in, API write and WebSocket fail with "Origin not allowed".
- **Free instance by mistake** = data loss on every restart. Keep the paid plan.
- **Shutdown.** The start command runs Node directly so Render's SIGTERM reaches the server; it
  closes sockets and exits within milliseconds, well inside the 30 s limit (not adjustable with a
  disk). `npm start` would not pass the signal on.
