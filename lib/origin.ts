import type { TokenKind } from "./tokens";

/**
 * Capa 2 de la defensa en profundidad contra fugas del test suite
 * (meta-prompt v3.0 §8). El principio: `origin` se DERIVA del tipo de token
 * que autenticó el ingest y del entorno del despliegue, nunca se lee del
 * body — aceptarlo del payload lo haría trivialmente falsificable, y lo que
 * está en juego es un push al móvil del trader por una señal inventada.
 *
 * Las otras dos capas: los CHECK de coherencia y claim_signals en Postgres
 * (009/011), y la cuarentena del propio EA.
 */

export type SignalOrigin = "tradingview" | "test" | "manual" | "replay";

export type IngestContext = {
  origin: SignalOrigin;
  is_test: boolean;
  env: string;
};

export const PRODUCTION_ENV = "production";

/** Entorno declarado del despliegue. Cualquier valor distinto de "production" es tráfico de prueba. */
export function currentEnv(): string {
  return process.env.PESSARO_ENV?.trim() || PRODUCTION_ENV;
}

export function isProductionEnv(): boolean {
  return currentEnv() === PRODUCTION_ENV;
}

/**
 * Sólo el token de TradingView, y sólo en un despliegue de producción,
 * produce tráfico entregable. Un preview de Vercel o una corrida local con
 * el token real siguen marcados como prueba: el entorno manda tanto como el
 * token.
 */
export function resolveIngestContext(tokenKind: TokenKind): IngestContext {
  const env = currentEnv();
  if (tokenKind === "tv_webhook" && env === PRODUCTION_ENV) {
    return { origin: "tradingview", is_test: false, env };
  }
  return { origin: "test", is_test: true, env };
}
