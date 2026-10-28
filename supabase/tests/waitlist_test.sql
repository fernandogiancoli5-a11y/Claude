-- Tests for migrations/0001_waitlist.sql on plain PostgreSQL with Supabase's roles emulated.
-- Run with scripts/test-supabase-sql.sh. Passing here does not prove behavior on Supabase itself.
\set ON_ERROR_STOP on
\set h1 '''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''
\set h2 '''bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'''
\set h3 '''cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'''

create or replace function pg_temp.expect(actual text, expected text, label text) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL %: expected %, got %', label, expected, actual;
  end if;
  raise notice 'ok - %', label;
end $$;

create or replace function pg_temp.expect_error(stmt text, label text) returns void
language plpgsql as $$
begin
  execute stmt;
  raise exception 'FAIL %: expected an error', label;
exception when others then
  if sqlerrm like 'FAIL %' then raise; end if;
  raise notice 'ok - % (%)', label, sqlerrm;
end $$;

-- As the server-side role (what the Netlify function's secret key maps to).
set role service_role;
select pg_temp.expect(public.join_waitlist('  Ada@Example.com ', 'engineer', :h1), 'joined', 'new address joins');
select pg_temp.expect(public.join_waitlist('ada@EXAMPLE.com', null, :h2), 'already', 'same address, other case: already');
select pg_temp.expect((select count(*)::text from public.waitlist), '1', 'stored once');
select pg_temp.expect((select email || '/' || role from public.waitlist), 'ada@example.com/engineer', 'stored lowercased with role');
select pg_temp.expect(public.join_waitlist('grace@example.org', '', :h2), 'joined', 'empty role is stored as null');
select pg_temp.expect((select coalesce(role, 'null') from public.waitlist where email = 'grace@example.org'), 'null', 'role null');

select pg_temp.expect_error($q$select public.join_waitlist('not-an-email', null, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')$q$, 'invalid email rejected');
select pg_temp.expect_error($q$select public.join_waitlist('x@example.com', 'admin', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')$q$, 'unknown role rejected');
select pg_temp.expect_error($q$select public.join_waitlist(repeat('a', 250) || '@x.io', null, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')$q$, 'over 254 chars rejected');
select pg_temp.expect_error($q$select public.join_waitlist('x@example.com', null, '10.0.0.1')$q$, 'raw IP instead of hash rejected');
select pg_temp.expect((select count(*)::text from public.waitlist where email = 'x@example.com'), '0', 'nothing stored by failed calls');

-- Rate limit: 5 attempts per hash per 10 minutes (h3 has made none that succeeded in recording).
select pg_temp.expect(public.join_waitlist('r' || n || '@example.com', null, :h3), 'joined', 'attempt ' || n || ' within limit')
from generate_series(1, 5) as n;
select pg_temp.expect(public.join_waitlist('r6@example.com', null, :h3), 'rate_limited', '6th attempt rate-limited');
select pg_temp.expect((select count(*)::text from public.waitlist where email = 'r6@example.com'), '0', 'rate-limited signup not stored');
select pg_temp.expect(public.join_waitlist('other@example.com', null, :h1), 'joined', 'other client unaffected');
select pg_temp.expect(public.keepalive()::text, '0', 'keepalive callable by service_role');
reset role;

-- Retention: attempt hashes older than an hour are deleted on the next call.
insert into public.waitlist_attempts (ip_hash, attempted_at)
values ('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', now() - interval '61 minutes');
set role service_role;
select public.join_waitlist('late@example.com', null, :h2);
reset role;
select pg_temp.expect((select count(*)::text from public.waitlist_attempts where attempted_at < now() - interval '1 hour'), '0', 'hashes older than 1 hour deleted');
select pg_temp.expect((select count(*)::text from public.waitlist_attempts where ip_hash !~ '^[0-9a-f]{64}$'), '0', 'only hashes stored');

-- Injection: parameters are data, never SQL.
set role service_role;
select pg_temp.expect(public.join_waitlist($q$x');drop/**/table/**/public.waitlist;--@example.com$q$, null, :h2), 'joined', 'injection text stored as plain data');
reset role;
select pg_temp.expect((select count(*)::text from public.waitlist where email like 'x'');drop%'), '1', 'waitlist table intact, value stored literally');

-- search_path hijack: a look-alike public.lower must not be picked up (search_path = '').
create function public.lower(text) returns text language sql as $$ select 'hijacked@example.com' $$;
set role service_role;
select public.join_waitlist('Hijack.Test@Example.com', null, :h2);
reset role;
select pg_temp.expect((select count(*)::text from public.waitlist where email = 'hijack.test@example.com'), '1', 'function ignores look-alike public.lower');
select pg_temp.expect((select count(*)::text from public.waitlist where email = 'hijacked@example.com'), '0', 'no hijacked value stored');
drop function public.lower(text);

-- The public roles (Supabase publishable/anon key, signed-in users) can do nothing.
set role anon;
select pg_temp.expect_error('select * from public.waitlist', 'anon cannot read waitlist');
select pg_temp.expect_error($q$insert into public.waitlist (email) values ('a@b.co')$q$, 'anon cannot insert');
select pg_temp.expect_error('select * from public.waitlist_attempts', 'anon cannot read attempts');
select pg_temp.expect_error($q$select public.join_waitlist('a@b.co', null, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')$q$, 'anon cannot call join_waitlist');
select pg_temp.expect_error('select public.keepalive()', 'anon cannot call keepalive');
reset role;
set role authenticated;
select pg_temp.expect_error('select * from public.waitlist', 'authenticated cannot read waitlist');
select pg_temp.expect_error($q$select public.join_waitlist('a@b.co', null, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')$q$, 'authenticated cannot call join_waitlist');
reset role;
