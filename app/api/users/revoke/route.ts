import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/auth";
import { countSuperAdmins, deleteUserRole, getUserRole } from "@/lib/users";
import { revokeUserSchema } from "@/lib/schema";

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

  const parsed = revokeUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }
  const { user_id } = parsed.data;

  const role = await getUserRole(user_id);
  if (!role) {
    return NextResponse.json({ ok: false, error: "usuario no encontrado" }, { status: 404 });
  }

  if (role === "super_admin" && (await countSuperAdmins()) <= 1) {
    return NextResponse.json({ ok: false, error: "no puedes revocar al último super_admin" }, { status: 400 });
  }

  const { data: authUser } = await supabase.auth.admin.getUserById(user_id);
  await deleteUserRole(user_id);

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "user_access_revoked",
    detail: { user_id, email: authUser.user?.email ?? null, role, revoked_by: caller.email ?? caller.id },
  });

  return NextResponse.json({ ok: true, user_id });
}
