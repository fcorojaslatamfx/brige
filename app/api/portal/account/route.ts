import { NextRequest, NextResponse } from "next/server";
import { resolveClientToken, clientStatus } from "@/lib/clients";
import { getPortalAccountData, TRADES_PAGE_SIZE } from "@/lib/portal-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Datos de trading del cliente para el Trading Portal (solo lectura).
 *
 * Misma autenticación que /api/portal: el token opaco del propio cliente, el
 * mismo que usa su EA. El navegador NO habla con Supabase — no hay anon key en
 * el bundle, no hay RLS que razonar y no hay canal de Realtime abierto por
 * pestaña. Todo pasa por aquí con el cliente service-role, igual que el resto
 * del bridge.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const client = token ? await resolveClientToken(token) : null;

  if (!client) return NextResponse.json({ ok: false, error: "token inválido" }, { status: 401 });

  const estado = clientStatus(client);
  if (estado !== "active") {
    const msg = estado === "expired" ? "token caducado" : "token revocado";
    return NextResponse.json({ ok: false, error: msg, status: estado }, { status: 403 });
  }

  const limit = parseIntParam(req.nextUrl.searchParams.get("limit"), TRADES_PAGE_SIZE);
  const offset = parseIntParam(req.nextUrl.searchParams.get("offset"), 0);

  const data = await getPortalAccountData(client.id, { limit, offset });

  return NextResponse.json({
    ok: true,
    server_time: Date.now(),
    client: {
      name: `${client.client_name} ${client.client_last_name}`.trim(),
      broker: client.broker,
      account_number: client.account_number,
      account_type: client.account_type,
      broker_server: client.broker_server,
      expires_at: client.expires_at,
    },
    ...data,
  });
}

function parseIntParam(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
