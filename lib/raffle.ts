import { normaliseWebsite, ticketLink, ticketQr } from "./ticket.ts";
export const DEFAULT_ORGANISATION_NAME = "Lions Club of Green Point - Avoca";
export const LEGACY_VENUE_NAME = "Not specified";
export const RESERVATION_MS = 2 * 60 * 1000;

export type RaffleStatus = "selling" | "drawing" | "ended";
export type ReservationStatus = "active" | "completed" | "expired" | "cancelled" | "voided";

export type Organisation = { id: string; name: string; archivedAt?: string };
export type Venue = { id: string; name: string; archivedAt?: string };
export type Bundle = { id: string; quantity: number; price: number };
export type Seller = { id: string; name: string; joinedAt: string };

export type Reservation = {
  id: string;
  sellerId: string;
  bundleId: string;
  quantity: number;
  amount: number;
  ticketNumbers: number[];
  createdAt: string;
  expiresAt: string;
  status: ReservationStatus;
  completedAt?: string;
  voidedAt?: string;
  printCount: number;
};

export type Winner = { id: string; prizeNumber: number; ticketNumber: number; confirmedAt: string };
export type DrawEvent = {
  id: string;
  prizeNumber: number;
  ticketNumber: number;
  drawnAt: string;
  outcome: "candidate" | "confirmed" | "redrawn" | "undone";
  resolvedAt?: string;
};

export type Raffle = {
  id: string;
  name: string;
  cause?: string;
  website?: string;
  pin: string;
  organisationId: string;
  venueId: string;
  organisationName: string;
  venueName: string;
  organisationNameSnapshot?: string;
  venueNameSnapshot?: string;
  startingTicket: number;
  highestIssued: number;
  prizeCount: number;
  bundles: Bundle[];
  createdAt: string;
  endedAt?: string;
  status: RaffleStatus;
  settingsLocked: boolean;
  sellers: Seller[];
  reservations: Reservation[];
  winners: Winner[];
  drawEvents: DrawEvent[];
  currentCandidateId?: string;
};

export type RaffleAccess = { pinRemembered: boolean; admin: boolean; sellerId?: string };
export type AppState = {
  version: 2;
  activeRaffles: Raffle[];
  history: Raffle[];
  organisations: Organisation[];
  venues: Venue[];
  accessByRaffle: Record<string, RaffleAccess>;
};
export type DemoState = AppState;

export type RaffleDraft = {
  name: string;
  cause?: string;
  website?: string;
  pin: string;
  organisationId: string;
  venueId: string;
  startingTicket: number;
  prizeCount: number;
  bundles: Array<{ quantity: number; price: number }>;
};

export const defaultDraft: RaffleDraft = {
  name: "Meat Raffle",
  cause: "",
  website: "",
  pin: "",
  organisationId: "",
  venueId: "",
  startingTicket: 1,
  prizeCount: 0,
  bundles: [
    { quantity: 5, price: 10 },
    { quantity: 15, price: 20 },
    { quantity: 50, price: 50 },
  ],
};

export const emptyState: AppState = {
  version: 2,
  activeRaffles: [],
  history: [],
  organisations: [],
  venues: [],
  accessByRaffle: {},
};

export function id(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}_${random}`;
}

export function normaliseName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-AU");
}

export function validateDraft(draft: RaffleDraft, options?: { requirePin?: boolean }): string | null {
  const requirePin = options?.requirePin ?? true;
  if (draft.cause !== undefined && (typeof draft.cause !== "string" || draft.cause.length > 250)) return "Keep the cause under 250 characters.";
  if (draft.website !== undefined && typeof draft.website !== "string") return "Enter a valid website.";
  try { const link = ticketLink(draft.website ?? "", draft.name); if (link) ticketQr(link.url); }
  catch (error) { return error instanceof Error ? error.message : "Enter a valid website."; }
  if (!draft.name.trim()) return "Enter a raffle name.";
  if (draft.name.length > 100) return "Keep the raffle name under 100 characters.";
  if (!draft.organisationId) return "Choose an organisation.";
  if (!draft.venueId) return "Choose a venue.";
  if ((draft.pin || requirePin) && !/^\d{4}$/.test(draft.pin)) return "PIN must be exactly four digits.";
  if (!Number.isSafeInteger(draft.startingTicket) || draft.startingTicket < 1 || draft.startingTicket > 1000000000) return "Starting ticket must be a whole number from 1 to 1 billion.";
  if (!Number.isInteger(draft.prizeCount) || draft.prizeCount < 1 || draft.prizeCount > 1000) return "Enter between 1 and 1,000 prizes.";
  if (draft.bundles.length < 1 || draft.bundles.length > 10) return "Choose between 1 and 10 ticket bundles.";
  if (draft.bundles.some((bundle) => !bundle || !Number.isInteger(bundle.quantity) || bundle.quantity < 1 || bundle.quantity > 1000 || !Number.isFinite(bundle.price) || bundle.price <= 0 || bundle.price > 10000 || Math.abs(bundle.price * 100 - Math.round(bundle.price * 100)) > 0.00001)) {
    return "Every bundle needs a valid quantity and price.";
  }
  return null;
}

export function createRaffle(draft: RaffleDraft, at = new Date(), raffleId = id("raffle")): Raffle {
  const error = validateDraft(draft);
  if (error) throw new Error(error);
  return {
    id: raffleId,
    name: draft.name.trim(),
    cause: draft.cause?.trim() ?? "",
    website: normaliseWebsite(draft.website ?? ""),
    pin: draft.pin,
    organisationId: draft.organisationId,
    venueId: draft.venueId,
    organisationName: "",
    venueName: "",
    startingTicket: draft.startingTicket,
    highestIssued: draft.startingTicket - 1,
    prizeCount: draft.prizeCount,
    bundles: draft.bundles.map((bundle, index) => ({ id: `bundle_${index + 1}`, ...bundle })),
    createdAt: at.toISOString(),
    status: "selling",
    settingsLocked: false,
    sellers: [],
    reservations: [],
    winners: [],
    drawEvents: [],
  };
}

export function expireReservations(raffle: Raffle, at = new Date()): number {
  let expired = 0;
  for (const reservation of raffle.reservations) {
    if (reservation.status === "active" && new Date(reservation.expiresAt).getTime() <= at.getTime()) {
      reservation.status = "expired";
      expired += 1;
    }
  }
  return expired;
}

export function validSales(raffle: Raffle) {
  return raffle.reservations.filter((reservation) => reservation.status === "completed");
}

export function activeReservations(raffle: Raffle, at = new Date()) {
  expireReservations(raffle, at);
  return raffle.reservations.filter((reservation) => reservation.status === "active");
}

export function reserveBundle(raffle: Raffle, sellerId: string, bundleId: string, at = new Date()): Reservation {
  expireReservations(raffle, at);
  if (raffle.status !== "selling") throw new Error("Sales are paused while the raffle is in Draw mode.");
  if (!raffle.sellers.some((seller) => seller.id === sellerId)) throw new Error("Seller is not joined to this raffle.");
  if (raffle.reservations.some((reservation) => reservation.sellerId === sellerId && reservation.status === "active")) throw new Error("Print or cancel this seller’s current reservation first.");
  const bundle = raffle.bundles.find((item) => item.id === bundleId);
  if (!bundle) throw new Error("That bundle is no longer available.");
  if (raffle.highestIssued - raffle.startingTicket + bundle.quantity > 100000) throw new Error("This MVP supports up to 100,000 issued tickets per raffle.");

  const occupied = new Set<number>();
  for (const reservation of raffle.reservations) {
    if (reservation.status === "active" || reservation.status === "completed") reservation.ticketNumbers.forEach((ticket) => occupied.add(ticket));
  }
  const ticketNumbers: number[] = [];
  for (let ticket = raffle.startingTicket; ticket <= raffle.highestIssued && ticketNumbers.length < bundle.quantity; ticket += 1) if (!occupied.has(ticket)) ticketNumbers.push(ticket);
  while (ticketNumbers.length < bundle.quantity) {
    raffle.highestIssued += 1;
    ticketNumbers.push(raffle.highestIssued);
  }
  const reservation: Reservation = {
    id: id("reservation"), sellerId, bundleId, quantity: bundle.quantity, amount: bundle.price,
    ticketNumbers, createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + RESERVATION_MS).toISOString(), status: "active", printCount: 0,
  };
  raffle.reservations.push(reservation);
  return reservation;
}

export function completePrint(raffle: Raffle, reservationId: string, at = new Date()) {
  expireReservations(raffle, at);
  const reservation = raffle.reservations.find((item) => item.id === reservationId);
  if (!reservation) throw new Error("Reservation not found.");
  if (reservation.status === "completed") {
    reservation.printCount += 1;
    return reservation;
  }
  if (reservation.status !== "active") throw new Error("This reservation expired. Start the sale again.");
  reservation.status = "completed";
  reservation.completedAt = at.toISOString();
  reservation.printCount = 1;
  raffle.settingsLocked = true;
  return reservation;
}

export function cancelReservation(raffle: Raffle, reservationId: string) {
  const reservation = raffle.reservations.find((item) => item.id === reservationId);
  if (!reservation || reservation.status !== "active") throw new Error("This reservation can no longer be cancelled.");
  reservation.status = "cancelled";
}

export function latestCompletedSaleForSeller(raffle: Raffle, sellerId: string) {
  const latestFinalized = raffle.reservations.slice().reverse()
    .filter((sale) => sale.sellerId === sellerId && (sale.status === "completed" || sale.status === "voided"))
    .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime())[0];
  return latestFinalized?.status === "completed" ? latestFinalized : undefined;
}

export function voidLatestSale(raffle: Raffle, sellerId: string, reservationId: string, at = new Date()) {
  if (raffle.status !== "selling") throw new Error("Sales cannot be voided while drawing is underway.");
  const latest = latestCompletedSaleForSeller(raffle, sellerId);
  if (!latest || latest.id !== reservationId) throw new Error("Only this seller’s most recent completed sale can be voided.");
  const drawnTickets = new Set(raffle.winners.map((winner) => winner.ticketNumber));
  if (latest.ticketNumbers.some((ticket) => drawnTickets.has(ticket))) throw new Error("This sale contains a confirmed winning ticket and cannot be voided.");
  latest.status = "voided";
  latest.voidedAt = at.toISOString();
}

export function groupTicketNumbers(numbers: number[]) {
  if (numbers.length === 0) return [] as Array<{ start: number; end: number }>;
  const sorted = [...numbers].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === end + 1) end = sorted[index];
    else { ranges.push({ start, end }); start = sorted[index]; end = sorted[index]; }
  }
  ranges.push({ start, end });
  return ranges;
}

export function formatRanges(numbers: number[]) {
  return groupTicketNumbers(numbers).map(({ start, end }) => (start === end ? `${start}` : `${start}–${end}`)).join(", ");
}

export function raffleStats(raffle: Raffle) {
  const sales = validSales(raffle);
  const totalTickets = sales.reduce((sum, sale) => sum + sale.quantity, 0);
  const expectedRevenue = sales.reduce((sum, sale) => sum + sale.amount, 0);
  const voidedTickets = raffle.reservations.filter((reservation) => reservation.status === "voided").reduce((sum, reservation) => sum + reservation.quantity, 0);
  const bundleBreakdown = raffle.bundles.map((bundle) => {
    const matching = sales.filter((sale) => sale.bundleId === bundle.id);
    return { ...bundle, sales: matching.length, tickets: matching.reduce((sum, sale) => sum + sale.quantity, 0), revenue: matching.reduce((sum, sale) => sum + sale.amount, 0) };
  });
  const soldNumbers = new Set(sales.flatMap((sale) => sale.ticketNumbers));
  const missing: number[] = [];
  for (let ticket = raffle.startingTicket; ticket <= raffle.highestIssued; ticket += 1) if (!soldNumbers.has(ticket)) missing.push(ticket);
  return { totalTickets, expectedRevenue, voidedTickets, bundleBreakdown, missingNumbers: missing, missingRanges: formatRanges(missing) };
}

function secureRandomIndex(length: number) {
  if (length < 1) throw new Error("No eligible tickets remain.");
  if (!globalThis.crypto?.getRandomValues) return Math.floor(Math.random() * length);
  const ceiling = Math.floor(0x100000000 / length) * length;
  const value = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(value); while (value[0] >= ceiling);
  return value[0] % length;
}

export function nextUnfilledPrize(raffle: Raffle) {
  for (let prize = 1; prize <= raffle.prizeCount; prize += 1) if (!raffle.winners.some((winner) => winner.prizeNumber === prize)) return prize;
  return null;
}

export function currentCandidate(raffle: Raffle) {
  return raffle.drawEvents.find((event) => event.id === raffle.currentCandidateId && event.outcome === "candidate");
}

export function startDraw(raffle: Raffle, at = new Date()) {
  if (raffle.status !== "selling") return;
  if (activeReservations(raffle, at).length > 0) throw new Error("Wait for every unprinted reservation to be printed, cancelled or expired.");
  if (validSales(raffle).length === 0) throw new Error("Sell at least one ticket before starting the draw.");
  raffle.status = "drawing";
}

export function returnToSelling(raffle: Raffle) {
  if (raffle.status === "ended") throw new Error("This raffle is permanently ended.");
  if (currentCandidate(raffle)) throw new Error("Confirm or redraw the current candidate before returning to Selling.");
  raffle.status = "selling";
}

export function drawCandidate(raffle: Raffle, prizeNumber = nextUnfilledPrize(raffle), at = new Date()) {
  if (raffle.status !== "drawing") throw new Error("Start Draw before choosing a candidate.");
  if (currentCandidate(raffle)) throw new Error("Resolve the current candidate first.");
  if (!prizeNumber || raffle.winners.some((winner) => winner.prizeNumber === prizeNumber)) throw new Error("Choose an unfilled prize.");
  const excluded = new Set(raffle.drawEvents.map((event) => event.ticketNumber));
  const eligible = validSales(raffle).flatMap((sale) => sale.ticketNumbers).filter((ticket) => !excluded.has(ticket));
  if (eligible.length === 0) throw new Error("No eligible tickets remain to draw.");
  const event: DrawEvent = { id: id("draw"), prizeNumber, ticketNumber: eligible[secureRandomIndex(eligible.length)], drawnAt: at.toISOString(), outcome: "candidate" };
  raffle.drawEvents.push(event);
  raffle.currentCandidateId = event.id;
  return event;
}

export function confirmWinner(raffle: Raffle, at = new Date()) {
  if (raffle.status !== "drawing") throw new Error("Start Draw first.");
  const candidate = currentCandidate(raffle);
  if (!candidate) throw new Error("There is no candidate to confirm.");
  candidate.outcome = "confirmed";
  candidate.resolvedAt = at.toISOString();
  raffle.winners.push({ id: id("winner"), prizeNumber: candidate.prizeNumber, ticketNumber: candidate.ticketNumber, confirmedAt: at.toISOString() });
  delete raffle.currentCandidateId;
}

export function redrawCandidate(raffle: Raffle, at = new Date()) {
  if (raffle.status !== "drawing") throw new Error("Start Draw first.");
  const candidate = currentCandidate(raffle);
  if (!candidate) throw new Error("There is no candidate to redraw.");
  const prize = candidate.prizeNumber;
  candidate.outcome = "redrawn";
  candidate.resolvedAt = at.toISOString();
  delete raffle.currentCandidateId;
  const excluded = new Set(raffle.drawEvents.map((event) => event.ticketNumber));
  if (!validSales(raffle).some((sale) => sale.ticketNumbers.some((ticket) => !excluded.has(ticket)))) return undefined;
  return drawCandidate(raffle, prize, at);
}

export function undoWinner(raffle: Raffle, winnerId: string, at = new Date()) {
  if (raffle.status !== "drawing") throw new Error("Start Draw before undoing a winner.");
  if (currentCandidate(raffle)) throw new Error("Resolve the current candidate first.");
  const winner = raffle.winners.find((item) => item.id === winnerId);
  if (!winner) throw new Error("Winner not found.");
  const drawEvent = raffle.drawEvents.find((event) => event.prizeNumber === winner.prizeNumber && event.ticketNumber === winner.ticketNumber && event.outcome === "confirmed");
  if (drawEvent) { drawEvent.outcome = "undone"; drawEvent.resolvedAt = at.toISOString(); }
  raffle.winners = raffle.winners.filter((item) => item.id !== winnerId);
}

export function endRaffle(raffle: Raffle, organisationName: string, venueName: string, at = new Date()) {
  if (raffle.status !== "drawing") throw new Error("Finish the draw before ending the raffle.");
  if (raffle.winners.length !== raffle.prizeCount) throw new Error("Confirm a winner for every prize before ending the raffle.");
  if (currentCandidate(raffle)) throw new Error("Resolve the current candidate first.");
  raffle.status = "ended";
  raffle.endedAt = at.toISOString();
  raffle.organisationNameSnapshot = organisationName;
  raffle.venueNameSnapshot = venueName;
  raffle.organisationName = organisationName;
  raffle.venueName = venueName;
}

export function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
}

export function formatDateTime(iso?: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}
