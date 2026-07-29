-- ============================================================
-- Pessaro Bridge · 016_ephemeral_setup_suppression.sql
-- Retención y supresión de SETUPS EFÍMEROS.
--
-- Problema que resuelve (pregunta del operador): un setup armado que se
-- cancela a los pocos segundos no debe llegar nunca al terminal. Hoy el
-- bridge entrega TODO lo que ingresa fresco, así que la pareja
-- (SETUP_BUY, SETUP_CANCEL) resuelta en 20 s produce dos alertas sonoras,
-- dos push y dos filas de panel para un evento que operativamente NUNCA
-- EXISTIÓ: no hubo ventana real para colocar la pendiente.
--
-- MECANISMO, en dos piezas que dependen una de la otra:
--
--  1. RETENCIÓN (`settings.setup_hold_seconds`, por defecto 45 s). Un
--     SETUP_BUY / SETUP_SELL no se entrega hasta que haya sobrevivido esa
--     ventana desde su ingesta. Sin la retención la supresión sería
--     inalcanzable: con polling de 2 s el setup ya estaría en el móvil del
--     trader cuando llega su cancelación.
--
--  2. SUPRESIÓN (`suppress_ephemeral_setups`). Se ejecuta al inicio de cada
--     claim, ANTES de seleccionar y antes de aplicar el TTL. Si dentro de la
--     ventana de retención llega una cancelación del mismo símbolo, el
--     armado pasa a status='suppressed' y —bajo la condición de seguridad de
--     abajo— la cancelación también: una cancelación de algo que el trader
--     nunca vio es ruido puro, y es exactamente el ruido del que se queja
--     ("recibo cancelaciones de operaciones que nunca me notificaron").
--
-- LA RETENCIÓN SOLO APLICA A SETUP_BUY / SETUP_SELL. `BUY_DUAL` / `SELL_DUAL`
-- significan "el precio YA tocó tu nivel": son el evento de máxima urgencia y
-- no se retrasan ni un segundo. Aun así SÍ participan de la supresión: si una
-- entrada todavía está en cola (nunca despachada) cuando llega su
-- cancelación, se suprime la pareja sin haber añadido latencia a nada.
--
-- GUARDARRAÍL DURO — NUNCA OCULTAR UNA CANCELACIÓN VIVA. La cancelación solo
-- se suprime si NO existe, para ese símbolo y cohorte, ninguna
-- "entrada despachada sin cerrar": una entrada/setup que sí salió al terminal
-- (o a un cliente) y a la que todavía no le siguió una cancelación despachada.
-- Si el trader tiene una pendiente colocada por indicación nuestra, su
-- cancelación se entrega siempre, cueste lo que cueste.
--
-- "Despachada" NO es status: el EA del operador consume la cola
-- (signals.claimed_at) pero los EA de cliente reciben por DIFUSIÓN, y esa
-- entrega vive en `client_deliveries` sin tocar signals.status (migración
-- 014). Una señal difundida a clientes puede seguir 'pending' para siempre.
-- Por eso el predicado de despacho mira las dos cosas — ignorarlo dejaría a
-- los clientes con órdenes pendientes cuya cancelación se suprimió.
--
-- Nota sobre `status='expired'`: puede venir de 'pending' (nunca salió) o de
-- 'claimed' (salió y el EA no ackeó). El status no distingue; claimed_at sí.
-- Todo este archivo usa claimed_at / client_deliveries, jamás el status.
--
-- ⚠ INVARIANTE DE UN SOLO RELOJ. La retención y la ventana de supresión se
-- miden con `now() - created_at`, así que `created_at` NO puede venir del reloj
-- de la app: con dos relojes, cualquier deriva se vuelve un desfase real y un
-- armado recién ingestado puede tener created_at en el FUTURO para Postgres —
-- la resta sale negativa y el armado queda retenido incluso con la ventana en
-- 0. Se detectó así, con la máquina de desarrollo 20 s adelantada. Por eso
-- `app/api/webhook/route.ts` dejó de escribir `created_at` y lo pone el default
-- `now()` de la tabla. Si alguna ruta futura vuelve a escribirlo a mano, esta
-- lógica se rompe en silencio.
-- ============================================================

-- ---------- 1 · configuración ----------
alter table public.settings
  add column if not exists setup_hold_seconds int not null default 45;

-- La retención tiene que caber dentro del TTL de cola o nada se entregaría
-- jamás: el setup moriría 'expired' esperando salir de la retención.
alter table public.settings drop constraint if exists settings_setup_hold_check;
alter table public.settings add constraint settings_setup_hold_check
  check (setup_hold_seconds >= 0 and setup_hold_seconds < queue_ttl_seconds);

comment on column public.settings.setup_hold_seconds is
  'Segundos que un SETUP_BUY/SETUP_SELL espera en cola antes de ser entregable. '
  '0 = desactivado (entrega inmediata, sin supresión de parejas efímeras).';

-- ---------- 2 · nuevo estado terminal ----------
alter table public.signals drop constraint if exists signals_status_check;
alter table public.signals add constraint signals_status_check
  check (status = any (array[
    'pending', 'claimed', 'notified', 'rejected_technical', 'expired', 'error',
    'suppressed'
  ]));

-- `on delete set null` (a diferencia de duplicate_of, que nació sin cláusula):
-- purgar una señal no debe quedar bloqueado por la que la referencia.
alter table public.signals
  add column if not exists superseded_by uuid references public.signals(id) on delete set null;

comment on column public.signals.superseded_by is
  'Cancelación que suprimió este armado dentro de setup_hold_seconds. En la '
  'propia cancelación suprimida apunta al armado que la dejó sin objeto.';

-- El claim consulta "¿hay cancelación pendiente de este símbolo?" y
-- "¿hay entrada despachada sin cerrar?" en cada poll (cada 2 s en ventana).
create index if not exists idx_signals_symbol_created
  on public.signals (symbol, created_at desc);

-- ---------- 3 · ¿esta señal ya salió del bridge? ----------
-- Única definición de "despachada" del proyecto: la cola del operador
-- (claimed_at) O la difusión a cualquier cliente (client_deliveries).
create or replace function public.signal_dispatched(p_id uuid, p_claimed_at timestamptz)
returns boolean
language sql
stable
as $$
  select p_claimed_at is not null
      or exists (select 1 from public.client_deliveries d where d.signal_id = p_id);
$$;

alter function public.signal_dispatched(uuid, timestamptz) set search_path = public, pg_temp;
revoke execute on function public.signal_dispatched(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.signal_dispatched(uuid, timestamptz) to service_role;

-- ---------- 4 · supresión de parejas efímeras ----------
-- p_hold_seconds: null → el valor de settings. Explícito solo desde la cola de
--   prueba, para que los tests sean deterministas sin mutar la configuración
--   de producción (§8: el camino de prueba es separado por construcción).
-- p_is_test: null → ambas cohortes; false → solo tráfico real.
create or replace function public.suppress_ephemeral_setups(
  p_hold_seconds int     default null,
  p_is_test      boolean default null
)
returns int
language plpgsql
as $$
declare
  v_hold int;
  v_n    int := 0;
begin
  select coalesce(p_hold_seconds, s.setup_hold_seconds) into v_hold
  from public.settings s where s.id = 1;

  if v_hold is null or v_hold <= 0 then
    return 0;
  end if;

  -- Cancelaciones aún en cola cuyo armado murió en la cuna. Una cancelación ya
  -- despachada no se toca: el trader la tiene, no hay nada que ocultar.
  with cxl as (
    select c.id, c.symbol, c.is_test, c.env, c.origin, c.created_at
    from public.signals c
    where c.action in ('CANCEL_ALL', 'SETUP_CANCEL')
      and c.status = 'pending'
      and (p_is_test is null or c.is_test = p_is_test)
      and not public.signal_dispatched(c.id, c.claimed_at)
  ),
  -- Armados/entradas que esta cancelación deja sin objeto: misma cohorte y
  -- símbolo, todavía en cola, nunca despachados, dentro de la ventana.
  victimas as (
    select e.id as entry_id, cxl.id as cancel_id
    from cxl
    join public.signals e
      on  e.symbol  = cxl.symbol
      and e.is_test  = cxl.is_test
      and e.env      = cxl.env
      and e.origin   = cxl.origin
      and e.action  in ('BUY_DUAL', 'SELL_DUAL', 'SETUP_BUY', 'SETUP_SELL')
      and e.status   = 'pending'
      and e.created_at <  cxl.created_at
      and e.created_at >= cxl.created_at - make_interval(secs => v_hold)
      and not public.signal_dispatched(e.id, e.claimed_at)
  ),
  -- Guardarraíl: la cancelación solo se suprime si dejó sin objeto al menos un
  -- armado Y no queda ninguna entrada despachada sin cerrar de ese símbolo.
  cancels_a_suprimir as (
    select cxl.id, (array_agg(v.entry_id order by v.entry_id))[1] as ref_entry
    from cxl
    join victimas v on v.cancel_id = cxl.id
    where not exists (
      select 1
      from public.signals e2
      where e2.symbol = cxl.symbol
        and e2.is_test = cxl.is_test
        and e2.env     = cxl.env
        and e2.origin  = cxl.origin
        and e2.action in ('BUY_DUAL', 'SELL_DUAL', 'SETUP_BUY', 'SETUP_SELL')
        and e2.created_at < cxl.created_at
        and public.signal_dispatched(e2.id, e2.claimed_at)
        -- ...y sin una cancelación despachada posterior que ya la cerrara.
        and not exists (
          select 1
          from public.signals c2
          where c2.symbol = cxl.symbol
            and c2.is_test = cxl.is_test
            and c2.env     = cxl.env
            and c2.origin  = cxl.origin
            and c2.action in ('CANCEL_ALL', 'SETUP_CANCEL')
            and c2.created_at > e2.created_at
            and c2.created_at < cxl.created_at
            and public.signal_dispatched(c2.id, c2.claimed_at)
        )
    )
    group by cxl.id
  ),
  upd_entradas as (
    update public.signals s
    set status = 'suppressed', superseded_by = v.cancel_id
    from victimas v
    where s.id = v.entry_id and s.status = 'pending'
    returning s.id, s.symbol, s.action, v.cancel_id
  ),
  upd_cancels as (
    update public.signals s
    set status = 'suppressed', superseded_by = ca.ref_entry
    from cancels_a_suprimir ca
    where s.id = ca.id and s.status = 'pending'
    returning s.id, s.symbol, s.action, ca.ref_entry as cancel_id
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
      'hold_seconds', v_hold,
      'pareja_id', t.cancel_id,
      'motivo', 'armado y cancelado dentro de la ventana de retencion: nunca hubo pendiente colocable'
    )
    from todo t
    returning 1
  )
  select count(*)::int into v_n from todo;

  return coalesce(v_n, 0);
end;
$$;

alter function public.suppress_ephemeral_setups(int, boolean) set search_path = public, pg_temp;
revoke execute on function public.suppress_ephemeral_setups(int, boolean) from public, anon, authenticated;
grant execute on function public.suppress_ephemeral_setups(int, boolean) to service_role;

-- ---------- 5 · cola del operador ----------
-- Orden obligatorio: SUPRIMIR → EXPIRAR POR TTL → SELECCIONAR. Si el TTL
-- corriera primero, un armado ya caducado dejaría de ser 'pending' y su
-- cancelación se entregaría huérfana — el ruido que veníamos a eliminar.
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

  perform public.suppress_ephemeral_setups(null, false);

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
      -- Retención: solo los armados esperan. Los disparos salen ya.
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

-- ---------- 6 · cola de prueba ----------
-- Se recrea con firma nueva (p_hold_seconds) en vez de sobrecargar: dos
-- funciones con el mismo nombre harían ambigua la resolución de PostgREST
-- cuando la llamada solo trae p_max.
drop function if exists public.claim_signals_test(int);

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

  perform public.suppress_ephemeral_setups(v_hold_seconds, true);

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

-- ---------- 7 · difusión a clientes ----------
-- Misma retención y misma supresión: un cliente no puede recibir una pareja
-- efímera que el operador no recibe. La supresión se ejecuta también aquí
-- porque puede que solo haya EA de cliente polleando.
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

  perform public.suppress_ephemeral_setups(null, false);

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

-- ---------- 8 · cupo diario: lo suprimido no consume ----------
-- Los umbrales miden la exposición OFRECIDA al trader. Un armado que murió en
-- la cuna nunca se ofreció, así que no debe gastar cupo del día. (Los
-- snapshots auth_* de filas ya insertadas no se reescriben: son históricos,
-- igual que hoy con las rechazadas.)
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
      and sg.status not in ('rejected_technical', 'suppressed')
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

revoke execute on function public.calc_thresholds(text, bigint, boolean) from public, anon, authenticated;
grant  execute on function public.calc_thresholds(text, bigint, boolean) to service_role;

create or replace function public.today_counts()
returns table(symbol text, symbol_count int, global_count int)
language sql stable
as $$
  with today as (
    select s.symbol
    from public.signals s
    where s.action in ('BUY_DUAL', 'SELL_DUAL', 'SETUP_BUY', 'SETUP_SELL')
      and s.status not in ('rejected_technical', 'suppressed')
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
