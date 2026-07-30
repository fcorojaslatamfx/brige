import { NextRequest, NextResponse } from "next/server";
import {
  resolveClientToken,
  clientStatus,
  listClientDeliveries,
  buildClientReport,
} from "@/lib/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Portal del cliente (solo lectura). Autenticado por el token del propio
 * cliente — el mismo que usa su EA — no por sesión Supabase. Devuelve SU token,
 * SUS señales, símbolos y reporte. Cero configuración: no expone ni permite
 * tocar nada que altere el bridge.
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

  const signals = await listClientDeliveries(client.id);
  const report = buildClientReport(signals);

  return NextResponse.json({
    ok: true,
    server_time: Date.now(),
    client: {
      name: `${client.client_name} ${client.client_last_name}`.trim(),
      email: client.client_email,
      token: client.token,
      expires_at: client.expires_at,
      status: estado,
      last_used_at: client.last_used_at,
    },
    signals,
    report,
  });
}
