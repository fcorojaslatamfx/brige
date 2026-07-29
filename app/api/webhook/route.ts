import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { webhookPayloadSchema, isEntrySignal, type WebhookPayload } from "@/lib/schema";
import { getSettings, isFresh, safeTokenEquals } from "@/lib/counts";
import { getToken, touchTokenUsage } from "@/lib/tokens";
import { resolveIngestContext, type IngestContext } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNIQUE_VIOLATION = "23505";

// Un desfase de más de una hora entre el reloj de quien emite y el nuestro
// no es una señal tardía sino un reloj roto: se rechaza sin encolar (§5.1).
const MAX_CLOCK_SKEW_MS = 3_600_000;

/** Apertura de vela para dedup; cae a timestamp cuando el Pine es v1.x (§5.1). */
function resolveBarTime(payload: WebhookPayload): number {
  return payload.bar_time ?? payload.timestamp;
}

function toInsertRow(payload: WebhookPayload, ctx: IngestContext) {
  const base = {
    raw: payload,
    account_id: payload.account_id,
    action: payload.action,
    symbol: payload.symbol,
    tf: payload.tf ?? null,
    bar_time: resolveBarTime(payload),
    ts_signal: payload.timestamp,
    origin: ctx.origin,
    is_test: ctx.is_test,
    env: ctx.env,
    // `created_at` lo pone Postgres (default now()). Antes se escribía aquí con
    // el reloj del proceso de la app, y eso metía DOS relojes en la misma
    // columna: cualquier deriva entre el runtime y Postgres se volvía un desfase
    // real. Se detectó midiendo la retención de armados (migración 016), que
    // compara `now() - created_at`: con la máquina de desarrollo 20 s adelantada,
    // un armado recién ingestado tenía created_at en el FUTURO para Postgres, la
    // resta salía negativa y el armado quedaba retenido incluso con la ventana
    // en 0. Con un solo reloj el invariante es trivial: created_at nunca está en
    // el futuro. También sanea el lag de latency_stats / delivery_funnel, que
    // comparan created_at contra ts_signal.
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
  if (!safeTokenEquals(token, (await getToken("tv_webhook")) ?? undefined)) {
    await supabase.from("audit").insert({
      signal_id: null,
      event_type: "invalid_token",
      detail: { route: "webhook" },
    });
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  // §1.6: el endpoint de webhook nunca actualizaba tokens.last_used_at para
  // kind='tv_webhook' pese a recibir tráfico, así que /status no podía saber
  // si TradingView seguía emitiendo. Se toca en cada request autenticado.
  await touchTokenUsage("tv_webhook");

  // §8 capa 2: el origen se deriva del token (aquí, siempre tv_webhook) y del
  // entorno del despliegue; JAMÁS del body. Un preview de Vercel o una corrida
  // local con el token real quedan marcados como prueba y no llegan al EA.
  const ctx = resolveIngestContext("tv_webhook");

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

  // §5.1: reloj roto (desfase > 1 h en cualquier dirección) ≠ señal tardía.
  // Se rechaza con 400 sin encolar y sin ensuciar las métricas de stale.
  if (Math.abs(payload.timestamp - nowMs) > MAX_CLOCK_SKEW_MS) {
    await supabase.from("audit").insert({
      signal_id: null,
      event_type: "invalid_payload",
      detail: { reason: "clock_skew", ts_signal: payload.timestamp, now: nowMs },
    });
    return NextResponse.json({ ok: false, error: "clock skew: timestamp too far from server time" }, { status: 400 });
  }

  const settings = await getSettings();
  const row = toInsertRow(payload, ctx);
  const barTime = resolveBarTime(payload);

  // Frescura: SIEMPRE contra timestamp (timenow), nunca contra bar_time (§5.1).
  if (!isFresh(payload.timestamp, settings.freshness_seconds, nowMs)) {
    const id = await insertRejected(row, "stale", null);
    return NextResponse.json({ ok: false, id, status: "rejected_technical", reason: "stale" }, { status: 200 });
  }

  // Deduplicación: SIEMPRE contra bar_time (apertura de vela estable), nunca
  // contra timestamp — dos emisiones del mismo disparo comparten bar_time pero
  // difieren en timenow por milisegundos (§3.3).
  const { data: existing } = await supabase
    .from("signals")
    .select("id")
    .eq("symbol", payload.symbol)
    .eq("action", payload.action)
    .eq("bar_time", barTime)
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
        .eq("bar_time", barTime)
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
