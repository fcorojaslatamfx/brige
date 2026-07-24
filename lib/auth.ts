import { NextRequest } from "next/server";
import { createSupabaseServerClient } from "./supabase-server";
import { safeTokenEquals } from "./counts";
import { getToken } from "./tokens";
import { getUserRole, type Role } from "./users";

export type AuthenticatedUser = { id: string; email: string | null; role: Role };

async function resolveSessionUser(): Promise<AuthenticatedUser | null> {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user) return null;

  const role = await getUserRole(user.id);
  if (!role) return null; // sesión válida pero sin fila en user_roles: acceso revocado

  return { id: user.id, email: user.email ?? null, role };
}

/**
 * Gate dual para acceso programático: sesión Supabase (cualquier rol vigente)
 * o el OPERATOR_TOKEN. Se mantiene para compatibilidad, pero las rutas que
 * ALTERAN el bridge deben usar isSuperAdminOrOperator (ver abajo): un admin
 * tiene sesión válida pero NO puede tocar la configuración del puente.
 */
export async function isAuthorizedOperator(req: NextRequest): Promise<boolean> {
  if (await resolveSessionUser()) return true;

  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-operator-token");
  return safeTokenEquals(token, (await getToken("operator")) ?? undefined);
}

/**
 * Gate para todo lo que CONFIGURA/ALTERA el bridge (settings, panel operativo
 * completo, tokens de sistema): solo super_admin por sesión, o el
 * OPERATOR_TOKEN para automatización externa. Un admin (rol normal) queda
 * fuera: su dashboard se limita a sus clientes (ver /status/clients).
 */
export async function isSuperAdminOrOperator(req: NextRequest): Promise<boolean> {
  const user = await resolveSessionUser();
  if (user) return user.role === "super_admin";

  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-operator-token");
  return safeTokenEquals(token, (await getToken("operator")) ?? undefined);
}

/** Sesión Supabase + fila vigente en user_roles, o null (incluye acceso revocado). */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  return resolveSessionUser();
}
