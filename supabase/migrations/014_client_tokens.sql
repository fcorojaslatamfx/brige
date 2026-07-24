-- ============================================================
-- Pessaro Bridge · 014_client_tokens.sql
-- Tokens de CLIENTE (leads/contactos de los admin).
--
-- Modelo de negocio: el super_admin genera un token por cliente, con
-- caducidad (7 / 14 / 30 días o indefinido), identificado por correo + móvil,
-- y opcionalmente asociado al admin dueño de ese lead. El cliente corre su
-- propio EA de MT4 y hace polling a /api/signals con ese token.
--
-- ⚠ CAMBIO DE MODELO DE ENTREGA. El EA del operador usa claim_signals
-- (consumo único: cada señal la reclama UN poller y pasa a 'claimed'). Ese
-- flujo NO se toca. Los clientes necesitan DIFUSIÓN: cada cliente debe
-- recibir CADA señal de forma independiente. Por eso la entrega a clientes se
-- rastrea en su propia tabla `client_deliveries` (una fila por señal×cliente),
-- desacoplada de signals.status. Que el operador ya haya notificado una señal
-- no impide que los clientes la reciban mientras siga fresca.
--
-- Solo tráfico real llega al cliente: el claim filtra por las mismas tres
-- condiciones que la cola del operador (is_test=false, origin='tradingview',
-- env='production'), así que el aislamiento del test suite (§8) también los
-- cubre por construcción.
-- ============================================================

create table public.client_tokens (
  id             uuid primary key default gen_random_uuid(),
  token          text not null unique,
  client_name    text,
  client_email   text not null,
  client_phone   text not null,
  assigned_admin uuid references auth.users(id) on delete set null,  -- admin dueño del lead
  expires_at     timestamptz,                                        -- null = indefinido
  created_by     uuid references auth.users(id),                     -- super_admin que lo generó
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  last_used_at   timestamptz                                         -- heartbeat del EA del cliente
);

create index idx_client_tokens_token on public.client_tokens (token);
create index idx_client_tokens_admin on public.client_tokens (assigned_admin);

alter table public.client_tokens enable row level security;
revoke all on public.client_tokens from anon, authenticated;
grant select, insert, update, delete on public.client_tokens to service_role;

-- Entrega por-cliente: una fila por (señal, cliente). PK compuesta = un
-- cliente no puede recibir dos veces la misma señal (idempotencia del claim).
create table public.client_deliveries (
  signal_id   uuid not null references public.signals(id)       on delete cascade,
  client_id   uuid not null references public.client_tokens(id) on delete cascade,
  status      text not null default 'claimed' check (status in ('claimed', 'notified', 'error')),
  claimed_at  timestamptz not null default now(),
  notified_at timestamptz,
  error       text,
  primary key (signal_id, client_id)
);

create index idx_client_deliveries_client on public.client_deliveries (client_id);

alter table public.client_deliveries enable row level security;
revoke all on public.client_deliveries from anon, authenticated;
grant select, insert, update, delete on public.client_deliveries to service_role;

-- ---------- claim de difusión para el EA de un cliente ----------
-- Devuelve las señales entregables aún NO entregadas a este cliente, dentro
-- de la ventana de frescura (queue_ttl_seconds), y crea su fila de entrega en
-- la misma operación. Idempotente ante polls concurrentes del mismo cliente
-- (on conflict do nothing sobre la PK); clientes distintos nunca se bloquean
-- entre sí porque cada uno inserta su propia fila.
create or replace function public.claim_signals_for_client(p_client_id uuid, p_max int default 50)
returns setof public.signals
language plpgsql
as $$
declare
  v_ttl_seconds int;
begin
  select queue_ttl_seconds into v_ttl_seconds from public.settings where id = 1;

  return query
  with cand as (
    select s.id
    from public.signals s
    where s.is_test = false
      and s.origin  = 'tradingview'
      and s.env     = 'production'
      and s.status <> 'rejected_technical'
      and (extract(epoch from now()) * 1000 - s.ts_signal) <= v_ttl_seconds * 1000
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
