import test from "node:test";
import assert from "node:assert/strict";
import { normaliseWebsite, ticketLink, ticketQr } from "../lib/ticket.ts";
import { createRaffle, defaultDraft, validateDraft } from "../lib/raffle.ts";
import { applyRaffleCommand, hashPin, type RaffleRuntime } from "../lib/live-engine.ts";
const draft = { ...defaultDraft, pin: "1234", organisationId: "org", venueId: "venue", prizeCount: 1 };
test("tracking preserves destination, encodes event names and replaces old tags", () => {
  const link = ticketLink("freetradeday.com.au/help?ref=club&utm_source=old#join", "Friday & Friends / 2026")!;
  const url = new URL(link.url);
  assert.equal(link.display, "freetradeday.com.au/help");
  assert.equal(url.searchParams.get("ref"), "club");
  assert.equal(url.hash, "#join");
  assert.equal(url.searchParams.get("utm_source"), "raffle");
  assert.equal(url.searchParams.get("utm_medium"), "qr");
  assert.equal(url.searchParams.get("utm_campaign"), "Friday & Friends / 2026");
});
test("reject unsafe URLs and oversized causes while supporting blank legacy fields", () => {
  for (const website of ["javascript:alert(1)", "data:text/html,hi", "https://user:pass@example.com", "not a website", "ftp://example.com"]) {
    assert.throws(() => normaliseWebsite(website));
    assert.ok(validateDraft({ ...draft, website }));
  }
  assert.ok(validateDraft({ ...draft, cause: "x".repeat(251) }));
  assert.equal(validateDraft(draft), null);
  assert.equal(ticketLink("", "Event"), null);
});
test("QR has quiet zone and integral dots within 48mm for long and Unicode links", () => {
  for (const website of ["https://freetradeday.com.au", `https://example.com/${"a".repeat(250)}`, "https://example.com/募金"]) {
    const link = ticketLink(website, "Community & friends")!;
    const qr = ticketQr(link.url);
    assert.ok(qr.path.startsWith("M4 4"));
    assert.ok(qr.widthMm <= 48);
    assert.ok(Number.isInteger(qr.widthMm * 8 / qr.size));
    assert.ok(qr.widthMm * 8 / qr.size >= 3);
  }
});
test("cause and website persist through create, edit, public data and sale locking", () => {
  const raffle = createRaffle({ ...draft, cause: "  Community meals  ", website: "example.com" });
  assert.equal(raffle.cause, "Community meals");
  assert.equal(raffle.website, "https://example.com/");
  raffle.pin = hashPin("1234");
  const runtime: RaffleRuntime = { raffle, sessions: { phone: { admin: true, pinRemembered: true } }, requests: {}, audit: [] };
  const command = { action: "edit", raffleId: raffle.id, requestId: crypto.randomUUID(), draft: { ...draft, cause: "Food bank", website: "example.org/help" } };
  applyRaffleCommand(runtime, "phone", command, { organisationName: "Club", venueName: "Hall" });
  assert.equal(raffle.cause, "Food bank");
  assert.equal(raffle.website, "https://example.org/help");
  raffle.settingsLocked = true;
  assert.throws(() => applyRaffleCommand(runtime, "phone", { ...command, requestId: crypto.randomUUID() }, { organisationName: "Club", venueName: "Hall" }), /locked/);
});
