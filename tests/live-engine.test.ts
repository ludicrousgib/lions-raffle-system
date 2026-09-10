import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand, publicState, type Command, type Store } from "../lib/live-engine.ts";
import { emptyState, defaultDraft, currentCandidate, raffleStats } from "../lib/raffle.ts";

function setup() {
  const store: Store = { state: structuredClone(emptyState), sessions: {}, requests: {} };
  const run = (key: string, action: string, values: Partial<Command> = {}, at = new Date()) => {
    // Match the API's transaction boundary: failed commands are never persisted.
    const next = structuredClone(store);
    const result = applyCommand(next, key, { action, raffleId: store.state.activeRaffle?.id, requestId: crypto.randomUUID(), ...values }, at);
    Object.assign(store, next);
    return result;
  };
  run("admin", "create", { draft: { ...defaultDraft, pin: "1234", prizeCount: 2 } });
  run("a", "join", { pin: "1234", name: "Alice" });
  run("b", "join", { pin: "1234", name: "Bob" });
  return { store, run };
}

test("PINs and session credentials never reach public responses; roles are enforced", () => {
  const { store, run } = setup();
  const view = publicState(store, "visitor");
  assert.equal(view.state.activeRaffle!.pin, "");
  assert.deepEqual(view.state.activeRaffle!.sellers, []);
  assert.deepEqual(view.state.deviceSellers, {});
  assert.throws(() => run("visitor", "admin", { pin: "0000" }), /PIN/);
  assert.throws(() => run("a", "start"), /Admin/);
  assert.throws(() => run("visitor", "reserve", { targetId: "bundle_1" }), /PIN/);
  assert.throws(() => run("visitor", "join", { pin: "1234", name: "ALICE" }), /already/);
  assert.throws(() => run("visitor", "create", { draft: { ...defaultDraft, pin: "1234", prizeCount: 1 } }), /already active/);
});

test("retrying the same request cannot duplicate a reservation or print", () => {
  const { store, run } = setup();
  const requestId = crypto.randomUUID();
  const first = run("a", "reserve", { targetId: "bundle_1", requestId });
  assert.equal(run("a", "reserve", { targetId: "bundle_1", requestId }), first);
  assert.equal(store.state.activeRaffle!.reservations.length, 1);
  const printId = crypto.randomUUID();
  run("a", "print", { targetId: first!, requestId: printId });
  run("a", "print", { targetId: first!, requestId: printId });
  assert.equal(store.state.activeRaffle!.reservations[0].printCount, 1);
  assert.throws(() => run("b", "void", { targetId: first! }), /own sale/);
});

test("settings cannot reset numbering over a live reservation and stay locked after void", () => {
  const { store, run } = setup();
  const id = run("a", "reserve", { targetId: "bundle_1" })!;
  assert.throws(() => run("admin", "edit", { draft: { ...defaultDraft, pin: "9999", prizeCount: 1 } }), /unprinted/);
  run("a", "print", { targetId: id });
  run("a", "void", { targetId: id });
  assert.equal(raffleStats(store.state.activeRaffle!).totalTickets, 0);
  assert.equal(raffleStats(store.state.activeRaffle!).expectedRevenue, 0);
  assert.throws(() => run("admin", "edit", { draft: { ...defaultDraft, pin: "9999", prizeCount: 1 } }), /locked/);
});

test("expired reservations cannot print; recycled gaps precede new numbers", () => {
  const { store, run } = setup();
  const at = new Date();
  const first = run("a", "reserve", { targetId: "bundle_1" }, at)!;
  const next = new Date(at.getTime() + 120001);
  assert.throws(() => run("a", "print", { targetId: first }, next), /expired/);
  const reused = run("b", "reserve", { targetId: "bundle_2" }, next);
  assert.deepEqual(store.state.activeRaffle!.reservations.find(r => r.id === reused)!.ticketNumbers, Array.from({ length: 15 }, (_, i) => i + 1));
});

test("draw transitions protect pending sales, candidate identity and confirmed winners", () => {
  const { store, run } = setup();
  const sale = run("a", "reserve", { targetId: "bundle_1" })!;
  assert.throws(() => run("admin", "start"), /unprinted/);
  run("a", "print", { targetId: sale });
  run("admin", "start");
  assert.throws(() => run("a", "void", { targetId: sale }), /drawing/);
  run("admin", "draw");
  const candidate = currentCandidate(store.state.activeRaffle!)!;
  assert.throws(() => run("admin", "selling"), /candidate/);
  assert.throws(() => run("admin", "confirm", { targetId: "stale" }), /changed/);
  run("admin", "confirm", { targetId: candidate.id });
  run("admin", "selling");
  assert.equal(store.state.activeRaffle!.winners[0].ticketNumber, candidate.ticketNumber);
  assert.throws(() => run("a", "void", { targetId: sale }), /confirmed winning/);
  const more = run("b", "reserve", { targetId: "bundle_1" })!;
  run("b", "print", { targetId: more });
  run("admin", "start");
  run("admin", "draw");
  const second = currentCandidate(store.state.activeRaffle!)!;
  assert.notEqual(second.ticketNumber, candidate.ticketNumber);
  run("admin", "confirm", { targetId: second.id });
  run("admin", "end");
  assert.equal(store.state.activeRaffle, null);
  assert.equal(store.state.history[0].winners.length, 2);
  assert.throws(() => run("admin", "selling"), /changed/);
  run("visitor", "delete", { targetId: store.state.history[0].id });
  assert.equal(store.state.history.length, 0);
});

test("redrawing the last eligible ticket resolves it and allows Selling to resume", () => {
  const { store, run } = setup();
  const sale = run("a", "reserve", { targetId: "bundle_1" })!;
  run("a", "print", { targetId: sale });
  run("admin", "start");
  run("admin", "draw");
  for (let i = 0; i < 5; i++) {
    run("admin", "redraw", { targetId: currentCandidate(store.state.activeRaffle!)!.id });
  }
  assert.equal(currentCandidate(store.state.activeRaffle!), undefined);
  assert.equal(new Set(store.state.activeRaffle!.drawEvents.map(e => e.ticketNumber)).size, 5);
  run("admin", "selling");
  assert.equal(store.state.activeRaffle!.status, "selling");
});
