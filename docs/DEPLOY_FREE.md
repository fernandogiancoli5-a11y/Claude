# Deploying the Pairloom site and waitlist for $0 (Netlify + Supabase)

This deploys **only the public site and its early-access waitlist**. The collaborative app is not
part of it (see the end). Nothing here has been deployed or tested on Netlify or Supabase yet:
the code is covered by mocked tests, the SQL by tests on a local PostgreSQL with Supabase's
roles emulated, and the full chain by a local browser test. Follow "Verify the deployment" before
telling anyone it works.

```
browser ──POST /api/waitlist──▶ Netlify function (netlify/functions/waitlist.mts)
                                     │ secret key, server-side only
                                     ▼
                         Supabase: public.join_waitlist(...)  (supabase/migrations/0001_waitlist.sql)
```

- The browser never talks to Supabase. The waitlist tables have Row Level Security on with no
  policies and no grants for the public roles, so Supabase's publishable key can do nothing.
- Validation and spam rules are shared with the Fastify server (`packages/shared/src/waitlist.ts`).
- Rate limit: 5 attempts per client per 10 minutes, keyed by a salted SHA-256 of the client IP.
  Hashes are deleted after one hour; raw IPs never reach the database.
- A failed database call is always reported to the visitor as an error, never as a signup.

## $0 rules

Both services have free plans that, per their pricing pages, do not charge:
Netlify Free is "$0/month, forever" with a hard 300-credit monthly limit and no auto-recharge;
Supabase Free has 2 projects, a 500 MB database and no automatic backups. **If either sign-up
asks for a card or nudges you to a paid plan, stop and choose the free option or don't continue.**
Do not add a custom domain (that costs money); use the free `*.netlify.app` address.

## 1. Supabase (database)

1. Create an account at supabase.com and a new project on the **Free** plan. Pick a region near
   your visitors and a strong database password (store it in a password manager; it is not used
   by Pairloom). **Leave the Data API enabled** (the function calls the database through it);
   the waitlist itself stays private because of the grants below, not because the API is off.
2. **SQL Editor → New query**: paste the whole of `supabase/migrations/0001_waitlist.sql` and
   **Run**. It is safe to run again.
3. Check: **Table Editor** shows `waitlist` and `waitlist_attempts`, both marked RLS enabled.
   The migration revokes the public roles' privileges and grants `service_role` explicitly, so it
   works whether or not your project still applies Supabase's older automatic grants (Supabase
   is moving to opt-in exposure).
4. **Project Settings → API Keys**: note the **Project URL** and create/copy a **secret key**
   (`sb_secret_…`). Treat the secret key like a password: it bypasses Row Level Security. Never
   paste it into the site, git, chat or tickets. (A legacy `service_role` key also works.)

## 2. Netlify (site + functions)

1. Create an account at netlify.com on the **Free** plan.
2. **Add new project → Import an existing project → GitHub**, choose the repository and the
   branch to publish. `netlify.toml` supplies the build command, publish directory, functions,
   Node version and security headers; leave those fields as detected.
3. Before the first deploy, **Project configuration → Environment variables → Add a variable**.
   On the Free plan variables can't be scoped (scopes are a Pro feature), so each one is
   available to both the build and the functions — which the functions need. Mark the secret
   ones **Contains secret values** if offered: Netlify then won't show them again and fails any
   deploy whose built files contain them. Do **not** put any of these in `netlify.toml`:
   variables declared there are not available to functions.

   | Variable | Value | Secret? |
   | --- | --- | --- |
   | `SUPABASE_URL` | Project URL from step 1.4, e.g. `https://abcd1234.supabase.co` | no |
   | `SUPABASE_SECRET_KEY` | secret key from step 1.4 | **yes** |
   | `WAITLIST_IP_SALT` | a random value, e.g. output of `openssl rand -hex 32` | **yes** |
   | `PAIRLOOM_CONTACT_EMAIL` | the address shown on the privacy page | no (but keep it out of git) |
   | `PAIRLOOM_APP_URL` | leave **unset** until the app is deployed somewhere; the Sign in link stays hidden | no |

   `PAIRLOOM_WAITLIST_BACKEND=supabase` is already set in `netlify.toml` (build-time only) so the
   privacy page describes this setup. Changing `WAITLIST_IP_SALT` later only resets current rate
   limits. Variable changes take effect on the **next deploy**.
4. **Deploy**. Each production deploy costs 15 of the 300 monthly credits, so avoid redeploying
   needlessly (with nothing else, that's at most 20 deploys a month).

## 3. Verify the deployment

Replace `SITE` with your `https://<name>.netlify.app` address.

1. Open `SITE`, `SITE/privacy.html` (contact address present; mentions salted hashes, one hour,
   Netlify and Supabase) and `SITE/does-not-exist` (404 page).
2. Sign up with a real address you control. You should see "You're on the list." In Supabase
   **Table Editor → waitlist**, exactly one row with the lowercased address.
3. Sign up again with different capitalisation: same success message, still one row.
4. Invalid address: inline error, no row.
5. Rate limit (from your terminal; 6th should be 429):
   ```bash
   for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "%{http_code}\n" -X POST "SITE/api/waitlist" \
     -H "content-type: application/json" -H "origin: SITE" \
     -d "{\"email\":\"ratetest$i@example.com\",\"elapsedMs\":4000}"; done
   ```
   Then delete the test rows (see "Deleting an entry").
6. Public key is locked out: with the **publishable** key (Project Settings → API Keys),
   ```bash
   curl -s "https://<ref>.supabase.co/rest/v1/waitlist?select=email" -H "apikey: <publishable key>"
   ```
   must return an error (permission denied), never rows.
7. **Netlify → Logs → Functions**: `waitlist` logs only `waitlist: joined` / `already` (never an
   address or IP). For `keepalive`, use **Run now** once and confirm `keepalive: ok`.
8. Security headers: `curl -sI SITE | grep -i content-security-policy` shows the policy, and the
   browser console shows no CSP errors on the home page.

Only after all of these pass is the waitlist live.

## Keeping it running

- **Pausing.** Supabase pauses free projects after about 7 days of "insufficient user database
  activity" and emails a warning roughly a week ahead. Its docs say API calls count as activity
  and that a few daily requests typically suffice, but they publish no exact threshold and don't
  say whether a single daily call made with the secret key is enough. While paused, signups **fail** (visitors see an error; nothing is
  lost silently, but those signups are not recorded). The daily `keepalive` function is a
  **mitigation, not a guarantee**: Supabase does not publish an exact activity threshold, and
  scheduled functions only run for published production deploys. If you get a pause warning,
  open the project dashboard (that counts as activity) and restore it if paused. Current Supabase
  docs say a paused project can be restored for up to 1 year (older docs said 90 days).
- **No backups on Free.** Export regularly (below) and keep the CSV somewhere private.
- **Credits.** Netlify Free is a hard 300 credits/month (bandwidth 20/GB, deploys 15 each,
  function compute 10/GB-hour, requests 2 per 10k). If credits run out, expect the site to be
  unavailable until the next cycle; you will not be charged.

## Known limits of this setup

- **Build-time exposure of secrets (Free plan).** Without scopes, `SUPABASE_SECRET_KEY` is also
  present during builds, where any npm install script of a dependency could read it. Keep
  dependencies minimal and the lockfile committed; rotate the key in Supabase if you suspect a
  leak (create a new secret key, update Netlify, redeploy, delete the old key).
- **Distributed spam.** The rate limit is per client (IPv4 address or IPv6 /64). Many different
  addresses can still add many fake signups; there is no global cap. The 500 MB database holds
  millions of rows, but watch the table for floods and delete them with SQL if needed.
- **Duplicates keep the first role.** Signing up again doesn't change a stored role.

## Data export and deletion

- **Export:** Supabase **SQL Editor**:
  ```sql
  select email, role, created_at from public.waitlist order by created_at;
  ```
  then **Export → CSV**. (Or Table Editor → `waitlist` → Export.)
- **Deleting an entry** (access/deletion requests, test rows):
  ```sql
  delete from public.waitlist where email = lower('person@example.com');
  ```
- **Removing rate-limit hashes immediately** (they expire after an hour anyway):
  `delete from public.waitlist_attempts;`

## Testing locally

- `npm test` — includes the function's mocked tests (`netlify/test`).
- `npm run test:sql` — applies the migration to a throwaway local PostgreSQL 15+ with Supabase's
  roles emulated and runs `supabase/tests/waitlist_test.sql`, including a concurrency check of
  the rate limit. Requires PostgreSQL binaries; it is not a test against Supabase itself.

## The collaborative app at $0

The app needs an always-on Node.js process with WebSockets and a persistent disk for SQLite;
agent workers and the model (Groq free tier) run on your own machine. Netlify and Supabase's free
plans do not provide that process. The options assessed so far: Render Free (no disk, sleeps,
wipes data — unsuitable), Northflank's free Sandbox (always on, volumes, no card per its pricing
page, but its docs say not for production; limits and WebSockets unverified — not implemented),
or your own computer behind a temporary Cloudflare Quick Tunnel (testing only). Until one of
these is deployed and verified, leave `PAIRLOOM_APP_URL` unset so the site doesn't link to an app
that isn't there.
