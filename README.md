# Lions Raffle System

Mobile-first Next.js MVP for the Lions Club of Green Point - Avoca. It covers raffle setup, seller joining, gap-reusing ticket allocation, two-minute print reservations, voids, draw/redraw/confirm/undo, final summaries and raffle history.

## Run the demo

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Demo mode saves raffle data in the browser on one device. The Print action deliberately simulates a successful print and then completes the sale.

## Supabase / multi-device path

1. Create a Supabase project and apply `supabase/schema.sql` in the SQL editor.
2. Copy `.env.example` to `.env.local` and add the project URL, anon key and server-only service-role key.
3. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only.
4. Move the remaining UI actions from the demo store to server routes/RPCs before enabling multi-device selling.

The reservation endpoint at `POST /api/reservations` demonstrates the production boundary: it verifies the PIN server-side and calls the row-locking, idempotent `reserve_bundle` Postgres function. The function expires stale reservations, locks the raffle allocation row, consumes the lowest available gaps first and only then advances the high-water mark.

## Deploy to Vercel

Import the repository in Vercel, add the same environment variables, and deploy with the default Next.js settings. Without Supabase environment variables the deployed app remains a single-device demo.

See `BUILD_SPEC.md` for the locked product decisions and post-MVP list.
