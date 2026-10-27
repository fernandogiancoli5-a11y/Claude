#!/usr/bin/env bash
# Tests supabase/migrations/0001_waitlist.sql against a throwaway local PostgreSQL, with Supabase's
# roles (anon, authenticated, service_role with BYPASSRLS) emulated. Needs PostgreSQL 15+ binaries
# (initdb, pg_ctl, psql). This checks the SQL logic only; it is NOT a test against Supabase.
#
#   PG_BIN=/usr/lib/postgresql/16/bin scripts/test-supabase-sql.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /usr/lib/postgresql/16/bin/pg_ctl)")}"
port="${PG_TEST_PORT:-55433}"
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
dir="$(as_pg "mktemp -d /tmp/pairloom-sqltest-XXXX")"
cleanup() { as_pg "'$bin/pg_ctl' -D '$dir/data' -m immediate stop >/dev/null 2>&1 || true"; }
trap cleanup EXIT
as_pg "'$bin/initdb' -D '$dir/data' -A trust -U postgres >/dev/null"
as_pg "'$bin/pg_ctl' -D '$dir/data' -o \"-p $port -k $dir -c listen_addresses=\" -l '$dir/log' -w start >/dev/null"
psql_() { psql -h "$dir" -p "$port" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_ -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;"
psql_ -f "$root/supabase/migrations/0001_waitlist.sql"
PGOPTIONS="-c client_min_messages=warning" psql_ -f "$root/supabase/migrations/0001_waitlist.sql" # re-running must be safe
echo "ok - migration applies twice"
psql_ -f "$root/supabase/tests/waitlist_test.sql" 2>&1 | sed -n 's/^psql:.*NOTICE:  //p'

# Concurrency: 12 simultaneous attempts from one client must yield exactly 5 within the limit.
hash=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
for i in $(seq 1 12); do
  psql_ -At -c "set role service_role; select public.join_waitlist('race$i@example.com', null, '$hash');" &
done > "$dir/race.out"
wait
ok=$(grep -c joined "$dir/race.out" || true); limited=$(grep -c rate_limited "$dir/race.out" || true)
[ "$ok" = 5 ] && [ "$limited" = 7 ] || { echo "FAIL concurrency: $ok joined, $limited limited"; exit 1; }
echo "ok - 12 concurrent attempts: 5 joined, 7 rate-limited"
echo "SQL tests passed (local PostgreSQL $(psql -V | awk '{print $3}'), Supabase roles emulated)"
