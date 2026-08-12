import { z } from "zod";
import { supabase } from "./supabase";
import { isProductionEnv } from "./origin";
import type { ClientTokenRow } from "./clients";

/**
 * Telemetría de cuenta del EA hacia el Trading Portal.
 *
 * El bloque viaja DENTRO del request que el EA ya hace a /api/signals, no en
 * un endpoint propio. Es la decisión que hace barata toda la funcionalidad:
 * el terminal del cliente ya pollea cada 2 s para recibir señales, así que
 * reportar el estado de la cuenta cuesta cero requests HTTP adicionales. Un
 * endpoint dedicado a 15 s habría añadido ~5.760 requests/día por cliente
 * para transportar datos que ya iban a cruzar el cable de todas formas.
 *
 * La contrapartida, asumida: el P&L flotante en la base tiene hasta 60 s de
 * retraso. La UI lo muestra ("actualizado hace Xs") en vez de fingir tiempo
 * real.
 */

// Topes de tamaño. No son defensivos contra un cliente hostil (el token ya
// autentica) sino contra un EA con un bug: una cuenta con 3.000 posiciones
// abiertas por un martingala descontrolado no debe poder mandar un payload de
// megabytes cada 2 s.
export const MAX_POSITIONS = 100;
export const MAX_CLOSED = 200;

/**
 * Ventana mínima, en segundos, entre dos escrituras del bloque `account` para
 * un mismo cliente. El EA ya se autolimita a 60 s, pero la cadencia del
 * cliente es una sugerencia, no una garantía: un EA mal configurado —o
 * recompilado por el propio cliente— podría adjuntar telemetría en cada poll
 * de 2 s. El límite que cuenta es el del servidor.
 *
 * Se aplica dentro de tp_ingest_telemetry, no aquí: ahorra un SELECT por
 * request y lo hace atómico frente a polls concurrentes. Cortar por frecuencia
 * solo descarta el bloque `account`; las posiciones y los cierres se procesan
 * igual, porque un cierre es un hecho irrepetible y perderlo sería un agujero
 * en el historial del cliente.
 */
export const ACCOUNT_MIN_INTERVAL_SECONDS = 30;

const finite = () => z.number().finite();

/** Epoch en SEGUNDOS. MQL4 emite TimeCurrent()/OrderOpenTime() en esa unidad. */
const epochSeconds = () => z.number().int().nonnegative();

const accountSchema = z.object({
  number: z.string().min(1).max(64),
  company: z.string().max(128).optional(),
  server: z.string().max(128).optional(),
  currency: z.string().max(8).optional(),
  leverage: z.string().max(16).optional(),
  type: z.enum(["real", "demo"]).optional(),
  balance: finite(),
  equity: finite(),
  margin_used: finite(),
  free_margin: finite(),
  margin_level: finite(),
  floating_pnl: finite(),
});

const positionSchema = z.object({
  ticket: z.number().int().positive(),
  symbol: z.string().min(1).max(32),
  type: z.enum(["BUY", "SELL"]),
  lots: finite().positive(),
  open_price: finite(),
  current_price: finite().optional(),
  sl: finite().optional(),
  tp: finite().optional(),
  profit: finite().optional(),
  swap: finite().optional(),
  open_time: epochSeconds(),
});

const closedSchema = positionSchema
  .omit({ current_price: true })
  .extend({
    close_price: finite(),
    close_time: epochSeconds(),
    commission: finite().optional(),
    comment: z.string().max(255).optional(),
  });

/**
 * `positions` y `closed` son opcionales y esa opcionalidad es semántica, no
 * cosmética: en el ingest, "ausente" significa "no ha cambiado, no toques
 * nada", mientras que un array VACÍO significa "el cliente cerró todo". Si se
 * colapsaran ambos casos, un EA que omite el bloque por no haber cambios
 * borraría las posiciones abiertas del portal.
 */
export const telemetrySchema = z.object({
  account: accountSchema,
  positions: z.array(positionSchema).max(MAX_POSITIONS).optional(),
  closed: z.array(closedSchema).max(MAX_CLOSED).optional(),
});

export type TelemetryPayload = z.infer<typeof telemetrySchema>;

export type TelemetryAck = {
  account_id: string;
  /**
   * Epoch en segundos del cierre más reciente que la base tiene de esta
   * cuenta. Es la marca de agua que el EA usa para pedir solo lo nuevo: la
   * sirve el SERVIDOR y no el terminal, así que un reinicio de MT4 o una
   * respuesta perdida no dejan huecos en el historial ni obligan al EA a
   * persistir estado en disco.
   */
  last_close_time: number;
  positions_synced: number;
  trades_inserted: number;
  account_throttled: boolean;
};

export type TelemetryResult =
  | { ok: true; ack: TelemetryAck }
  | { ok: false; status: number; error: string };

/**
 * Procesa el bloque de telemetría de un cliente ya autenticado.
 *
 * Deliberadamente NO lanza: el llamador es el camino de entrega de señales, y
 * un fallo reportando el balance no puede impedir que al trader le llegue una
 * entrada. Todos los errores salen como valor y el route handler decide.
 */
export async function ingestTelemetry(
  client: ClientTokenRow,
  raw: unknown,
): Promise<TelemetryResult> {
  const parsed = telemetrySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: `telemetría inválida: ${parsed.error.issues[0]?.message ?? "payload no reconocido"}`,
    };
  }
  const payload = parsed.data;

  // ── Anti-suplantación ──────────────────────────────────────────────────
  // El número de cuenta del terminal tiene que ser el que el operador dio de
  // alta para este token. Además de cerrar el reporte cruzado entre clientes,
  // esto atrapa el caso real y mucho más frecuente: el cliente adjunta el EA
  // al terminal equivocado y sus cifras acabarían en la cuenta de otro.
  if (!accountNumberMatches(payload.account.number, client.account_number)) {
    await supabase.from("audit").insert({
      signal_id: null,
      event_type: "telemetry_account_mismatch",
      detail: {
        client_id: client.id,
        expected: client.account_number,
        received: payload.account.number,
      },
    });
    return { ok: false, status: 409, error: "la cuenta del terminal no coincide con la registrada" };
  }

  // ── Entorno ────────────────────────────────────────────────────────────
  // Misma regla que el ingest de señales (lib/origin.ts): un preview de Vercel
  // apuntando a la base de producción no debe escribir cifras reales de nadie.
  if (!isProductionEnv()) {
    return { ok: false, status: 202, error: "entorno de prueba: telemetría ignorada" };
  }

  const { data, error } = await supabase.rpc("tp_ingest_telemetry", {
    p_client_id: client.id,
    p_payload: payload,
    p_min_interval: ACCOUNT_MIN_INTERVAL_SECONDS,
  });
  if (error) return { ok: false, status: 500, error: error.message };

  return { ok: true, ack: data as TelemetryAck };
}

/**
 * Compara números de cuenta tolerando el prefijo del bróker.
 *
 * `client_tokens.account_number` lo teclea un operador y en la práctica llega
 * como "MT4-284751" o "284751" indistintamente, mientras que MQL4 devuelve
 * AccountNumber() como entero puro. Comparar en crudo rechazaría cuentas
 * perfectamente válidas por una diferencia de formato de captura.
 */
export function accountNumberMatches(fromTerminal: string, registered: string): boolean {
  const digits = (s: string) => s.replace(/\D/g, "");
  const a = digits(fromTerminal);
  const b = digits(registered);
  return a.length > 0 && a === b;
}
