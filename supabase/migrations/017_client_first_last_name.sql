-- ============================================================
-- Pessaro Bridge · 017_client_first_last_name.sql
-- Nombre y apellido del cliente, ambos obligatorios.
--
-- Hasta ahora `client_name` era un único campo libre y OPCIONAL. La sección
-- de Clientes pasa a ser un alta de invitación formal (nombre, apellido,
-- móvil, correo) y esos cuatro datos identifican a la persona en los correos
-- que salen: el saludo del correo al cliente y el aviso a los super_admin.
-- Un "Hola," sin nombre en un correo de invitación es un defecto visible.
--
-- `client_name` conserva su nombre de columna pero cambia de SEMÁNTICA: pasa a
-- ser el NOMBRE DE PILA. Se prefirió eso a renombrarla porque la columna la
-- leen `lib/clients.ts`, el portal del cliente y el panel; renombrar obligaba a
-- tocar todo eso a cambio de nada. El apellido va en `client_last_name`.
--
-- Obligatoriedad real: NOT NULL en la tabla, no solo `required` en el HTML (que
-- un fetch directo a la API se salta). Mismo criterio que la migración 015 con
-- los datos de bróker, incluido el backfill idempotente 'SIN_DATO' para filas
-- previas. Hoy la tabla tiene 0 filas, así que el backfill es un no-op — se
-- deja igual para que la migración sea segura si se reaplica sobre datos.
-- ============================================================

alter table public.client_tokens
  add column if not exists client_last_name text;

-- Backfill antes de los NOT NULL (idempotente, seguro si se reaplica).
update public.client_tokens set client_name      = 'SIN_DATO' where client_name      is null or btrim(client_name) = '';
update public.client_tokens set client_last_name = 'SIN_DATO' where client_last_name is null or btrim(client_last_name) = '';

alter table public.client_tokens alter column client_name      set not null;
alter table public.client_tokens alter column client_last_name set not null;

comment on column public.client_tokens.client_name is
  'Nombre de pila del cliente. Obligatorio desde la migración 017 (antes era un '
  'campo libre opcional con el nombre completo).';
comment on column public.client_tokens.client_last_name is
  'Apellido del cliente. Obligatorio desde la migración 017.';
