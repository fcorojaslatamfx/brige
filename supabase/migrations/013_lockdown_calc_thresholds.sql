-- ============================================================
-- Pessaro Bridge · 013_lockdown_calc_thresholds.sql
-- Hardening posterior a 010.
--
-- calc_thresholds es SECURITY DEFINER (necesita serlo: la llama el trigger y
-- debe contar sobre toda la tabla sin depender del rol que inserta). Pero en
-- Postgres toda función nace con EXECUTE para PUBLIC, así que quedó expuesta
-- vía PostgREST como /rest/v1/rpc/calc_thresholds para los roles anon y
-- authenticated — y al ser DEFINER, esa llamada BYPASSA RLS y filtraría los
-- conteos de señales a cualquiera sin sesión (advisor 0028/0029).
--
-- El resto de funciones del proyecto son SECURITY INVOKER: una llamada de
-- anon choca contra RLS (sin políticas → denegado), por eso no aparecen. Sólo
-- esta necesita el revoke explícito. Sigue accesible para service_role, que
-- es quien la usa desde el trigger y desde contar_dia.
-- ============================================================

revoke execute on function public.calc_thresholds(text, bigint, boolean) from public, anon, authenticated;
grant  execute on function public.calc_thresholds(text, bigint, boolean) to service_role;
