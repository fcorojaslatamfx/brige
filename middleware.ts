import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Protege las páginas del dashboard (/status/*, /login) con sesión
 * Supabase Auth. No toca /api/* a propósito: TradingView, el EA de MT4 y
 * Vercel Cron no pueden seguir redirects ni guardar cookies — su auth
 * vive dentro de cada route handler (ver lib/auth.ts, lib/tokens.ts).
 */
/**
 * Dominio del Trading Portal. Apunta al MISMO proyecto de Vercel que
 * brige.pessaro.cl; lo único que cambia es dónde aterriza la raíz.
 */
const PORTAL_HOST = "portal.pessaro.cl";

export async function middleware(request: NextRequest) {
  // ── Enrutado por dominio ───────────────────────────────────────────────
  // Va ANTES de la comprobación de sesión y sale por rewrite, no por
  // redirect: /portal se autentica con el token opaco del cliente, no con
  // Supabase Auth. Si cayera en el flujo de abajo, a cada cliente del portal
  // se le mandaría a /login, que es una pantalla que no le corresponde y para
  // la que no tiene credenciales.
  const host = request.headers.get("host")?.split(":")[0];
  if (host === PORTAL_HOST && request.nextUrl.pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/portal/resumen";
    return NextResponse.rewrite(url);
  }
  if (request.nextUrl.pathname === "/") {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLoginPage = request.nextUrl.pathname === "/login";

  if (!user && !isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/status";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // "/" entra solo para resolver el dominio del portal; el handler sale de
  // inmediato para cualquier otro host. /portal/* NO está en el matcher: se
  // autentica por token dentro de cada ruta, igual que /api/*.
  matcher: ["/", "/status/:path*", "/login"],
};
