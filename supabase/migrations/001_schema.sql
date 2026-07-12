-- ============================================================
-- Pessaro Bridge · 001_schema.sql
-- Modo despachador manual: cero supresión, conteo autoritativo.
-- ============================================================

-- ---------- settings: una sola fila, mapa operativo editable ----------
create table settings (
  id                 smallint primary key default 1 check (id = 1),
  symbol_threshold   int not null default 3,
  global_threshold   int not null default 6,
  freshness_seconds  int not null default 180,   -- ventana de ingesta (webhook)
  queue_ttl_seconds  int not null default 300,   -- TTL de cola (claim/entrega)
  updated_at         timestamptz not null default now(),
  updated_by         text
);
insert into settings (id) values (1) on conflict (id) do nothing;

-- ---------- signals: cola de entrada, nunca se suprime por umbral ----------
create table signals (
  id                          uuid primary key default gen_random_uuid(),
  raw                         jsonb not null,          -- payload original tal cual llegó
  account_id                  text,
  action                      text not null check (action in ('BUY_DUAL','SELL_DUAL','CANCEL_ALL')),
  symbol                      text not null,
  tf                          text,
  type                        text,                     -- LIMIT, etc. (null en CANCEL_ALL)
  grade                       text check (grade in ('ELITE','STANDARD')),
  impulse_atr                 numeric,
  price                       numeric,
  sl                          numeric,
  tp1                         numeric,
  tp2                         numeric,
  lots1                       numeric,
  lots2                       numeric,
  risk_usd                    numeric,
  ts_signal                   bigint not null,          -- epoch ms, emitido por Pine

  -- conteos que trae Pine (best-effort, solo para auditoría de discrepancias)
  origin_symbol_count         int,
  origin_global_count         int,
  origin_threshold_exceeded   boolean,

  -- conteos autoritativos, calculados por el bridge (la verdad)
  auth_symbol_count           int,
  auth_global_count           int,
  auth_threshold_exceeded     boolean,
  symbol_threshold_snapshot   int,     -- umbral vigente al momento de calcular (trazabilidad)
  global_threshold_snapshot   int,

  status                      text not null default 'pending'
                               check (status in ('pending','claimed','notified','rejected_technical','expired','error')),
  error                       text,
  duplicate_of                uuid references signals(id),  -- fila original cuando status='rejected_technical' por dedup
  claimed_at                  timestamptz,
  notified_at                 timestamptz,
  created_at                  timestamptz not null default now()
);

-- dedup técnica: solo puede existir UNA fila "viva" (no rechazada) por
-- (symbol, action, ts_signal). Las repeticiones exactas SÍ se insertan,
-- pero con status='rejected_technical' (excluidas de esta constraint),
-- para que queden visibles en /status además de en audit.
create unique index ux_signals_dedup_live on signals (symbol, action, ts_signal)
  where status <> 'rejected_technical';

-- polling eficiente del EA
create index idx_signals_pending on signals (status, ts_signal) where status = 'pending';

-- conteo diario eficiente
create index idx_signals_symbol_ts on signals (symbol, ts_signal);

-- listado reciente para /status
create index idx_signals_created on signals (created_at desc);

-- ---------- audit: registro inmutable de todo evento ----------
create table audit (
  id          bigint generated always as identity primary key,
  signal_id   uuid references signals(id),
  event_type  text not null,   -- ingested | duplicate_rejected | stale_rejected | invalid_token
                                -- | invalid_payload | count_discrepancy | threshold_exceeded
                                -- | status_changed | ack_error | ack_note | settings_changed
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index idx_audit_signal on audit (signal_id);
create index idx_audit_created on audit (created_at);

-- ============================================================
-- Conteo autoritativo
-- ============================================================

-- "día de mercado" = fecha en America/New_York (ventana operativa LON→NY)
create or replace function market_day(ts_ms bigint)
returns date
language sql immutable
as $$
  select (to_timestamp(ts_ms / 1000.0) at time zone 'America/New_York')::date
$$;

-- cuenta señales de ENTRADA (BUY_DUAL/SELL_DUAL, no rechazadas técnicamente)
-- del día de mercado de p_ts_ms: por símbolo y global.
create or replace function contar_dia(p_symbol text, p_ts_ms bigint)
returns table(symbol_count int, global_count int)
language sql stable
as $$
  select
    count(*) filter (where symbol = p_symbol)::int as symbol_count,
    count(*)::int as global_count
  from signals
  where action in ('BUY_DUAL','SELL_DUAL')
    and status <> 'rejected_technical'
    and market_day(ts_signal) = market_day(p_ts_ms)
$$;

-- trigger: al insertar una señal de entrada VIVA (no rechazada), calcula y
-- persiste auth_* con los umbrales vigentes de settings, y audita
-- discrepancias / umbral excedido. Las filas rejected_technical
-- (duplicadas/viejas) no participan del conteo.
create or replace function fn_apply_authoritative_counts()
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
  if NEW.action not in ('BUY_DUAL','SELL_DUAL') or NEW.status = 'rejected_technical' then
    return NEW;
  end if;

  select symbol_threshold, global_threshold
    into v_symbol_threshold, v_global_threshold
    from settings where id = 1;

  select symbol_count, global_count
    into v_symbol_count, v_global_count
    from contar_dia(NEW.symbol, NEW.ts_signal);
    -- NEW ya está insertada y visible dentro de la misma transacción (AFTER INSERT)

  v_exceeded := (v_symbol_count > v_symbol_threshold) or (v_global_count > v_global_threshold);

  update signals set
    auth_symbol_count = v_symbol_count,
    auth_global_count = v_global_count,
    auth_threshold_exceeded = v_exceeded,
    symbol_threshold_snapshot = v_symbol_threshold,
    global_threshold_snapshot = v_global_threshold
  where id = NEW.id;

  insert into audit (signal_id, event_type, detail)
  values (NEW.id, 'ingested', jsonb_build_object(
    'symbol', NEW.symbol, 'action', NEW.action,
    'auth_symbol_count', v_symbol_count, 'auth_global_count', v_global_count,
    'origin_symbol_count', NEW.origin_symbol_count, 'origin_global_count', NEW.origin_global_count
  ));

  if v_exceeded then
    insert into audit (signal_id, event_type, detail)
    values (NEW.id, 'threshold_exceeded', jsonb_build_object(
      'auth_symbol_count', v_symbol_count, 'symbol_threshold', v_symbol_threshold,
      'auth_global_count', v_global_count, 'global_threshold', v_global_threshold
    ));
  end if;

  if (NEW.origin_symbol_count is not null and NEW.origin_symbol_count <> v_symbol_count)
     or (NEW.origin_global_count is not null and NEW.origin_global_count <> v_global_count) then
    insert into audit (signal_id, event_type, detail)
    values (NEW.id, 'count_discrepancy', jsonb_build_object(
      'origin_symbol_count', NEW.origin_symbol_count, 'auth_symbol_count', v_symbol_count,
      'origin_global_count', NEW.origin_global_count, 'auth_global_count', v_global_count
    ));
  end if;

  return NEW;
end;
$$;

create trigger trg_apply_authoritative_counts
  after insert on signals
  for each row
  execute function fn_apply_authoritative_counts();

-- trigger genérico: cualquier cambio de status queda auditado sin que
-- cada ruta tenga que insertar en audit manualmente.
create or replace function fn_audit_status_change()
returns trigger
language plpgsql
as $$
begin
  if NEW.status is distinct from OLD.status then
    insert into audit (signal_id, event_type, detail)
    values (NEW.id, 'status_changed', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  end if;
  return NEW;
end;
$$;

create trigger trg_audit_status_change
  after update of status on signals
  for each row
  execute function fn_audit_status_change();

-- ============================================================
-- RPC: claim atómico para el EA (GET /api/signals)
-- ============================================================
-- Expira en tiempo real (antes de repartir) las señales pending/claimed que
-- superaron queue_ttl_seconds. No basta con el cron diario de mantenimiento
-- (Vercel Cron en plan Hobby corre 1x/día): el EA necesita ver 'expired'
-- dentro de la misma ventana de TTL (criterio de aceptación #9), así que la
-- expiración vive aquí, en el camino caliente de cada poll.
create or replace function claim_signals(p_max int default 50)
returns setof signals
language plpgsql
as $$
declare
  v_ttl_seconds int;
begin
  select queue_ttl_seconds into v_ttl_seconds from settings where id = 1;

  update signals
  set status = 'expired'
  where status in ('pending', 'claimed')
    and (extract(epoch from now()) * 1000 - ts_signal) > v_ttl_seconds * 1000;

  return query
  with cte as (
    select id from signals
    where status = 'pending'
    order by ts_signal asc
    limit p_max
    for update skip locked
  )
  update signals s
  set status = 'claimed', claimed_at = now()
  from cte
  where s.id = cte.id
  returning s.*;
end;
$$;

-- ============================================================
-- Mantenimiento (invocado por /api/cron/cleanup vía Vercel Cron)
-- ============================================================
create or replace function expire_stale_signals()
returns int
language sql
as $$
  with updated as (
    update signals
    set status = 'expired'
    where status in ('pending','claimed')
      and (extract(epoch from now()) * 1000 - ts_signal) >
          (select queue_ttl_seconds from settings where id = 1) * 1000
    returning id
  )
  select count(*)::int from updated;
$$;

create or replace function compact_audit(p_days int default 90)
returns int
language sql
as $$
  with deleted as (
    delete from audit
    where created_at < now() - (p_days || ' days')::interval
    returning id
  )
  select count(*)::int from deleted;
$$;

-- conteos del día por símbolo + global, para el panel /status
create or replace function today_counts()
returns table(symbol text, symbol_count int, global_count int)
language sql stable
as $$
  with today as (
    select symbol
    from signals
    where action in ('BUY_DUAL','SELL_DUAL')
      and status <> 'rejected_technical'
      and market_day(ts_signal) = market_day(floor(extract(epoch from now()) * 1000)::bigint)
  ), totals as (
    select count(*)::int as global_count from today
  )
  select t.symbol, count(*)::int as symbol_count, totals.global_count
  from today t, totals
  group by t.symbol, totals.global_count
$$;

-- ============================================================
-- RLS: solo service role (Vercel) accede; anon/authenticated sin acceso
-- ============================================================
alter table settings enable row level security;
alter table signals  enable row level security;
alter table audit    enable row level security;

revoke all on settings, signals, audit from anon, authenticated;
-- (sin policies para anon/authenticated → acceso denegado por defecto;
--  service_role bypassa RLS de forma nativa en Supabase)
