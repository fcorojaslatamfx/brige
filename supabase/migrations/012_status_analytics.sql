-- ============================================================
-- Pessaro Bridge · 012_status_analytics.sql
-- Meta-prompt v3.0 §5.4: el panel /status necesita hacer VISIBLE lo que la
-- investigación tuvo que reconstruir a mano en SQL. Dos vistas de agregación
-- que el primer día habrían delatado el problema de `stale`:
--
--   delivery_funnel — recibidas → validadas → encoladas → notificadas, con el
--                     desglose de rechazos por motivo.
--   latency_stats   — lag ts_signal→created_at por acción, y cuántas cruzaron
--                     freshness_seconds (la línea que mata las entradas).
--
-- Ambas aceptan un filtro de origen (tradingview / test / manual / replay /
-- 'all') para poder ver el tráfico de prueba aparte del real, con el default
-- puesto en 'tradingview' (§5.4: el badge de prueba solo cuando se lo pide).
-- ============================================================

create or replace function public.delivery_funnel(
  p_hours  int  default 48,
  p_origin text default 'tradingview'
)
returns table (status text, error text, n bigint, pct numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  with base as (
    select s.status, s.error
    from public.signals s
    where s.created_at > now() - make_interval(hours => p_hours)
      and (p_origin = 'all' or s.origin = p_origin)
  )
  select
    base.status,
    base.error,
    count(*) as n,
    round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 1) as pct
  from base
  group by base.status, base.error
  order by n desc;
$$;

grant execute on function public.delivery_funnel(int, text) to service_role;

create or replace function public.latency_stats(
  p_hours  int  default 48,
  p_origin text default 'tradingview'
)
returns table (
  action    text,
  n         bigint,
  lag_avg   numeric,
  lag_min   numeric,
  lag_max   numeric,
  over_fresh bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with fresh as (
    select freshness_seconds from public.settings where id = 1
  ),
  base as (
    select
      s.action,
      extract(epoch from (s.created_at - to_timestamp(s.ts_signal / 1000.0))) as lag_s
    from public.signals s
    where s.created_at > now() - make_interval(hours => p_hours)
      and (p_origin = 'all' or s.origin = p_origin)
  )
  select
    base.action,
    count(*) as n,
    round(avg(base.lag_s)::numeric, 1) as lag_avg,
    round(min(base.lag_s)::numeric, 1) as lag_min,
    round(max(base.lag_s)::numeric, 1) as lag_max,
    count(*) filter (where base.lag_s > (select freshness_seconds from fresh)) as over_fresh
  from base
  group by base.action
  order by n desc;
$$;

grant execute on function public.latency_stats(int, text) to service_role;
