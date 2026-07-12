import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { safeTokenEquals } from "@/lib/counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vercel Cron llama esta ruta con `Authorization: Bearer $CRON_SECRET`.
 * https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  if (!safeTokenEquals(provided, process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  const [expiredRes, compactedRes] = await Promise.all([
    supabase.rpc("expire_stale_signals"),
    supabase.rpc("compact_audit", { p_days: 90 }),
  ]);

  if (expiredRes.error) {
    return NextResponse.json({ ok: false, error: expiredRes.error.message }, { status: 500 });
  }
  if (compactedRes.error) {
    return NextResponse.json({ ok: false, error: compactedRes.error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    expired_signals: expiredRes.data,
    compacted_audit_rows: compactedRes.data,
  });
}
