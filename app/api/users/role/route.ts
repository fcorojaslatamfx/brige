import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/auth";
import { countSuperAdmins, getUserRole, upsertUserRole } from "@/lib/users";
import { changeRoleSchema } from "@/lib/schema";

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

  const parsed = changeRoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }
  const { user_id, role } = parsed.data;

  const currentRole = await getUserRole(user_id);
  if (!currentRole) {
    return NextResponse.json({ ok: false, error: "usuario no encontrado" }, { status: 404 });
  }

  if (currentRole === "super_admin" && role === "admin" && (await countSuperAdmins()) <= 1) {
    return NextResponse.json({ ok: false, error: "no puedes degradar al último super_admin" }, { status: 400 });
  }

  await upsertUserRole(user_id, role, caller.id);

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "user_role_changed",
    detail: { user_id, old_role: currentRole, new_role: role, changed_by: caller.email ?? caller.id },
  });

  return NextResponse.json({ ok: true, user_id, role });
}
