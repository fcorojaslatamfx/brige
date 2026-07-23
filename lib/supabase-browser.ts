import { createBrowserClient } from "@supabase/ssr";

/** Cliente Supabase Auth para componentes de cliente (login, logout). */
export function createSupabaseBrowserClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
