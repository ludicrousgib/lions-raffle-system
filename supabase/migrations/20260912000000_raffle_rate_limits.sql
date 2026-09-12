-- Restore the rate-limiter primitives app/api/raffle/route.ts depends on.
-- These existed only in the superseded supabase/live-schema.sql bootstrap file.
-- The multi-raffle migration set never carried them forward, so applying
-- supabase/migrations/ alone to a fresh project left every POST to /api/raffle
-- failing (the route calls raffle_allow_request on every write).
create table if not exists public.raffle_rate_limits (
  key text primary key,
  started_at timestamptz not null,
  attempts integer not null
);
alter table public.raffle_rate_limits enable row level security;
revoke all on public.raffle_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.raffle_rate_limits to service_role;

create or replace function public.raffle_allow_request(p_key text, p_limit integer, p_seconds integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
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
end;
$$;
revoke all on function public.raffle_allow_request(text, integer, integer) from public, anon, authenticated;
grant execute on function public.raffle_allow_request(text, integer, integer) to service_role;
