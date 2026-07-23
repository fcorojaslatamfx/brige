import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { listUsersWithRoles } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const caller = await getAuthenticatedUser();
  if (!caller) {
    return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });
  }
  if (caller.role !== "super_admin") {
    return NextResponse.json({ ok: false, error: "solo super_admin" }, { status: 403 });
  }

  const users = await listUsersWithRoles();
  return NextResponse.json({ ok: true, users });
}
