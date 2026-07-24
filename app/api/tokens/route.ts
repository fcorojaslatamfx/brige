import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { listTokens } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });
  }
  if (user.role !== "super_admin") {
    return NextResponse.json({ ok: false, error: "solo super_admin" }, { status: 403 });
  }

  const tokens = await listTokens();
  return NextResponse.json({ ok: true, tokens });
}
