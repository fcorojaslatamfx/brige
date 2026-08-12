import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/auth";
import { getClientToken, renewClientToken, toClientEmailData } from "@/lib/clients";
import { sendClientRenewedEmail } from "@/lib/email";
import { renewClientSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Extiende la vigencia de un token de cliente por 7, 14 o 30 días.
 *
 * Mismo gate que revocar (solo `super_admin`): alargar un acceso y cortarlo son
 * las dos caras de la misma decisión, y sería incoherente que un `admin`
 * pudiera hacer una y no la otra.
 *
 * El token NO se regenera. Renovar es "este cliente sigue estando al día", no
 * "toma una credencial nueva": si cambiara el token, el cliente tendría que
 * reconfigurar su EA cada mes y el correo de renovación pasaría a transportar
 * un secreto — dos costes sin ninguna ganancia de seguridad, porque el token
 * viejo se invalida igual con Revocar cuando de verdad hace falta.
 */
export async function POST(req: NextRequest) {
  const caller = await getAuthenticatedUser();
  if (!caller) return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });
  if (caller.role !== "super_admin") return NextResponse.json({ ok: false, error: "solo super_admin" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed json" }, { status: 400 });
  }

  const parsed = renewClientSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }

  const current = await getClientToken(parsed.data.id);
  if (!current) return NextResponse.json({ ok: false, error: "cliente no encontrado" }, { status: 404 });

  // Confirmación de identidad: el panel se refresca solo cada 5 s y la fila que
  // el operador tenía en pantalla puede haber cambiado de sitio. Ver el
  // comentario de renewClientSchema.
  if (current.client_email !== parsed.data.client_email.toLowerCase().trim()) {
    return NextResponse.json(
      { ok: false, error: "el correo no coincide con el del token — recarga el panel y vuelve a intentarlo" },
      { status: 409 },
    );
  }

  const client = await renewClientToken(current.id, parsed.data.expiry);
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "el token está revocado: para devolverle el acceso, da de alta uno nuevo" },
      { status: 409 },
    );
  }

  // El correo no aborta la renovación: la vigencia ya quedó extendida en la
  // base y el cliente puede seguir operando aunque Resend esté caído. Mismo
  // criterio que el alta (lib/client-onboarding.ts).
  let emailWarning: string | null = null;
  try {
    await sendClientRenewedEmail({ client: toClientEmailData(client) });
  } catch (e) {
    emailWarning = `no se pudo avisar al cliente (${e instanceof Error ? e.message : "error"})`;
  }

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "client_token_renewed",
    detail: {
      client_id: client.id,
      client_email: client.client_email,
      client_name: `${client.client_name} ${client.client_last_name}`,
      client_phone: client.client_phone,
      expiry: parsed.data.expiry,
      expires_at_anterior: current.expires_at,
      expires_at: client.expires_at,
      renewed_by: caller.email ?? caller.id,
      aviso_al_cliente: emailWarning === null,
    },
  });

  return NextResponse.json({ ok: true, client, email_warning: emailWarning });
}
