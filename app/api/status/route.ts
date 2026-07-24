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

  const [settings, pendingCountRes, auditRes, signalsRes, dayCountsRes, eaTokenRes, funnelRes, latencyRes] =
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
    ]);

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
