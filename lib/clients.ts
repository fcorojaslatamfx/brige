import { randomBytes } from "node:crypto";
import { supabase } from "./supabase";

/** Opciones de caducidad ofrecidas al generar un token de cliente. */
export type ClientExpiry = "7d" | "14d" | "30d" | "never";

export const EXPIRY_DAYS: Record<Exclude<ClientExpiry, "never">, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

export type ClientTokenRow = {
  id: string;
  token: string;
  /** Nombre de pila. Obligatorio desde la migración 017 (antes: nombre completo opcional). */
  client_name: string;
  client_last_name: string;
  client_email: string;
  client_phone: string;
  broker: string;
  account_type: "demo" | "real";
  account_number: string;
  broker_server: string;
  assigned_admin: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};

/** Estado derivado para el panel (no se persiste). */
export type ClientStatus = "active" | "expired" | "revoked";

export type ClientTokenView = ClientTokenRow & {
  status: ClientStatus;
  assigned_admin_email: string | null;
  created_by_email: string | null;
};

const CACHE_TTL_MS = 5_000;
type CachedClient = { row: ClientTokenRow | null; expiresAt: number };
const tokenCache = new Map<string, CachedClient>();

/** Calcula el instante de expiración a partir de la opción elegida (null = indefinido). */
export function computeExpiresAt(expiry: ClientExpiry, now = new Date()): string | null {
  if (expiry === "never") return null;
  const ms = EXPIRY_DAYS[expiry] * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() + ms).toISOString();
}

export function clientStatus(row: Pick<ClientTokenRow, "revoked_at" | "expires_at">, nowMs = Date.now()): ClientStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && new Date(row.expires_at).getTime() <= nowMs) return "expired";
  return "active";
}

export async function createClientToken(input: {
  client_name: string;
  client_last_name: string;
  client_email: string;
  client_phone: string;
  broker: string;
  account_type: "demo" | "real";
  account_number: string;
  broker_server: string;
  assigned_admin?: string | null;
  expiry: ClientExpiry;
  created_by: string;
}): Promise<ClientTokenRow> {
  const token = randomBytes(32).toString("hex");
  const { data, error } = await supabase
    .from("client_tokens")
    .insert({
      token,
      client_name: input.client_name.trim(),
      client_last_name: input.client_last_name.trim(),
      client_email: input.client_email.toLowerCase().trim(),
      client_phone: input.client_phone.trim(),
      broker: input.broker.trim(),
      account_type: input.account_type, // viene de un <select> cerrado, sin trim
      account_number: input.account_number.trim(),
      broker_server: input.broker_server.trim(),
      assigned_admin: input.assigned_admin ?? null,
      expires_at: computeExpiresAt(input.expiry),
      created_by: input.created_by,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`No se pudo crear el token de cliente: ${error?.message ?? "sin datos"}`);
  return data as ClientTokenRow;
}

/**
 * Proyección de una fila de cliente a los datos que consumen los correos.
 *
 * Existe para que `lib/email.ts` no dependa de la forma de la tabla: el correo
 * necesita "nombre, apellido, cuenta y vigencia", no una ClientTokenRow.
 */
export function toClientEmailData(row: ClientTokenRow) {
  return {
    firstName: row.client_name,
    lastName: row.client_last_name,
    email: row.client_email,
    phone: row.client_phone,
    broker: row.broker,
    accountType: row.account_type,
    accountNumber: row.account_number,
    brokerServer: row.broker_server,
    expiresAt: row.expires_at,
  };
}

/** Lista de clientes. Con `assignedAdmin` filtra a los de ese admin (dashboard de admin). */
export async function listClientTokens(opts?: { assignedAdmin?: string }): Promise<ClientTokenView[]> {
  let query = supabase.from("client_tokens").select("*").order("created_at", { ascending: false });
  if (opts?.assignedAdmin) query = query.eq("assigned_admin", opts.assignedAdmin);
  const { data, error } = await query;
  if (error) throw new Error(`No se pudieron leer los clientes: ${error.message}`);

  const rows = (data ?? []) as ClientTokenRow[];

  // Resolver correos de los usuarios referenciados (admin asignado + creador).
  const userIds = new Set<string>();
  for (const r of rows) {
    if (r.assigned_admin) userIds.add(r.assigned_admin);
    if (r.created_by) userIds.add(r.created_by);
  }
  const emailById = new Map<string, string | null>();
  if (userIds.size > 0) {
    const { data: authList } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of authList?.users ?? []) emailById.set(u.id, u.email ?? null);
  }

  const nowMs = Date.now();
  return rows.map((r) => ({
    ...r,
    status: clientStatus(r, nowMs),
    assigned_admin_email: r.assigned_admin ? (emailById.get(r.assigned_admin) ?? null) : null,
    created_by_email: r.created_by ? (emailById.get(r.created_by) ?? null) : null,
  }));
}

export async function getClientToken(id: string): Promise<ClientTokenRow | null> {
  const { data, error } = await supabase.from("client_tokens").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as ClientTokenRow;
}

export async function revokeClientToken(id: string): Promise<void> {
  const { data, error } = await supabase
    .from("client_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null)
    .select("token")
    .maybeSingle();
  if (error) throw new Error(`No se pudo revocar el token de cliente: ${error.message}`);
  if (data?.token) tokenCache.delete(data.token);
}

/**
 * Resuelve el token que presenta un EA de cliente. Devuelve la fila SIEMPRE
 * que el token exista (aunque esté revocado o caducado) para que el endpoint
 * pueda distinguir 403 "revocado/caducado" de 401 "token inexistente". La
 * validación de vigencia la hace el caller con clientStatus(). Caché corta:
 * el EA pollea cada ~1-2 s, mismo tradeoff que lib/tokens.ts.
 */
export async function resolveClientToken(token: string): Promise<ClientTokenRow | null> {
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.row;

  const { data } = await supabase.from("client_tokens").select("*").eq("token", token).maybeSingle();
  const row = (data as ClientTokenRow | null) ?? null;
  tokenCache.set(token, { row, expiresAt: Date.now() + CACHE_TTL_MS });
  return row;
}

/** Heartbeat: marca el último poll del EA del cliente (para el badge online/offline del panel). */
export async function touchClientUsage(id: string): Promise<void> {
  await supabase.from("client_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", id);
}

// ---------- Portal del cliente (solo lectura, sin configuración) ----------

export type ClientDeliveredSignal = {
  status: "claimed" | "notified" | "error";
  claimed_at: string;
  notified_at: string | null;
  symbol: string;
  action: string;
  grade: string | null;
  type: string | null;
  price: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  ts_signal: number;
  created_at: string;
};

export type ClientReport = {
  total: number;
  bySymbol: { symbol: string; count: number }[];
  byGrade: { grade: string; count: number }[];
  byStatus: { status: string; count: number }[];
  lastReceivedAt: string | null;
};

/** Señales entregadas a un cliente (join client_deliveries → signals), más recientes primero. */
export async function listClientDeliveries(clientId: string, limit = 200): Promise<ClientDeliveredSignal[]> {
  const { data, error } = await supabase
    .from("client_deliveries")
    .select(
      "status, claimed_at, notified_at, signals(symbol, action, grade, type, price, sl, tp1, tp2, ts_signal, created_at)",
    )
    .eq("client_id", clientId)
    .order("claimed_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`No se pudieron leer las entregas: ${error.message}`);

  return (data ?? [])
    .map((r) => {
      // PostgREST embebe la relación to-one como objeto (o array según versión); normalizamos.
      const s = Array.isArray(r.signals) ? r.signals[0] : r.signals;
      if (!s) return null;
      return {
        status: r.status as ClientDeliveredSignal["status"],
        claimed_at: r.claimed_at as string,
        notified_at: (r.notified_at as string | null) ?? null,
        symbol: s.symbol,
        action: s.action,
        grade: s.grade ?? null,
        type: s.type ?? null,
        price: s.price ?? null,
        sl: s.sl ?? null,
        tp1: s.tp1 ?? null,
        tp2: s.tp2 ?? null,
        ts_signal: s.ts_signal,
        created_at: s.created_at,
      } as ClientDeliveredSignal;
    })
    .filter((x): x is ClientDeliveredSignal => x !== null);
}

/** Reporte agregado (conteos por símbolo / grade / estado) para el portal del cliente. */
export function buildClientReport(rows: ClientDeliveredSignal[]): ClientReport {
  const tally = (key: (r: ClientDeliveredSignal) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([k, count]) => ({ k, count })).sort((a, b) => b.count - a.count);
  };

  return {
    total: rows.length,
    bySymbol: tally((r) => r.symbol).map(({ k, count }) => ({ symbol: k, count })),
    byGrade: tally((r) => r.grade ?? "—").map(({ k, count }) => ({ grade: k, count })),
    byStatus: tally((r) => r.status).map(({ k, count }) => ({ status: k, count })),
    lastReceivedAt: rows[0]?.claimed_at ?? null,
  };
}
