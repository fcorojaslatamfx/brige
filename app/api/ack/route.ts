import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { ackSchema } from "@/lib/schema";
import { safeTokenEquals } from "@/lib/counts";
import { getToken } from "@/lib/tokens";
import { resolveClientToken, clientStatus } from "@/lib/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ack de un EA de cliente: marca su fila en client_deliveries (no la señal
 * global). Idempotente: un segundo ack no revienta.
 */
async function ackClientDelivery(
  clientId: string,
  id: string,
  status: "notified" | "error",
  error: string | undefined,
) {
  const { data: current, error: fetchError } = await supabase
    .from("client_deliveries")
    .select("status")
    .eq("signal_id", id)
    .eq("client_id", clientId)
    .maybeSingle();

  if (fetchError) return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  if (!current) return NextResponse.json({ ok: false, error: "delivery not found" }, { status: 404 });
  if (current.status !== "claimed") {
    return NextResponse.json({ ok: true, id, status: current.status, note: "not in claimed state, no-op" });
  }

  const nextStatus = status === "notified" ? "notified" : "error";
  const { error: updateError } = await supabase
    .from("client_deliveries")
    .update({
      status: nextStatus,
      notified_at: nextStatus === "notified" ? new Date().toISOString() : null,
      error: error ?? null,
    })
    .eq("signal_id", id)
    .eq("client_id", clientId)
    .eq("status", "claimed");

  if (updateError) return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });

  if (nextStatus === "error") {
    await supabase.from("audit").insert({
      signal_id: id,
      event_type: "client_ack_error",
      detail: { client_id: clientId, error: error ?? "ea_error" },
    });
  }

  return NextResponse.json({ ok: true, id, status: nextStatus });
}

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const isOperatorEa = safeTokenEquals(token, (await getToken("ea")) ?? undefined);
  const client = !isOperatorEa && token ? await resolveClientToken(token) : null;

  if (!isOperatorEa && !client) {
    await supabase.from("audit").insert({
      signal_id: null,
      event_type: "invalid_token",
      detail: { route: "ack" },
    });
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }
  if (client && clientStatus(client) !== "active") {
    return NextResponse.json({ ok: false, error: "token no activo" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed json" }, { status: 400 });
  }

  const parsed = ackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }
  const { id, status, error } = parsed.data;

  // EA de cliente → ack sobre su propia fila de entrega.
  if (client) {
    return ackClientDelivery(client.id, id, status, error);
  }

  // EA del operador → ack sobre la señal global (flujo original).
  const { data: current, error: fetchError } = await supabase
    .from("signals")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ ok: false, error: "signal not found" }, { status: 404 });
  }
  if (current.status !== "claimed") {
    // Ack repetido o fuera de orden: idempotente, no lo tratamos como error fatal.
    return NextResponse.json({ ok: true, id, status: current.status, note: "not in claimed state, no-op" });
  }

  // `error` es informativo y se guarda tanto si status='notified' (p.ej. un
  // gap de mapeo de símbolo que no impidió notificar) como si status='error'
  // (falla real de notificación) — solo el status de la fila cambia.
  const nextStatus = status === "notified" ? "notified" : "error";
  const { error: updateError } = await supabase
    .from("signals")
    .update({
      status: nextStatus,
      notified_at: nextStatus === "notified" ? new Date().toISOString() : null,
      error: error ?? null,
    })
    .eq("id", id)
    .eq("status", "claimed");

  if (updateError) {
    return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
  }

  if (nextStatus === "error") {
    await supabase.from("audit").insert({
      signal_id: id,
      event_type: "ack_error",
      detail: { error: error ?? "ea_error" },
    });
  } else if (error) {
    await supabase.from("audit").insert({
      signal_id: id,
      event_type: "ack_note",
      detail: { note: error },
    });
  }

  return NextResponse.json({ ok: true, id, status: nextStatus });
}
