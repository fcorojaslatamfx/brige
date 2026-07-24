-- ============================================================
-- Pessaro Bridge · 011_deliverable_view.sql
-- Meta-prompt v3.0 §6 "Migración 007" + §5.5.
--
-- Objetivo: que sea IMPOSIBLE POR CONSTRUCCIÓN que /api/signals sirva una
-- fila de prueba al EA. No basta con que la ruta se acuerde de filtrar:
-- el claim atómico —el único camino por el que una señal llega al
-- terminal— deja de poder ver nada que no sea tráfico real.
-- ============================================================

create or replace view public.signals_deliverable as
  select * from public.signals
  where is_test = false
    and origin  = 'tradingview'
    and env     = 'production';

grant select on public.signals_deliverable to service_role;
revoke all on public.signals_deliverable from anon, authenticated;

-- ---------- claim del EA: sólo tráfico real ----------
-- Se replican las tres condiciones de la vista en el WHERE (la alternativa
-- que admite §6) porque el claim es un UPDATE ... FROM con FOR UPDATE SKIP
-- LOCKED y necesita la tabla base.
create or replace function public.claim_signals(p_max int default 50)
returns setof public.signals
language plpgsql
as $$
declare
  v_ttl_seconds int;
begin
  select queue_ttl_seconds into v_ttl_seconds from public.settings where id = 1;

  -- Expiración en el camino caliente: el cron de Vercel corre 1x/día en
  -- plan Hobby, así que el TTL tiene que evaluarse en cada poll o el EA
  -- nunca vería 'expired' dentro de su propia ventana.
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

-- ---------- claim de la cohorte de prueba ----------
-- Camino separado y explícito para el test suite y para el smoke test post
-- deploy. Lo consume /api/signals?include_test=true, que exige el token
-- `operator` — NUNCA el del EA (§8 capa 2). Existe para que las pruebas
-- puedan ejercitar el flujo claim→ack completo sin tocar jamás la cola
-- que ve el terminal del trader.
create or replace function public.claim_signals_test(p_max int default 50)
returns setof public.signals
language plpgsql
as $$
declare
  v_ttl_seconds int;
begin
  select queue_ttl_seconds into v_ttl_seconds from public.settings where id = 1;

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

alter function public.claim_signals_test(int) set search_path = public, pg_temp;
grant execute on function public.claim_signals_test(int) to service_role;

-- ---------- §5.5 · dejar rastro de POR QUÉ caducó ----------
-- 39 de 171 señales murieron como 'expired' y la causa real no era el
-- bridge sino el terminal apagado entre 08:00 y 12:00 UTC. queue_ttl=300 s
-- se mantiene (no queremos notificar señales rancias); lo que faltaba era
-- poder demostrar la causa en vez de discutirla.
create or replace function public.fn_audit_status_change()
returns trigger
language plpgsql
as $$
declare
  v_ea_last_poll timestamptz;
begin
  if NEW.status is distinct from OLD.status then
    insert into public.audit (signal_id, event_type, detail)
    values (NEW.id, 'status_changed', jsonb_build_object('from', OLD.status, 'to', NEW.status));

    if NEW.status = 'expired' then
      select t.last_used_at into v_ea_last_poll from public.tokens t where t.kind = 'ea';

      insert into public.audit (signal_id, event_type, detail)
      values (NEW.id, 'expired_in_queue', jsonb_build_object(
        'symbol', NEW.symbol,
        'action', NEW.action,
        'segundos_en_cola', round(extract(epoch from (now() - NEW.created_at))::numeric, 1),
        'ea_last_poll_at', v_ea_last_poll,
        'ea_polled_durante_la_espera',
          v_ea_last_poll is not null and v_ea_last_poll > NEW.created_at
      ));
    end if;
  end if;
  return NEW;
end;
$$;

alter function public.fn_audit_status_change() set search_path = public, pg_temp;
