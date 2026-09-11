import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  DomainError,
  accessFor,
  applyRaffleCommand,
  digest,
  hashPin,
  publicRaffle,
  type Command,
  type RaffleRuntime,
} from "@/lib/live-engine";
import {
  createRaffle,
  normaliseName,
  validateDraft,
  type AppState,
  type Organisation,
  type Raffle,
  type Venue,
} from "@/lib/raffle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const COOKIE = "lions_device";

type EntityRow = { id: string; name: string; archived_at: string | null };
type RaffleRow = {
  id: string;
  revision: number;
  payload: Raffle;
  sessions: RaffleRuntime["sessions"];
  requests: RaffleRuntime["requests"];
  audit: RaffleRuntime["audit"];
  organisation_id: string;
  venue_id: string;
  status: Raffle["status"];
  created_at: string;
  ended_at: string | null;
  created_by_device_key: string | null;
};

function connection() {
  const db = getSupabaseAdmin();
  if (!db) throw new Error("The live database is not configured yet.");
  return db;
}

function identity(request: NextRequest) {
  const old = request.cookies.get(COOKIE)?.value;
  const token = old && /^[0-9a-f]{64}$/.test(old) ? old : randomBytes(32).toString("hex");
  return { token, key: digest(token) };
}

function response(payload: unknown, token: string, status = 200) {
  const result = NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  result.cookies.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 400 * 86400 });
  return result;
}

function runtimeFromRow(row: RaffleRow): RaffleRuntime {
  return { raffle: row.payload, sessions: row.sessions ?? {}, requests: row.requests ?? {}, audit: row.audit ?? [] };
}

function cleanEntityName(value: unknown) {
  const name = typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 100) throw new DomainError("Enter a name between 1 and 100 characters.");
  return name;
}

async function readState(key: string) {
  const db = connection();
  const [rafflesResult, organisationsResult, venuesResult] = await Promise.all([
    db.from("raffles").select("id,revision,payload,sessions,requests,audit,organisation_id,venue_id,status,created_at,ended_at,created_by_device_key").order("created_at", { ascending: false }),
    db.from("organisations").select("id,name,archived_at").order("name"),
    db.from("venues").select("id,name,archived_at").order("name"),
  ]);
  if (rafflesResult.error || organisationsResult.error || venuesResult.error) throw new Error("The raffle database is unavailable. Please retry shortly.");
  const rows = (rafflesResult.data ?? []) as RaffleRow[];
  const organisationRows = (organisationsResult.data ?? []) as EntityRow[];
  const venueRows = (venuesResult.data ?? []) as EntityRow[];
  const organisationNames = new Map(organisationRows.map((item) => [item.id, item.name]));
  const venueNames = new Map(venueRows.map((item) => [item.id, item.name]));
  const accessByRaffle: AppState["accessByRaffle"] = {};
  const raffles = rows.map((row) => {
    const raffleRuntime = runtimeFromRow(row);
    const names = {
      organisationName: organisationNames.get(row.organisation_id) ?? "Unknown organisation",
      venueName: venueNames.get(row.venue_id) ?? "Unknown venue",
    };
    accessByRaffle[row.id] = accessFor(raffleRuntime, key);
    return publicRaffle(raffleRuntime, key, names);
  });
  const state: AppState = {
    version: 2,
    activeRaffles: raffles.filter((raffle) => raffle.status !== "ended").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    history: raffles.filter((raffle) => raffle.status === "ended").sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "")),
    organisations: organisationRows.map((item): Organisation => ({ id: item.id, name: item.name, ...(item.archived_at ? { archivedAt: item.archived_at } : {}) })),
    venues: venueRows.map((item): Venue => ({ id: item.id, name: item.name, ...(item.archived_at ? { archivedAt: item.archived_at } : {}) })),
    accessByRaffle,
  };
  return { state, revision: rows.reduce((sum, row) => sum + Number(row.revision), 0), serverNow: Date.now() };
}

async function readRaffle(raffleId: string) {
  const { data, error } = await connection().from("raffles")
    .select("id,revision,payload,sessions,requests,audit,organisation_id,venue_id,status,created_at,ended_at,created_by_device_key")
    .eq("id", raffleId).maybeSingle();
  if (error) throw new Error("The raffle database is unavailable. Please retry shortly.");
  return data as RaffleRow | null;
}

async function entityNames(organisationId: string, venueId: string) {
  const db = connection();
  const [organisation, venue] = await Promise.all([
    db.from("organisations").select("name,archived_at").eq("id", organisationId).maybeSingle(),
    db.from("venues").select("name,archived_at").eq("id", venueId).maybeSingle(),
  ]);
  if (organisation.error || venue.error || !organisation.data || !venue.data) throw new DomainError("Choose an available organisation and venue.");
  return {
    organisationName: organisation.data.name as string,
    venueName: venue.data.name as string,
    organisationArchived: Boolean(organisation.data.archived_at),
    venueArchived: Boolean(venue.data.archived_at),
  };
}

async function create(command: Command, key: string) {
  const draft = command.draft;
  if (!draft) throw new DomainError("Check the raffle settings.");
  const validation = validateDraft(draft);
  if (validation) throw new DomainError(validation);
  const raffleId = `raffle_${command.requestId}`;
  const retry = await readRaffle(raffleId);
  if (retry?.created_by_device_key === key) return raffleId;
  const names = await entityNames(draft.organisationId, draft.venueId);
  if (names.organisationArchived || names.venueArchived) throw new DomainError("Archived organisations and venues cannot be used for new raffles.");
  const { data: sameVenue, error: venueError } = await connection().from("raffles")
    .select("id,name,organisation_id").eq("venue_id", draft.venueId).neq("status", "ended");
  if (venueError) throw new Error("Could not check active raffles.");
  const exact = (sameVenue ?? []).some((row) => row.organisation_id === draft.organisationId && normaliseName(row.name) === normaliseName(draft.name));
  if (exact) throw new DomainError("An active raffle with this name, organisation and venue already exists.", "DUPLICATE_ACTIVE_RAFFLE");
  if ((sameVenue ?? []).length > 0 && !command.confirmDuplicate) throw new DomainError("Another active raffle is already using this venue. You can continue because its name or organisation is different.", "VENUE_IN_USE");

  const raffle = createRaffle(draft, new Date(), raffleId);
  raffle.pin = hashPin(raffle.pin);
  raffle.organisationName = names.organisationName;
  raffle.venueName = names.venueName;
  const { error } = await connection().from("raffles").insert({
    id: raffle.id,
    name: raffle.name,
    pin_hash: raffle.pin,
    organisation_id: raffle.organisationId,
    venue_id: raffle.venueId,
    starting_ticket: raffle.startingTicket,
    highest_issued: raffle.highestIssued,
    prize_count: raffle.prizeCount,
    status: raffle.status,
    settings_locked: raffle.settingsLocked,
    created_at: raffle.createdAt,
    payload: raffle,
    sessions: { [key]: { pinRemembered: true, admin: true } },
    requests: {},
    audit: [{ action: "create", at: raffle.createdAt, deviceKey: key }],
    created_by_device_key: key,
  });
  if (error) {
    if (error.code === "23505") {
      const existing = await readRaffle(raffleId);
      if (existing?.created_by_device_key === key) return raffleId;
      throw new DomainError("An active raffle with this name, organisation and venue already exists.", "DUPLICATE_ACTIVE_RAFFLE");
    }
    throw new DomainError(error.message);
  }
  return raffleId;
}

async function manageEntity(command: Command) {
  const table = command.entityType === "organisation" ? "organisations" : command.entityType === "venue" ? "venues" : null;
  if (!table) throw new DomainError("Choose organisations or venues.");
  const action = command.action;
  const id = command.entityId ?? command.requestId;
  if (action === "entity-create") {
    const name = cleanEntityName(command.name);
    const { error } = await connection().from(table).insert({ id, name });
    if (error?.code === "23505") {
      const existing = await connection().from(table).select("name").eq("id", id).maybeSingle();
      if (existing.data?.name === name) return id;
      if (command.entityType === "organisation") throw new DomainError("Organisation names must be unique.");
    }
    if (error) throw new DomainError(error.message);
  } else if (action === "entity-rename") {
    const name = cleanEntityName(command.name);
    const { error } = await connection().from(table).update({ name }).eq("id", id);
    if (error) throw new DomainError(error.code === "23505" ? "Organisation names must be unique." : error.message);
  } else if (action === "entity-archive") {
    const { error } = await connection().from(table).update({ archived_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new DomainError(error.message);
  } else if (action === "entity-restore") {
    const { error } = await connection().from(table).update({ archived_at: null }).eq("id", id);
    if (error) throw new DomainError(error.message);
  } else if (action === "entity-delete") {
    const { error } = await connection().from(table).delete().eq("id", id);
    if (error) throw new DomainError("This item has been used by a raffle and cannot be deleted. Archive it instead.");
  } else throw new DomainError("Unknown management action.");
  return id;
}

async function updateRaffle(command: Command, key: string) {
  if (!command.raffleId) throw new DomainError("Choose a raffle first.");
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const row = await readRaffle(command.raffleId);
    if (!row) {
      if (command.action === "delete-active" || command.action === "delete-history") return command.raffleId;
      throw new DomainError("That raffle is no longer available.", "RAFFLE_CHANGED");
    }
    if (command.action === "delete-history") {
      if (row.status !== "ended") throw new DomainError("Only completed raffles can be deleted from History.");
      const { error } = await connection().from("raffles").delete().eq("id", row.id).eq("revision", row.revision);
      if (error) throw new DomainError(error.message);
      return row.id;
    }
    const runtime = runtimeFromRow(row);
    const currentNames = await entityNames(row.organisation_id, row.venue_id);
    const result = applyRaffleCommand(runtime, key, command, currentNames);
    if (command.action === "delete-active") {
      const { data, error } = await connection().from("raffles").delete().eq("id", row.id).eq("revision", row.revision).select("id").maybeSingle();
      if (error) throw new DomainError(error.message);
      if (data) return result;
      continue;
    }
    const raffle = runtime.raffle;
    const { data, error } = await connection().from("raffles").update({
      name: raffle.name,
      pin_hash: raffle.pin,
      organisation_id: raffle.organisationId,
      venue_id: raffle.venueId,
      organisation_name_snapshot: raffle.organisationNameSnapshot ?? null,
      venue_name_snapshot: raffle.venueNameSnapshot ?? null,
      starting_ticket: raffle.startingTicket,
      highest_issued: raffle.highestIssued,
      prize_count: raffle.prizeCount,
      status: raffle.status,
      settings_locked: raffle.settingsLocked,
      ended_at: raffle.endedAt ?? null,
      payload: raffle,
      sessions: runtime.sessions,
      requests: runtime.requests,
      audit: runtime.audit,
      revision: row.revision + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id).eq("revision", row.revision).select("revision").maybeSingle();
    if (error) throw new DomainError(error.message);
    if (data) return result;
  }
  throw new DomainError("This raffle is busy. Please try again.", "RAFFLE_BUSY");
}

export async function GET(request: NextRequest) {
  const { token, key } = identity(request);
  try {
    return response(await readState(key), token);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Connection failed." }, token, 503);
  }
}

export async function POST(request: NextRequest) {
  const { token, key } = identity(request);
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) return response({ error: "Please use this app to submit changes." }, token, 403);
    if (!request.headers.get("content-type")?.startsWith("application/json")) return response({ error: "JSON required." }, token, 415);
    const raw = await request.text();
    if (raw.length > 20000) return response({ error: "Request too large." }, token, 413);
    const command = JSON.parse(raw) as Command;
    if (!command || typeof command.action !== "string" || !/^[0-9a-f-]{36}$/i.test(command.requestId)) throw new DomainError("Invalid request.");
    const auth = command.action === "join" || command.action === "admin";
    const ip = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for") ?? "local";
    const { data: allowed, error: limitError } = await connection().rpc("raffle_allow_request", {
      p_key: `${auth ? "pin" : "write"}:${digest(ip)}`,
      p_limit: auth ? 15 : 180,
      p_seconds: auth ? 300 : 60,
    });
    if (limitError) throw new Error("Could not verify this request. Please retry.");
    if (!allowed) return response({ error: "Too many attempts. Please wait a few minutes before trying again." }, token, 429);

    let result: string | null;
    if (command.action === "create") result = await create(command, key);
    else if (command.action.startsWith("entity-")) result = await manageEntity(command);
    else result = await updateRaffle(command, key);
    return response({ ...(await readState(key)), result }, token);
  } catch (error) {
    const code = error instanceof DomainError ? error.code : undefined;
    return response({ error: error instanceof Error ? error.message : "Something went wrong.", code }, token, 400);
  }
}
