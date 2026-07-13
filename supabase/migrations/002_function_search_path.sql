-- ============================================================
-- Pessaro Bridge · 002_function_search_path.sql
-- Hardening: fija search_path en las funciones de 001_schema.sql
-- (advisor de seguridad de Supabase: function_search_path_mutable).
-- Sin este SET, una función podría resolver un objeto sin calificar
-- (p.ej. "settings") contra un esquema distinto si el search_path del
-- rol que llama fue manipulado. Ninguna de estas funciones es
-- SECURITY DEFINER, pero se fija igual como buena práctica estándar.
-- ============================================================

alter function public.market_day(bigint) set search_path = public, pg_temp;
alter function public.contar_dia(text, bigint) set search_path = public, pg_temp;
alter function public.fn_apply_authoritative_counts() set search_path = public, pg_temp;
alter function public.fn_audit_status_change() set search_path = public, pg_temp;
alter function public.claim_signals(int) set search_path = public, pg_temp;
alter function public.expire_stale_signals() set search_path = public, pg_temp;
alter function public.compact_audit(int) set search_path = public, pg_temp;
alter function public.today_counts() set search_path = public, pg_temp;
