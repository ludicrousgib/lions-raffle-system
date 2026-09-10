import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  type DemoState, type Raffle, type RaffleDraft, cancelReservation, completePrint,
  confirmWinner, createRaffle, currentCandidate, drawCandidate, endRaffle,
  expireReservations, redrawCandidate, reserveBundle, returnToSelling, startDraw,
  undoWinner, validateDraft, voidLatestSale,
} from "./raffle.ts";

type Session = { raffleId: string; sellerId?: string; admin?: boolean; expiresAt: number };
export type Store = {
  state: DemoState;
  sessions: Record<string, Session>;
  requests: Record<string, { result: string | null; at: number }>;
};
export type Command = { action: string; raffleId?: string; requestId: string; pin?: string; name?: string; draft?: RaffleDraft; targetId?: string };
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function hashPin(pin: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

function matchesPin(pin: unknown, stored: string) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) return false;
  const [salt, value] = stored.split(":");
  if (!salt || !value) return false;
  const expected = Buffer.from(value, "hex");
  return expected.length === 32 && timingSafeEqual(scryptSync(pin, salt, 32), expected);
}

function checkedDraft(draft: RaffleDraft | undefined) {
  if (!draft || typeof draft.name !== "string" || typeof draft.pin !== "string" || !Array.isArray(draft.bundles)) throw new Error("Check the raffle settings.");
  const error = validateDraft(draft);
  if (error) throw new Error(error);
  return draft;
}

export function applyCommand(store: Store, key: string, command: Command, at = new Date()): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(command.requestId)) throw new Error("Invalid request. Refresh and try again.");
  const requestKey = `${key}:${command.requestId}`;
  if (store.requests[requestKey]) return store.requests[requestKey].result;
  const session = store.sessions[key]?.expiresAt > at.getTime() ? store.sessions[key] : undefined;
  const raffle = store.state.activeRaffle;
  let result: string | null = null;
  if (raffle) expireReservations(raffle, at);
  if (command.action === "create") {
    if (raffle) throw new Error("A raffle is already active. Finish it before creating another.");
    const fresh = createRaffle(checkedDraft(command.draft), at);
    fresh.pin = hashPin(fresh.pin);
    store.state.activeRaffle = fresh;
    store.sessions[key] = { raffleId: fresh.id, admin: true, expiresAt: at.getTime() + 30 * 86400000 };
    result = fresh.id;
  } else if (command.action === "delete") {
    if (!store.state.history.some(r => r.id === command.targetId)) throw new Error("This history entry has already been removed.");
    store.state.history = store.state.history.filter(r => r.id !== command.targetId);
  } else {
    if (!raffle || raffle.id !== command.raffleId) throw new Error("The active raffle has changed. Return to the home screen.");
    if (command.action === "join" || command.action === "admin") {
      if (!matchesPin(command.pin, raffle.pin)) throw new Error("That PIN does not match the active raffle.");
      const access: Session = session?.raffleId === raffle.id ? session : { raffleId: raffle.id, expiresAt: at.getTime() + 30 * 86400000 };
      if (command.action === "admin") access.admin = true;
      else if (!access.sellerId) {
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name || name.length > 60) throw new Error("Enter a seller name (up to 60 characters).");
        if (raffle.sellers.some(s => s.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("That seller name is already being used in this raffle.");
        const seller = { id: `seller_${randomBytes(16).toString("hex")}`, name, joinedAt: at.toISOString() };
        raffle.sellers.push(seller);
        access.sellerId = seller.id;
      }
      store.sessions[key] = access;
    } else {
      if (!session || session.raffleId !== raffle.id) throw new Error("Enter the raffle PIN to continue.");
      const sellerActions = ["reserve", "print", "cancel", "void"];
      if (sellerActions.includes(command.action)) {
        if (!session.sellerId) throw new Error("Join as a seller first.");
        const target = raffle.reservations.find(r => r.id === command.targetId);
        if (command.action !== "reserve" && target?.sellerId !== session.sellerId) throw new Error("You can only change your own sale.");
        switch (command.action) {
          case "reserve": result = reserveBundle(raffle, session.sellerId, command.targetId ?? "", at).id; break;
          case "print":
            if (raffle.status !== "selling" && target?.status !== "completed") throw new Error("Sales are paused.");
            completePrint(raffle, command.targetId!, at); break;
          case "cancel": cancelReservation(raffle, command.targetId!); break;
          case "void": voidLatestSale(raffle, session.sellerId, command.targetId!, at); break;
        }
      } else {
        if (!session.admin) throw new Error("Open Admin with the raffle PIN first.");
        switch (command.action) {
          case "edit": {
            if (raffle.settingsLocked || raffle.status !== "selling") throw new Error("Settings are locked.");
            if (raffle.reservations.some(r => r.status === "active")) throw new Error("Wait for unprinted reservations to expire or be cancelled before editing settings.");
            const draft = checkedDraft(command.draft);
            raffle.name = draft.name.trim();
            raffle.pin = hashPin(draft.pin);
            raffle.startingTicket = draft.startingTicket;
            raffle.highestIssued = draft.startingTicket - 1;
            raffle.prizeCount = draft.prizeCount;
            raffle.bundles = draft.bundles.map((b, i) => ({ ...b, id: `bundle_${i + 1}` }));
            // No completed sale exists; retire only historical, non-live reservations.
            raffle.reservations = [];
            break;
          }
          case "start": startDraw(raffle, at); break;
          case "selling": returnToSelling(raffle); break;
          case "draw": drawCandidate(raffle, undefined, at); break;
          case "confirm":
          case "redraw":
            if (currentCandidate(raffle)?.id !== command.targetId) throw new Error("The candidate changed. Review the current ticket first.");
            if (command.action === "confirm") confirmWinner(raffle, at);
            else redrawCandidate(raffle, at);
            break;
          case "undo": undoWinner(raffle, command.targetId!, at); break;
          case "end":
            endRaffle(raffle, at);
            store.state.history.unshift(raffle);
            store.state.activeRaffle = null;
            result = raffle.id;
            break;
          default: throw new Error("Unknown action.");
        }
      }
    }
  }
  store.requests[requestKey] = { result, at: at.getTime() };
  // Keep retry receipts for a full day; never replay a sale after a lost response.
  for (const [id, receipt] of Object.entries(store.requests)) if (receipt.at < at.getTime() - 86400000) delete store.requests[id];
  for (const [id, access] of Object.entries(store.sessions)) if (access.expiresAt < at.getTime()) delete store.sessions[id];
  return result;
}

export function publicState(store: Store, key: string) {
  const state = structuredClone(store.state);
  const session = store.sessions[key]?.expiresAt > Date.now() ? store.sessions[key] : undefined;
  const clean = (raffle: Raffle) => {
    raffle.pin = "";
    raffle.sellers = raffle.sellers.filter(s => session?.raffleId === raffle.id && s.id === session.sellerId);
    expireReservations(raffle);
  };
  if (state.activeRaffle) clean(state.activeRaffle);
  state.history.forEach(clean);
  state.deviceSellers = session?.sellerId ? { [session.raffleId]: session.sellerId } : {};
  return { state, adminRaffleId: session?.admin ? session.raffleId : null };
}
