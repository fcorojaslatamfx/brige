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

  // El snapshot de equity del Trading Portal se deriva aquí, desde tp_accounts,
  // en vez de mandarlo el EA. Es una fila por cuenta y día: pedírsela al
  // terminal habría añadido tráfico y lógica de calendario en MQL4 para
  // producir un dato que el servidor ya tiene. Además esta ruta es la ÚNICA
  // entrada de cron disponible (vercel.json), así que la alternativa no era
  // "otro cron" sino "ningún snapshot".
  const [expiredRes, compactedRes, equityRes] = await Promise.all([
    supabase.rpc("expire_stale_signals"),
    supabase.rpc("compact_audit", { p_days: 90 }),
    supabase.rpc("tp_snapshot_equity"),
  ]);

  if (expiredRes.error) {
    return NextResponse.json({ ok: false, error: expiredRes.error.message }, { status: 500 });
  }
  if (compactedRes.error) {
    return NextResponse.json({ ok: false, error: compactedRes.error.message }, { status: 500 });
  }
  // Un fallo del snapshot NO tumba la limpieza: expirar señales y compactar
  // auditoría son las tareas que protegen la salud de la base, y perderlas por
  // un problema en una métrica del portal sería el intercambio equivocado.
  if (equityRes.error) {
    console.error("cron: falló tp_snapshot_equity —", equityRes.error.message);
  }

  // `stale` = cuentas activas que no entraron al snapshot porque su terminal
  // lleva más de un día sin reportar (migración 022). Se registra en el log
  // porque es el único aviso automático de que un cliente tiene MetaTrader
  // caído: un EA solo vive mientras el terminal está encendido, y sin esta
  // línea el operador solo se enteraría entrando a mirar badges uno a uno.
  const equity = equityRes.data as { day: string; written: number; stale: number } | null;
  if (equity && equity.stale > 0) {
    console.warn(
      `cron: ${equity.stale} cuenta(s) fuera del snapshot de equity por telemetría rancia — MetaTrader apagado`,
    );
  }

  return NextResponse.json({
    ok: true,
    expired_signals: expiredRes.data,
    compacted_audit_rows: compactedRes.data,
    equity_snapshots: equity,
  });
}
