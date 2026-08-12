import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { safeTokenEquals, toEaPayload, type SignalRow } from "@/lib/counts";
import { getToken, touchTokenUsage } from "@/lib/tokens";
import { resolveClientToken, clientStatus, touchClientUsage } from "@/lib/clients";
import { ingestTelemetry, type TelemetryAck } from "@/lib/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MAX = 50;

/**
 * GET y POST comparten el mismo handler. La diferencia es que POST admite un
 * cuerpo con telemetría de cuenta para el Trading Portal (v3 del EA), mientras
 * que GET es exactamente el contrato de siempre.
 *
 * Los dos verbos conviven a propósito: hay EAs v2 ya instalados en terminales
 * de clientes que seguirán haciendo GET indefinidamente. El despliegue del v3
 * es cliente a cliente y sin fecha límite; nada obliga a nadie a actualizar
 * para seguir recibiendo señales.
 */
export async function GET(req: NextRequest) {
  return handle(req, null);
}

export async function POST(req: NextRequest) {
  // Un cuerpo ilegible no puede tumbar la entrega de señales: el EA que
  // pollea lo hace para recibir entradas, y el reporte de balance es
  // accesorio frente a eso. Se ignora el cuerpo y se sigue.
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  return handle(req, body);
}

async function handle(req: NextRequest, body: unknown) {
  const token = req.nextUrl.searchParams.get("token");
  const wantsTest = req.nextUrl.searchParams.get("include_test") === "true";

  // §8 capa 2: la cola de prueba sólo se sirve al token `operator`, JAMÁS al
  // del EA. Aunque falle todo lo demás, el terminal del trader no tiene forma
  // de pedir tráfico de prueba: no conoce el token que lo desbloquea.
  if (wantsTest) {
    if (!safeTokenEquals(token, (await getToken("operator")) ?? undefined)) {
      await supabase.from("audit").insert({
        signal_id: null,
        event_type: "invalid_token",
        detail: { route: "signals", include_test: true },
      });
      return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
    }

    const max = parseMax(req.nextUrl.searchParams.get("max"));
    const { data, error } = await supabase.rpc("claim_signals_test", { p_max: max });
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    const signals = ((data ?? []) as SignalRow[]).map(toEaPayload);
    return NextResponse.json(
      { ok: true, count: signals.length, server_time: Date.now(), signals },
      { status: 200 },
    );
  }

  const max = parseMax(req.nextUrl.searchParams.get("max"));

  // ── EA del operador (token de sistema `ea`): flujo de consumo único ────────
  if (safeTokenEquals(token, (await getToken("ea")) ?? undefined)) {
    // Heartbeat: registrar el poll aunque no haya señales pendientes que
    // reclamar — antes solo se sabía que el EA seguía vivo cuando
    // claim_signals tocaba una fila, así que con la cola vacía el panel
    // marcaba "offline" pese a que el EA autenticaba bien cada ciclo.
    await touchTokenUsage("ea");

    // claim_signals (011) sólo ve is_test=false + origin='tradingview' +
    // env='production': es imposible que este camino sirva una fila de prueba.
    const { data, error } = await supabase.rpc("claim_signals", { p_max: max });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    const signals = ((data ?? []) as SignalRow[]).map(toEaPayload);
    // server_time deja al EA detectar deriva de reloj contra el bridge (§5.3).
    return NextResponse.json({ ok: true, count: signals.length, server_time: Date.now(), signals }, { status: 200 });
  }

  // ── EA de un cliente (token de cliente): flujo de DIFUSIÓN ─────────────────
  // Cada cliente recibe cada señal de forma independiente (client_deliveries),
  // sin consumir la cola del operador.
  const client = token ? await resolveClientToken(token) : null;
  if (client) {
    const estado = clientStatus(client);
    if (estado !== "active") {
      await supabase.from("audit").insert({
        signal_id: null,
        event_type: "invalid_token",
        detail: { route: "signals", client_id: client.id, reason: estado },
      });
      const msg = estado === "expired" ? "token caducado" : "token revocado";
      return NextResponse.json({ ok: false, error: msg }, { status: 403 });
    }

    await touchClientUsage(client.id);

    // ── Telemetría del portal, montada sobre este mismo request ──────────
    // Va ANTES del claim y su resultado nunca corta la respuesta: si el
    // reporte de cuenta falla, el cliente sigue recibiendo sus señales y se
    // entera del problema por el campo `telemetry` de la respuesta.
    let telemetry: TelemetryResponse | undefined;
    const rawTelemetry = extractTelemetry(body);
    if (rawTelemetry !== undefined) {
      const result = await ingestTelemetry(client, rawTelemetry);
      telemetry = result.ok
        ? { ok: true, ...result.ack }
        : { ok: false, error: result.error };
    }

    const { data, error } = await supabase.rpc("claim_signals_for_client", {
      p_client_id: client.id,
      p_max: max,
    });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    const signals = ((data ?? []) as SignalRow[]).map(toEaPayload);
    return NextResponse.json(
      { ok: true, count: signals.length, server_time: Date.now(), signals, telemetry },
      { status: 200 },
    );
  }

  // ── Token desconocido ──────────────────────────────────────────────────────
  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "invalid_token",
    detail: { route: "signals" },
  });
  return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
}

type TelemetryResponse =
  | ({ ok: true } & TelemetryAck)
  | { ok: false; error: string };

/**
 * Saca el bloque `telemetry` del cuerpo. Devuelve `undefined` cuando no viene
 * —el caso de la inmensa mayoría de los polls, que no deben costar nada— y el
 * valor crudo cuando sí, para que sea Zod quien lo valide y no dos capas
 * distintas con criterios que se pueden desincronizar.
 */
function extractTelemetry(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  if (!("telemetry" in body)) return undefined;
  return (body as { telemetry: unknown }).telemetry;
}

function parseMax(raw: string | null): number {
  return raw ? Math.max(1, Math.min(200, parseInt(raw, 10) || DEFAULT_MAX)) : DEFAULT_MAX;
}
