-- ============================================================
-- Pessaro Bridge · 003_grant_service_role.sql
-- Fix: service_role no tenía SELECT/INSERT/UPDATE/DELETE en las tablas
-- del bridge (solo REFERENCES/TRIGGER/TRUNCATE, heredado de los
-- privilegios por defecto del proyecto). RLS estaba bien configurado
-- (bypass nativo para service_role), pero sin el GRANT de tabla el
-- error es "permission denied for table X" antes de llegar siquiera a
-- evaluar RLS. Se otorga explícito en vez de depender de defaults.
-- ============================================================

grant select, insert, update, delete on public.settings to service_role;
grant select, insert, update, delete on public.signals to service_role;
grant select, insert, update, delete on public.audit to service_role;
