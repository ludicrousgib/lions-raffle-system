-- Multi-raffle production migration.
-- Additive and idempotent: the legacy aggregate remains untouched as a rollback source.
create extension if not exists pgcrypto;

create table if not exists public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '' and char_length(name) <= 100),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists organisations_unique_name
  on public.organisations (lower(btrim(name)));

create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '' and char_length(name) <= 100),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists venues_name on public.venues (lower(btrim(name)));

insert into public.organisations (id, name)
values ('00000000-0000-4000-8000-000000000001', 'Lions Club of Green Point - Avoca')
on conflict do nothing;

insert into public.venues (id, name)
values ('00000000-0000-4000-8000-000000000002', 'Not specified')
on conflict do nothing;

create table if not exists public.raffles (
  id text primary key check (id ~ '^raffle_[0-9A-Za-z-]+$'),
  name text not null check (btrim(name) <> '' and char_length(name) <= 100),
  pin_hash text not null,
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  organisation_name_snapshot text,
  venue_name_snapshot text,
  starting_ticket bigint not null check (starting_ticket between 1 and 1000000000),
  highest_issued bigint not null,
  prize_count integer not null check (prize_count between 1 and 1000),
  status text not null default 'selling' check (status in ('selling', 'drawing', 'ended')),
  settings_locked boolean not null default false,
  payload jsonb not null,
  sessions jsonb not null default '{}'::jsonb check (jsonb_typeof(sessions) = 'object'),
  requests jsonb not null default '{}'::jsonb check (jsonb_typeof(requests) = 'object'),
  audit jsonb not null default '[]'::jsonb check (jsonb_typeof(audit) = 'array'),
  revision bigint not null default 0 check (revision >= 0),
  created_by_device_key text,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  check (highest_issued >= starting_ticket - 1),
  check ((status = 'ended') = (ended_at is not null)),
  check (status <> 'ended' or (
    organisation_name_snapshot is not null and btrim(organisation_name_snapshot) <> '' and
    venue_name_snapshot is not null and btrim(venue_name_snapshot) <> ''
  ))
);

create unique index if not exists raffles_unique_active_context
  on public.raffles (lower(btrim(name)), organisation_id, venue_id)
  where status <> 'ended';
create index if not exists raffles_active_created on public.raffles (created_at desc) where status <> 'ended';
create index if not exists raffles_history_ended on public.raffles (ended_at desc) where status = 'ended';
create index if not exists raffles_active_organisation on public.raffles (organisation_id) where status <> 'ended';
create index if not exists raffles_active_venue on public.raffles (venue_id) where status <> 'ended';

create table if not exists public.raffle_signals (
  scope text primary key,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);
insert into public.raffle_signals (scope) values ('global') on conflict do nothing;

create or replace function public.raffle_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists organisations_touch_updated_at on public.organisations;
create trigger organisations_touch_updated_at before update on public.organisations
for each row execute function public.raffle_touch_updated_at();
drop trigger if exists venues_touch_updated_at on public.venues;
create trigger venues_touch_updated_at before update on public.venues
for each row execute function public.raffle_touch_updated_at();

create or replace function public.raffle_guard_entity_archive()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    if tg_table_name = 'organisations' and exists (
      select 1 from public.raffles where organisation_id = new.id and status <> 'ended'
    ) then
      raise exception 'This organisation is used by an active raffle and cannot be archived.';
    end if;
    if tg_table_name = 'venues' and exists (
      select 1 from public.raffles where venue_id = new.id and status <> 'ended'
    ) then
      raise exception 'This venue is used by an active raffle and cannot be archived.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists organisations_archive_guard on public.organisations;
create trigger organisations_archive_guard before update of archived_at on public.organisations
for each row execute function public.raffle_guard_entity_archive();
drop trigger if exists venues_archive_guard on public.venues;
create trigger venues_archive_guard before update of archived_at on public.venues
for each row execute function public.raffle_guard_entity_archive();

create or replace function public.raffle_guard_context()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status <> 'ended' then
    if exists (select 1 from public.organisations where id = new.organisation_id and archived_at is not null) then
      raise exception 'Archived organisations cannot be used by an active raffle.';
    end if;
    if exists (select 1 from public.venues where id = new.venue_id and archived_at is not null) then
      raise exception 'Archived venues cannot be used by an active raffle.';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'ended' and new.status <> 'ended' then
      raise exception 'Completed raffles cannot be reopened.';
    end if;
    if old.settings_locked and (
      old.organisation_id is distinct from new.organisation_id or old.venue_id is distinct from new.venue_id
    ) then
      raise exception 'Organisation and venue are locked after the first completed sale.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists raffles_context_guard on public.raffles;
create trigger raffles_context_guard before insert or update on public.raffles
for each row execute function public.raffle_guard_context();

create or replace function public.raffle_emit_signal()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare raffle_scope text;
begin
  if tg_op = 'DELETE' then raffle_scope := 'raffle:' || old.id;
  else raffle_scope := 'raffle:' || new.id;
  end if;
  insert into public.raffle_signals as signal (scope, revision, updated_at)
  values (raffle_scope, 1, now())
  on conflict (scope) do update set revision = signal.revision + 1, updated_at = now();
  insert into public.raffle_signals as signal (scope, revision, updated_at)
  values ('global', 1, now())
  on conflict (scope) do update set revision = signal.revision + 1, updated_at = now();
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists raffles_emit_signal on public.raffles;
create trigger raffles_emit_signal after insert or update or delete on public.raffles
for each row execute function public.raffle_emit_signal();

create or replace function public.raffle_emit_global_signal()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.raffle_signals as signal (scope, revision, updated_at)
  values ('global', 1, now())
  on conflict (scope) do update set revision = signal.revision + 1, updated_at = now();
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists organisations_emit_signal on public.organisations;
create trigger organisations_emit_signal after insert or update or delete on public.organisations
for each row execute function public.raffle_emit_global_signal();
drop trigger if exists venues_emit_signal on public.venues;
create trigger venues_emit_signal after insert or update or delete on public.venues
for each row execute function public.raffle_emit_global_signal();

-- Migrate every legacy active and completed raffle without modifying the source row.
do $$
declare
  legacy_payload jsonb;
  legacy_raffle jsonb;
  migrated_raffle jsonb;
  legacy_sessions jsonb;
begin
  if to_regclass('public.raffle_store') is null then return; end if;
  select payload into legacy_payload from public.raffle_store where id = 1;
  if legacy_payload is null then return; end if;

  for legacy_raffle in
    select value from (
      select legacy_payload #> '{state,activeRaffle}' as value
      union all
      select value from jsonb_array_elements(coalesce(legacy_payload #> '{state,history}', '[]'::jsonb))
    ) legacy where value is not null and value <> 'null'::jsonb
  loop
    migrated_raffle := legacy_raffle || jsonb_build_object(
      'organisationId', '00000000-0000-4000-8000-000000000001',
      'venueId', '00000000-0000-4000-8000-000000000002',
      'organisationName', 'Lions Club of Green Point - Avoca',
      'venueName', 'Not specified'
    );
    if legacy_raffle ->> 'status' = 'ended' then
      migrated_raffle := migrated_raffle || jsonb_build_object(
        'organisationNameSnapshot', 'Lions Club of Green Point - Avoca',
        'venueNameSnapshot', 'Not specified'
      );
      legacy_sessions := '{}'::jsonb;
    else
      select coalesce(jsonb_object_agg(entry.key,
        (entry.value - 'raffleId' - 'expiresAt') || '{"pinRemembered":true}'::jsonb
      ), '{}'::jsonb)
      into legacy_sessions
      from jsonb_each(coalesce(legacy_payload -> 'sessions', '{}'::jsonb)) entry
      where entry.value ->> 'raffleId' = legacy_raffle ->> 'id';
    end if;

    insert into public.raffles (
      id, name, pin_hash, organisation_id, venue_id,
      organisation_name_snapshot, venue_name_snapshot,
      starting_ticket, highest_issued, prize_count, status, settings_locked,
      payload, sessions, requests, audit, revision, created_at, ended_at
    ) values (
      migrated_raffle ->> 'id',
      migrated_raffle ->> 'name',
      migrated_raffle ->> 'pin',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      case when migrated_raffle ->> 'status' = 'ended' then 'Lions Club of Green Point - Avoca' end,
      case when migrated_raffle ->> 'status' = 'ended' then 'Not specified' end,
      (migrated_raffle ->> 'startingTicket')::bigint,
      (migrated_raffle ->> 'highestIssued')::bigint,
      (migrated_raffle ->> 'prizeCount')::integer,
      migrated_raffle ->> 'status',
      coalesce((migrated_raffle ->> 'settingsLocked')::boolean, false),
      migrated_raffle,
      legacy_sessions,
      case when migrated_raffle ->> 'status' <> 'ended' then coalesce(legacy_payload -> 'requests', '{}'::jsonb) else '{}'::jsonb end,
      '[]'::jsonb,
      0,
      (migrated_raffle ->> 'createdAt')::timestamptz,
      nullif(migrated_raffle ->> 'endedAt', '')::timestamptz
    ) on conflict (id) do nothing;
  end loop;
end;
$$;

alter table public.organisations enable row level security;
alter table public.venues enable row level security;
alter table public.raffles enable row level security;
alter table public.raffle_signals enable row level security;

revoke all on public.organisations, public.venues, public.raffles from public, anon, authenticated;
grant select, insert, update, delete on public.organisations, public.venues, public.raffles to service_role;
revoke all on public.raffle_signals from public, anon, authenticated;
grant select on public.raffle_signals to anon, authenticated, service_role;
grant insert, update, delete on public.raffle_signals to service_role;

drop policy if exists "Public raffle change signals" on public.raffle_signals;
create policy "Public raffle change signals" on public.raffle_signals
for select to anon, authenticated using (true);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'raffle_signals'
    ) then
    alter publication supabase_realtime add table public.raffle_signals;
  end if;
end;
$$;

comment on table public.organisations is 'Shared organisation directory; future account ownership can be added without changing raffle references.';
comment on table public.venues is 'Shared venue directory. Duplicate names are intentionally permitted.';
comment on table public.raffles is 'One independently versioned, atomic runtime aggregate per raffle.';
comment on column public.raffles.payload is 'Raffle-scoped reservations, sales, sellers, draw state, exclusions, winners and print state.';
