import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { applyCommand, digest, publicState, type Command, type Store } from "@/lib/live-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const COOKIE = "lions_device";

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
  const res = NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  res.cookies.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 30 * 86400 });
  return res;
}
async function read() {
  const { data, error } = await connection().from("raffle_store").select("revision,payload").eq("id", 1).single();
  if (error || !data) throw new Error("The raffle database is unavailable. Please retry shortly.");
  return data as { revision: number; payload: Store };
}
export async function GET(request: NextRequest) {
  const { token, key } = identity(request);
  try {
    const row = await read();
    return response({ ...publicState(row.payload, key), revision: row.revision, serverNow: Date.now() }, token);
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
    if (raw.length > 16000) return response({ error: "Request too large." }, token, 413);
    const command = JSON.parse(raw) as Command;
    if (!command || typeof command.action !== "string") throw new Error("Invalid request.");
    const auth = command.action === "join" || command.action === "admin";
    const ip = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for") ?? "local";
    const { data: allowed, error: limitError } = await connection().rpc("raffle_allow_request", {
      p_key: `${auth ? "pin" : "write"}:${digest(ip)}`,
      p_limit: auth ? 15 : 180,
      p_seconds: auth ? 300 : 60,
    });
    if (limitError) throw new Error("Could not verify this request. Please retry.");
    if (!allowed) return response({ error: "Too many attempts. Please wait a few minutes before trying again." }, token, 429);
    for (let attempt = 0; attempt < 15; attempt++) {
      const row = await read();
      const result = applyCommand(row.payload, key, command);
      const { data, error } = await connection().from("raffle_store")
        .update({ payload: row.payload, revision: row.revision + 1, updated_at: new Date().toISOString() })
        .eq("id", 1).eq("revision", row.revision).select("revision").maybeSingle();
      if (error) throw new Error("Saving failed. Retry the same action to check its result safely.");
      if (data) return response({ ...publicState(row.payload, key), result, revision: data.revision, serverNow: Date.now() }, token);
    }
    return response({ error: "The raffle is busy. Please try again." }, token, 409);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Something went wrong." }, token, 400);
  }
}
