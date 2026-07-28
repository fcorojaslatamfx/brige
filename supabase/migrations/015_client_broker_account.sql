-- ============================================================
-- Pessaro Bridge · 015_client_broker_account.sql
-- Datos de cuenta de bróker por cliente — obligatorios para
-- todo cliente NUEVO. Backfill de filas preexistentes con un
-- valor centinela explícito para no perder NOT NULL en el
-- esquema (la UI nunca debe mostrar el centinela sin distinguirlo).
-- ============================================================

alter table public.client_tokens
  add column broker         text,
  add column account_type   text,
  add column account_number text,
  add column broker_server  text;

-- Backfill de filas creadas antes de esta migración (si existen).
-- 'SIN_DATO' es intencionalmente distinguible en la UI para que el
-- super_admin sepa que debe completar esos clientes manualmente.
update public.client_tokens
set broker = 'SIN_DATO', account_type = 'demo', account_number = 'SIN_DATO', broker_server = 'SIN_DATO'
where broker is null;

alter table public.client_tokens
  alter column broker         set not null,
  alter column account_type   set not null,
  alter column account_number set not null,
  alter column broker_server  set not null;

alter table public.client_tokens
  add constraint client_tokens_account_type_check check (account_type in ('demo', 'real'));

create index idx_client_tokens_broker on public.client_tokens (broker);
