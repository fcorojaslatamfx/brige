import { timingSafeEqual } from "node:crypto";
import { supabase } from "./supabase";
import { CANCEL_ACTIONS, type SignalAction } from "./schema";
import type { SignalOrigin } from "./origin";

export type SettingsRow = {
  id: number;
  symbol_threshold: number;
  global_threshold: number;
  freshness_seconds: number;
  queue_ttl_seconds: number;
  updated_at: string;
  updated_by: string | null;
};

/** Fila de la tabla signals tal cual la devuelve Supabase (snake_case). */
export type SignalRow = {
  id: string;
  raw: unknown;
  account_id: string | null;
  action: SignalAction;
  symbol: string;
  tf: string | null;
  type: string | null;
  grade: "ELITE" | "STANDARD" | null;
  impulse_atr: number | null;
  price: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  lots1: number | null;
  lots2: number | null;
  risk_usd: number | null;
  bar_time: number | null;
  ts_signal: number;
  origin_symbol_count: number | null;
  origin_global_count: number | null;
  origin_threshold_exceeded: boolean | null;
  auth_symbol_count: number | null;
  auth_global_count: number | null;
  auth_threshold_exceeded: boolean | null;
  symbol_threshold_snapshot: number | null;
  global_threshold_snapshot: number | null;
  origin: SignalOrigin;
  is_test: boolean;
  env: string;
  status: "pending" | "claimed" | "notified" | "rejected_technical" | "expired" | "error";
  error: string | null;
  duplicate_of: string | null;
  claimed_at: string | null;
  notified_at: string | null;
  created_at: string;
};

export async function getSettings(): Promise<SettingsRow> {
  const { data, error } = await supabase.from("settings").select("*").eq("id", 1).single();
  if (error || !data) {
    throw new Error(`No se pudo leer settings: ${error?.message ?? "fila no encontrada"}`);
  }
  return data as SettingsRow;
}

export function isFresh(tsSignalMs: number, freshnessSeconds: number, nowMs: number): boolean {
  return nowMs - tsSignalMs <= freshnessSeconds * 1000;
}

/** Comparación de tokens en tiempo constante (evita timing attacks). */
export function safeTokenEquals(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isCancelAction(action: SignalAction): boolean {
  return (CANCEL_ACTIONS as readonly string[]).includes(action);
}

/**
 * Traduce una fila de `signals` (entrada o setup) al payload v2.0 que
 * consume el EA (meta-prompt v3.0 §3.2).
 *
 * El objeto `thresholds` es autoritativo (lo calcula Supabase, no Pine) y es
 * OBLIGATORIO en toda entrada/setup. Regla dura del §3.2: si alguna de las
 * columnas auth_* / snapshot viene en NULL, se OMITE el objeto entero — nunca
 * se manda con ceros. El EA v2.0 distingue "sin datos" de "cupo en cero"; un
 * 0/0 fabricado le haría creer que tiene cupo agotado o libre cuando en
 * realidad el contrato llegó incompleto.
 *
 * Se conservan además los campos planos v1 (current_symbol_count, etc.) para
 * que un EA v1.x que aún no entienda `thresholds` siga leyendo el cupo real.
 */
export function toEaPayload(row: SignalRow) {
  const commonMeta = {
    bar_time: row.bar_time ?? row.ts_signal,
    ts_signal: row.ts_signal,
    is_test: row.is_test,
    env: row.env,
    origin: row.origin,
  };

  if (isCancelAction(row.action)) {
    return {
      id: row.id,
      account_id: row.account_id,
      action: row.action,
      symbol: row.symbol,
      tf: row.tf,
      timestamp: row.ts_signal,
      ...commonMeta,
    };
  }

  const thresholds = buildThresholds(row);

  return {
    id: row.id,
    account_id: row.account_id,
    action: row.action,
    symbol: row.symbol,
    tf: row.tf,
    type: row.type,
    grade: row.grade,
    impulse_atr: row.impulse_atr,
    price: row.price,
    sl: row.sl,
    partial_1: { lots: row.lots1, tp: row.tp1 },
    partial_2: { lots: row.lots2, tp: row.tp2 },
    risk_usd: row.risk_usd,
    // Contrato plano v1 (retrocompatibilidad con EA v1.x): mismos valores
    // autoritativos, campos sueltos. Solo se incluyen si hay datos.
    ...(thresholds
      ? {
          current_symbol_count: thresholds.symbol_count,
          symbol_threshold: thresholds.symbol_threshold,
          current_global_count: thresholds.global_count,
          global_threshold: thresholds.global_threshold,
          threshold_exceeded: thresholds.exceeded,
        }
      : {}),
    // Contrato anidado v2.0 (obligatorio o ausente, nunca con ceros).
    ...(thresholds ? { thresholds } : {}),
    timestamp: row.ts_signal,
    ...commonMeta,
  };
}

type ThresholdBlock = {
  symbol_count: number;
  symbol_threshold: number;
  global_count: number;
  global_threshold: number;
  exceeded: boolean;
};

/** null si CUALQUIER columna autoritativa falta: el §3.2 prohíbe emitir el bloque a medias. */
function buildThresholds(row: SignalRow): ThresholdBlock | null {
  if (
    row.auth_symbol_count === null ||
    row.auth_global_count === null ||
    row.symbol_threshold_snapshot === null ||
    row.global_threshold_snapshot === null ||
    row.auth_threshold_exceeded === null
  ) {
    return null;
  }
  return {
    symbol_count: row.auth_symbol_count,
    symbol_threshold: row.symbol_threshold_snapshot,
    global_count: row.auth_global_count,
    global_threshold: row.global_threshold_snapshot,
    exceeded: row.auth_threshold_exceeded,
  };
}
