import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/auth";
import { createOrGetAuthUser, upsertUserRole, generateRecoveryLink } from "@/lib/users";
import { sendInviteEmail } from "@/lib/email";
import { inviteUserSchema } from "@/lib/schema";

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

  const parsed = inviteUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }
  const { email, role } = parsed.data;

  let userId: string;
  let isExisting: boolean;
  let resendId: string;
  try {
    const authUser = await createOrGetAuthUser(email);
    userId = authUser.id;
    isExisting = authUser.isExisting;

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

  return NextResponse.json({ ok: true, user_id: userId, is_existing: isExisting, resend_id: resendId });
}
