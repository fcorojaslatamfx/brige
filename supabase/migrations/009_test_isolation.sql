-- ============================================================
-- Pessaro Bridge · 009_test_isolation.sql
-- Meta-prompt v3.0 §6 "Migración 005" + §8 capa 1.
--
-- Defecto 3: no había NINGUNA barrera entre el test suite y el trader.
-- Una señal insertada por Vitest, por un smoke test de despliegue o por un
-- curl de verificación entraba en la misma cola, con el mismo account_id, y
-- GET /api/signals se la entregaba al EA, que hacía sonar la alerta y
-- mandaba el push al móvil. Que la tabla estuviera limpia era suerte
-- operativa, no una garantía.
--
-- Esta es la capa 1 de tres (las otras: bridge en el ingest, cuarentena en
-- el EA). Aquí el objetivo es que la incoherencia sea IMPOSIBLE por
-- construcción, no que la aplicación se acuerde de filtrar.
-- ============================================================

alter table public.signals
  add column if not exists origin  text    not null default 'tradingview',
  add column if not exists is_test boolean not null default false,
  add column if not exists env     text    not null default 'production';

alter table public.signals drop constraint if exists signals_origin_check;
alter table public.signals add constraint signals_origin_check
  check (origin = any (array['tradingview', 'test', 'manual', 'replay']));

-- Coherencia forzada por la base, no por la aplicación: si algo se declara
-- tráfico real de TradingView, no puede a la vez estar marcado como prueba.
-- Cualquier otro origen queda libre de marcar is_test/env como corresponda.
alter table public.signals drop constraint if exists signals_test_coherence;
alter table public.signals add constraint signals_test_coherence
  check ( (origin =  'tradingview' and is_test = false and env = 'production')
       or (origin <> 'tradingview') );

-- Índice de entrega: el camino caliente de claim_signals ya no mira solo
-- (status, ts_signal), sino status + las tres condiciones de entregabilidad.
create index if not exists signals_delivery_idx
  on public.signals (status, created_at)
  where is_test = false and origin = 'tradingview';

comment on column public.signals.origin is
  'Se deriva SIEMPRE del tipo de token que autenticó el ingest, nunca de un '
  'campo del body: aceptarlo del payload lo haría trivialmente falsificable.';
