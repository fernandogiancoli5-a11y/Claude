-- Pairloom early-access waitlist (Supabase / Postgres).
--
-- Run once in the Supabase SQL editor (or with `supabase db push`). Safe to re-run.
-- Access model: nothing here is reachable with the public (publishable/anon) key. Only the
-- Netlify function, holding the project's SECRET key (Postgres role `service_role`), may call
-- public.join_waitlist and public.keepalive. Keep the secret key out of browsers and git.
--
-- Mirrors packages/shared/src/waitlist.ts: roles list, 254-char limit, 5 attempts per client
-- per 10 minutes. Client identity is a salted HMAC-SHA256 computed by the function from the IP
-- (IPv6: its /64 prefix); the raw IP never reaches the database, and hashes are deleted after
-- one hour.

-- ------------------------------------------------------------------ tables

create table if not exists public.waitlist (
  id bigint generated always as identity primary key,
  email text not null
    check (char_length(email) between 3 and 254)
    check (email = lower(email))
    check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role text check (role in ('engineer', 'founder', 'product', 'student', 'other')),
  created_at timestamptz not null default now()
);
-- Case-insensitive uniqueness (emails are also stored lowercased).
create unique index if not exists waitlist_email_lower_key on public.waitlist (lower(email));

create table if not exists public.waitlist_attempts (
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz not null default now()
);
create index if not exists waitlist_attempts_hash_time on public.waitlist_attempts (ip_hash, attempted_at);
-- The one-hour retention delete runs on every call; without this it scans the whole table.
create index if not exists waitlist_attempts_time on public.waitlist_attempts (attempted_at);

-- Row Level Security with NO policies: the Data API cannot read or write these tables with the
-- publishable key. service_role bypasses RLS by design and is only used server-side.
alter table public.waitlist enable row level security;
alter table public.waitlist_attempts enable row level security;
revoke all on table public.waitlist, public.waitlist_attempts from public, anon, authenticated;
revoke all on sequence public.waitlist_id_seq from public, anon, authenticated;

-- ------------------------------------------------------------------ signup

-- Returns 'joined' | 'already' | 'rate_limited'. One transaction: the per-client advisory lock
-- serializes concurrent attempts from the same hash so the limit cannot be raced, and the insert
-- is idempotent for any letter case. Errors (bad input, constraint failures) raise, so the caller
-- can never mistake a failed insert for success.
create or replace function public.join_waitlist(p_email text, p_role text, p_ip_hash text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_recent integer;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid client hash' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pairloom-waitlist:' || p_ip_hash, 0));

  -- Retention: attempt hashes older than one hour are deleted on every call.
  delete from public.waitlist_attempts where attempted_at < now() - interval '1 hour';

  select count(*) into v_recent
  from public.waitlist_attempts
  where ip_hash = p_ip_hash and attempted_at > now() - interval '10 minutes';
  if v_recent >= 5 then
    return 'rate_limited';
  end if;

  insert into public.waitlist_attempts (ip_hash) values (p_ip_hash);

  insert into public.waitlist (email, role)
  values (v_email, nullif(p_role, ''))
  on conflict ((lower(email))) do nothing;

  if found then
    return 'joined';
  end if;
  return 'already';
end;
$$;

-- Tiny query used by the scheduled keep-alive so a quiet waitlist still shows database activity.
create or replace function public.keepalive()
returns integer
language sql
security invoker
set search_path = ''
as $$
  select count(*)::integer from public.waitlist where false;
$$;

revoke all on function public.join_waitlist(text, text, text) from public, anon, authenticated;
revoke all on function public.keepalive() from public, anon, authenticated;
grant execute on function public.join_waitlist(text, text, text) to service_role;
grant execute on function public.keepalive() to service_role;
grant select, insert on table public.waitlist to service_role;
grant select, insert, delete on table public.waitlist_attempts to service_role;
grant usage on sequence public.waitlist_id_seq to service_role;
