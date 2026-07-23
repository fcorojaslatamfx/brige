-- ============================================================
-- Pessaro Bridge · 004_tokens.sql
-- Tabla de tokens gestionados desde el dashboard de admin
-- (/status/tokens), reemplaza TV_WEBHOOK_TOKEN/EA_TOKEN/OPERATOR_TOKEN
-- como env vars planas. Una fila por tipo, en texto plano (el objetivo
-- explícito es poder volver a ver el valor vigente, no solo compararlo
-- una vez y olvidarlo). RLS + grants siguen el mismo patrón que
-- settings/signals/audit (001_schema.sql + 003_grant_service_role.sql):
-- sin políticas, acceso exclusivo vía service_role.
-- ============================================================

create table tokens (
  kind        text primary key check (kind in ('tv_webhook', 'ea', 'operator')),
  value       text not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table tokens enable row level security;

revoke all on tokens from anon, authenticated;
grant select, insert, update, delete on public.tokens to service_role;
