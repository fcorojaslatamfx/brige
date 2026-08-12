-- ============================================================
-- Pessaro Bridge · 021_hot_path_index.sql
-- Coste del camino caliente: el índice que le faltaba a la expiración.
--
-- claim_signals() ejecuta en CADA poll del EA —cada 2 s dentro de la ventana
-- operativa— este UPDATE de expiración:
--
--   update public.signals set status = 'expired'
--   where status in ('pending', 'claimed') and <ts_signal fuera del TTL>
--
-- Se corre unas 82.000 veces al mes (medido en pg_stat_statements) y casi
-- siempre no hay nada que expirar. El problema es que no tiene índice: el
-- índice parcial que existía, idx_signals_pending, está restringido a
-- `where status = 'pending'`, así que el planificador NO puede usarlo para un
-- predicado `status in ('pending','claimed')`. El EXPLAIN acababa recorriendo
-- ~972 filas por ux_signals_dedup_bar_time y filtrando a mano.
--
-- El índice de abajo cubre exactamente el predicado. Como es PARCIAL sobre los
-- dos estados abiertos, contiene solo las señales vivas —normalmente un puñado
-- de filas— en vez de las 2.078 de la tabla, y sigue siendo pequeño a medida
-- que el histórico crece (~110 señales/día). Es la diferencia entre un coste
-- que escala con el histórico y uno que escala con la cola.
-- ============================================================

create index if not exists idx_signals_open
  on public.signals (ts_signal)
  where status in ('pending', 'claimed');

comment on index public.idx_signals_open is
  'Índice del UPDATE de expiración de claim_signals/claim_signals_test, que corre en cada poll del EA. Parcial sobre los dos estados abiertos a propósito: idx_signals_pending solo cubre pending y por eso no servía para el predicado in (pending, claimed).';

-- ---------- claim_signals con la expiración guardada ----------
-- Idéntica a la versión de 018 salvo por el `if exists`. La lógica de
-- supresión (016/018) y el claim con FOR UPDATE SKIP LOCKED se mantienen
-- palabra por palabra: son el corazón del sistema y esta migración es de
-- rendimiento, no de comportamiento.
--
-- La guarda evita entrar en la maquinaria de escritura de un UPDATE cuando no
-- hay nada que expirar, que es el caso en la inmensa mayoría de los polls. Con
-- el índice de arriba, la comprobación se resuelve mirando unas pocas entradas.
create or replace function public.claim_signals(p_max int default 50)
returns setof public.signals
language plpgsql
as $$
declare
  v_ttl_seconds  int;
  v_hold_seconds int;
begin
  select queue_ttl_seconds, setup_hold_seconds
    into v_ttl_seconds, v_hold_seconds
    from public.settings where id = 1;

  perform public.suppress_ephemeral_setups(false);

  if exists (
    select 1
    from public.signals
    where status in ('pending', 'claimed')
      and (extract(epoch from now()) * 1000 - ts_signal) > v_ttl_seconds * 1000
  ) then
    update public.signals
    set status = 'expired'
    where status in ('pending', 'claimed')
      and (extract(epoch from now()) * 1000 - ts_signal) > v_ttl_seconds * 1000;
  end if;

  return query
  with cte as (
    select s.id from public.signals s
    where s.status  = 'pending'
      and s.is_test = false
      and s.origin  = 'tradingview'
      and s.env     = 'production'
      and (s.action not in ('SETUP_BUY', 'SETUP_SELL')
           or now() - s.created_at >= make_interval(secs => v_hold_seconds))
    order by s.ts_signal asc
    limit p_max
    for update skip locked
  )
  update public.signals s
  set status = 'claimed', claimed_at = now()
  from cte
  where s.id = cte.id
  returning s.*;
end;
$$;

alter function public.claim_signals(int) set search_path = public, pg_temp;
grant execute on function public.claim_signals(int) to service_role;
