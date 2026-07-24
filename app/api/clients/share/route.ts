import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/auth";
import { getClientToken, clientStatus } from "@/lib/clients";
import { sendClientTokenEmail } from "@/lib/email";
import { shareClientSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reenvía el token de cliente al correo del propio cliente (solo super_admin). */
export async function POST(req: NextRequest) {
  const caller = await getAuthenticatedUser();
  if (!caller) return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed json" }, { status: 400 });
  }

  const parsed = shareClientSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }

  const client = await getClientToken(parsed.data.id);
  if (!client) return NextResponse.json({ ok: false, error: "cliente no encontrado" }, { status: 404 });

  // super_admin comparte cualquiera; un admin solo puede compartir SUS clientes.
  if (caller.role !== "super_admin" && client.assigned_admin !== caller.id) {
    return NextResponse.json({ ok: false, error: "no autorizado sobre este cliente" }, { status: 403 });
  }
  if (clientStatus(client) !== "active") {
    return NextResponse.json({ ok: false, error: "el token no está activo (revocado o caducado)" }, { status: 400 });
  }

  let resendId: string;
  try {
    resendId = await sendClientTokenEmail({
      to: client.client_email,
      clientName: client.client_name,
      token: client.token,
      expiresAt: client.expires_at,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "client_token_shared",
    detail: { client_id: client.id, client_email: client.client_email, shared_by: caller.email ?? caller.id },
  });

  return NextResponse.json({ ok: true, resend_id: resendId });
}
