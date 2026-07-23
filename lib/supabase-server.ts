import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Cliente Supabase Auth para Route Handlers (App Router). Usa la anon key
 * pública, nunca la service-role key — solo sirve para leer/refrescar la
 * sesión (auth.getUser()), nunca para consultar signals/settings/tokens,
 * que siguen siendo exclusivos del cliente service-role en lib/supabase.ts.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Llamado desde un Server Component sin permiso de escritura;
          // el middleware ya se encarga de refrescar la sesión.
        }
      },
    },
  });
}
