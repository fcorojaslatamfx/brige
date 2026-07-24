-- ============================================================
-- Pessaro Bridge · 008_setup_actions.sql
-- Meta-prompt v3.0 §6 "Migración 004".
--
-- Defecto 2: los eventos de setup armado nunca llegaban al trader porque
-- el indicador jamás los emitía y ninguna capa los aceptaba. El setup
-- armado es el instante en que existe una orden límite pendiente REAL y
-- colocable; el disparo (BUY_DUAL) ocurre cuando el precio YA tocó el
-- nivel. Sin SETUP_* el aviso llega siempre tarde.
--
-- SETUP_BUY / SETUP_SELL llevan niveles completos (mismo shape que una
-- entrada). SETUP_CANCEL es la forma reducida, alias moderno de
-- CANCEL_ALL, que se mantiene aceptado por retrocompatibilidad.
-- ============================================================

alter table public.signals drop constraint if exists signals_action_check;

alter table public.signals add constraint signals_action_check
  check (action = any (array[
    'BUY_DUAL', 'SELL_DUAL', 'CANCEL_ALL',
    'SETUP_BUY', 'SETUP_SELL', 'SETUP_CANCEL'
  ]));
