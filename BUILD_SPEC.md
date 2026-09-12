# Lions Raffle System — Multi-Raffle MVP Build Spec

## Product goal

A mobile-first web app for running multiple simultaneous in-person Lions raffles from seller phones. This is an enhancement of the working MVP: ticket allocation, simulated printing, voids, drawing and history remain intact. Payment continues to be collected separately.

## Raffle contexts and access

- Any number of raffles may be active at once. New raffles enter Selling immediately; there is no Draft state.
- Every reservation, expiry, ticket number, reusable gap, sale, seller, latest-sale void, draw state, exclusion, prize, winner, print count, request receipt and audit event belongs to exactly one raffle.
- Each raffle is an independently revisioned database aggregate. Commands use compare-and-swap updates on that raffle only, so concurrent raffles neither leak state nor block one another.
- Raffles may share names, starting ticket numbers and four-digit PINs.
- The home screen lists all active raffles newest first. Cards show raffle name, organisation, venue and Selling/Draw status before PIN entry.
- Selecting a raffle always presents Join Raffle and Admin / Draw. Successful PIN access is remembered for that raffle on the device until it ends. The choice screen remains visible even when access is remembered.
- Seller and admin use the same organiser-chosen four-digit PIN. Roles are server-stored behind an opaque persistent HttpOnly device cookie; PIN hashes never reach the browser.
- Sellers may participate in multiple raffles from one device. Seller name is remembered globally in browser storage and prefilled when joining another raffle.
- Seller names may repeat across raffles. Within one raffle, normalized matching names represent one seller identity. The app warns before reusing that identity; proceeding combines sales and shares most-recent-sale void access.
- A seller may open a raffle in Draw mode, but selling and void controls stay disabled until it returns to Selling.

## Organisations

- Organisations are first-class records. `Lions Club of Green Point - Avoca` is seeded and is the default for creation.
- Names are required and unique after trimming/case normalization.
- Anyone may open Manage Organisations & Venues, add organisations, rename them, archive/restore them, and delete unused ones.
- A used organisation cannot be deleted. It can be archived only when no active raffle references it.
- Archived organisations remain in Manage and completed history but are hidden from normal creation selectors.
- Active raffles resolve the live organisation name. Ending a raffle snapshots the name so later renames do not alter history.
- Organisation choice locks after the first completed sale.
- Raffles use stable organisation foreign keys, leaving a clean ownership boundary for future account and permission tables without changing raffle data.

## Venues

- Venues are first-class, shared records and are required for new raffles.
- Venue names may repeat. No address or suburb fields are included yet.
- Venues follow the same rename/archive/restore/delete rules as organisations. Archiving is blocked while an active raffle references the venue.
- Active raffles resolve the current name; completed raffles retain the snapshot made when ending.
- Venue choice locks after the first completed sale.
- Migrated raffles use the seeded venue `Not specified`.

## Raffle creation

- Existing fields remain: name, four-digit PIN, starting ticket, prize count and exactly three bundle buttons.
- Organisation and venue are required and may be created from the form.
- An exact active duplicate—normalized raffle name plus organisation plus venue—is blocked by both application validation and a partial unique database index.
- If another active raffle uses the venue but differs by name or organisation, the app warns and allows Continue anyway.
- Duplicate checks ignore completed raffles.
- Name, PIN, starting number, prize count, bundles, organisation and venue remain editable until the first sale completes, then lock.

## Tickets, reservations, printing and voids

- Ticket allocation remains atomic and server-authoritative. The lowest reusable numbers are issued first, then new higher numbers. A bundle may span gaps and new ranges.
- Each seller may hold one active two-minute reservation per raffle. An unprinted reservation is not a sale; expiry/cancellation returns its numbers to that raffle only.
- Print is the simulated commit point. A successful first print completes and locks the sale. Failed printer simulation leaves the reservation active. Reprint never reallocates and increments only that sale’s print state.
- The customer ticket shows organisation, raffle name, venue, sale date/time, compact range summary, every individual ticket number, quantity, amount and the thanks message.
- In Selling mode, the shared seller identity may void only its most recent completed sale. The sale’s tickets and expected value are removed and its numbers become reusable within the same raffle.
- A sale containing a confirmed winner cannot be voided. Voiding does not expose an earlier sale as a new void target.

## Admin, draw and global overview

- The focused raffle dashboard remains the primary admin view. It shows first ticket, highest issued, valid tickets, expected sales and bundle breakdown.
- Missing/reusable ranges are listed with a warning that an external first-to-highest draw is unsafe; the built-in draw uses the exact valid pool.
- Start Draw is blocked by active unprinted reservations. Draw pauses sales and voids only in that raffle.
- Returning to Selling is allowed only without an unresolved candidate. Confirmed winners remain locked and later sales are eligible for unfilled prizes.
- Candidate selection is uniform across valid sold tickets and permanently excludes every prior candidate, including redraws and undone winners.
- End Raffle is available after all prizes are filled. It permanently snapshots organisation/venue names and moves only that raffle to History.
- Global Overview is public and read-only. It lists all active raffles and the five most recently completed raffles with name, organisation, venue, status, tickets sold and expected sales.
- Selecting an active overview row opens the focused dashboard in read-only mode; PIN access unlocks controls. Completed rows open the final summary.

## History and deletion

- History is public, shows all completed raffles newest first, and includes the snapshotted organisation and venue names.
- Completed raffles may be permanently deleted with normal confirmation.
- An active raffle with no sale that ever reached completed state may be deleted with normal confirmation.
- If any sale ever completed, including one later voided, deleting the active raffle shows a strong warning and requires typing `DELETE`.
- Deleting a raffle removes only its row-scoped reservations, sales, sellers, draw data, winners, sessions, request receipts and audit trail. Other raffles and shared entities are unaffected.
- Device access disappears automatically after a raffle ends or is deleted.

## Data and delivery architecture

- Next.js App Router on Vercel with Supabase/Postgres as the authority.
- `organisations` and `venues` are normalized, RLS-protected tables.
- `raffles` stores one independently revisioned aggregate per raffle plus indexed relational context, status and snapshots. Foreign keys, checks, partial uniqueness and archive-guard triggers enforce cross-record rules.
- The server computes allocation/draw results and performs conditional updates. Contending commands reload and recompute; idempotency receipts prevent duplicate reservations or prints after lost responses.
- A public, non-sensitive `raffle_signals` table drives Supabase Realtime refreshes when a publishable key is configured. Ten-second polling remains a fail-safe.
- Browser clients never receive service-role credentials, PIN hashes, other seller names, sessions, audit entries or idempotency receipts.
- Production migration is additive and idempotent. Every pre-enhancement active/completed raffle is copied with all nested reservations, timestamps, ticket allocations, print counts, winners, draw exclusions and summaries preserved. The original aggregate remains untouched during cutover.

## Deferred future items

- Tenant accounts, organisation membership, role-based permissions and separate admin credentials.
- Search/filter by organisation, venue or raffle in Active and History.
- Venue address/suburb and richer organisation profiles.
- Real Epson TM-P20II-801 integration and completion only after physical printer success.
- Square integration, customer names, online sales and financial reconciliation.
- Seller reports, exports and normalized high-volume sale/ticket tables after club-scale load testing.
- PWA/native distribution, QR joining and carefully designed offline resilience.
- Backups, retention, recovery, monitoring and operational controls appropriate for live cash events.

## Explicitly out of scope

Tenant authentication, offline selling, payment processing, real printer control, custom bundle quantities at sale time, addresses, app-store distribution and online ticket sales.

## September 2026 ticket enhancement

- Raffle menu uses a one-rem gap between the status card and Join Raffle.
- Optional cause (250 characters) and website (300 characters) are saved in each raffle's existing JSON payload; no database migration or backfill is needed. They follow existing settings locks and remain in history.
- Create/edit now includes a required sample-ticket review step with all three bundles selectable. Back preserves unsaved settings; preview never reserves tickets or creates a raffle.
- One shared ticket renderer displays organisation, event, venue, time, ranges, every individual number, quantity, amount, fundraising text, website and QR.
- Plain domains default to HTTPS. Only HTTP(S) links without credentials are accepted. QR URLs preserve query parameters/fragments and replace utm_source=raffle, utm_medium=qr, utm_campaign=<event name>. The visible website omits query and fragment. Analytics must be configured on the destination site to report visits; generating/scanning the code is not itself an app analytics event.
- Epson TM-P20II-801 (C31CJ99801) is Bluetooth. Specification sheet: 58 mm thermal paper, 203 dpi, no auto cutter. Epson technical reference: 48 mm / 384 dots printable width. Receipt uses monochrome, 5 mm side margins, wrapping content, and no clipped scrolling number list. QR has four-module quiet zone, medium error correction and integer dots per module (minimum three), capped at 384 dots.
- Actual printing remains explicitly simulated. Mixed iOS/Android Bluetooth printing needs an Epson-supported companion/native integration and hardware acceptance testing. Browser print stylesheet assumes a 58 mm roll driver at 100% scale, no browser headers/footers. No claim of hardware compatibility is made from CSS alone.
- Hardware acceptance: pair each phone platform, verify full ticket and long/non-contiguous numbers, scan QR from paper and inspect tags, confirm tear-off feed, and exercise failed-print/retry without duplicate sales.

References: supplied TM-P20II Specification_Sheet.pdf; https://files.support.epson.com/pdf/pos/bulk/tm-p20ii_trg_en_reve.pdf ; https://github.com/soldair/node-qrcode
