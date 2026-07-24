import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/auth";
import { regenerateToken } from "@/lib/tokens";
import { tokenRegenerateSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });
  }
  if (user.role !== "super_admin") {
    return NextResponse.json({ ok: false, error: "solo super_admin" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed json" }, { status: 400 });
  }

  const parsed = tokenRegenerateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }

  const token = await regenerateToken(parsed.data.kind, user.email ?? user.id);

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "token_regenerated",
    detail: { kind: token.kind, regenerated_by: user.email ?? user.id },
  });

  return NextResponse.json({ ok: true, token });
}
