import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { safeTokenEquals, toEaPayload, type SignalRow } from "@/lib/counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MAX = 50;

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!safeTokenEquals(token, process.env.EA_TOKEN)) {
    await supabase.from("audit").insert({
      signal_id: null,
      event_type: "invalid_token",
      detail: { route: "signals" },
    });
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  const maxParam = req.nextUrl.searchParams.get("max");
  const max = maxParam ? Math.max(1, Math.min(200, parseInt(maxParam, 10) || DEFAULT_MAX)) : DEFAULT_MAX;

  const { data, error } = await supabase.rpc("claim_signals", { p_max: max });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as SignalRow[];
  const signals = rows.map(toEaPayload);

  return NextResponse.json({ ok: true, count: signals.length, signals }, { status: 200 });
}
