import { normaliseWebsite } from "./ticket.ts";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  type Raffle,
  type RaffleDraft,
  cancelReservation,
  completePrint,
  confirmWinner,
  currentCandidate,
  drawCandidate,
  endRaffle,
  expireReservations,
  normaliseName,
  redrawCandidate,
  reserveBundle,
  returnToSelling,
  startDraw,
  undoWinner,
  validateDraft,
  voidLatestSale,
} from "./raffle.ts";

export type Session = { pinRemembered: true; sellerId?: string; admin?: boolean };
export type RequestReceipt = { result: string | null; at: number };
export type AuditEntry = { action: string; at: string; deviceKey: string; targetId?: string };

export type RaffleRuntime = {
  raffle: Raffle;
  sessions: Record<string, Session>;
  requests: Record<string, RequestReceipt>;
  audit: AuditEntry[];
};

export type Command = {
  action: string;
  raffleId?: string;
  requestId: string;
  pin?: string;
  name?: string;
  draft?: RaffleDraft;
  targetId?: string;
  confirmDuplicate?: boolean;
  confirmDelete?: string;
  entityType?: "organisation" | "venue";
  entityId?: string;
};

export class DomainError extends Error {
  readonly code: string;
  constructor(message: string, code = "INVALID_COMMAND") {
    super(message);
    this.code = code;
    this.name = "DomainError";
  }
}

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function hashPin(pin: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function matchesPin(pin: unknown, stored: string) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) return false;
  const [salt, value] = stored.split(":");
  if (!salt || !value) return false;
  const expected = Buffer.from(value, "hex");
  return expected.length === 32 && timingSafeEqual(scryptSync(pin, salt, 32), expected);
}

function checkedDraft(draft: RaffleDraft | undefined) {
  if (!draft || typeof draft.name !== "string" || typeof draft.pin !== "string" || !Array.isArray(draft.bundles)) throw new DomainError("Check the raffle settings.");
  const error = validateDraft(draft);
  if (error) throw new DomainError(error);
  return draft;
}

function requirePin(runtime: RaffleRuntime, key: string, pin: unknown) {
  const existing = runtime.sessions[key];
  if (existing?.pinRemembered) return existing;
  if (!matchesPin(pin, runtime.raffle.pin)) throw new DomainError("That PIN does not match this raffle.", "INCORRECT_PIN");
  const session: Session = { pinRemembered: true };
  runtime.sessions[key] = session;
  return session;
}

export function applyRaffleCommand(
  runtime: RaffleRuntime,
  key: string,
  command: Command,
  names: { organisationName: string; venueName: string },
  at = new Date(),
): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(command.requestId)) throw new DomainError("Invalid request. Refresh and try again.");
  if (runtime.raffle.id !== command.raffleId) throw new DomainError("That raffle is no longer available. Return to Raffles.", "RAFFLE_CHANGED");
  const requestKey = `${key}:${command.requestId}`;
  if (runtime.requests[requestKey]) return runtime.requests[requestKey].result;
  const raffle = runtime.raffle;
  expireReservations(raffle, at);
  if (raffle.status === "ended") throw new DomainError("This raffle has ended.", "RAFFLE_ENDED");

  let result: string | null = null;
  if (command.action === "join" || command.action === "admin") {
    const access = requirePin(runtime, key, command.pin);
    if (command.action === "admin") access.admin = true;
    else if (!access.sellerId) {
      const name = typeof command.name === "string" ? command.name.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
      if (!name || name.length > 60) throw new DomainError("Enter a seller name (up to 60 characters).");
      const matching = raffle.sellers.find((seller) => normaliseName(seller.name) === normaliseName(name));
      if (matching && !command.confirmDuplicate) {
        throw new DomainError("This name is already used in this raffle. Continue only if you are the same seller; sales and latest-sale void access will be shared.", "DUPLICATE_SELLER");
      }
      if (matching) access.sellerId = matching.id;
      else {
        const seller = { id: `seller_${randomBytes(16).toString("hex")}`, name, joinedAt: at.toISOString() };
        raffle.sellers.push(seller);
        access.sellerId = seller.id;
      }
    }
  } else {
    const session = runtime.sessions[key];
    if (!session?.pinRemembered) throw new DomainError("Enter this raffle’s PIN to continue.", "PIN_REQUIRED");
    const sellerActions = ["reserve", "print", "cancel", "void"];
    if (sellerActions.includes(command.action)) {
      if (!session.sellerId) throw new DomainError("Join as a seller first.");
      const target = raffle.reservations.find((reservation) => reservation.id === command.targetId);
      if (command.action !== "reserve" && target?.sellerId !== session.sellerId) throw new DomainError("You can only change sales for this seller identity.");
      switch (command.action) {
        case "reserve": result = reserveBundle(raffle, session.sellerId, command.targetId ?? "", at).id; break;
        case "print":
          if (raffle.status !== "selling" && target?.status !== "completed") throw new DomainError("Sales are paused.");
          completePrint(raffle, command.targetId!, at);
          break;
        case "cancel": cancelReservation(raffle, command.targetId!); break;
        case "void": voidLatestSale(raffle, session.sellerId, command.targetId!, at); break;
      }
    } else {
      if (!session.admin) throw new DomainError("Open Admin / Draw first.", "ADMIN_REQUIRED");
      switch (command.action) {
        case "edit": {
          if (raffle.settingsLocked || raffle.status !== "selling") throw new DomainError("Settings are locked after the first completed sale.");
          if (raffle.reservations.some((reservation) => reservation.status === "active")) throw new DomainError("Wait for unprinted reservations to expire or be cancelled before editing settings.");
          const draft = checkedDraft(command.draft);
          raffle.name = draft.name.trim();
          raffle.cause = draft.cause?.trim() ?? "";
          raffle.website = normaliseWebsite(draft.website ?? "");
          raffle.pin = hashPin(draft.pin);
          raffle.organisationId = draft.organisationId;
          raffle.venueId = draft.venueId;
          raffle.startingTicket = draft.startingTicket;
          raffle.highestIssued = draft.startingTicket - 1;
          raffle.prizeCount = draft.prizeCount;
          raffle.bundles = draft.bundles.map((bundle, index) => ({ ...bundle, id: `bundle_${index + 1}` }));
          raffle.reservations = [];
          break;
        }
        case "start": startDraw(raffle, at); break;
        case "selling": returnToSelling(raffle); break;
        case "draw": drawCandidate(raffle, undefined, at); break;
        case "confirm":
        case "redraw":
          if (currentCandidate(raffle)?.id !== command.targetId) throw new DomainError("The candidate changed. Review the current ticket first.");
          if (command.action === "confirm") confirmWinner(raffle, at);
          else redrawCandidate(raffle, at);
          break;
        case "undo": undoWinner(raffle, command.targetId!, at); break;
        case "end":
          endRaffle(raffle, names.organisationName, names.venueName, at);
          runtime.sessions = {};
          result = raffle.id;
          break;
        case "delete-active":
          if (raffle.reservations.some((sale) => Boolean(sale.completedAt)) && command.confirmDelete !== "DELETE") throw new DomainError("Type DELETE to confirm removal of a raffle with completed sales.", "DELETE_CONFIRMATION_REQUIRED");
          result = raffle.id;
          break;
        default: throw new DomainError("Unknown action.");
      }
    }
  }

  runtime.requests[requestKey] = { result, at: at.getTime() };
  runtime.audit.push({ action: command.action, at: at.toISOString(), deviceKey: key, targetId: command.targetId });
  if (runtime.audit.length > 5000) runtime.audit.splice(0, runtime.audit.length - 5000);
  for (const [receiptKey, receipt] of Object.entries(runtime.requests)) if (receipt.at < at.getTime() - 86400000) delete runtime.requests[receiptKey];
  return result;
}

export function publicRaffle(runtime: RaffleRuntime, key: string, names: { organisationName: string; venueName: string }, at = new Date()) {
  const raffle = structuredClone(runtime.raffle);
  raffle.pin = "";
  expireReservations(raffle, at);
  if (raffle.status === "ended") {
    raffle.organisationName = raffle.organisationNameSnapshot ?? names.organisationName;
    raffle.venueName = raffle.venueNameSnapshot ?? names.venueName;
    raffle.sellers = [];
  } else {
    raffle.organisationName = names.organisationName;
    raffle.venueName = names.venueName;
    const sellerId = runtime.sessions[key]?.sellerId;
    raffle.sellers = sellerId ? raffle.sellers.filter((seller) => seller.id === sellerId) : [];
  }
  return raffle;
}

export function accessFor(runtime: RaffleRuntime, key: string) {
  const session = runtime.raffle.status === "ended" ? undefined : runtime.sessions[key];
  return { pinRemembered: Boolean(session?.pinRemembered), admin: Boolean(session?.admin), sellerId: session?.sellerId };
}
