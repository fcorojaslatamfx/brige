-- ============================================================
-- Pessaro Bridge · 010_authoritative_thresholds.sql
-- Meta-prompt v3.0 §5.2 / §6 "Migración 006".
--
-- Defecto 4 (el "0/0 símbolo · 0/0 global" del panel del EA): la cadena
-- estaba rota en tres puntos a la vez. El indicador no emite contadores y
-- estructuralmente NO PUEDE emitirlos bien (los contextos request.security
-- de los 14 slots no leen variables del gráfico anfitrión, decisión D4);
-- el bridge dejaba auth_* en NULL para todo lo que no fuera BUY/SELL_DUAL;
-- y el EA leía claves que nadie escribía y caía al default 0.
--
-- Decisión de arquitectura: EL BRIDGE ES LA ÚNICA FUENTE DE VERDAD de los
-- umbrales. Es la única capa con visión de cartera completa, ya tiene los
-- valores configurables en settings y el historial en Postgres.
--
-- Los umbrales INFORMAN, NUNCA FILTRAN (restricción permanente §12.2):
-- exceeded=true es un adjetivo, no un verbo. La señal se entrega igual,
-- marcada en ámbar.
--
-- Dos desviaciones deliberadas respecto del SQL literal del meta-prompt,
-- ambas por coherencia con lo que ya existe en el proyecto:
--
--  1. El "día de mercado" se calcula con market_day(ts_signal) — el helper
--     de 001_schema.sql, ya usado por today_counts() y por el panel — en
--     vez de con created_at. Si el EA y /status usaran definiciones
--     distintas de "hoy" mostrarían números distintos para el mismo día.
--  2. Se añade el parámetro p_is_test: cada cohorte se cuenta contra sí
--     misma. Así el tráfico de pruebas nunca infla el cupo real del trader
--     (§8) y, a la vez, los tests de umbral siguen siendo verificables.
--
-- Se conserva el `>=` del meta-prompt: el cupo se marca al ALCANZARLO, no
-- al superarlo. Es un cambio de semántica respecto de la v1.x (que usaba
-- `>`); con symbol_threshold=10, la señal nº 10 ya sale en ámbar.
-- ============================================================

create or replace function public.calc_thresholds(
  p_symbol  text,
  p_ts_ms   bigint  default null,
  p_is_test boolean default false
)
returns table (
  symbol_count     int,
  global_count     int,
  symbol_threshold int,
  global_threshold int,
  exceeded         boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cfg as (
    select s.symbol_threshold, s.global_threshold
    from public.settings s
    where s.id = 1
  ),
  hoy as (
    select sg.symbol
    from public.signals sg
    where sg.action in ('BUY_DUAL', 'SELL_DUAL', 'SETUP_BUY', 'SETUP_SELL')
      and sg.status <> 'rejected_technical'
      and coalesce(sg.is_test, false) = p_is_test
      and public.market_day(sg.ts_signal) =
          public.market_day(coalesce(p_ts_ms, (extract(epoch from now()) * 1000)::bigint))
  )
  select
    (select count(*)::int from hoy where hoy.symbol = p_symbol),
    (select count(*)::int from hoy),
    cfg.symbol_threshold,
    cfg.global_threshold,
    (select count(*) from hoy where hoy.symbol = p_symbol) >= cfg.symbol_threshold
      or (select count(*) from hoy) >= cfg.global_threshold
  from cfg;
$$;

-- Sin este GRANT el fallo no es un 500 visible sino un "permission denied"
-- silencioso: exactamente el incidente que obligó a escribir
-- 003_grant_service_role.sql. Verificar explícitamente tras aplicar.
grant execute on function public.calc_thresholds(text, bigint, boolean) to service_role;

-- ---------- contar_dia: se mantiene la firma, delega en la nueva verdad ----------
-- (la firma no puede cambiar sin romper el `alter function ... set
--  search_path` de 002_function_search_path.sql)
create or replace function public.contar_dia(p_symbol text, p_ts_ms bigint)
returns table(symbol_count int, global_count int)
language sql stable
as $$
  select t.symbol_count, t.global_count
  from public.calc_thresholds(p_symbol, p_ts_ms, false) t;
$$;

-- ---------- trigger: ahora también sobre los eventos de setup ----------
create or replace function public.fn_apply_authoritative_counts()
returns trigger
language plpgsql
as $$
declare
  v_symbol_count int;
  v_global_count int;
  v_symbol_threshold int;
  v_global_threshold int;
  v_exceeded boolean;
begin
  if NEW.action not in ('BUY_DUAL', 'SELL_DUAL', 'SETUP_BUY', 'SETUP_SELL')
     or NEW.status = 'rejected_technical' then
    return NEW;
  end if;

  -- NEW ya está insertada y visible dentro de la misma transacción (AFTER INSERT)
  select t.symbol_count, t.global_count, t.symbol_threshold, t.global_threshold, t.exceeded
    into v_symbol_count, v_global_count, v_symbol_threshold, v_global_threshold, v_exceeded
    from public.calc_thresholds(NEW.symbol, NEW.ts_signal, NEW.is_test) t;

  update public.signals set
    auth_symbol_count = v_symbol_count,
    auth_global_count = v_global_count,
    auth_threshold_exceeded = v_exceeded,
    symbol_threshold_snapshot = v_symbol_threshold,
    global_threshold_snapshot = v_global_threshold
  where id = NEW.id;

  insert into public.audit (signal_id, event_type, detail)
  values (NEW.id, 'ingested', jsonb_build_object(
    'symbol', NEW.symbol, 'action', NEW.action,
    'origin', NEW.origin, 'is_test', NEW.is_test,
    'auth_symbol_count', v_symbol_count, 'auth_global_count', v_global_count,
    'origin_symbol_count', NEW.origin_symbol_count, 'origin_global_count', NEW.origin_global_count
  ));

  if v_exceeded then
    insert into public.audit (signal_id, event_type, detail)
    values (NEW.id, 'threshold_exceeded', jsonb_build_object(
      'auth_symbol_count', v_symbol_count, 'symbol_threshold', v_symbol_threshold,
      'auth_global_count', v_global_count, 'global_threshold', v_global_threshold,
      'nota', 'informativo: la senal se entrega igualmente'
    ));
  end if;

  if (NEW.origin_symbol_count is not null and NEW.origin_symbol_count <> v_symbol_count)
     or (NEW.origin_global_count is not null and NEW.origin_global_count <> v_global_count) then
    insert into public.audit (signal_id, event_type, detail)
    values (NEW.id, 'count_discrepancy', jsonb_build_object(
      'origin_symbol_count', NEW.origin_symbol_count, 'auth_symbol_count', v_symbol_count,
      'origin_global_count', NEW.origin_global_count, 'auth_global_count', v_global_count
    ));
  end if;

  return NEW;
end;
$$;

alter function public.fn_apply_authoritative_counts() set search_path = public, pg_temp;

-- ---------- today_counts: setups incluidos, tráfico de prueba fuera ----------
create or replace function public.today_counts()
returns table(symbol text, symbol_count int, global_count int)
language sql stable
as $$
  with today as (
    select s.symbol
    from public.signals s
    where s.action in ('BUY_DUAL', 'SELL_DUAL', 'SETUP_BUY', 'SETUP_SELL')
      and s.status <> 'rejected_technical'
      and s.is_test = false
      and s.origin = 'tradingview'
      and public.market_day(s.ts_signal) =
          public.market_day(floor(extract(epoch from now()) * 1000)::bigint)
  ), totals as (
    select count(*)::int as global_count from today
  )
  select t.symbol, count(*)::int as symbol_count, totals.global_count
  from today t, totals
  group by t.symbol, totals.global_count
$$;

alter function public.today_counts() set search_path = public, pg_temp;
alter function public.contar_dia(text, bigint) set search_path = public, pg_temp;
