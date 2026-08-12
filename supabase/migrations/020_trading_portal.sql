-- ============================================================
-- Pessaro Bridge · 020_trading_portal.sql
-- Fusión del Trading Portal dentro del proyecto del bridge.
--
-- Origen: pessaro-trading-portal/supabase/migrations/001_trading_portal_schema.sql,
-- que vivía en su propio proyecto Supabase (ckouxsidjkqhqfwvmakn) y estaba
-- VACÍO — 0 filas en las cinco tablas. Por eso esto es DDL puro: no hay
-- migración de datos que hacer, y esa es exactamente la razón de fusionar
-- ahora y no en seis meses.
--
-- Cinco desviaciones deliberadas respecto del esquema original:
--
-- 1. IDENTIDAD POR client_id, NO POR user_id. El portal original colgaba
--    de auth.users con RLS `auth.uid() = user_id`. Los clientes del bridge
--    no tienen cuenta en auth.users — se autentican con el token opaco de
--    client_tokens, igual que su EA. Mantener las dos identidades obligaría
--    a sincronizarlas de por vida; se elige la que ya existe y ya funciona.
--
-- 2. SIN tp_ohlc. ChartPage del portal usa el widget externo de TradingView
--    (s3.tradingview.com) y el componente de lightweight-charts nunca se
--    renderiza. tp_ohlc habría sido con diferencia la tabla más grande del
--    sistema para alimentar a nadie. Su política `read_ohlc using (true)`
--    además la exponía entera a anon.
--
-- 3. SIN Realtime. Con telemetría a 60s, Postgres Changes no aporta
--    frescura real y obliga a poner la anon key en el navegador. El portal
--    lee por /api con el cliente service-role.
--
-- 4. SIN pg_cron. El original creaba la extensión y no la usaba nunca. El
--    scheduling del bridge es Vercel Cron (vercel.json), una entrada diaria.
--
-- 5. RLS AL ESTILO DEL BRIDGE: activo, cero políticas, revoke a anon y
--    authenticated, grants solo a service_role. Mismo patrón que 003 y 014.
--
-- Las constraints unique (account_id, ticket) son nuevas y NO son cosmética:
-- son lo único que hace idempotente el ingest del EA. Sin ellas, un reenvío
-- tras un reinicio del terminal duplica el historial del cliente.
-- ============================================================

-- ── CUENTAS ──────────────────────────────────────────────────────────────
-- unique (client_id): un cliente, una cuenta MT. Si algún día un cliente
-- opera varias cuentas, esta constraint es el punto donde hay que decidirlo
-- de forma explícita en vez de que aparezcan filas huérfanas.
create table public.tp_accounts (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null unique references public.client_tokens(id) on delete cascade,
  account_number  text not null unique,
  account_type    text not null default 'real' check (account_type in ('real', 'demo')),
  currency        text not null default 'USD',
  leverage        text default '1:100',
  balance         numeric(14,2) not null default 0,
  equity          numeric(14,2) not null default 0,
  margin_used     numeric(14,2) not null default 0,
  free_margin     numeric(14,2) not null default 0,
  margin_level    numeric(10,2) not null default 0,
  floating_pnl    numeric(14,2) not null default 0,
  initial_balance numeric(14,2) not null default 0,
  status          text default 'active' check (status in ('active', 'inactive', 'suspended')),
  broker          text default 'Pessaro Capital',
  server          text default 'MT4-Live',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column public.tp_accounts.updated_at is
  'Instante del último bloque `account` de telemetría aceptado. La UI lo muestra como "actualizado hace Xs": con la cadencia de 60s del EA, el P&L flotante tiene hasta un minuto de retraso y eso debe ser visible, no disimulado.';

comment on column public.tp_accounts.initial_balance is
  'Capital de referencia para el cálculo de rendimiento. NO lo escribe la telemetría: el EA no puede saber cuál fue el depósito inicial del cliente. Lo fija el operador al dar de alta la cuenta.';

-- ── HISTORIAL CERRADO ────────────────────────────────────────────────────
create table public.tp_trades (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.tp_accounts(id) on delete cascade,
  ticket          bigint not null,
  symbol          text not null,
  position_type   text not null check (position_type in ('BUY', 'SELL')),
  lots            numeric(10,4) not null,
  open_price      numeric(14,5) not null,
  close_price     numeric(14,5) not null,
  stop_loss       numeric(14,5),
  take_profit     numeric(14,5),
  profit_loss     numeric(14,2) not null default 0,
  commission      numeric(10,2) default 0,
  swap            numeric(10,2) default 0,
  open_time       timestamptz not null,
  close_time      timestamptz not null,
  duration_mins   integer generated always as (
    (extract(epoch from (close_time - open_time)) / 60)::integer
  ) stored,
  running_balance numeric(14,2),
  comment         text,
  created_at      timestamptz not null default now(),
  unique (account_id, ticket)
);

comment on constraint tp_trades_account_id_ticket_key on public.tp_trades is
  'Clave de idempotencia del ingest. El EA reenvía operaciones cerradas cuando pierde la marca de agua (reinicio del terminal, respuesta perdida); esta constraint convierte ese reenvío en un no-op en vez de en historial duplicado.';

-- ── POSICIONES ABIERTAS ──────────────────────────────────────────────────
-- Semántica de conjunto: el EA manda la foto completa y el servidor borra
-- lo que no venga. La constraint unique es lo que permite el upsert.
create table public.tp_open_positions (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.tp_accounts(id) on delete cascade,
  ticket          bigint not null,
  symbol          text not null,
  position_type   text not null check (position_type in ('BUY', 'SELL')),
  lots            numeric(10,4) not null,
  open_price      numeric(14,5) not null,
  current_price   numeric(14,5),
  stop_loss       numeric(14,5),
  take_profit     numeric(14,5),
  profit_loss     numeric(14,2) default 0,
  swap            numeric(10,2) default 0,
  open_time       timestamptz not null,
  updated_at      timestamptz not null default now(),
  unique (account_id, ticket)
);

-- ── CURVA DE EQUITY DIARIA ───────────────────────────────────────────────
-- No la escribe el EA: la deriva el cron diario de Vercel desde tp_accounts
-- (app/api/cron/cleanup). Cero tráfico adicional desde el terminal.
create table public.tp_equity_snapshots (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.tp_accounts(id) on delete cascade,
  snapshot_at date not null,
  balance     numeric(14,2) not null,
  equity      numeric(14,2) not null,
  floating    numeric(14,2) default 0,
  unique (account_id, snapshot_at)
);

-- ── ÍNDICES ──────────────────────────────────────────────────────────────
-- Sin índice por client_id en trades/positions: se llega siempre por
-- account_id, y tp_accounts.client_id ya es unique.
create index idx_tp_trades_account   on public.tp_trades (account_id, close_time desc);
create index idx_tp_trades_symbol    on public.tp_trades (symbol);
create index idx_tp_positions_account on public.tp_open_positions (account_id);
create index idx_tp_equity_account   on public.tp_equity_snapshots (account_id, snapshot_at desc);

-- ── RLS / GRANTS ─────────────────────────────────────────────────────────
-- Patrón del bridge: RLS activo con cero políticas + revoke explícito.
-- service_role hace bypass nativo de RLS, pero sin el grant de tabla el
-- error es "permission denied" antes de evaluar RLS (ver 003).
alter table public.tp_accounts         enable row level security;
alter table public.tp_trades           enable row level security;
alter table public.tp_open_positions   enable row level security;
alter table public.tp_equity_snapshots enable row level security;

revoke all on public.tp_accounts         from anon, authenticated;
revoke all on public.tp_trades           from anon, authenticated;
revoke all on public.tp_open_positions   from anon, authenticated;
revoke all on public.tp_equity_snapshots from anon, authenticated;

grant select, insert, update, delete on public.tp_accounts         to service_role;
grant select, insert, update, delete on public.tp_trades           to service_role;
grant select, insert, update, delete on public.tp_open_positions   to service_role;
grant select, insert, update, delete on public.tp_equity_snapshots to service_role;

-- ── TRIGGER updated_at ───────────────────────────────────────────────────
create or replace function public.tp_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter function public.tp_set_updated_at() set search_path = public, pg_temp;

create trigger trg_tp_accounts_updated
  before update on public.tp_accounts
  for each row execute function public.tp_set_updated_at();

create trigger trg_tp_positions_updated
  before update on public.tp_open_positions
  for each row execute function public.tp_set_updated_at();

-- ============================================================
-- INGEST DE TELEMETRÍA
--
-- Un solo round-trip. La alternativa ingenua —tres llamadas PostgREST
-- desde el route handler— multiplica por tres el trabajo del pooler y del
-- planner en el camino más caliente del sistema (el EA hace un request cada
-- 2s por cliente). Aquí todo el trabajo ocurre en una función.
--
-- Los tres bloques son independientes y OPCIONALES. Distinguir "ausente" de
-- "vacío" es crítico en `positions`: ausente significa "no ha cambiado, no
-- toques nada"; un array vacío significa "el cliente cerró todo". Por eso
-- se comprueba `? 'positions'` sobre el jsonb y no la longitud del array.
-- ============================================================
create or replace function public.tp_ingest_telemetry(
  p_client_id     uuid,
  p_payload       jsonb,
  p_min_interval  int default 30   -- segundos entre escrituras del bloque account
)
returns jsonb
language plpgsql
as $$
declare
  v_account_id      uuid;
  v_account         jsonb := p_payload -> 'account';
  v_last_close      timestamptz;
  v_positions_count int := 0;
  v_trades_inserted int := 0;
  v_throttled       boolean := false;
begin
  if v_account is null then
    raise exception 'tp_ingest_telemetry: falta el bloque account';
  end if;

  -- El UPSERT va por client_id, no por account_number: el cliente es la
  -- identidad estable. Si un cliente cambia de número de cuenta con el
  -- mismo token, se actualiza su fila en vez de crear una huérfana.
  --
  -- El rate-limit vive AQUÍ y no en el route handler por dos razones: evita
  -- un SELECT extra por cada request con telemetría, y es atómico — dos polls
  -- concurrentes del mismo EA no pueden colarse ambos por una comprobación
  -- previa que los dos leyeron antes de que ninguno escribiera.
  insert into public.tp_accounts (
    client_id, account_number, account_type, currency, leverage,
    balance, equity, margin_used, free_margin, margin_level, floating_pnl,
    broker, server
  )
  values (
    p_client_id,
    v_account ->> 'number',
    coalesce(v_account ->> 'type', 'real'),
    coalesce(v_account ->> 'currency', 'USD'),
    v_account ->> 'leverage',
    -- coalesce a 0 y no confianza ciega en el payload: estas columnas son
    -- NOT NULL y un campo ausente reventaría el ingest entero por un dato
    -- accesorio. Zod ya los exige aguas arriba; esto es la segunda barrera.
    coalesce((v_account ->> 'balance')::numeric, 0),
    coalesce((v_account ->> 'equity')::numeric, 0),
    coalesce((v_account ->> 'margin_used')::numeric, 0),
    coalesce((v_account ->> 'free_margin')::numeric, 0),
    coalesce((v_account ->> 'margin_level')::numeric, 0),
    coalesce((v_account ->> 'floating_pnl')::numeric, 0),
    v_account ->> 'company',
    v_account ->> 'server'
  )
  on conflict (client_id) do update set
    account_number = excluded.account_number,
    account_type   = excluded.account_type,
    currency       = excluded.currency,
    leverage       = excluded.leverage,
    balance        = excluded.balance,
    equity         = excluded.equity,
    margin_used    = excluded.margin_used,
    free_margin    = excluded.free_margin,
    margin_level   = excluded.margin_level,
    floating_pnl   = excluded.floating_pnl,
    broker         = excluded.broker,
    server         = excluded.server
    -- initial_balance NO se toca: lo fija el operador, el EA no lo sabe.
  where public.tp_accounts.updated_at < now() - make_interval(secs => p_min_interval)
  returning id into v_account_id;

  -- Sin fila devuelta = el WHERE del DO UPDATE cortó por frecuencia. La cuenta
  -- existe, solo no se reescribió. Se recupera su id para que las posiciones y
  -- las operaciones cerradas SÍ se procesen: un cierre es un hecho puntual e
  -- irrepetible y no puede perderse por un límite pensado para las métricas
  -- continuas de balance.
  if v_account_id is null then
    v_throttled := true;
    select id into v_account_id from public.tp_accounts where client_id = p_client_id;
  end if;

  -- ---------- posiciones abiertas: reemplazo de conjunto ----------
  if p_payload ? 'positions' then
    with incoming as (
      select
        (p ->> 'ticket')::bigint        as ticket,
        p ->> 'symbol'                  as symbol,
        p ->> 'type'                    as position_type,
        (p ->> 'lots')::numeric         as lots,
        (p ->> 'open_price')::numeric   as open_price,
        (p ->> 'current_price')::numeric as current_price,
        nullif(p ->> 'sl', '0')::numeric as stop_loss,
        nullif(p ->> 'tp', '0')::numeric as take_profit,
        (p ->> 'profit')::numeric       as profit_loss,
        (p ->> 'swap')::numeric         as swap,
        to_timestamp((p ->> 'open_time')::bigint) as open_time
      from jsonb_array_elements(p_payload -> 'positions') as p
    ),
    upserted as (
      insert into public.tp_open_positions (
        account_id, ticket, symbol, position_type, lots,
        open_price, current_price, stop_loss, take_profit,
        profit_loss, swap, open_time
      )
      select
        v_account_id, ticket, symbol, position_type, lots,
        open_price, current_price, stop_loss, take_profit,
        profit_loss, swap, open_time
      from incoming
      on conflict (account_id, ticket) do update set
        current_price = excluded.current_price,
        stop_loss     = excluded.stop_loss,
        take_profit   = excluded.take_profit,
        lots          = excluded.lots,
        profit_loss   = excluded.profit_loss,
        swap          = excluded.swap
      returning 1
    ),
    deleted as (
      delete from public.tp_open_positions op
      where op.account_id = v_account_id
        and not exists (select 1 from incoming i where i.ticket = op.ticket)
      returning 1
    )
    select count(*) into v_positions_count from upserted;
  end if;

  -- ---------- operaciones cerradas: solo inserta lo nuevo ----------
  if p_payload ? 'closed' then
    with incoming as (
      select
        (c ->> 'ticket')::bigint        as ticket,
        c ->> 'symbol'                  as symbol,
        c ->> 'type'                    as position_type,
        (c ->> 'lots')::numeric         as lots,
        (c ->> 'open_price')::numeric   as open_price,
        (c ->> 'close_price')::numeric  as close_price,
        nullif(c ->> 'sl', '0')::numeric as stop_loss,
        nullif(c ->> 'tp', '0')::numeric as take_profit,
        (c ->> 'profit')::numeric       as profit_loss,
        (c ->> 'commission')::numeric   as commission,
        (c ->> 'swap')::numeric         as swap,
        to_timestamp((c ->> 'open_time')::bigint)  as open_time,
        to_timestamp((c ->> 'close_time')::bigint) as close_time,
        c ->> 'comment'                 as comment
      from jsonb_array_elements(p_payload -> 'closed') as c
    ),
    ins as (
      insert into public.tp_trades (
        account_id, ticket, symbol, position_type, lots,
        open_price, close_price, stop_loss, take_profit,
        profit_loss, commission, swap, open_time, close_time, comment
      )
      select
        v_account_id, ticket, symbol, position_type, lots,
        open_price, close_price, stop_loss, take_profit,
        profit_loss, commission, swap, open_time, close_time, comment
      from incoming
      on conflict (account_id, ticket) do nothing
      returning 1
    )
    select count(*) into v_trades_inserted from ins;
  end if;

  -- La marca de agua sale SIEMPRE de la tabla, no del payload: así el EA
  -- se resincroniza solo tras un reinicio del terminal sin persistir nada
  -- en disco, y una respuesta perdida no le hace saltarse operaciones.
  select max(close_time) into v_last_close
  from public.tp_trades where account_id = v_account_id;

  return jsonb_build_object(
    'account_id',       v_account_id,
    'last_close_time',  coalesce(extract(epoch from v_last_close)::bigint, 0),
    'positions_synced', v_positions_count,
    'trades_inserted',  v_trades_inserted,
    'account_throttled', v_throttled
  );
end;
$$;

alter function public.tp_ingest_telemetry(uuid, jsonb, int) set search_path = public, pg_temp;
revoke all on function public.tp_ingest_telemetry(uuid, jsonb, int) from anon, authenticated;
grant execute on function public.tp_ingest_telemetry(uuid, jsonb, int) to service_role;

-- ============================================================
-- SNAPSHOT DIARIO DE EQUITY
-- Lo llama el cron diario de Vercel que ya existe (03:00 UTC). No hay cron
-- nuevo: el plan actual permite una sola entrada en vercel.json, y ya está
-- ocupada por la limpieza.
-- ============================================================
create or replace function public.tp_snapshot_equity(p_day date default current_date)
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  insert into public.tp_equity_snapshots (account_id, snapshot_at, balance, equity, floating)
  select a.id, p_day, a.balance, a.equity, a.floating_pnl
  from public.tp_accounts a
  where a.status = 'active'
  on conflict (account_id, snapshot_at) do update set
    balance  = excluded.balance,
    equity   = excluded.equity,
    floating = excluded.floating;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter function public.tp_snapshot_equity(date) set search_path = public, pg_temp;
grant execute on function public.tp_snapshot_equity(date) to service_role;
