# Lions Raffle System

Mobile-first Next.js app for running multiple simultaneous Lions raffles. Each raffle has independent ticket allocation, two-minute reservations, gap reuse, sales, sellers, draw state, exclusions, winners, printing state and device access. Shared organisation and venue records provide live names for active raffles and immutable snapshots for completed history.

## Run locally

```bash
npm ci
npm test
npm run dev
```

Set the values shown in `.env.example` in `.env.local`. The service-role key is server-only. The publishable/legacy anon key is optional for Realtime refreshes; ten-second polling remains available without it.

The Print action deliberately simulates success and completes the sale. No money is processed, and there is no offline selling fallback.

## Database

Apply migrations in order from `supabase/migrations/` to the existing Supabase project. The multi-raffle migration:

- creates normalized `organisations` and `venues` tables;
- creates one independently revisioned `raffles` row per raffle;
- adds foreign keys, checks, active-context uniqueness, lookup indexes, RLS and archive guards;
- enables a non-sensitive Realtime signal table;
- seeds `Lions Club of Green Point - Avoca` and `Not specified`;
- copies every legacy active/completed raffle without modifying the legacy aggregate.

The temporary cutover bridge keeps the new rows synchronized while the previous deployment is still live. Remove the bridge only after production is verified.

All app writes go through `POST /api/raffle`. Server-side domain logic computes ticket allocations and draw results. A conditional update on that raffle’s revision is the atomic boundary; concurrent requests retry against the winning version. Per-raffle idempotency receipts stop lost-response retries from issuing tickets or printing twice.

RLS is enabled on every public table. Normal raffle data is available only to the server role. Browser clients may read `raffle_signals`, which contains only a scope, revision and timestamp.

## Verification

```bash
npm test
npm run lint
npm run build
```

Tests cover overlapping numbering across active raffles, same-PIN isolation, duplicate seller identity, reservations/expiry, void gap reuse, independent draw state, idempotency, settings locks and organisation/venue history snapshots.

## Deployment

The repository is connected to the existing Vercel project. Apply additive database migrations first, verify the migrated row counts, then deploy the tested commit. Keep `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` configured in Production. Add `NEXT_PUBLIC_SUPABASE_ANON_KEY` to enable immediate Realtime refreshes.

See `BUILD_SPEC.md` for the complete behavior and deferred items.
