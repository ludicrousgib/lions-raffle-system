# Lions Raffle System

Mobile-first Next.js MVP for the Lions Club of Green Point - Avoca. It covers raffle setup, seller joining, gap-reusing ticket allocation, two-minute print reservations, voids, draw/redraw/confirm/undo, final summaries and raffle history.

## Run the live MVP

```bash
npm ci
npm run build
npm start
```

Open `http://localhost:3000` after configuring Supabase below. The Print action deliberately simulates success and completes the sale. No money is processed. The app fails closed without a database connection: there is no browser-local or offline selling fallback.

## Supabase setup

1. Create a Supabase project and apply `supabase/live-schema.sql` in the SQL editor. Its final query verifies RLS and blocked anonymous access.
2. Set the project URL and server-only service-role key from `.env.example` in `.env.local`. The frontend does not need an anon key.
3. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only.
4. Configure the same two values in Vercel Production. Previews should use a separate database.

`POST /api/raffle` accepts named commands, checks server-stored roles and ownership, and applies the domain rules on the server. PostgreSQL atomically updates a single versioned JSONB aggregate only if its revision matches. A concurrent loser reloads and recomputes. Allocation, print, void, draw and one-active-raffle creation therefore share one atomic boundary across Vercel instances. Idempotency receipts prevent duplicate submissions from issuing tickets twice. Three-second polling refreshes shared device state.

Device identity is an opaque HttpOnly cookie. PINs are salted and hashed server-side and never returned to clients. PIN attempts are rate-limited in Postgres; database access is restricted to the server role.

The aggregate deliberately favours an auditable transaction boundary for a small club. The earlier relational design in `supabase/schema.sql` is reference only, is not deployed, and must not be enabled alongside the live model. Normalising and load-testing beyond club scale remain follow-up work.

## Deploy to Vercel

Import the repository in Vercel, add the environment variables, and deploy with the default Next.js settings. Without Supabase configuration, selling is unavailable.

## Verification and caveats

Run `npm test`, `npm run lint` and `npm run build`.

- Print/Reprint are simulations, not physical printing.
- The agreed shared four-digit PIN is demo-level access control, not separate admin security.
- Anyone with the public URL can create a raffle when none is active, view history and permanently delete completed history, as agreed for MVP.
- Resource safeguards currently allow up to 1,000 tickets per bundle, 1,000 prizes, a starting number up to one billion and roughly 100,000 issued numbers per raffle. Review before larger events.
- Check database availability before each event. Backups, monitoring and recovery need an operational plan before relying on this for real money.

See `BUILD_SPEC.md` for the locked product decisions and post-MVP list.
