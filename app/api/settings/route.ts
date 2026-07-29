import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { settingsUpdateSchema } from "@/lib/schema";
import { getSettings } from "@/lib/counts";
import { isSuperAdminOrOperator } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isSuperAdminOrOperator(req))) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 403 });
  }
  const settings = await getSettings();
  return NextResponse.json({ ok: true, settings });
}

export async function PUT(req: NextRequest) {
  // Alterar umbrales del bridge es exclusivo de super_admin (o el operator token).
  if (!(await isSuperAdminOrOperator(req))) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 403 });
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
    // La retención de armados tiene que caber dentro del TTL de cola o nada se
    // entregaría nunca (el armado moriría 'expired' esperando salir). Lo impone
    // un CHECK de la tabla; sin este mapeo el panel mostraría un 500 opaco.
    if (error.code === "23514" && error.message.includes("setup_hold")) {
      return NextResponse.json(
        {
          ok: false,
          error: `La retención de armados debe ser menor que el TTL de cola (${
            parsed.data.queue_ttl_seconds ?? before.queue_ttl_seconds
          }s).`,
        },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "settings_changed",
    detail: { before, after },
  });

  return NextResponse.json({ ok: true, settings: after });
}
