-- Compatibility notice
--
-- The live schema is now managed by the ordered, idempotent files in
-- supabase/migrations/. Apply those migrations rather than this former one-shot
-- bootstrap file. Keeping this path prevents older setup notes from silently
-- installing the obsolete single-raffle aggregate.

select version from supabase_migrations.schema_migrations order by version;
