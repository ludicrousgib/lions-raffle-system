-- Live MVP: one versioned aggregate. Every command uses an atomic conditional
-- UPDATE (compare-and-swap); a lost race recomputes against the winning version.
-- The server, never a phone, computes ticket allocation and draw results.
create table if not exists public.raffle_store (
  id integer primary key check (id = 1),
  revision bigint not null default 0,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.raffle_store enable row level security;
revoke all on public.raffle_store from public, anon, authenticated;
grant select, update on public.raffle_store to service_role;
insert into public.raffle_store (id, payload) values (1,
  '{"state":{"version":1,"activeRaffle":null,"history":[],"deviceSellers":{}},"sessions":{},"requests":{}}'
) on conflict (id) do nothing;

create table if not exists public.raffle_rate_limits (
  key text primary key,
  started_at timestamptz not null,
  attempts integer not null
);
alter table public.raffle_rate_limits enable row level security;
revoke all on public.raffle_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.raffle_rate_limits to service_role;

create or replace function public.raffle_allow_request(p_key text, p_limit integer, p_seconds integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  insert into public.raffle_rate_limits as r (key, started_at, attempts)
  values (p_key, now(), 1)
  on conflict (key) do update set
    attempts = case when r.started_at < now() - make_interval(secs => p_seconds) then 1 else r.attempts + 1 end,
    started_at = case when r.started_at < now() - make_interval(secs => p_seconds) then now() else r.started_at end
  returning attempts into n;
  delete from public.raffle_rate_limits where started_at < now() - interval '1 day';
  return n <= p_limit;
end; $$;
revoke all on function public.raffle_allow_request(text, integer, integer) from public, anon, authenticated;
grant execute on function public.raffle_allow_request(text, integer, integer) to service_role;

-- Safe verification (must return true for both protection checks).
select relname, relrowsecurity as rls_enabled,
  not has_table_privilege('anon', oid, 'SELECT') as anonymous_access_blocked
from pg_class where oid in ('public.raffle_store'::regclass, 'public.raffle_rate_limits'::regclass);
