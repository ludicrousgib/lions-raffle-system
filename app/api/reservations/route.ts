import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";

type ReservationRequest = {
  raffleId?: string;
  sellerId?: string;
  bundleId?: string;
  requestId?: string;
  pin?: string;
};

export async function POST(request: Request) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase is not configured. The app is running in single-device demo mode." },
      { status: 503 },
    );
  }

  let body: ReservationRequest;
  try {
    body = (await request.json()) as ReservationRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.raffleId || !body.sellerId || !body.bundleId || !body.requestId || !/^\d{4}$/.test(body.pin ?? "")) {
    return NextResponse.json({ error: "Raffle, seller, bundle, request ID and four-digit PIN are required." }, { status: 400 });
  }

  const { data: pinAccepted, error: pinError } = await supabase.rpc("verify_raffle_pin", {
    p_raffle_id: body.raffleId,
    p_pin: body.pin,
  });
  if (pinError) return NextResponse.json({ error: "Could not verify the raffle PIN." }, { status: 500 });
  if (!pinAccepted) return NextResponse.json({ error: "Incorrect raffle PIN." }, { status: 403 });

  const { data, error } = await supabase.rpc("reserve_bundle", {
    p_raffle_id: body.raffleId,
    p_seller_id: body.sellerId,
    p_bundle_id: body.bundleId,
    p_client_request_id: body.requestId,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  const reservation = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({ reservation }, { status: 201 });
}
