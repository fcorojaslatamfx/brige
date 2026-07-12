import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSettings, safeTokenEquals } from "@/lib/counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-operator-token");
  if (!safeTokenEquals(token, process.env.OPERATOR_TOKEN)) {
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  const [settings, pendingCountRes, auditRes, dayCountsRes, lastClaimRes] = await Promise.all([
    getSettings(),
    supabase.from("signals").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("audit").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.rpc("today_counts"),
    supabase.from("signals").select("claimed_at").not("claimed_at", "is", null).order("claimed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const dayCounts = dayCountsRes.data ?? [];
  const globalCount = dayCounts[0]?.global_count ?? 0;
  const overThreshold = dayCounts.filter(
    (r: { symbol_count: number }) => r.symbol_count > settings.symbol_threshold,
  ).length;
  const globalOverThreshold = globalCount > settings.global_threshold;

  const lastPollAt = lastClaimRes.data?.claimed_at ?? null;
  const lastPollLatencySeconds = lastPollAt ? (Date.now() - new Date(lastPollAt).getTime()) / 1000 : null;

  return NextResponse.json({
    ok: true,
    settings,
    pending_count: pendingCountRes.count ?? 0,
    recent_audit: auditRes.data ?? [],
    day_counts: dayCounts,
    global_count: globalCount,
    global_threshold_exceeded: globalOverThreshold,
    symbols_over_threshold: overThreshold,
    last_poll_at: lastPollAt,
    last_poll_latency_seconds: lastPollLatencySeconds,
    ea_online: lastPollLatencySeconds !== null && lastPollLatencySeconds < 10,
  });
}
