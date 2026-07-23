import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { settingsUpdateSchema } from "@/lib/schema";
import { getSettings } from "@/lib/counts";
import { isAuthorizedOperator } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAuthorizedOperator(req))) {
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }
  const settings = await getSettings();
  return NextResponse.json({ ok: true, settings });
}

export async function PUT(req: NextRequest) {
  if (!(await isAuthorizedOperator(req))) {
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed json" }, { status: 400 });
  }

  const parsed = settingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }

  const before = await getSettings();

  const { data: after, error } = await supabase
    .from("settings")
    .update({ ...parsed.data, updated_at: new Date().toISOString(), updated_by: "operator" })
    .eq("id", 1)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "settings_changed",
    detail: { before, after },
  });

  return NextResponse.json({ ok: true, settings: after });
}
