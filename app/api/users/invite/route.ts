import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/auth";
import { countSuperAdmins, createOrGetAuthUser, getUserRole, upsertUserRole, generateRecoveryLink } from "@/lib/users";
import { sendInviteEmail } from "@/lib/email";
import { onboardClient } from "@/lib/client-onboarding";
import { inviteSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const caller = await getAuthenticatedUser();
  if (!caller) {
    return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });
  }
  if (caller.role !== "super_admin") {
    return NextResponse.json({ ok: false, error: "solo super_admin" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed json" }, { status: 400 });
  }

  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }

  // Rol "cliente": NO es un usuario del panel. No se crea cuenta en Supabase
  // Auth, no se toca `user_roles` y no se manda link de contraseña — el cliente
  // no inicia sesión, se identifica con su token en el EA. Comparte formulario
  // con la invitación de administradores solo porque para el operador es el
  // mismo gesto; por debajo es el flujo de client_tokens.
  if (parsed.data.role === "cliente") {
    const { role: _role, email: clientEmail, ...perfil } = parsed.data;
    void _role;

    let result;
    try {
      result = await onboardClient(
        { ...perfil, client_email: clientEmail },
        { id: caller.id, email: caller.email ?? null },
      );
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      kind: "cliente",
      client_id: result.client.id,
      email_warning: result.emailWarning,
    });
  }

  const { email, role } = parsed.data;

  let userId: string;
  let isExisting: boolean;
  let resendId: string;
  try {
    const authUser = await createOrGetAuthUser(email);
    userId = authUser.id;
    isExisting = authUser.isExisting;
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error desconocido" }, { status: 500 });
  }

  // Invitar un correo que YA tiene acceso reescribe su rol (upsert). Sin estos
  // guardarraíles, invitarse a uno mismo como "admin" —un tipeo del propio
  // correo en el formulario— degrada silenciosamente al super_admin que está
  // invitando y deja el panel sin nadie que pueda gestionar usuarios: /status/users
  // pasa a responder 403 y solo se recupera por fuera (scripts/set-user-role.ts).
  const currentRole = isExisting ? await getUserRole(userId) : null;

  if (userId === caller.id && currentRole && role !== currentRole) {
    return NextResponse.json(
      { ok: false, error: "no puedes cambiar tu propio rol desde una invitación" },
      { status: 400 },
    );
  }

  if (currentRole === "super_admin" && role === "admin" && (await countSuperAdmins()) <= 1) {
    return NextResponse.json({ ok: false, error: "no puedes degradar al último super_admin" }, { status: 400 });
  }

  try {
    await upsertUserRole(userId, role, caller.id);

    const actionLink = await generateRecoveryLink(email);
    resendId = await sendInviteEmail({ to: email, actionLink, isExisting });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error desconocido" }, { status: 500 });
  }

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "user_invited",
    detail: { email, role, invited_by: caller.email ?? caller.id, is_existing: isExisting },
  });

  return NextResponse.json({ ok: true, kind: "usuario", user_id: userId, is_existing: isExisting, resend_id: resendId });
}
