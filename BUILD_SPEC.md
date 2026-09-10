# Lions Raffle System — MVP Build Spec

## Product goal

A mobile-first web app for running one in-person Lions raffle from seller phones. The app handles ticket allocation, simulated printing, voids, drawing and history; payment is collected separately (no Square integration). The live MVP uses Supabase for authoritative persistence and shared-device updates.

## Locked MVP decisions

### Raffle setup and access

- Only one raffle may be active at a time.
- Anyone may create a raffle. If one is active, the landing screen offers **Join Raffle** and **Admin / Draw**.
- Both seller and admin entry use the same organiser-chosen four-digit numeric PIN.
- Raffle name defaults to **Meat Raffle** and is editable.
- Creation date/time is automatic and local. There is no venue field.
- The organiser chooses the starting ticket number; ticket numbers then have no configured upper limit.
- Prize count is required, has no default and must be at least one. Labels are **Prize 1**, **Prize 2**, etc. All prizes share one ticket pool.
- There are exactly three configurable bundle buttons, defaulting to **5 tickets / $10**, **15 tickets / $20**, and **50 tickets / $50**. No custom quantities.
- Name, PIN, starting number, prize count and bundle settings remain editable until the first sale is completed, then lock for that raffle.

### Seller identity and selling

- A seller joins with a unique name plus raffle PIN. Names are unique within the raffle.
- The device remembers and automatically reuses that seller identity for the active raffle. No seller switching is needed for MVP.
- The seller screen shows the three bundle actions and total valid tickets sold, but not expected revenue or the next available ticket number.
- Selecting a bundle opens confirmation. No number is reserved until **Confirm**.
- Confirm creates a two-minute reservation. Allocation is atomic and server-authoritative in Supabase; concurrent requests may be ordered by the server as long as no number is duplicated.
- Allocation uses the lowest reusable numbers first, including partial gaps, may span multiple ranges, and issues new higher numbers only after every reusable lower number is exhausted.
- An unprinted reservation is not a sale. It expires after two minutes and its numbers return to reusable inventory.
- **Print** is the commit point. In the demo it simulates success; a successful print completes and locks the sale immediately. A failed future printer attempt leaves the reservation active for retry. **Reprint** never allocates again.
- **Done** only dismisses a successfully printed result and cannot dismiss an unprinted reservation.
- The result shows fixed club name **Lions Club of Green Point - Avoca**, raffle name, automatic local date/time, a compact range summary, every individual ticket number, quantity, amount paid, **Thanks for your support!**, Print/Reprint and Done.

### Voids

- While the raffle is in Selling mode, each seller may void only their own most recent completed sale, including after Done.
- Voiding immediately reduces total valid tickets sold and expected revenue.
- Voided ticket numbers return to reusable inventory and are preferentially reallocated from the lowest number upward.
- Sales and voids are disabled in Draw mode and after the raffle ends.

### Admin and draw

- Admin shows first ticket, highest ticket ever issued, total valid tickets sold, expected sales value and sales count/revenue by bundle. There is no sales-by-seller report.
- Admin clearly warns when missing/unreused numbers make the first-to-highest range unsafe for a third-party draw and lists the missing ranges. The built-in draw remains safe.
- **Start Draw** is explicit and is blocked while any active unprinted reservation remains (after expiry cleanup).
- Draw mode pauses selling and voids. Admin may return to Selling only when no unresolved candidate exists.
- Confirmed winners stay locked when returning to Selling. Tickets sold later are eligible only for the remaining prizes.
- Built-in draw selects uniformly from the exact currently valid sold ticket pool and excludes every ticket number previously drawn in that raffle.
- Each unfilled prize has **Draw candidate**. A candidate must be resolved with **Confirm Winner** or **Redraw**.
- A redrawn/unclaimed ticket remains excluded permanently. The redraw produces a new candidate for the same prize.
- Undoing a confirmed winner requires confirmation, un-fills that prize, and the undone ticket remains excluded permanently.
- Once all prizes are filled, the app offers **End Raffle**.

### Ending and history

- End Raffle requires confirmation, is permanent for MVP, and moves the raffle to History.
- The final read-only summary shows raffle name, created and ended local date/time, total valid tickets sold, first ticket, highest issued, expected sales value, bundle breakdown, voided ticket count and the confirmed winner for every prize. It does not list every sale.
- History is available without a PIN and is ordered newest first.
- Anyone may delete a completed raffle with a simple confirmation. Deleted history is permanently removed.

## Data and delivery architecture

- Next.js App Router application, mobile-first and suitable for Vercel.
- All UI changes go through the server; no localStorage selling fallback.
- A private, versioned Supabase JSONB aggregate is updated using atomic compare-and-swap. Contending commands reload and recompute; only committed responses are shown. This serializes reservations, printing, voids, draws and active-raffle creation together.
- Opaque HttpOnly device cookies, server-stored roles, salted PIN hashes, persistent PIN rate limits and idempotency receipts protect server actions. The service key stays server-only. Devices refresh shared state every three seconds.
- No offline selling: production selling must pause when the authoritative backend cannot be reached.

## Post-MVP decisions to revisit

Implementation edge cases: settings changes wait for active reservations to be cancelled or expired; a sale containing a confirmed winner cannot be voided; an exhausted redraw resolves the rejected candidate and permits returning to Selling. Undo is available in Draw mode after resolving any candidate. Voiding the latest sale does not expose an earlier sale as a new undo target.

Brand implementation uses Lions blue `#00338D`, yellow `#EBB700`, purple `#7A2582`, navy `#0D2240` and Roboto from the supplied guidelines. The generic ticket icon is not a Lions emblem; do not imitate or modify the official logo.

- Load-test the live aggregate beyond club scale, consider a normalized relational model, and verify simultaneous use on multiple physical phones and networks.
- Review resource caps, PIN protections, backups, retention, audit logging and public create/delete access before operational use.
- Integrate and test the Epson TM-P20II-801 across Bluetooth/Wi-Fi, iPhone and Android; complete a sale only after a real printer success response.
- Add a configurable club name instead of the fixed Green Point–Avoca name.
- Reconsider separate admin permissions/PIN and stronger deletion authorization.
- Reconsider reopening ended raffles and recovery from accidental deletion.
- Allow more than three bundles and optional custom quantities/maximum transaction size.
- Add venue/location, QR join, seller switching, seller sales breakdown, full sale audit views and exports.
- Investigate Square integration, customer names, online raffle sales and richer financial reporting.
- Consider a PWA/installable experience and later native app distribution.
- Evaluate offline resilience only if a safe multi-device allocation design is available.
- Decide whether an undone confirmed winner should ever become eligible again; MVP deliberately keeps it excluded.

## Explicitly out of scope

Real printer integration, Square integration, custom quantities, venue, seller sales breakdown, app-store distribution, online customer sales and offline selling.
