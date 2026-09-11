-- Keep the additive multi-raffle tables synchronized while the previous deployment
-- is still writing the legacy aggregate. New-runtime rows (revision > 0 or with a
-- creator device) are never overwritten.
create or replace function public.raffle_sync_legacy_store()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  legacy_payload jsonb := new.payload;
  legacy_raffle jsonb;
  migrated_raffle jsonb;
  legacy_sessions jsonb;
begin
  delete from public.raffles target
  where target.revision = 0
    and target.created_by_device_key is null
    and not exists (
      select 1 from (
        select legacy_payload #> '{state,activeRaffle}' as value
        union all
        select value from jsonb_array_elements(coalesce(legacy_payload #> '{state,history}', '[]'::jsonb))
      ) legacy
      where legacy.value is not null
        and legacy.value <> 'null'::jsonb
        and legacy.value ->> 'id' = target.id
    );

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
      migrated_raffle ->> 'id', migrated_raffle ->> 'name', migrated_raffle ->> 'pin',
      '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
      case when migrated_raffle ->> 'status' = 'ended' then 'Lions Club of Green Point - Avoca' end,
      case when migrated_raffle ->> 'status' = 'ended' then 'Not specified' end,
      (migrated_raffle ->> 'startingTicket')::bigint, (migrated_raffle ->> 'highestIssued')::bigint,
      (migrated_raffle ->> 'prizeCount')::integer, migrated_raffle ->> 'status',
      coalesce((migrated_raffle ->> 'settingsLocked')::boolean, false), migrated_raffle,
      legacy_sessions,
      case when migrated_raffle ->> 'status' <> 'ended' then coalesce(legacy_payload -> 'requests', '{}'::jsonb) else '{}'::jsonb end,
      '[]'::jsonb, 0, (migrated_raffle ->> 'createdAt')::timestamptz,
      nullif(migrated_raffle ->> 'endedAt', '')::timestamptz
    )
    on conflict (id) do update set
      name = excluded.name,
      pin_hash = excluded.pin_hash,
      organisation_name_snapshot = excluded.organisation_name_snapshot,
      venue_name_snapshot = excluded.venue_name_snapshot,
      starting_ticket = excluded.starting_ticket,
      highest_issued = excluded.highest_issued,
      prize_count = excluded.prize_count,
      status = excluded.status,
      settings_locked = excluded.settings_locked,
      payload = excluded.payload,
      sessions = excluded.sessions,
      requests = excluded.requests,
      created_at = excluded.created_at,
      ended_at = excluded.ended_at,
      updated_at = now()
    where public.raffles.revision = 0 and public.raffles.created_by_device_key is null;
  end loop;
  return new;
end;
$$;

drop trigger if exists raffle_store_cutover_bridge on public.raffle_store;
create trigger raffle_store_cutover_bridge after insert or update of payload on public.raffle_store
for each row when (new.id = 1) execute function public.raffle_sync_legacy_store();

-- Synchronize the latest legacy revision now, including any activity that occurred
-- after the first additive migration was applied.
update public.raffle_store set payload = payload where id = 1;
