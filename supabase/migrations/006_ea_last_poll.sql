-- ============================================================
-- Pessaro Bridge · 006_ea_last_poll.sql
-- Fix: el badge "EA ONLINE/OFFLINE" y "último poll" en /status leían
-- signals.claimed_at (última señal RECLAMADA), pero el EA hace poll
-- constante aunque no haya señales pendientes que reclamar -> con la cola
-- vacía, claimed_at nunca avanza y el panel muestra "offline"/"sin datos"
-- pese a que el EA está autenticando correctamente cada ciclo.
--
-- last_used_at es un heartbeat de autenticación (se toca en cada GET
-- /api/signals con token válido, haya o no señales para entregar),
-- independiente de updated_at (que sigue siendo "cuándo se rotó el token").
-- ============================================================

alter table tokens add column last_used_at timestamptz;
