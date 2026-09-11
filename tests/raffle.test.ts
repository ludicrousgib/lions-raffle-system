import assert from "node:assert/strict";
import test from "node:test";
import {
  completePrint,
  confirmWinner,
  createRaffle,
  defaultDraft,
  drawCandidate,
  expireReservations,
  raffleStats,
  reserveBundle,
  startDraw,
  undoWinner,
  voidLatestSale,
} from "../lib/raffle.ts";

function setup(startingTicket = 1, prizeCount = 2) {
  const raffle = createRaffle({ ...defaultDraft, pin: "1234", organisationId: "org-1", venueId: "venue-1", startingTicket, prizeCount });
  raffle.sellers.push(
    { id: "seller-a", name: "Alex", joinedAt: new Date(0).toISOString() },
    { id: "seller-b", name: "Billie", joinedAt: new Date(0).toISOString() },
  );
  return raffle;
}

test("allocator fills the lowest reusable gap and then spans into new numbers", () => {
  const raffle = setup(501);
  const first = reserveBundle(raffle, "seller-a", "bundle_2");
  completePrint(raffle, first.id);
  const second = reserveBundle(raffle, "seller-b", "bundle_3");
  completePrint(raffle, second.id);
  voidLatestSale(raffle, "seller-a", first.id);

  const reuse = reserveBundle(raffle, "seller-a", "bundle_1");
  assert.deepEqual(reuse.ticketNumbers, [501, 502, 503, 504, 505]);
  completePrint(raffle, reuse.id);
  const spanning = reserveBundle(raffle, "seller-a", "bundle_2");
  assert.deepEqual(spanning.ticketNumbers, [506, 507, 508, 509, 510, 511, 512, 513, 514, 515, 566, 567, 568, 569, 570]);
});

test("expired unprinted reservations return their numbers to inventory", () => {
  const raffle = setup();
  const start = new Date("2026-09-10T10:00:00Z");
  reserveBundle(raffle, "seller-a", "bundle_1", start);
  assert.equal(expireReservations(raffle, new Date(start.getTime() + 120_001)), 1);
  const next = reserveBundle(raffle, "seller-b", "bundle_2", new Date(start.getTime() + 120_002));
  assert.deepEqual(next.ticketNumbers, Array.from({ length: 15 }, (_, index) => index + 1));
});

test("printing completes the sale and locks raffle settings", () => {
  const raffle = setup();
  const reservation = reserveBundle(raffle, "seller-a", "bundle_1");
  assert.equal(raffleStats(raffle).totalTickets, 0);
  completePrint(raffle, reservation.id);
  assert.equal(raffleStats(raffle).totalTickets, 5);
  assert.equal(raffle.settingsLocked, true);
});

test("draw candidates come only from valid sold tickets and never repeat", () => {
  const raffle = setup();
  const reservation = reserveBundle(raffle, "seller-a", "bundle_1");
  completePrint(raffle, reservation.id);
  startDraw(raffle);
  const first = drawCandidate(raffle);
  assert.ok(reservation.ticketNumbers.includes(first.ticketNumber));
  confirmWinner(raffle);
  const second = drawCandidate(raffle);
  assert.notEqual(second.ticketNumber, first.ticketNumber);
});

test("undoing a winner leaves that ticket excluded", () => {
  const raffle = setup();
  const reservation = reserveBundle(raffle, "seller-a", "bundle_1");
  completePrint(raffle, reservation.id);
  startDraw(raffle);
  const first = drawCandidate(raffle);
  confirmWinner(raffle);
  undoWinner(raffle, raffle.winners[0].id);
  const replacement = drawCandidate(raffle);
  assert.notEqual(replacement.ticketNumber, first.ticketNumber);
});
