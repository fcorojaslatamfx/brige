-- ============================================================
-- Pessaro Bridge · 019_client_token_expiry_required.sql
-- La caducidad de un token de cliente pasa a ser OBLIGATORIA.
--
-- Hasta aquí `expires_at` admitía null con el significado "indefinido", y era
-- una de las cuatro opciones del formulario de alta. Se elimina: un acceso sin
-- fecha de término solo se corta si alguien se acuerda de revocarlo, y lo que
-- no tiene fecha no se revisa nunca. Con vencimiento obligatorio, cada cliente
-- vuelve a pasar por una decisión explícita cada 7, 14 o 30 días.
--
-- BACKFILL — por qué `now() + 30 días` y no `created_at + 30 días`. Un token
-- creado hace 60 días con vigencia indefinida está siendo usado HOY por un
-- cliente real. Fecharlo desde su creación lo dejaría vencido en el mismo
-- instante del deploy: el EA de ese cliente empezaría a recibir 403 sin que
-- nadie hubiera decidido cortarle el acceso. Se le da el plazo máximo desde
-- ahora, que es lo que un operador habría elegido al migrarlo a mano, y queda
-- visible en /status/clients para renovarlo o revocarlo con criterio.
--
-- Los REVOCADOS también se rellenan: la columna es NOT NULL para todas las
-- filas y `clientStatus()` ya da prioridad a `revoked_at` sobre la fecha, así
-- que ponerles una fecha futura no les devuelve el acceso.
-- ============================================================

update public.client_tokens
set expires_at = now() + interval '30 days'
where expires_at is null;

alter table public.client_tokens
  alter column expires_at set not null;

comment on column public.client_tokens.expires_at is
  'Vencimiento del acceso. Obligatorio desde la migración 019: se otorga en el '
  'alta y se extiende con POST /api/clients/renew, siempre por 7, 14 o 30 días '
  'contados desde el instante de la operación (nunca acumulando sobre el saldo '
  'anterior). Renovar no cambia el token: el cliente no reconfigura su EA.';
