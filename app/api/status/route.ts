import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSettings } from "@/lib/counts";
import { isSuperAdminOrOperator } from "@/lib/auth";
import { computeEaPollStatus } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORIGIN_FILTERS = ["tradingview", "test", "manual", "replay", "all"] as const;
type OriginFilter = (typeof ORIGIN_FILTERS)[number];

function parseOrigin(raw: string | null): OriginFilter {
  return (ORIGIN_FILTERS as readonly string[]).includes(raw ?? "") ? (raw as OriginFilter) : "tradingview";
}

// PostgREST interpreta un .in([]) vacío como "sin filtro": este centinela lo
// evita, garantizando "cero resultados" cuando no hay ids que filtrar.
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function GET(req: NextRequest) {
  // Panel operativo completo: solo super_admin (o operator token). Los admin
  // se redirigen a /status/clients (su dashboard acotado).
  if (!(await isSuperAdminOrOperator(req))) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 403 });
  }

  // §5.4: filtro de origen, por defecto en 'tradingview'. El panel marca un
  // badge visible cuando se está mirando tráfico de prueba.
  const origin = parseOrigin(req.nextUrl.searchParams.get("origin"));

  const recentQuery = supabase
    .from("signals")
    .select(
      "id, action, symbol, tf, grade, price, sl, tp1, tp2, status, auth_symbol_count, auth_global_count, auth_threshold_exceeded, error, duplicate_of, origin, is_test, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (origin !== "all") recentQuery.eq("origin", origin);

  // §6: filtro por BRÓKER (destino), dinámico. Los brokers los define el
  // super_admin al crear clientes → sin whitelist fija, solo guardarraíl de
  // longitud. Como signals no conoce el bróker (la difusión no segmenta), este
  // filtro = señales ENTREGADAS a clientes de ese bróker, resuelto en dos pasos
  // vía client_deliveries.
  const brokerParam = (req.nextUrl.searchParams.get("broker") ?? "all").slice(0, 80);
  if (brokerParam !== "all") {
    const { data: clientRows } = await supabase.from("client_tokens").select("id").eq("broker", brokerParam);
    const clientIds = (clientRows ?? []).map((c) => c.id);
    const { data: deliveryRows } = await supabase
      .from("client_deliveries")
      .select("signal_id")
      .in("client_id", clientIds.length > 0 ? clientIds : [NIL_UUID]);
    const signalIds = [...new Set((deliveryRows ?? []).map((d) => d.signal_id))];
    recentQuery.in("id", signalIds.length > 0 ? signalIds : [NIL_UUID]);
  }

  const [settings, pendingCountRes, auditRes, signalsRes, dayCountsRes, eaTokenRes, funnelRes, latencyRes, brokersRes] =
    await Promise.all([
      getSettings(),
      supabase
        .from("signals")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .eq("origin", "tradingview")
        .eq("is_test", false),
      supabase.from("audit").select("*").order("created_at", { ascending: false }).limit(50),
      recentQuery,
      supabase.rpc("today_counts"),
      supabase.from("tokens").select("last_used_at").eq("kind", "ea").maybeSingle(),
      supabase.rpc("delivery_funnel", { p_hours: 48, p_origin: origin }),
      supabase.rpc("latency_stats", { p_hours: 48, p_origin: origin }),
      supabase.from("client_tokens").select("broker").order("broker"),
    ]);

  const brokers = [...new Set((brokersRes.data ?? []).map((r: { broker: string }) => r.broker))];

  const dayCounts = dayCountsRes.data ?? [];
  const globalCount = dayCounts[0]?.global_count ?? 0;
  const overThreshold = dayCounts.filter(
    (r: { symbol_count: number }) => r.symbol_count >= settings.symbol_threshold,
  ).length;
  const globalOverThreshold = globalCount >= settings.global_threshold;

  const { lastPollAt, lastPollLatencySeconds, eaOnline } = computeEaPollStatus(eaTokenRes.data?.last_used_at ?? null);

  return NextResponse.json({
    ok: true,
    settings,
    origin,
    broker: brokerParam,
    brokers,
    pending_count: pendingCountRes.count ?? 0,
    recent_signals: signalsRes.data ?? [],
    recent_audit: auditRes.data ?? [],
    day_counts: dayCounts,
    global_count: globalCount,
    global_threshold_exceeded: globalOverThreshold,
    symbols_over_threshold: overThreshold,
    last_poll_at: lastPollAt,
    last_poll_latency_seconds: lastPollLatencySeconds,
    ea_online: eaOnline,
    delivery_funnel: funnelRes.data ?? [],
    latency_stats: latencyRes.data ?? [],
  });
}
