import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/auth";
import { getClientToken, revokeClientToken } from "@/lib/clients";
import { revokeClientSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revoca (corta) el acceso de un cliente. Reversible solo generando un token nuevo. */
export async function POST(req: NextRequest) {
  const caller = await getAuthenticatedUser();
  if (!caller) return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });
  if (caller.role !== "super_admin") return NextResponse.json({ ok: false, error: "solo super_admin" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed json" }, { status: 400 });
  }

  const parsed = revokeClientSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }

  const client = await getClientToken(parsed.data.id);
  if (!client) return NextResponse.json({ ok: false, error: "cliente no encontrado" }, { status: 404 });

  await revokeClientToken(client.id);

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "client_token_revoked",
    detail: { client_id: client.id, client_email: client.client_email, revoked_by: caller.email ?? caller.id },
  });

  return NextResponse.json({ ok: true, id: client.id });
}
