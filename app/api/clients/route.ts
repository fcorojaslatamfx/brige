import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/auth";
import { createClientToken, listClientTokens } from "@/lib/clients";
import { listUsersWithRoles } from "@/lib/users";
import { createClientSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET: lista de clientes.
 *  - super_admin: TODOS los clientes + lista de admins (para asignar).
 *  - admin: SOLO sus clientes (assigned_admin = él), sin lista de admins.
 */
export async function GET() {
  const caller = await getAuthenticatedUser();
  if (!caller) return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });

  if (caller.role === "super_admin") {
    const [clients, users] = await Promise.all([listClientTokens(), listUsersWithRoles()]);
    const admins = users.map((u) => ({ user_id: u.user_id, email: u.email, role: u.role }));
    return NextResponse.json({ ok: true, role: caller.role, clients, admins });
  }

  // Rol admin: dashboard acotado a sus propios clientes.
  const clients = await listClientTokens({ assignedAdmin: caller.id });
  return NextResponse.json({ ok: true, role: caller.role, clients, admins: [] });
}

/** POST: generar un token de cliente con caducidad (solo super_admin). */
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

  const parsed = createClientSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  let created;
  try {
    created = await createClientToken({ ...input, created_by: caller.id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "client_token_created",
    detail: {
      client_id: created.id,
      client_email: created.client_email,
      broker: created.broker,
      account_type: created.account_type,
      expiry: input.expiry,
      expires_at: created.expires_at,
      created_by: caller.email ?? caller.id,
    },
  });

  return NextResponse.json({ ok: true, client: created });
}
