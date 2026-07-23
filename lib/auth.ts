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
 * Gate dual para /api/status y /api/settings: sesión Supabase (con rol
 * vigente en user_roles) o el OPERATOR_TOKEN vigente (acceso programático
 * externo), igual que documenta el README. Regenerar tokens o gestionar
 * usuarios, en cambio, exige sesión — ver app/api/tokens/regenerate y
 * app/api/users/*.
 */
export async function isAuthorizedOperator(req: NextRequest): Promise<boolean> {
  if (await resolveSessionUser()) return true;

  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-operator-token");
  return safeTokenEquals(token, (await getToken("operator")) ?? undefined);
}

/** Sesión Supabase + fila vigente en user_roles, o null (incluye acceso revocado). */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  return resolveSessionUser();
}
