import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { webhookPayloadSchema, isEntrySignal, type WebhookPayload } from "@/lib/schema";
import { getSettings, isFresh, safeTokenEquals } from "@/lib/counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNIQUE_VIOLATION = "23505";

function toInsertRow(payload: WebhookPayload, nowMs: number) {
  const base = {
    raw: payload,
    account_id: payload.account_id,
    action: payload.action,
    symbol: payload.symbol,
    tf: payload.tf,
    ts_signal: payload.timestamp,
    created_at: new Date(nowMs).toISOString(),
  };

  if (!isEntrySignal(payload)) {
    return base;
  }

  return {
    ...base,
    type: payload.type ?? null,
    grade: payload.grade ?? null,
    impulse_atr: payload.impulse_atr ?? null,
    price: payload.price,
    sl: payload.sl,
    tp1: payload.partial_1.tp,
    tp2: payload.partial_2.tp,
    lots1: payload.partial_1.lots,
    lots2: payload.partial_2.lots,
    risk_usd: payload.risk_usd,
    origin_symbol_count: payload.current_symbol_count ?? null,
    origin_global_count: payload.current_global_count ?? null,
    origin_threshold_exceeded: payload.threshold_exceeded ?? null,
  };
}

async function insertRejected(
  row: Record<string, unknown>,
  reason: "stale" | "duplicate",
  duplicateOfId: string | null,
) {
  const { data, error } = await supabase
    .from("signals")
    .insert({ ...row, status: "rejected_technical", error: reason, duplicate_of: duplicateOfId })
    .select("id")
    .single();
  if (error) throw error;

  await supabase.from("audit").insert({
    signal_id: data.id,
    event_type: reason === "stale" ? "stale_rejected" : "duplicate_rejected",
    detail: { symbol: row.symbol, action: row.action, ts_signal: row.ts_signal },
  });

  return data.id as string;
}

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!safeTokenEquals(token, process.env.TV_WEBHOOK_TOKEN)) {
    await supabase.from("audit").insert({
      signal_id: null,
      event_type: "invalid_token",
      detail: { route: "webhook" },
    });
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed json" }, { status: 400 });
  }

  const parsed = webhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    await supabase.from("audit").insert({
      signal_id: null,
      event_type: "invalid_payload",
      detail: { issues: parsed.error.issues, body },
    });
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }
  const payload = parsed.data;

  const nowMs = Date.now();
  const settings = await getSettings();
  const row = toInsertRow(payload, nowMs);

  if (!isFresh(payload.timestamp, settings.freshness_seconds, nowMs)) {
    const id = await insertRejected(row, "stale", null);
    return NextResponse.json({ ok: false, id, status: "rejected_technical", reason: "stale" }, { status: 200 });
  }

  const { data: existing } = await supabase
    .from("signals")
    .select("id")
    .eq("symbol", payload.symbol)
    .eq("action", payload.action)
    .eq("ts_signal", payload.timestamp)
    .neq("status", "rejected_technical")
    .limit(1)
    .maybeSingle();

  if (existing) {
    const id = await insertRejected(row, "duplicate", existing.id);
    return NextResponse.json({ ok: false, id, status: "rejected_technical", reason: "duplicate" }, { status: 200 });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("signals")
    .insert({ ...row, status: "pending" })
    .select("id")
    .single();

  if (insertError) {
    // Carrera: otra request insertó la misma clave (symbol, action, ts_signal)
    // entre nuestro chequeo de duplicado y este insert.
    if (insertError.code === UNIQUE_VIOLATION) {
      const { data: winner } = await supabase
        .from("signals")
        .select("id")
        .eq("symbol", payload.symbol)
        .eq("action", payload.action)
        .eq("ts_signal", payload.timestamp)
        .neq("status", "rejected_technical")
        .limit(1)
        .maybeSingle();
      const id = await insertRejected(row, "duplicate", winner?.id ?? null);
      return NextResponse.json({ ok: false, id, status: "rejected_technical", reason: "duplicate" }, { status: 200 });
    }
    throw insertError;
  }

  // El trigger fn_apply_authoritative_counts ya corrió; releemos para
  // devolver los conteos autoritativos definitivos en la respuesta.
  const { data: finalRow } = await supabase
    .from("signals")
    .select("id, status, auth_symbol_count, auth_global_count, auth_threshold_exceeded")
    .eq("id", inserted.id)
    .single();

  return NextResponse.json({ ok: true, ...finalRow }, { status: 200 });
}
