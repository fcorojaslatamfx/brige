import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { findAuthUserByEmail, generateRecoveryLink, getUserRole } from "@/lib/users";
import { sendPasswordResetEmail } from "@/lib/email";
import { forgotPasswordSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Público a propósito (sin sesión): es la puerta de entrada para alguien que
 * justamente NO puede loguearse. Responde {ok:true} siempre, exista o no el
 * correo, para no revelar qué cuentas tienen acceso al panel. Nunca crea un
 * usuario nuevo (a diferencia de /api/users/invite) — solo reenvía el link a
 * cuentas que ya tienen una fila vigente en user_roles.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed json" }, { status: 400 });
  }

  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
  }
  const { email } = parsed.data;

  try {
    const authUser = await findAuthUserByEmail(email);
    if (authUser) {
      const role = await getUserRole(authUser.id);
      if (role) {
        const actionLink = await generateRecoveryLink(email);
        await sendPasswordResetEmail({ to: email, actionLink });
        await supabase.from("audit").insert({
          signal_id: null,
          event_type: "password_reset_requested",
          detail: { email },
        });
      }
    }
  } catch {
    // no revelar detalles de fallos internos a un llamador sin sesión
  }

  return NextResponse.json({ ok: true });
}
