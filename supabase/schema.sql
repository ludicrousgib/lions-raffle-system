-- Lions Raffle System production schema for Supabase/Postgres.
-- Apply in a new Supabase project, then use the server-only service role key.

create extension if not exists pgcrypto;

create table if not exists public.raffles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pin_hash text not null,
  starting_ticket bigint not null check (starting_ticket > 0),
  highest_issued bigint not null,
  prize_count integer not null check (prize_count > 0),
  status text not null default 'selling' check (status in ('selling', 'drawing', 'ended')),
  settings_locked boolean not null default false,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  check (highest_issued >= starting_ticket - 1)
);

create unique index if not exists one_unfinished_raffle
  on public.raffles ((true))
  where status <> 'ended';

create table if not exists public.raffle_bundles (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete cascade,
  slot integer not null check (slot between 1 and 3),
  quantity integer not null check (quantity > 0),
  price_cents integer not null check (price_cents > 0),
  unique (raffle_id, slot)
);

create table if not exists public.sellers (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete cascade,
  name text not null,
  device_id text not null,
  joined_at timestamptz not null default now()
);

create unique index if not exists seller_name_per_raffle
  on public.sellers (raffle_id, lower(name));

create unique index if not exists seller_device_per_raffle
  on public.sellers (raffle_id, device_id);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete cascade,
  seller_id uuid not null references public.sellers(id) on delete restrict,
  bundle_id uuid not null references public.raffle_bundles(id) on delete restrict,
  client_request_id uuid not null,
  quantity integer not null check (quantity > 0),
  amount_cents integer not null check (amount_cents > 0),
  ticket_numbers bigint[] not null check (cardinality(ticket_numbers) = quantity),
  status text not null default 'active' check (status in ('active', 'completed', 'expired', 'cancelled', 'voided')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  voided_at timestamptz,
  print_count integer not null default 0 check (print_count >= 0),
  unique (raffle_id, client_request_id)
);

create index if not exists reservations_raffle_status
  on public.reservations (raffle_id, status);

create table if not exists public.draw_events (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete cascade,
  prize_number integer not null check (prize_number > 0),
  ticket_number bigint not null,
  outcome text not null default 'candidate' check (outcome in ('candidate', 'confirmed', 'redrawn', 'undone')),
  drawn_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index if not exists one_unresolved_candidate_per_raffle
  on public.draw_events (raffle_id)
  where outcome = 'candidate';

create index if not exists excluded_drawn_ticket
  on public.draw_events (raffle_id, ticket_number);

create table if not exists public.winners (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete cascade,
  draw_event_id uuid not null unique references public.draw_events(id) on delete restrict,
  prize_number integer not null check (prize_number > 0),
  ticket_number bigint not null,
  confirmed_at timestamptz not null default now(),
  unique (raffle_id, prize_number),
  unique (raffle_id, ticket_number)
);

alter table public.raffles enable row level security;
alter table public.raffle_bundles enable row level security;
alter table public.sellers enable row level security;
alter table public.reservations enable row level security;
alter table public.draw_events enable row level security;
alter table public.winners enable row level security;

create or replace function public.verify_raffle_pin(p_raffle_id uuid, p_pin text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.raffles
    where id = p_raffle_id
      and p_pin ~ '^[0-9]{4}$'
      and pin_hash = crypt(p_pin, pin_hash)
  );
$$;

create or replace function public.create_raffle(
  p_name text,
  p_pin text,
  p_starting_ticket bigint,
  p_prize_count integer,
  p_bundles jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_raffle_id uuid;
begin
  if btrim(p_name) = '' then raise exception 'Raffle name is required'; end if;
  if p_pin !~ '^[0-9]{4}$' then raise exception 'PIN must contain four digits'; end if;
  if p_starting_ticket < 1 or p_prize_count < 1 then raise exception 'Invalid raffle settings'; end if;
  if jsonb_typeof(p_bundles) <> 'array' or jsonb_array_length(p_bundles) <> 3 then
    raise exception 'Exactly three bundles are required';
  end if;

  insert into public.raffles (name, pin_hash, starting_ticket, highest_issued, prize_count)
  values (btrim(p_name), crypt(p_pin, gen_salt('bf')), p_starting_ticket, p_starting_ticket - 1, p_prize_count)
  returning id into v_raffle_id;

  insert into public.raffle_bundles (raffle_id, slot, quantity, price_cents)
  select v_raffle_id, item.ordinality::integer,
         (item.value ->> 'quantity')::integer,
         (item.value ->> 'price_cents')::integer
  from jsonb_array_elements(p_bundles) with ordinality as item(value, ordinality);

  return v_raffle_id;
end;
$$;

create or replace function public.join_seller(p_raffle_id uuid, p_name text, p_device_id text, p_pin text)
returns public.sellers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_seller public.sellers%rowtype;
begin
  if not public.verify_raffle_pin(p_raffle_id, p_pin) then raise exception 'Incorrect raffle PIN'; end if;
  select * into v_seller from public.sellers where raffle_id = p_raffle_id and device_id = p_device_id;
  if found then return v_seller; end if;
  if btrim(p_name) = '' then raise exception 'Seller name is required'; end if;
  insert into public.sellers (raffle_id, name, device_id)
  values (p_raffle_id, btrim(p_name), p_device_id)
  returning * into v_seller;
  return v_seller;
end;
$$;

create or replace function public.reserve_bundle(
  p_raffle_id uuid,
  p_seller_id uuid,
  p_bundle_id uuid,
  p_client_request_id uuid
)
returns table (reservation_id uuid, ticket_numbers bigint[], expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_raffle public.raffles%rowtype;
  v_bundle public.raffle_bundles%rowtype;
  v_existing public.reservations%rowtype;
  v_tickets bigint[] := '{}'::bigint[];
  v_needed integer;
  v_reservation_id uuid;
  v_expires_at timestamptz := now() + interval '2 minutes';
begin
  select * into v_raffle
  from public.raffles
  where id = p_raffle_id
  for update;

  if not found then raise exception 'Raffle not found'; end if;

  update public.reservations
  set status = 'expired'
  where raffle_id = p_raffle_id and status = 'active' and expires_at <= now();

  select * into v_existing
  from public.reservations
  where raffle_id = p_raffle_id and client_request_id = p_client_request_id;

  if found then
    return query select v_existing.id, v_existing.ticket_numbers, v_existing.expires_at;
    return;
  end if;

  if v_raffle.status <> 'selling' then raise exception 'Sales are paused'; end if;
  if not exists (select 1 from public.sellers where id = p_seller_id and raffle_id = p_raffle_id) then
    raise exception 'Seller is not joined to this raffle';
  end if;
  if exists (select 1 from public.reservations where raffle_id = p_raffle_id and seller_id = p_seller_id and status = 'active') then
    raise exception 'Seller already has an active reservation';
  end if;

  select * into v_bundle
  from public.raffle_bundles
  where id = p_bundle_id and raffle_id = p_raffle_id;
  if not found then raise exception 'Bundle not found'; end if;

  select coalesce(array_agg(candidate order by candidate), '{}'::bigint[])
  into v_tickets
  from (
    select series.ticket_number as candidate
    from generate_series(v_raffle.starting_ticket, v_raffle.highest_issued) as series(ticket_number)
    where not exists (
      select 1
      from public.reservations occupied
      cross join lateral unnest(occupied.ticket_numbers) as held(ticket_number)
      where occupied.raffle_id = p_raffle_id
        and occupied.status in ('active', 'completed')
        and held.ticket_number = series.ticket_number
    )
    order by series.ticket_number
    limit v_bundle.quantity
  ) reusable;

  v_needed := v_bundle.quantity - cardinality(v_tickets);
  if v_needed > 0 then
    v_tickets := v_tickets || array(
      select generate_series(v_raffle.highest_issued + 1, v_raffle.highest_issued + v_needed)
    );
    update public.raffles
    set highest_issued = highest_issued + v_needed
    where id = p_raffle_id;
  end if;

  insert into public.reservations (
    raffle_id, seller_id, bundle_id, client_request_id,
    quantity, amount_cents, ticket_numbers, expires_at
  ) values (
    p_raffle_id, p_seller_id, p_bundle_id, p_client_request_id,
    v_bundle.quantity, v_bundle.price_cents, v_tickets, v_expires_at
  ) returning id into v_reservation_id;

  return query select v_reservation_id, v_tickets, v_expires_at;
end;
$$;

create or replace function public.complete_reservation_after_print(p_reservation_id uuid)
returns public.reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_reservation public.reservations%rowtype;
begin
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if v_reservation.status = 'completed' then
    update public.reservations set print_count = print_count + 1 where id = p_reservation_id returning * into v_reservation;
    return v_reservation;
  end if;
  if v_reservation.status <> 'active' or v_reservation.expires_at <= now() then
    raise exception 'Reservation is no longer active';
  end if;
  update public.reservations
  set status = 'completed', completed_at = now(), print_count = 1
  where id = p_reservation_id
  returning * into v_reservation;
  update public.raffles set settings_locked = true where id = v_reservation.raffle_id;
  return v_reservation;
end;
$$;

create or replace function public.void_latest_sale(p_raffle_id uuid, p_seller_id uuid, p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_raffle public.raffles%rowtype; v_latest public.reservations%rowtype;
begin
  select * into v_raffle from public.raffles where id = p_raffle_id for update;
  if not found or v_raffle.status <> 'selling' then raise exception 'Voids are unavailable'; end if;
  select * into v_latest
  from public.reservations
  where raffle_id = p_raffle_id and seller_id = p_seller_id and status in ('completed', 'voided')
  order by completed_at desc
  limit 1;
  if not found or v_latest.id <> p_reservation_id or v_latest.status <> 'completed' then
    raise exception 'Only the seller''s most recent completed sale can be voided';
  end if;
  if exists (
    select 1 from public.draw_events event
    where event.raffle_id = p_raffle_id and event.ticket_number = any(v_latest.ticket_numbers)
  ) then raise exception 'A previously drawn ticket cannot be voided'; end if;
  update public.reservations set status = 'voided', voided_at = now() where id = p_reservation_id;
end;
$$;

create or replace function public.start_draw(p_raffle_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_raffle public.raffles%rowtype;
begin
  select * into v_raffle from public.raffles where id = p_raffle_id for update;
  if not found or v_raffle.status <> 'selling' then raise exception 'Raffle is not selling'; end if;
  update public.reservations set status = 'expired'
  where raffle_id = p_raffle_id and status = 'active' and expires_at <= now();
  if exists (select 1 from public.reservations where raffle_id = p_raffle_id and status = 'active') then
    raise exception 'Unprinted reservations are still active';
  end if;
  if not exists (select 1 from public.reservations where raffle_id = p_raffle_id and status = 'completed') then
    raise exception 'No valid sold tickets';
  end if;
  update public.raffles set status = 'drawing' where id = p_raffle_id;
end;
$$;

create or replace function public.return_to_selling(p_raffle_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_raffle public.raffles%rowtype;
begin
  select * into v_raffle from public.raffles where id = p_raffle_id for update;
  if not found or v_raffle.status <> 'drawing' then raise exception 'Raffle is not in Draw mode'; end if;
  if exists (select 1 from public.draw_events where raffle_id = p_raffle_id and outcome = 'candidate') then
    raise exception 'Resolve the current candidate first';
  end if;
  update public.raffles set status = 'selling' where id = p_raffle_id;
end;
$$;

create or replace function public.draw_candidate(p_raffle_id uuid, p_prize_number integer default null)
returns public.draw_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_raffle public.raffles%rowtype; v_prize integer; v_ticket bigint; v_event public.draw_events%rowtype;
begin
  select * into v_raffle from public.raffles where id = p_raffle_id for update;
  if not found or v_raffle.status <> 'drawing' then raise exception 'Raffle is not in Draw mode'; end if;
  if exists (select 1 from public.draw_events where raffle_id = p_raffle_id and outcome = 'candidate') then
    raise exception 'Resolve the current candidate first';
  end if;
  if p_prize_number is null then
    select prize into v_prize
    from generate_series(1, v_raffle.prize_count) prize
    where not exists (select 1 from public.winners where raffle_id = p_raffle_id and prize_number = prize)
    order by prize limit 1;
  else
    v_prize := p_prize_number;
  end if;
  if v_prize is null or v_prize < 1 or v_prize > v_raffle.prize_count
     or exists (select 1 from public.winners where raffle_id = p_raffle_id and prize_number = v_prize) then
    raise exception 'Prize is already filled or invalid';
  end if;

  select sold.ticket_number into v_ticket
  from public.reservations sale
  cross join lateral unnest(sale.ticket_numbers) as sold(ticket_number)
  where sale.raffle_id = p_raffle_id and sale.status = 'completed'
    and not exists (
      select 1 from public.draw_events prior
      where prior.raffle_id = p_raffle_id and prior.ticket_number = sold.ticket_number
    )
  order by random()
  limit 1;
  if v_ticket is null then raise exception 'No eligible tickets remain'; end if;

  insert into public.draw_events (raffle_id, prize_number, ticket_number)
  values (p_raffle_id, v_prize, v_ticket)
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function public.confirm_candidate(p_raffle_id uuid)
returns public.winners
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_event public.draw_events%rowtype; v_winner public.winners%rowtype;
begin
  select * into v_event from public.draw_events
  where raffle_id = p_raffle_id and outcome = 'candidate'
  for update;
  if not found then raise exception 'No candidate to confirm'; end if;
  update public.draw_events set outcome = 'confirmed', resolved_at = now() where id = v_event.id;
  insert into public.winners (raffle_id, draw_event_id, prize_number, ticket_number)
  values (p_raffle_id, v_event.id, v_event.prize_number, v_event.ticket_number)
  returning * into v_winner;
  return v_winner;
end;
$$;

create or replace function public.redraw_candidate(p_raffle_id uuid)
returns public.draw_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_event public.draw_events%rowtype;
begin
  select * into v_event from public.draw_events
  where raffle_id = p_raffle_id and outcome = 'candidate'
  for update;
  if not found then raise exception 'No candidate to redraw'; end if;
  update public.draw_events set outcome = 'redrawn', resolved_at = now() where id = v_event.id;
  return public.draw_candidate(p_raffle_id, v_event.prize_number);
end;
$$;

create or replace function public.undo_winner(p_winner_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_winner public.winners%rowtype;
begin
  select * into v_winner from public.winners where id = p_winner_id for update;
  if not found then raise exception 'Winner not found'; end if;
  delete from public.winners where id = p_winner_id;
  update public.draw_events set outcome = 'undone', resolved_at = now() where id = v_winner.draw_event_id;
end;
$$;

create or replace function public.end_raffle(p_raffle_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_raffle public.raffles%rowtype; v_winner_count integer;
begin
  select * into v_raffle from public.raffles where id = p_raffle_id for update;
  if not found or v_raffle.status <> 'drawing' then raise exception 'Raffle is not in Draw mode'; end if;
  if exists (select 1 from public.draw_events where raffle_id = p_raffle_id and outcome = 'candidate') then
    raise exception 'Resolve the current candidate first';
  end if;
  select count(*) into v_winner_count from public.winners where raffle_id = p_raffle_id;
  if v_winner_count <> v_raffle.prize_count then raise exception 'Every prize needs a confirmed winner'; end if;
  update public.raffles set status = 'ended', ended_at = now() where id = p_raffle_id;
end;
$$;

revoke all on function public.create_raffle(text, text, bigint, integer, jsonb) from public, anon, authenticated;
revoke all on function public.join_seller(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.verify_raffle_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.reserve_bundle(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_reservation_after_print(uuid) from public, anon, authenticated;
revoke all on function public.void_latest_sale(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.start_draw(uuid) from public, anon, authenticated;
revoke all on function public.return_to_selling(uuid) from public, anon, authenticated;
revoke all on function public.draw_candidate(uuid, integer) from public, anon, authenticated;
revoke all on function public.confirm_candidate(uuid) from public, anon, authenticated;
revoke all on function public.redraw_candidate(uuid) from public, anon, authenticated;
revoke all on function public.undo_winner(uuid) from public, anon, authenticated;
revoke all on function public.end_raffle(uuid) from public, anon, authenticated;

grant execute on function public.create_raffle(text, text, bigint, integer, jsonb) to service_role;
grant execute on function public.join_seller(uuid, text, text, text) to service_role;
grant execute on function public.verify_raffle_pin(uuid, text) to service_role;
grant execute on function public.reserve_bundle(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.complete_reservation_after_print(uuid) to service_role;
grant execute on function public.void_latest_sale(uuid, uuid, uuid) to service_role;
grant execute on function public.start_draw(uuid) to service_role;
grant execute on function public.return_to_selling(uuid) to service_role;
grant execute on function public.draw_candidate(uuid, integer) to service_role;
grant execute on function public.confirm_candidate(uuid) to service_role;
grant execute on function public.redraw_candidate(uuid) to service_role;
grant execute on function public.undo_winner(uuid) to service_role;
grant execute on function public.end_raffle(uuid) to service_role;
