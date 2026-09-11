import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRaffleCommand,
  hashPin,
  publicRaffle,
  type Command,
  type RaffleRuntime,
} from "../lib/live-engine.ts";
import { createRaffle, currentCandidate, defaultDraft, raffleStats } from "../lib/raffle.ts";

const names = { organisationName: "Lions Club", venueName: "Community Hall" };

function setup(id: string, name = "Meat Raffle", pin = "1234") {
  const raffle = createRaffle({
    ...defaultDraft,
    name,
    pin,
    organisationId: "org-1",
    venueId: "venue-1",
    prizeCount: 1,
  }, new Date("2026-09-11T10:00:00Z"), id);
  raffle.pin = hashPin(raffle.pin);
  const runtime: RaffleRuntime = { raffle, sessions: {}, requests: {}, audit: [] };
  const run = (key: string, action: string, values: Partial<Command> = {}, at = new Date("2026-09-11T10:01:00Z")) => {
    const next = structuredClone(runtime);
    const result = applyRaffleCommand(next, key, { action, raffleId: id, requestId: crypto.randomUUID(), ...values }, names, at);
    Object.assign(runtime, next);
    return result;
  };
  return { runtime, run };
}

test("same PIN, ticket numbers and seller names remain independent between raffles", () => {
  const first = setup("raffle-first", "Friday Meat Raffle");
  const second = setup("raffle-second", "Friday Seafood Raffle");
  first.run("phone-a", "join", { pin: "1234", name: "Alex" });
  second.run("phone-a", "join", { pin: "1234", name: "Alex" });
  assert.notEqual(first.runtime.sessions["phone-a"].sellerId, second.runtime.sessions["phone-a"].sellerId);

  const firstSale = first.run("phone-a", "reserve", { targetId: "bundle_1" })!;
  const secondSale = second.run("phone-a", "reserve", { targetId: "bundle_1" })!;
  assert.deepEqual(first.runtime.raffle.reservations.find((item) => item.id === firstSale)!.ticketNumbers, [1, 2, 3, 4, 5]);
  assert.deepEqual(second.runtime.raffle.reservations.find((item) => item.id === secondSale)!.ticketNumbers, [1, 2, 3, 4, 5]);
  first.run("phone-a", "print", { targetId: firstSale });
  assert.equal(raffleStats(first.runtime.raffle).totalTickets, 5);
  assert.equal(raffleStats(second.runtime.raffle).totalTickets, 0);
});

test("matching seller names in one raffle reuse identity and share latest-sale void rules", () => {
  const { runtime, run } = setup("raffle-shared-seller");
  run("phone-a", "join", { pin: "1234", name: "Alex Smith" });
  assert.throws(() => run("phone-b", "join", { pin: "1234", name: "  ALEX   SMITH " }), /already used/);
  run("phone-b", "join", { pin: "1234", name: "  ALEX   SMITH ", confirmDuplicate: true });
  assert.equal(runtime.sessions["phone-a"].sellerId, runtime.sessions["phone-b"].sellerId);
  assert.equal(runtime.raffle.sellers.length, 1);
  const sale = run("phone-a", "reserve", { targetId: "bundle_1" })!;
  run("phone-a", "print", { targetId: sale });
  run("phone-b", "void", { targetId: sale });
  assert.equal(raffleStats(runtime.raffle).totalTickets, 0);
  run("phone-a", "admin");
  assert.throws(() => run("phone-a", "delete-active"), /Type DELETE/);
  assert.equal(run("phone-a", "delete-active", { confirmDelete: "DELETE" }), runtime.raffle.id);
});

test("void gaps, reservations, expiry and draw mode are scoped to one raffle", () => {
  const first = setup("raffle-one");
  const second = setup("raffle-two");
  for (const item of [first, second]) {
    item.run("seller", "join", { pin: "1234", name: "Taylor" });
    item.run("admin", "admin", { pin: "1234" });
  }
  const firstSale = first.run("seller", "reserve", { targetId: "bundle_1" })!;
  first.run("seller", "print", { targetId: firstSale });
  first.run("seller", "void", { targetId: firstSale });
  const firstReuse = first.run("seller", "reserve", { targetId: "bundle_1" })!;
  assert.deepEqual(first.runtime.raffle.reservations.find((item) => item.id === firstReuse)!.ticketNumbers, [1, 2, 3, 4, 5]);
  first.run("seller", "print", { targetId: firstReuse });
  first.run("admin", "start");
  assert.equal(first.runtime.raffle.status, "drawing");
  assert.equal(second.runtime.raffle.status, "selling");
  const secondSale = second.run("seller", "reserve", { targetId: "bundle_2" })!;
  assert.deepEqual(second.runtime.raffle.reservations.find((item) => item.id === secondSale)!.ticketNumbers, Array.from({ length: 15 }, (_, index) => index + 1));
});

test("request receipts are per raffle and retrying cannot duplicate a sale", () => {
  const { runtime, run } = setup("raffle-idempotent");
  run("seller", "join", { pin: "1234", name: "Robin" });
  const requestId = crypto.randomUUID();
  const first = run("seller", "reserve", { targetId: "bundle_1", requestId });
  assert.equal(run("seller", "reserve", { targetId: "bundle_1", requestId }), first);
  assert.equal(runtime.raffle.reservations.length, 1);
  const printId = crypto.randomUUID();
  run("seller", "print", { targetId: first!, requestId: printId });
  run("seller", "print", { targetId: first!, requestId: printId });
  assert.equal(runtime.raffle.reservations[0].printCount, 1);
});

test("organisation and venue names snapshot at end while active names stay live", () => {
  const { runtime, run } = setup("raffle-snapshot");
  run("seller", "join", { pin: "1234", name: "Casey" });
  run("admin", "admin", { pin: "1234" });
  const sale = run("seller", "reserve", { targetId: "bundle_1" })!;
  run("seller", "print", { targetId: sale });
  run("admin", "start");
  run("admin", "draw");
  run("admin", "confirm", { targetId: currentCandidate(runtime.raffle)!.id });
  run("admin", "end");
  const publicResult = publicRaffle(runtime, "visitor", { organisationName: "Renamed later", venueName: "New venue name" });
  assert.equal(publicResult.organisationName, "Lions Club");
  assert.equal(publicResult.venueName, "Community Hall");
  assert.deepEqual(runtime.sessions, {});
});

test("settings including organisation and venue lock after the first completed sale", () => {
  const { run } = setup("raffle-locked");
  run("seller", "join", { pin: "1234", name: "Morgan" });
  run("admin", "admin", { pin: "1234" });
  const sale = run("seller", "reserve", { targetId: "bundle_1" })!;
  run("seller", "print", { targetId: sale });
  assert.throws(() => run("admin", "edit", { draft: { ...defaultDraft, pin: "9999", organisationId: "org-2", venueId: "venue-2", prizeCount: 1 } }), /locked/);
});
