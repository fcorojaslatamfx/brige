import { NextRequest } from "next/server";
import { createSupabaseServerClient } from "./supabase-server";
import { safeTokenEquals } from "./counts";
import { getToken } from "./tokens";

/**
 * Gate dual para /api/status y /api/settings: sesión Supabase (dashboard)
 * o el OPERATOR_TOKEN vigente (acceso programático externo), igual que
 * documenta el README. Regenerar tokens, en cambio, exige sesión — ver
 * app/api/tokens/regenerate/route.ts.
 */
export async function isAuthorizedOperator(req: NextRequest): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) return true;

  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-operator-token");
  return safeTokenEquals(token, (await getToken("operator")) ?? undefined);
}

/** Devuelve el usuario autenticado (sesión Supabase) o null. */
export async function getAuthenticatedUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
