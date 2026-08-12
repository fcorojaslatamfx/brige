-- ============================================================
-- Pessaro Bridge · 022_equity_snapshot_freshness.sql
-- La curva de equity deja de inventar días.
--
-- EL FALLO. tp_snapshot_equity() (migración 020) copiaba tp_accounts a
-- tp_equity_snapshots cada noche SIN mirar si el dato estaba fresco. Un EA
-- vive dentro de MetaTrader: si el cliente apaga el PC, deja de reportar. Con
-- el terminal cinco días caído, el cron escribía cinco snapshots diarios con
-- las MISMAS cifras congeladas, y la curva salía una línea plana que se lee
-- como "no operó" cuando lo cierto es "no reportó". Son dos hechos distintos y
-- el gráfico los mostraba igual.
--
-- Peor todavía: al volver el terminal, el EA sube las operaciones que cerraron
-- mientras estuvo apagado, así que el balance de aquellos días SÍ había
-- cambiado. Los snapshots ya escritos se quedaban mintiendo, porque el cron
-- solo toca current_date y nunca revisita el pasado.
--
-- LA CORRECCIÓN. Una cuenta solo entra en el snapshot si su telemetría es más
-- reciente que p_max_staleness_hours. Si no, no se escribe fila: la curva
-- muestra un HUECO. Un hueco dice "no sabemos"; una línea plana afirma "el
-- balance fue este", y esa afirmación no la respalda ningún dato.
--
-- POR QUÉ 26 HORAS Y NO 2. El umbral no mide "¿está vivo ahora?" sino "¿supimos
-- de este terminal en algún momento de este día?". Muchos clientes apagan el PC
-- por la noche y el cron corre a las 03:00 UTC: a esa hora su último reporte
-- puede tener ocho horas y seguir siendo una observación legítima de la
-- jornada. Con 26 h se cubre el día completo más margen para un cron que se
-- retrase, y se sigue descartando lo que lleva dos días o más sin señal.
--
-- Cambia el tipo de retorno (int -> jsonb) para devolver también cuántas
-- cuentas se omitieron. Eso convierte el cron diario en el detector de
-- terminales caídos que hoy no existe: el operador ve el número sin tener que
-- ir cliente por cliente mirando badges. Requiere drop + create porque
-- Postgres no deja cambiar el tipo de retorno con create or replace; es
-- seguro, la función es nueva y todavía no la usa ningún dato.
-- ============================================================

drop function if exists public.tp_snapshot_equity(date);

create function public.tp_snapshot_equity(
  p_day                   date default current_date,
  p_max_staleness_hours   int  default 26
)
returns jsonb
language plpgsql
as $$
declare
  v_written int;
  v_stale   int;
begin
  select count(*) into v_stale
  from public.tp_accounts a
  where a.status = 'active'
    and a.updated_at < now() - make_interval(hours => p_max_staleness_hours);

  insert into public.tp_equity_snapshots (account_id, snapshot_at, balance, equity, floating)
  select a.id, p_day, a.balance, a.equity, a.floating_pnl
  from public.tp_accounts a
  where a.status = 'active'
    and a.updated_at >= now() - make_interval(hours => p_max_staleness_hours)
  on conflict (account_id, snapshot_at) do update set
    balance  = excluded.balance,
    equity   = excluded.equity,
    floating = excluded.floating;

  get diagnostics v_written = row_count;

  return jsonb_build_object(
    'day',     p_day,
    'written', v_written,
    'stale',   v_stale
  );
end;
$$;

comment on function public.tp_snapshot_equity(date, int) is
  'Snapshot diario de la curva de equity, invocado por /api/cron/cleanup. Omite las cuentas cuya telemetría lleva más de p_max_staleness_hours sin llegar: un EA depende de que MetaTrader esté encendido, y registrar cifras congeladas como si fueran la observación del día convertiría un terminal apagado en una curva plana indistinguible de una jornada sin operar. El contador `stale` que devuelve es la señal de cuántos clientes tienen el terminal caído.';

alter function public.tp_snapshot_equity(date, int) set search_path = public, pg_temp;
grant execute on function public.tp_snapshot_equity(date, int) to service_role;
