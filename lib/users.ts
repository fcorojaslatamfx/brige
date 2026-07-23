import { randomUUID } from "node:crypto";
import { supabase } from "./supabase";
import type { Role } from "./schema";

export type { Role };

export type UserRow = {
  user_id: string;
  email: string | null;
  role: Role;
  created_at: string;
  created_by: string | null;
  created_by_email: string | null;
  last_sign_in_at: string | null;
};

const APP_URL = process.env.APP_URL ?? "https://brige.pessaro.cl";

const CACHE_TTL_MS = 5_000;
const roleCache = new Map<string, { role: Role | null; expiresAt: number }>();

function clearRoleCache(userId: string) {
  roleCache.delete(userId);
}

/**
 * Lookup con caché corta en memoria: /status hace poll a /api/status cada
 * 5s (REFRESH_MS en app/status/page.tsx), y cada poll pasa por acá — sin
 * caché sería una consulta extra a Supabase por tick. Un usuario recién
 * revocado puede conservar acceso hasta CACHE_TTL_MS, mismo tradeoff que
 * lib/tokens.ts's getToken.
 */
export async function getUserRole(userId: string): Promise<Role | null> {
  const cached = roleCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.role;
  }

  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId).maybeSingle();
  const role = error || !data ? null : (data.role as Role);
  roleCache.set(userId, { role, expiresAt: Date.now() + CACHE_TTL_MS });
  return role;
}

export async function countSuperAdmins(): Promise<number> {
  const { count, error } = await supabase
    .from("user_roles")
    .select("user_id", { count: "exact", head: true })
    .eq("role", "super_admin");
  if (error) throw new Error(`No se pudo contar super admins: ${error.message}`);
  return count ?? 0;
}

export async function listUsersWithRoles(): Promise<UserRow[]> {
  const [{ data: roles, error: rolesError }, { data: authList, error: authError }] = await Promise.all([
    supabase.from("user_roles").select("user_id, role, created_at, created_by").order("created_at"),
    supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }),
  ]);

  if (rolesError) throw new Error(`No se pudieron leer los roles: ${rolesError.message}`);
  if (authError) throw new Error(`No se pudo leer la lista de usuarios: ${authError.message}`);

  const byId = new Map(authList.users.map((u) => [u.id, u]));

  return (roles ?? []).map((r) => ({
    user_id: r.user_id,
    email: byId.get(r.user_id)?.email ?? null,
    role: r.role as Role,
    created_at: r.created_at,
    created_by: r.created_by,
    created_by_email: r.created_by ? (byId.get(r.created_by)?.email ?? null) : null,
    last_sign_in_at: byId.get(r.user_id)?.last_sign_in_at ?? null,
  }));
}

export async function findAuthUserByEmail(email: string) {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`No se pudo buscar el usuario: ${error.message}`);
  const target = email.toLowerCase().trim();
  return data.users.find((u) => u.email?.toLowerCase() === target) ?? null;
}

export async function createOrGetAuthUser(email: string): Promise<{ id: string; isExisting: boolean }> {
  const existing = await findAuthUserByEmail(email);
  if (existing) return { id: existing.id, isExisting: true };

  const tempPassword = randomUUID() + "A1!";
  const { data, error } = await supabase.auth.admin.createUser({
    email: email.toLowerCase().trim(),
    password: tempPassword,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`No se pudo crear el usuario: ${error?.message ?? "sin datos"}`);
  return { id: data.user.id, isExisting: false };
}

export async function upsertUserRole(userId: string, role: Role, createdBy: string | null): Promise<void> {
  const { error } = await supabase.from("user_roles").upsert({ user_id: userId, role, created_by: createdBy });
  if (error) throw new Error(`No se pudo asignar el rol: ${error.message}`);
  clearRoleCache(userId);
}

export async function deleteUserRole(userId: string): Promise<void> {
  const { error } = await supabase.from("user_roles").delete().eq("user_id", userId);
  if (error) throw new Error(`No se pudo revocar el acceso: ${error.message}`);
  clearRoleCache(userId);
}

export async function generateRecoveryLink(email: string): Promise<string> {
  const { data, error } = await supabase.auth.admin.generateLink({
    type: "recovery",
    email: email.toLowerCase().trim(),
    options: { redirectTo: `${APP_URL}/set-password` },
  });
  if (error || !data.properties?.action_link) {
    throw new Error(`No se pudo generar el link de acceso: ${error?.message ?? "sin datos"}`);
  }
  return data.properties.action_link;
}
