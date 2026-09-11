-- Canonical schema entry point
--
-- The production schema and legacy-data conversion are defined in the ordered
-- SQL files under supabase/migrations/. This file intentionally contains no
-- standalone DDL so it cannot recreate the superseded one-active-raffle model.

select version from supabase_migrations.schema_migrations order by version;
