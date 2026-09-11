-- Remove the temporary write bridge after the multi-raffle application has
-- replaced the legacy single-state deployment.
drop trigger if exists raffle_store_cutover_bridge on public.raffle_store;
drop function if exists public.raffle_sync_legacy_store();
