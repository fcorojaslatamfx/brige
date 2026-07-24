-- ============================================================
-- Pessaro Bridge · 007_bar_time.sql
-- Meta-prompt v3.0 §3.3 / §6 "Migración 003" (renumerada: 003–006 ya
-- estaban ocupadas por grants, tokens, roles y last_used_at).
--
-- Defecto 1-A: el indicador emitía `timestamp` = `time` (apertura de la
-- vela) en vez de `timenow` (instante real del disparo). Como el disparo
-- de entrada es intrabarra, el lag contra freshness_seconds=180 llegaba a
-- 897 s y el 60 % del flujo moría como `stale`.
--
-- El arreglo separa los dos conceptos que estaban colapsados en un solo
-- campo:
--   ts_signal (= timestamp = timenow) -> FRESCURA
--   bar_time  (= time)                -> DEDUPLICACIÓN
--
-- Orden de despliegue obligatorio (§3.3): esta migración y el bridge que
-- escribe bar_time van ANTES que el Pine v2.0. Si se publicara el Pine
-- primero, cada duplicado de TradingView traería un `timestamp` distinto
-- en milisegundos, pasaría el dedup y el trader recibiría cada alerta dos
-- veces con sonido y push — regresión peor que el defecto original.
--
-- El índice antiguo ux_signals_dedup_live (symbol, action, ts_signal) se
-- CONSERVA a propósito hasta la Fase 6. Mientras el Pine siga siendo v1.x,
-- bar_time = ts_signal y ambos índices coinciden; en cuanto entre el Pine
-- v2.0 el índice viejo deja de deduplicar (ts_signal pasa a ser único por
-- emisión) y recién ahí se puede eliminar sin ventana desprotegida.
-- ============================================================

alter table public.signals add column if not exists bar_time bigint;

-- Backfill: para todo el histórico v1.x ambos conceptos eran el mismo valor.
update public.signals set bar_time = ts_signal where bar_time is null;

create unique index if not exists ux_signals_dedup_bar_time
  on public.signals (symbol, action, bar_time)
  where status <> 'rejected_technical';

comment on column public.signals.bar_time is
  'Apertura de la vela en epoch ms (Pine `time`). Clave estable de dedup. '
  'No confundir con ts_signal, que es el instante real de emisión (`timenow`) '
  'y es lo único que se compara contra freshness_seconds.';
