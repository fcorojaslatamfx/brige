-- ============================================================
-- Pessaro Bridge · 005_user_roles.sql
-- Roles de acceso al dashboard: super_admin (gestiona usuarios) y
-- admin (mismo acceso operativo que hoy, sin gestión de usuarios).
-- Tener sesión Supabase Auth ya NO basta para entrar al dashboard:
-- hace falta además una fila en user_roles (ver lib/auth.ts). Borrar
-- la fila revoca el acceso sin tocar la cuenta de auth.users — la
-- cuenta se puede restaurar re-invitando, sin recrear el login.
-- Mismo patrón de grants que 004_tokens.sql: sin políticas RLS,
-- acceso exclusivo vía service_role.
-- ============================================================

create table user_roles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('super_admin', 'admin')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);

alter table user_roles enable row level security;

revoke all on user_roles from anon, authenticated;
grant select, insert, update, delete on public.user_roles to service_role;

-- Bootstrap: el único usuario existente (fcorojas.fx@gmail.com) fue creado
-- por scripts/create-admin-user.ts ANTES de que esta tabla existiera.
-- Sin esta fila quedaría bloqueado de su propio dashboard apenas se
-- despliegue este cambio.
insert into user_roles (user_id, role, created_by)
values ('95ddb5c9-492c-4f94-a0de-bcecf44c4fce', 'super_admin', null)
on conflict (user_id) do nothing;
