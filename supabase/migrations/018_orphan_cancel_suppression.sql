-- ============================================================
-- Pessaro Bridge · 018_orphan_cancel_suppression.sql
-- Supresión de CANCELACIONES HUÉRFANAS.
--
-- Problema medido en producción: 43 CANCEL_ALL notificadas frente a 134
-- entradas muertas como 'expired'. El trader recibe cancelaciones de
-- operaciones que NUNCA se le notificaron — no porque fueran efímeras (eso lo
-- cubre la 016), sino porque su armado murió por TTL o porque el terminal
-- estaba apagado cuando tocaba entregarlo. Es la queja original: "recibo
-- cancelaciones de operaciones que nunca me avisaron".
--
-- LA REGLA, en una frase: una cancelación se entrega SOLO si existe una entrada
-- de ese símbolo que salió de verdad al terminal y que todavía no fue cerrada
-- por una cancelación ya entregada. Si no hay nada vivo que cancelar, la
-- cancelación no es información: es ruido.
--
-- Esto GENERALIZA el guardarraíl de la 016 en vez de añadir una regla nueva.
-- Allí la cancelación se suprimía si (a) había matado un armado pendiente
-- dentro de la ventana Y (b) no quedaba una entrada despachada sin cerrar.
-- Resulta que (b) por sí solo es el predicado correcto: (a) solo restringía el
-- caso a las parejas efímeras. Al quitar (a), el mismo mecanismo cubre también
-- las huérfanas por TTL y por terminal apagado.
--
-- CONSECUENCIA IMPORTANTE — la ventana deja de intervenir en la supresión. Las
-- "víctimas" de una cancelación pasan a ser TODAS las entradas de ese símbolo
-- que sigan en cola y nunca se hayan despachado, sin límite de tiempo. Entregar
-- un armado que una cancelación posterior ya invalidó es exactamente el ruido
-- que veníamos a eliminar, dé igual cuántos segundos pasaron. `setup_hold_seconds`
-- se mantiene y sigue siendo necesaria, pero su único trabajo ahora es RETENER
-- la entrega el tiempo suficiente para que la cancelación alcance al armado;
-- ya no aparece en el predicado de supresión. Por eso `suppress_ephemeral_setups`
-- pierde el parámetro `p_hold_seconds`, que quedó sin uso.
--
-- La cadena se cierra sola y no necesita ventana de tiempo: en cuanto una
-- cancelación SE ENTREGA, la entrada que la motivó queda "cerrada", así que las
-- cancelaciones siguientes del mismo símbolo vuelven a ser huérfanas y se
-- suprimen. Una entrada despachada y jamás cancelada mantiene su derecho a que
-- le llegue la cancelación, por vieja que sea — que es justo lo que se quiere.
--
-- `settings.suppress_orphan_cancels` permite volver atrás sin migración: es un
-- cambio en CUÁNDO le llega una cancelación al trader, y eso merece un
-- interruptor. Con el flag apagado se mantiene el guardarraíl de la 016 (una
-- cancelación con algo vivo detrás siempre se entrega) y solo se dejan de
-- suprimir las huérfanas.
-- ============================================================

alter table public.settings
  add column if not exists suppress_orphan_cancels boolean not null default true;

comment on column public.settings.suppress_orphan_cancels is
  'true: una cancelación sin ninguna entrada despachada y sin cerrar detrás no '
  'se entrega al terminal (es ruido). false: se entrega igual, como antes de la '
  'migración 018. No afecta al guardarraíl: con algo vivo detrás SIEMPRE se entrega.';

-- ---------- supresión unificada ----------
-- Se elimina la firma vieja: `p_hold_seconds` quedó sin uso y dejarla como
-- sobrecarga haría ambigua la resolución de PostgREST.
drop function if exists public.suppress_ephemeral_setups(int, boolean);

create or replace function public.suppress_ephemeral_setups(p_is_test boolean default null)
returns int
language plpgsql
as $$
declare
  v_suppress_orphans boolean;
  v_n                int := 0;
begin
  select s.suppress_orphan_cancels into v_suppress_orphans
  from public.settings s where s.id = 1;

  with cxl as (
    select c.id, c.symbol, c.is_test, c.env, c.origin, c.created_at,
      -- ¿Queda algo VIVO que esta cancelación pueda cancelar? Es decir: una
      -- entrada de ese símbolo que sí salió al terminal (o a un cliente) y a la
      -- que todavía no le siguió una cancelación entregada.
      exists (
        select 1
        from public.signals e2
        where e2.symbol  = c.symbol
          and e2.is_test = c.is_test
          and e2.env     = c.env
          and e2.origin  = c.origin
          and e2.action in ('BUY_DUAL', 'SELL_DUAL', 'SETUP_BUY', 'SETUP_SELL')
          and e2.created_at < c.created_at
          and public.signal_dispatched(e2.id, e2.claimed_at)
          and not exists (
            select 1
            from public.signals c2
            where c2.symbol  = c.symbol
              and c2.is_test = c.is_test
              and c2.env     = c.env
              and c2.origin  = c.origin
              and c2.action in ('CANCEL_ALL', 'SETUP_CANCEL')
              and c2.created_at > e2.created_at
              and c2.created_at < c.created_at
              and public.signal_dispatched(c2.id, c2.claimed_at)
          )
      ) as tiene_algo_vivo
    from public.signals c
    where c.action in ('CANCEL_ALL', 'SETUP_CANCEL')
      and c.status = 'pending'
      and (p_is_test is null or c.is_test = p_is_test)
      and not public.signal_dispatched(c.id, c.claimed_at)
  ),
  -- Entradas que esta cancelación deja sin objeto: mismo símbolo y cohorte,
  -- todavía en cola y nunca despachadas. Sin ventana de tiempo (ver cabecera).
  victimas as (
    select e.id as entry_id, cxl.id as cancel_id
    from cxl
    join public.signals e
      on  e.symbol  = cxl.symbol
      and e.is_test = cxl.is_test
      and e.env     = cxl.env
      and e.origin  = cxl.origin
      and e.action in ('BUY_DUAL', 'SELL_DUAL', 'SETUP_BUY', 'SETUP_SELL')
      and e.status  = 'pending'
      and e.created_at < cxl.created_at
      and not public.signal_dispatched(e.id, e.claimed_at)
  ),
  cancels_a_suprimir as (
    select cxl.id,
           (select (array_agg(v.entry_id order by v.entry_id))[1]
            from victimas v where v.cancel_id = cxl.id) as ref_entry
    from cxl
    where v_suppress_orphans
      and not cxl.tiene_algo_vivo
  ),
  upd_entradas as (
    update public.signals s
    set status = 'suppressed', superseded_by = v.cancel_id
    from victimas v
    where s.id = v.entry_id and s.status = 'pending'
    returning s.id, s.symbol, s.action, v.cancel_id as pareja, 'armado_sin_objeto'::text as motivo
  ),
  upd_cancels as (
    update public.signals s
    set status = 'suppressed', superseded_by = ca.ref_entry
    from cancels_a_suprimir ca
    where s.id = ca.id and s.status = 'pending'
    returning s.id, s.symbol, s.action, ca.ref_entry as pareja, 'cancelacion_huerfana'::text as motivo
  ),
  todo as (
    select * from upd_entradas
    union all
    select * from upd_cancels
  ),
  auditoria as (
    insert into public.audit (signal_id, event_type, detail)
    select t.id, 'setup_suppressed', jsonb_build_object(
      'symbol', t.symbol,
      'action', t.action,
      'motivo', t.motivo,
      'pareja_id', t.pareja,
      'nota', case t.motivo
        when 'cancelacion_huerfana' then 'no quedaba ninguna entrada despachada sin cerrar de este simbolo'
        else 'una cancelacion posterior lo dejo sin objeto antes de que saliera de la cola'
      end
    )
    from todo t
    returning 1
  )
  select count(*)::int into v_n from todo;

  return coalesce(v_n, 0);
end;
$$;

alter function public.suppress_ephemeral_setups(boolean) set search_path = public, pg_temp;
revoke execute on function public.suppress_ephemeral_setups(boolean) from public, anon, authenticated;
grant execute on function public.suppress_ephemeral_setups(boolean) to service_role;

-- ---------- los tres claims pasan a la firma nueva ----------

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

  update public.signals
  set status = 'expired'
  where status in ('pending', 'claimed')
    and (extract(epoch from now()) * 1000 - ts_signal) > v_ttl_seconds * 1000;

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

create or replace function public.claim_signals_test(
  p_max          int default 50,
  p_hold_seconds int default null
)
returns setof public.signals
language plpgsql
as $$
declare
  v_ttl_seconds  int;
  v_hold_seconds int;
begin
  select queue_ttl_seconds, coalesce(p_hold_seconds, setup_hold_seconds)
    into v_ttl_seconds, v_hold_seconds
    from public.settings where id = 1;

  perform public.suppress_ephemeral_setups(true);

  update public.signals
  set status = 'expired'
  where status in ('pending', 'claimed')
    and is_test = true
    and (extract(epoch from now()) * 1000 - ts_signal) > v_ttl_seconds * 1000;

  return query
  with cte as (
    select s.id from public.signals s
    where s.status  = 'pending'
      and s.is_test = true
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

alter function public.claim_signals_test(int, int) set search_path = public, pg_temp;
grant execute on function public.claim_signals_test(int, int) to service_role;

create or replace function public.claim_signals_for_client(p_client_id uuid, p_max int default 50)
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

  return query
  with cand as (
    select s.id
    from public.signals s
    where s.is_test = false
      and s.origin  = 'tradingview'
      and s.env     = 'production'
      and s.status not in ('rejected_technical', 'suppressed')
      and (extract(epoch from now()) * 1000 - s.ts_signal) <= v_ttl_seconds * 1000
      and (s.action not in ('SETUP_BUY', 'SETUP_SELL')
           or now() - s.created_at >= make_interval(secs => v_hold_seconds))
      and not exists (
        select 1 from public.client_deliveries d
        where d.signal_id = s.id and d.client_id = p_client_id
      )
    order by s.ts_signal asc
    limit p_max
  ),
  ins as (
    insert into public.client_deliveries (signal_id, client_id, status, claimed_at)
    select cand.id, p_client_id, 'claimed', now() from cand
    on conflict (signal_id, client_id) do nothing
    returning signal_id
  )
  select s.*
  from public.signals s
  join ins on ins.signal_id = s.id
  order by s.ts_signal asc;
end;
$$;

alter function public.claim_signals_for_client(uuid, int) set search_path = public, pg_temp;
grant execute on function public.claim_signals_for_client(uuid, int) to service_role;
