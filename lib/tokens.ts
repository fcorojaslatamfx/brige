import { randomBytes } from "node:crypto";
import { supabase } from "./supabase";

export type TokenKind = "tv_webhook" | "ea" | "operator";

export type TokenRow = {
  kind: TokenKind;
  value: string;
  updated_at: string;
  updated_by: string | null;
  last_used_at: string | null;
};

const CACHE_TTL_MS = 5_000;
const cache = new Map<TokenKind, { value: string; expiresAt: number }>();

/**
 * Lookup con caché corta en memoria: el EA hace poll cada ~1s
 * (mt4/PessaroBridgeEA.mq4), así que sin caché cada poll pegaría a
 * Supabase. Una instancia recién regenerada puede aceptar el token viejo
 * hasta CACHE_TTL_MS — aceptable porque regenerar es una acción deliberada
 * de un único operador, no un límite de seguridad contra un atacante activo.
 */
export async function getToken(kind: TokenKind): Promise<string | null> {
  const cached = cache.get(kind);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const { data, error } = await supabase.from("tokens").select("value").eq("kind", kind).maybeSingle();
  if (error || !data) return null;

  cache.set(kind, { value: data.value, expiresAt: Date.now() + CACHE_TTL_MS });
  return data.value;
}

export async function listTokens(): Promise<TokenRow[]> {
  const { data, error } = await supabase
    .from("tokens")
    .select("kind, value, updated_at, updated_by, last_used_at")
    .order("kind");
  if (error) throw new Error(`No se pudieron leer los tokens: ${error.message}`);
  return (data ?? []) as TokenRow[];
}

/**
 * Heartbeat de autenticación: se llama en cada request exitoso contra un
 * endpoint que consume este token (hoy solo /api/signals con kind "ea"),
 * haya o no trabajo real que hacer. Independiente de `updated_at`
 * (rotación) — es lo que /api/status usa para "último poll"/online-offline,
 * en vez de inferirlo de efectos secundarios como signals.claimed_at.
 */
export async function touchTokenUsage(kind: TokenKind): Promise<void> {
  const { error } = await supabase.from("tokens").update({ last_used_at: new Date().toISOString() }).eq("kind", kind);
  if (error) throw new Error(`No se pudo registrar el uso del token: ${error.message}`);
}

const EA_ONLINE_THRESHOLD_SECONDS = 10;

export type EaPollStatus = {
  lastPollAt: string | null;
  lastPollLatencySeconds: number | null;
  eaOnline: boolean;
};

/** Deriva el badge online/offline de /status a partir del heartbeat de tokens.last_used_at (kind "ea"). */
export function computeEaPollStatus(lastUsedAt: string | null, nowMs = Date.now()): EaPollStatus {
  const lastPollLatencySeconds = lastUsedAt ? (nowMs - new Date(lastUsedAt).getTime()) / 1000 : null;
  return {
    lastPollAt: lastUsedAt,
    lastPollLatencySeconds,
    eaOnline: lastPollLatencySeconds !== null && lastPollLatencySeconds < EA_ONLINE_THRESHOLD_SECONDS,
  };
}

export async function regenerateToken(kind: TokenKind, updatedBy: string): Promise<TokenRow> {
  const value = randomBytes(32).toString("hex");
  const { data, error } = await supabase
    .from("tokens")
    .upsert({ kind, value, updated_at: new Date().toISOString(), updated_by: updatedBy })
    .select("kind, value, updated_at, updated_by, last_used_at")
    .single();

  if (error || !data) {
    throw new Error(`No se pudo regenerar el token: ${error?.message ?? "sin datos"}`);
  }

  cache.delete(kind);
  return data as TokenRow;
}
