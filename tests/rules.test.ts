import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ackSchema, settingsUpdateSchema, webhookPayloadSchema, createClientSchema } from "../lib/schema";
import { isFresh, safeTokenEquals, toEaPayload, type SignalRow } from "../lib/counts";
import { computeEaPollStatus, getToken, type TokenKind } from "../lib/tokens";
import { computeExpiresAt, clientStatus, buildClientReport, type ClientDeliveredSignal } from "../lib/clients";
import { supabase } from "../lib/supabase";
import { POST as webhookPOST } from "../app/api/webhook/route";
import { GET as signalsGET } from "../app/api/signals/route";
import { POST as ackPOST } from "../app/api/ack/route";
import { GET as portalGET } from "../app/api/portal/route";

// Presencia de credenciales en el entorno: chequeo síncrono barato para
// decidir si intentar la suite de integración. Los valores REALES usados
// por los tests (TV_TOKEN/EA_TOKEN) se resuelven desde la tabla `tokens`
// en el beforeAll de abajo — la env var solo sirve para sembrarla si viene
// vacía (bootstrap local/CI), nunca como fallback en tiempo de request.
const ENV_TV_TOKEN = process.env.TV_WEBHOOK_TOKEN;
const ENV_EA_TOKEN = process.env.EA_TOKEN;
const ENV_OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;
let TV_TOKEN: string | undefined;
let EA_TOKEN: string | undefined;
let OPERATOR_TOKEN: string | undefined;
const BASE = "http://localhost";

// Prefijo único por corrida: ningún instrumento real (XAUUSD, EURJPY, ...)
// empieza así, y dos corridas de la suite nunca chocan entre sí. Se mantiene
// corto (base36 del timestamp) para que symbol+sufijo no pase el tope de 20
// caracteres del contrato Zod (§5.1) — los símbolos reales no lo pasan.
const TEST_PREFIX = `T${Date.now().toString(36).toUpperCase()}`;
const SYM_BASIC = `${TEST_PREFIX}_BASIC`;
const SYM_DUP = `${TEST_PREFIX}_DUP`;
const SYM_STALE = `${TEST_PREFIX}_STALE`;
const SYM_THRESHOLD = `${TEST_PREFIX}_THRESH`;
const SYM_CLAIM = `${TEST_PREFIX}_CLAIM`;
const SYM_ACK = `${TEST_PREFIX}_ACK`;
const SYM_LEAK = `${TEST_PREFIX}_LEAK`;
const SYM_BROADCAST = `${TEST_PREFIX}_BCAST`;
const SYM_EPHEMERAL = `${TEST_PREFIX}_EPH`;
const SYM_HOLD = `${TEST_PREFIX}_HOLD`;
const SYM_NOHOLD = `${TEST_PREFIX}_NOHOLD`;
const SYM_GUARD = `${TEST_PREFIX}_GUARD`;

function httpRequest(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(new URL(path, BASE), init);
}

function jsonRequest(path: string, body: unknown) {
  return httpRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function entryPayload(symbol: string, overrides: Record<string, unknown> = {}) {
  return {
    account_id: "TD_CONF_LON_NY",
    action: "BUY_DUAL",
    symbol,
    tf: "15",
    type: "LIMIT",
    grade: "ELITE",
    impulse_atr: 2.85,
    price: 100,
    sl: 95,
    partial_1: { lots: 0.01, tp: 110 },
    partial_2: { lots: 0.01, tp: 120 },
    risk_usd: 50,
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Armado (SETUP_BUY/SETUP_SELL): mismo shape que una entrada.
 *
 * `bar_time` se pasa explícito y distinto en cada llamada porque el índice de
 * dedup es (symbol, action, bar_time): dos armados del mismo símbolo en un
 * test necesitan velas distintas o el segundo entra como duplicado.
 */
function setupPayload(symbol: string, action: "SETUP_BUY" | "SETUP_SELL", overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return entryPayload(symbol, { action, bar_time: now, timestamp: now, schema: "2.0", ...overrides });
}

function cancelPayload(
  symbol: string,
  action: "SETUP_CANCEL" | "CANCEL_ALL" = "SETUP_CANCEL",
  overrides: Record<string, unknown> = {},
) {
  const now = Date.now();
  return {
    account_id: "TD_CONF_LON_NY",
    action,
    symbol,
    tf: "15",
    bar_time: now,
    timestamp: now,
    schema: "2.0",
    ...overrides,
  };
}

// ==================== reglas puras (sin red) ====================

describe("lib/schema · contrato Zod (§2 del meta-prompt)", () => {
  it("acepta un BUY_DUAL válido sin los campos de conteo de Pine", () => {
    expect(webhookPayloadSchema.safeParse(entryPayload("XAUUSD")).success).toBe(true);
  });

  it("acepta los campos de conteo best-effort de Pine cuando vienen", () => {
    const result = webhookPayloadSchema.safeParse(
      entryPayload("XAUUSD", {
        current_symbol_count: 4,
        symbol_threshold: 3,
        current_global_count: 7,
        global_threshold: 6,
        threshold_exceeded: true,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("acepta un payload v1.0 (sin grade/impulse_atr/conteos) y completa los defaults", () => {
    const v1Payload = {
      account_id: "TD_CONF_LON_NY",
      action: "BUY_DUAL",
      symbol: "XAUUSD",
      tf: "15",
      price: 100,
      sl: 95,
      partial_1: { lots: 0.01, tp: 110 },
      partial_2: { lots: 0.01, tp: 120 },
      risk_usd: 50,
      timestamp: Date.now(),
    };
    const result = webhookPayloadSchema.safeParse(v1Payload);
    expect(result.success).toBe(true);
    if (result.success && result.data.action === "BUY_DUAL") {
      expect(result.data.grade).toBe("STANDARD");
      expect(result.data.impulse_atr).toBe(0);
      expect(result.data.current_symbol_count).toBeUndefined();
      expect(result.data.threshold_exceeded).toBeUndefined();
    }
  });

  it("rechaza una señal de entrada sin sl", () => {
    const { sl: _sl, ...rest } = entryPayload("XAUUSD");
    expect(webhookPayloadSchema.safeParse(rest).success).toBe(false);
  });

  it("rechaza grade fuera de {ELITE, STANDARD}", () => {
    expect(webhookPayloadSchema.safeParse(entryPayload("XAUUSD", { grade: "GOLD" })).success).toBe(false);
  });

  it("rechaza una acción desconocida", () => {
    expect(webhookPayloadSchema.safeParse(entryPayload("XAUUSD", { action: "HOLD" })).success).toBe(false);
  });

  it("acepta CANCEL_ALL sin price/sl/partial_*", () => {
    const result = webhookPayloadSchema.safeParse({
      account_id: "TD_CONF_LON_NY",
      action: "CANCEL_ALL",
      symbol: "EURJPY",
      tf: "15",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it("§3.1: acepta SETUP_BUY / SETUP_SELL con niveles completos y bar_time/schema", () => {
    for (const action of ["SETUP_BUY", "SETUP_SELL"] as const) {
      const result = webhookPayloadSchema.safeParse(
        entryPayload("XAUUSD", { action, bar_time: 1_700_000_000_000, timestamp: Date.now(), schema: "2.0" }),
      );
      expect(result.success).toBe(true);
    }
  });

  it("§3.1: acepta SETUP_CANCEL con la forma reducida", () => {
    const result = webhookPayloadSchema.safeParse({
      account_id: "TD_CONF_LON_NY",
      action: "SETUP_CANCEL",
      symbol: "EURJPY",
      tf: "15",
      bar_time: 1_700_000_000_000,
      timestamp: Date.now(),
      schema: "2.0",
    });
    expect(result.success).toBe(true);
  });

  it("bar_time es opcional (payload v1.x sigue válido)", () => {
    // entryPayload no incluye bar_time: es exactamente un payload v1.x.
    expect(webhookPayloadSchema.safeParse(entryPayload("XAUUSD")).success).toBe(true);
  });
});

describe("lib/schema · ack y settings", () => {
  it("ackSchema exige id uuid y status notified|error", () => {
    expect(ackSchema.safeParse({ id: "not-a-uuid", status: "notified" }).success).toBe(false);
    expect(
      ackSchema.safeParse({ id: "11111111-1111-1111-1111-111111111111", status: "notified" }).success,
    ).toBe(true);
  });

  it("settingsUpdateSchema exige al menos un campo", () => {
    expect(settingsUpdateSchema.safeParse({}).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ symbol_threshold: 5 }).success).toBe(true);
  });

  it("setup_hold_seconds acepta 0 (retención desactivada) y rechaza negativos", () => {
    expect(settingsUpdateSchema.safeParse({ setup_hold_seconds: 0 }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ setup_hold_seconds: 45 }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ setup_hold_seconds: -1 }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ setup_hold_seconds: 2.5 }).success).toBe(false);
  });
});

describe("lib/schema · tokens de cliente", () => {
  const base = {
    client_email: "lead@ejemplo.com",
    client_phone: "+56912345678",
    expiry: "30d" as const,
    broker: "Tradeview",
    account_type: "demo" as const,
    account_number: "123456",
    broker_server: "Tradeview-Demo",
  };

  it("acepta una creación válida con caducidad y campos opcionales", () => {
    expect(createClientSchema.safeParse({ ...base, client_name: "Lead X" }).success).toBe(true);
    expect(createClientSchema.safeParse(base).success).toBe(true);
  });

  it("rechaza correo inválido, teléfono vacío y caducidad desconocida", () => {
    expect(createClientSchema.safeParse({ ...base, client_email: "no-es-correo" }).success).toBe(false);
    expect(createClientSchema.safeParse({ ...base, client_phone: "" }).success).toBe(false);
    expect(createClientSchema.safeParse({ ...base, expiry: "90d" }).success).toBe(false);
  });

  it("§8.1: los 4 campos de bróker son obligatorios en el servidor (Zod sin .optional)", () => {
    for (const field of ["broker", "account_number", "broker_server"] as const) {
      const { [field]: _omit, ...rest } = base;
      void _omit;
      expect(createClientSchema.safeParse(rest).success).toBe(false);
    }
    expect(createClientSchema.safeParse({ ...base, broker: "" }).success).toBe(false);
    expect(createClientSchema.safeParse({ ...base, account_type: "margin" }).success).toBe(false);
  });
});

describe("lib/clients · caducidad y estado", () => {
  it("computeExpiresAt: 7/14/30 días desde ahora, o null para indefinido", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(computeExpiresAt("never", now)).toBeNull();
    expect(computeExpiresAt("7d", now)).toBe("2026-01-08T00:00:00.000Z");
    expect(computeExpiresAt("14d", now)).toBe("2026-01-15T00:00:00.000Z");
    expect(computeExpiresAt("30d", now)).toBe("2026-01-31T00:00:00.000Z");
  });

  it("clientStatus: revoked > expired > active", () => {
    const now = Date.parse("2026-01-10T00:00:00Z");
    expect(clientStatus({ revoked_at: "2026-01-05T00:00:00Z", expires_at: null }, now)).toBe("revoked");
    expect(clientStatus({ revoked_at: null, expires_at: "2026-01-09T00:00:00Z" }, now)).toBe("expired");
    expect(clientStatus({ revoked_at: null, expires_at: "2026-01-20T00:00:00Z" }, now)).toBe("active");
    expect(clientStatus({ revoked_at: null, expires_at: null }, now)).toBe("active");
  });

  it("buildClientReport: agrega por símbolo, calidad y estado", () => {
    const mk = (symbol: string, grade: string, status: ClientDeliveredSignal["status"]): ClientDeliveredSignal => ({
      status,
      claimed_at: "2026-01-10T00:00:00Z",
      notified_at: null,
      symbol,
      action: "BUY_DUAL",
      grade,
      type: "LIMIT",
      price: 1,
      sl: 1,
      tp1: 1,
      tp2: 1,
      ts_signal: 1,
      created_at: "2026-01-10T00:00:00Z",
    });
    const report = buildClientReport([
      mk("XAUUSD", "ELITE", "notified"),
      mk("XAUUSD", "STANDARD", "claimed"),
      mk("EURUSD", "ELITE", "notified"),
    ]);
    expect(report.total).toBe(3);
    expect(report.bySymbol.find((s) => s.symbol === "XAUUSD")?.count).toBe(2);
    expect(report.byGrade.find((g) => g.grade === "ELITE")?.count).toBe(2);
    expect(report.byStatus.find((s) => s.status === "notified")?.count).toBe(2);
  });
});

describe("lib/counts · frescura y comparación de tokens", () => {
  it("una señal de hace 10s es fresca con ventana de 180s", () => {
    const now = 1_700_000_000_000;
    expect(isFresh(now - 10_000, 180, now)).toBe(true);
  });

  it("una señal de hace 10 minutos NO es fresca con ventana de 180s", () => {
    const now = 1_700_000_000_000;
    expect(isFresh(now - 600_000, 180, now)).toBe(false);
  });

  it("safeTokenEquals rechaza no-match, largo distinto y valores ausentes", () => {
    expect(safeTokenEquals("abc123", "abc123")).toBe(true);
    expect(safeTokenEquals("abc123", "abc124")).toBe(false);
    expect(safeTokenEquals("abc", "abc123")).toBe(false);
    expect(safeTokenEquals(null, "abc123")).toBe(false);
    expect(safeTokenEquals("abc123", undefined)).toBe(false);
  });
});

describe("lib/counts · toEaPayload sobreescribe con conteos autoritativos", () => {
  const baseRow: SignalRow = {
    id: "fake-id",
    raw: {},
    account_id: "TD_CONF_LON_NY",
    action: "BUY_DUAL",
    symbol: "XAUUSD",
    tf: "15",
    type: "LIMIT",
    grade: "ELITE",
    impulse_atr: 2.85,
    price: 100,
    sl: 95,
    tp1: 110,
    tp2: 120,
    lots1: 0.01,
    lots2: 0.01,
    risk_usd: 50,
    bar_time: 1_700_000_000_000,
    ts_signal: 1_700_000_000_000,
    origin_symbol_count: 1, // Pine cree que es la 1ª (p.ej. script recargado)
    origin_global_count: 1,
    origin_threshold_exceeded: false,
    auth_symbol_count: 4, // Supabase sabe que en realidad es la 4ª
    auth_global_count: 7,
    auth_threshold_exceeded: true,
    symbol_threshold_snapshot: 3,
    global_threshold_snapshot: 6,
    origin: "tradingview",
    is_test: false,
    env: "production",
    status: "pending",
    error: null,
    duplicate_of: null,
    superseded_by: null,
    claimed_at: null,
    notified_at: null,
    created_at: new Date().toISOString(),
  };

  it("usa auth_* aunque origin_* traiga otro valor (discrepancia Pine)", () => {
    const payload = toEaPayload(baseRow) as Record<string, unknown>;
    // Contrato plano v1 (retrocompatibilidad)
    expect(payload.current_symbol_count).toBe(4);
    expect(payload.current_global_count).toBe(7);
    expect(payload.symbol_threshold).toBe(3);
    expect(payload.global_threshold).toBe(6);
    expect(payload.threshold_exceeded).toBe(true);
    // Contrato anidado v2.0 (§3.2)
    expect(payload.thresholds).toEqual({
      symbol_count: 4,
      symbol_threshold: 3,
      global_count: 7,
      global_threshold: 6,
      exceeded: true,
    });
  });

  it("§3.2: si falta cualquier columna autoritativa, OMITE thresholds — nunca lo manda con ceros", () => {
    const payload = toEaPayload({ ...baseRow, auth_symbol_count: null }) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("thresholds");
    expect(payload).not.toHaveProperty("current_symbol_count");
    expect(payload).not.toHaveProperty("threshold_exceeded");
  });

  it("SETUP_BUY lleva niveles y bloque thresholds igual que una entrada", () => {
    const payload = toEaPayload({ ...baseRow, action: "SETUP_BUY" }) as Record<string, unknown>;
    expect(payload.action).toBe("SETUP_BUY");
    expect(payload.price).toBe(100);
    expect(payload.thresholds).toBeDefined();
  });

  it("CANCEL_ALL y SETUP_CANCEL no llevan campos de niveles/conteo", () => {
    for (const action of ["CANCEL_ALL", "SETUP_CANCEL"] as const) {
      const payload = toEaPayload({ ...baseRow, action, symbol: "EURJPY" }) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("price");
      expect(payload).not.toHaveProperty("thresholds");
      expect(payload).not.toHaveProperty("current_symbol_count");
    }
  });

  it("todo payload lleva la metadata de aislamiento (is_test/env/origin/bar_time)", () => {
    const payload = toEaPayload(baseRow) as Record<string, unknown>;
    expect(payload.is_test).toBe(false);
    expect(payload.env).toBe("production");
    expect(payload.origin).toBe("tradingview");
    expect(payload.bar_time).toBe(1_700_000_000_000);
  });

  it("la contabilidad interna (status/superseded_by/duplicate_of) NO viaja al EA", () => {
    // El EA no debe poder tomar decisiones con el estado de la cola: qué se
    // entrega y qué se suprime lo decide el bridge (migración 016).
    const payload = toEaPayload({ ...baseRow, superseded_by: "otra-uuid" }) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("superseded_by");
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("duplicate_of");
  });
});

// ==================== reglas de negocio contra Supabase real ====================
// A diferencia de los tests de arriba, estos llaman a los route handlers
// reales (sin mocks) contra el proyecto Supabase de .env.local: es la única
// forma fiel de probar dedup/conteo/flag, que viven en SQL (trigger +
// contar_dia), no en JS. Usan símbolos sintéticos que ningún instrumento
// real usa y limpian sus propias filas en afterAll — pero SÍ escriben en la
// base mientras corren. Si no hay credenciales en el entorno, se saltan.
const hasLiveCreds = Boolean(
  ENV_TV_TOKEN &&
    ENV_EA_TOKEN &&
    ENV_OPERATOR_TOKEN &&
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Cola de prueba: la suite corre con PESSARO_ENV='test' (tests/setup.ts), así
// que sus ingests quedan is_test=true y NO los sirve la cola del EA. Para
// ejercitar claim→ack se usa el camino explícito de prueba: token `operator`
// + include_test=true (meta-prompt v3.0 §8 capa 2).
function testClaim(max = 100) {
  return signalsGET(httpRequest(`/api/signals?token=${OPERATOR_TOKEN}&include_test=true&max=${max}`));
}

/** Lee el token activo desde `tokens`; si la fila viene vacía, la siembra con el valor de la env var (bootstrap). */
async function ensureTokenSeeded(kind: TokenKind, envValue: string | undefined): Promise<string | undefined> {
  const existing = await getToken(kind);
  if (existing) return existing;
  if (!envValue) return undefined;
  await supabase.from("tokens").upsert({ kind, value: envValue, updated_by: "test-bootstrap" });
  return envValue;
}

describe.skipIf(!hasLiveCreds)("reglas de negocio (integración contra Supabase real)", () => {
  beforeAll(async () => {
    TV_TOKEN = await ensureTokenSeeded("tv_webhook", ENV_TV_TOKEN);
    EA_TOKEN = await ensureTokenSeeded("ea", ENV_EA_TOKEN);
    OPERATOR_TOKEN = await ensureTokenSeeded("operator", ENV_OPERATOR_TOKEN);
  });

  // El test de "token inválido" deja una fila en `audit` sin signal_id (no
  // hay señal a la que ligarla) que este afterAll no puede distinguir de un
  // evento real de token inválido sin arriesgar un filtro de tiempo poco
  // fiable (desfase de reloj entre esta máquina y el servidor de Postgres).
  // Se deja: es indistinguible de tráfico real con token incorrecto, que el
  // sistema va a loguear igual en producción, y `compact_audit()` ya
  // purga `audit` cada 90 días vía el cron de mantenimiento.
  afterAll(async () => {
    const { data: rows } = await supabase.from("signals").select("id").like("symbol", `${TEST_PREFIX}%`);
    const ids = (rows ?? []).map((r) => r.id);
    if (ids.length > 0) {
      await supabase.from("audit").delete().in("signal_id", ids);
      await supabase.from("signals").delete().in("id", ids);
    }
    // Clientes de prueba: la cascada borra sus client_deliveries.
    await supabase.from("client_tokens").delete().like("client_email", `%@${TEST_PREFIX}.local`);
  });

  // Alta directa en client_tokens (crear vía API exigiría sesión Supabase, que
  // no existe en este contexto). No se crean señales entregables aquí: estos
  // tests cubren la barrera de vigencia del token (activo/caducado/revocado),
  // no el fan-out — ese se validó de forma transaccional (rollback) contra la
  // función SQL, sin tocar tráfico real.
  async function seedClient(opts: { expiresAt?: string | null; revoked?: boolean }): Promise<{ token: string; id: string }> {
    const token = `CLTEST_${TEST_PREFIX}_${Math.random().toString(36).slice(2)}`;
    const { data, error } = await supabase
      .from("client_tokens")
      .insert({
        token,
        client_email: `c${Date.now()}${Math.random().toString(36).slice(2)}@${TEST_PREFIX}.local`,
        client_phone: "+56900000000",
        broker: "TESTBROKER",
        account_type: "demo",
        account_number: "TEST123",
        broker_server: "TESTBROKER-Demo",
        expires_at: opts.expiresAt ?? null,
        revoked_at: opts.revoked ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { token, id: data.id as string };
  }

  it("token de cliente ACTIVO → /api/signals responde 200 (aunque no haya nada que entregar)", async () => {
    const { token } = await seedClient({ expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const res = await signalsGET(httpRequest(`/api/signals?token=${token}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.count).toBe("number");
    expect(typeof body.server_time).toBe("number");
  });

  it("token de cliente CADUCADO → 403 'token caducado', el EA del cliente deja de recibir", async () => {
    const { token } = await seedClient({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await signalsGET(httpRequest(`/api/signals?token=${token}`));
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toContain("caducado");
  });

  it("token de cliente REVOCADO → 403", async () => {
    const { token } = await seedClient({ revoked: true });
    const res = await signalsGET(httpRequest(`/api/signals?token=${token}`));
    expect(res.status).toBe(403);
  });

  it("token de cliente inexistente → 401 (no 403)", async () => {
    const res = await signalsGET(httpRequest(`/api/signals?token=CLTEST_${TEST_PREFIX}_no-existe`));
    expect(res.status).toBe(401);
  });

  it("un token de cliente NO drena la cola del operador (claim_signals intacto)", async () => {
    // Se ingesta una señal de prueba (is_test=true por PESSARO_ENV=test); ni el
    // operador ni el cliente deben verla, pero probamos que el token de cliente
    // toma su propio camino (claim_signals_for_client) sin error.
    await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_BROADCAST)));
    const { token } = await seedClient({ expiresAt: null }); // indefinido
    const res = await signalsGET(httpRequest(`/api/signals?token=${token}`));
    expect((await res.json()).ok).toBe(true);
  });

  // ---------- Portal del cliente (solo lectura) ----------

  it("portal: token ACTIVO devuelve su token, señales entregadas y reporte agregado", async () => {
    const { token, id } = await seedClient({ expiresAt: null });

    // Ingesta una señal (is_test en la suite) y se le entrega directamente a
    // este cliente insertando su fila de entrega — el portal la debe listar.
    const ingest = await webhookPOST(
      jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_BROADCAST, { grade: "ELITE" })),
    );
    const { id: signalId } = await ingest.json();
    await supabase.from("client_deliveries").insert({ signal_id: signalId, client_id: id, status: "notified" });

    const res = await portalGET(httpRequest(`/api/portal?token=${token}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.client.token).toBe(token);
    expect(body.report.total).toBeGreaterThanOrEqual(1);
    expect(body.signals.some((s: { symbol: string }) => s.symbol === SYM_BROADCAST)).toBe(true);
    expect(body.report.bySymbol.some((s: { symbol: string }) => s.symbol === SYM_BROADCAST)).toBe(true);
  });

  it("portal: token CADUCADO → 403, inexistente → 401", async () => {
    const { token } = await seedClient({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await portalGET(httpRequest(`/api/portal?token=${token}`))).status).toBe(403);
    expect((await portalGET(httpRequest(`/api/portal?token=CLTEST_${TEST_PREFIX}_nope`))).status).toBe(401);
  });

  it("token inválido → 401, nada se inserta", async () => {
    const res = await webhookPOST(
      jsonRequest(`/api/webhook?token=no-es-el-token`, entryPayload(SYM_BASIC)),
    );
    expect(res.status).toBe(401);
  });

  it("1ª señal del día para un símbolo nuevo → auth_symbol_count=1, threshold_exceeded=false", async () => {
    const res = await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_BASIC)));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.auth_symbol_count).toBe(1);
    expect(body.auth_threshold_exceeded).toBe(false);
  });

  it("señal duplicada exacta (mismo symbol+action+timestamp) → rejected_technical", async () => {
    const payload = entryPayload(SYM_DUP);
    const first = await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, payload));
    expect((await first.json()).ok).toBe(true);

    const second = await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, payload));
    const body = await second.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("rejected_technical");
    expect(body.reason).toBe("duplicate");
  });

  it("señal vieja (fuera de la ventana de frescura) → rejected_technical por stale", async () => {
    const payload = entryPayload(SYM_STALE, { timestamp: Date.now() - 10 * 60 * 1000 });
    const res = await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, payload));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("rejected_technical");
    expect(body.reason).toBe("stale");
  });

  // Timeout propio: este test emite `symbol_threshold` señales EN SERIE, y ese
  // valor es configurable en caliente. En producción está en 10, así que son 10
  // ingestas completas (~6 viajes de red cada una) y con el timeout global de
  // 20 s se agota por latencia, no por lógica.
  it("al ALCANZAR el umbral por símbolo la señal SE ENTREGA con threshold_exceeded=true — nada se suprime", async () => {
    // Independiente del valor configurado en settings: se emiten exactamente
    // `symbol_threshold` señales y se comprueba que la última (que ALCANZA el
    // umbral, semántica `>=` del §5.2) sale en ámbar sin ser rechazada.
    const { data: cfg } = await supabase.from("settings").select("symbol_threshold").eq("id", 1).single();
    const threshold = cfg?.symbol_threshold ?? 3;

    let last: { ok: boolean; auth_symbol_count?: number; auth_threshold_exceeded?: boolean } = { ok: false };
    for (let i = 0; i < threshold; i++) {
      const res = await webhookPOST(
        jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_THRESHOLD, { timestamp: Date.now() + i })),
      );
      last = await res.json();
      expect(last.ok).toBe(true); // ninguna se rechaza por umbral
    }
    expect(last.auth_symbol_count).toBe(threshold);
    expect(last.auth_threshold_exceeded).toBe(true);
  }, 90_000);

  it("claim atómico: GET /api/signals no entrega la misma señal dos veces", async () => {
    await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_CLAIM)));

    const first = await testClaim();
    const firstBody = await first.json();
    const claimedIds = new Set<string>(firstBody.signals.map((s: { id: string }) => s.id));
    expect(claimedIds.size).toBeGreaterThan(0);

    const second = await testClaim();
    const secondBody = await second.json();
    const overlap = secondBody.signals.filter((s: { id: string }) => claimedIds.has(s.id));
    expect(overlap.length).toBe(0);
  });

  it("§8/§11.8 · CRÍTICO: una señal is_test NUNCA aparece en la cola del EA (token ea)", async () => {
    // Ingesta bajo PESSARO_ENV='test' → is_test=true, origin='test'.
    const ingest = await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_LEAK)));
    const { id } = await ingest.json();
    expect(id).toBeTruthy();

    // El EA (cola de producción) drena todo lo que pueda: la fila de prueba
    // no puede estar entre lo entregado, ni ahora ni en polls sucesivos.
    for (let i = 0; i < 3; i++) {
      const res = await signalsGET(httpRequest(`/api/signals?token=${EA_TOKEN}&max=200`));
      const body = await res.json();
      expect(body.signals.some((s: { id: string }) => s.id === id)).toBe(false);
    }

    // Y en la base: la fila sigue 'pending', jamás pasó a 'claimed'/'notified'.
    const { data } = await supabase.from("signals").select("status, is_test, origin").eq("id", id).single();
    expect(data?.is_test).toBe(true);
    expect(data?.origin).toBe("test");
    expect(["pending", "expired"]).toContain(data?.status);
  });

  it("GET /api/signals válido registra el heartbeat aunque no haya señales pendientes, y computeEaPollStatus lo ve online", async () => {
    // Cola vacía a propósito: el bug era que "último poll"/online-offline
    // dependía de signals.claimed_at, que solo avanza cuando HAY una señal
    // que reclamar. Sin nada pendiente, un poll legítimo no debía dejar
    // rastro — este test cubre justo ese caso, leyendo el mismo heartbeat
    // (tokens.last_used_at) que expone /api/status.
    const before = await signalsGET(httpRequest(`/api/signals?token=${EA_TOKEN}&max=100`));
    expect((await before.json()).ok).toBe(true);

    const { data } = await supabase.from("tokens").select("last_used_at").eq("kind", "ea").maybeSingle();
    const status = computeEaPollStatus(data?.last_used_at ?? null);

    expect(status.lastPollAt).toBeTruthy();
    expect(status.eaOnline).toBe(true);
    expect(status.lastPollLatencySeconds).toBeLessThan(10);
  });

  it("POST /api/ack marca notified y es idempotente en un segundo ack", async () => {
    const ingest = await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_ACK)));
    const { id } = await ingest.json();

    const claimRes = await testClaim();
    const claimed = (await claimRes.json()).signals.find((s: { id: string }) => s.id === id);
    expect(claimed).toBeTruthy();

    const ackRes = await ackPOST(jsonRequest(`/api/ack?token=${EA_TOKEN}`, { id, status: "notified" }));
    const ackBody = await ackRes.json();
    expect(ackBody.ok).toBe(true);
    expect(ackBody.status).toBe("notified");

    const secondAck = await ackPOST(jsonRequest(`/api/ack?token=${EA_TOKEN}`, { id, status: "notified" }));
    expect((await secondAck.json()).ok).toBe(true); // no-op idempotente, no revienta
  });

  // ---------- Migración 016 · retención y supresión de setups efímeros ----------
  // La ventana de retención se pasa EXPLÍCITA en cada claim (p_hold_seconds) en
  // vez de tocar `settings`: mutar la configuración global —aunque sea por dos
  // segundos— cambiaría el comportamiento del bridge real mientras la suite
  // corre. La cola de prueba existe justo para esto (§8 capa 2).
  const HOLD_LARGO = 3600;

  /**
   * Ingesta que exige quedar ENCOLADA.
   *
   * No basta con que la respuesta traiga `id`: una señal rechazada por stale o
   * por duplicado también trae el suyo (queda como fila visible en /status). Si
   * el helper solo mirara `id`, un rechazo se colaría como "ingestada" y el test
   * fallaría después, en el claim, con un mensaje que no dice nada.
   */
  async function ingest(payload: unknown): Promise<string> {
    const res = await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, payload));
    const body = await res.json();
    if (body.ok !== true) throw new Error(`ingesta NO encolada: ${JSON.stringify(body)}`);
    return body.id as string;
  }

  /** Drena la cola de prueba con una retención dada y devuelve los ids entregados. */
  async function claimTestQueue(holdSeconds: number, max = 200): Promise<Set<string>> {
    const { data, error } = await supabase.rpc("claim_signals_test", {
      p_max: max,
      p_hold_seconds: holdSeconds,
    });
    if (error) throw error;
    return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
  }

  async function rowOf(id: string) {
    const { data } = await supabase.from("signals").select("status, superseded_by").eq("id", id).single();
    return data as { status: string; superseded_by: string | null };
  }

  it("§016 CRÍTICO: armado + cancelación dentro de la ventana → ninguno llega al terminal", async () => {
    const setupId = await ingest(setupPayload(SYM_EPHEMERAL, "SETUP_BUY"));
    const cancelId = await ingest(cancelPayload(SYM_EPHEMERAL));

    const entregadas = await claimTestQueue(HOLD_LARGO);

    expect(entregadas.has(setupId)).toBe(false);
    expect(entregadas.has(cancelId)).toBe(false);

    const setup = await rowOf(setupId);
    const cancel = await rowOf(cancelId);
    expect(setup.status).toBe("suppressed");
    expect(cancel.status).toBe("suppressed");
    // Cada mitad de la pareja apunta a la otra: la traza queda en la fila.
    expect(setup.superseded_by).toBe(cancelId);
    expect(cancel.superseded_by).toBe(setupId);
  });

  it("§016: un armado sin cancelación NO sale mientras dure la retención…", async () => {
    const setupId = await ingest(setupPayload(SYM_HOLD, "SETUP_SELL"));

    const entregadas = await claimTestQueue(HOLD_LARGO);

    expect(entregadas.has(setupId)).toBe(false);
    expect((await rowOf(setupId)).status).toBe("pending"); // retenido, NO suprimido
  });

  it("§016: …y sí sale en cuanto la retención se agota (hold=0)", async () => {
    const setupId = await ingest(setupPayload(SYM_NOHOLD, "SETUP_BUY"));

    const entregadas = await claimTestQueue(0);

    expect(entregadas.has(setupId)).toBe(true);
    expect((await rowOf(setupId)).status).toBe("claimed");
  });

  it("§016 GUARDARRAÍL: la cancelación de un armado YA despachado se entrega siempre", async () => {
    // 1) Armado que sí sale al terminal.
    const armadoVisto = await ingest(setupPayload(SYM_GUARD, "SETUP_BUY", { bar_time: Date.now() - 60_000 }));
    expect((await claimTestQueue(0)).has(armadoVisto)).toBe(true);

    // 2) Segundo armado recién llegado + su cancelación inmediata.
    const armadoEfimero = await ingest(setupPayload(SYM_GUARD, "SETUP_BUY", { bar_time: Date.now() }));
    const cancelId = await ingest(cancelPayload(SYM_GUARD));

    const entregadas = await claimTestQueue(HOLD_LARGO);

    // El armado efímero se suprime…
    expect(entregadas.has(armadoEfimero)).toBe(false);
    expect((await rowOf(armadoEfimero)).status).toBe("suppressed");
    // …pero la cancelación SALE: el trader tiene una pendiente colocada por
    // indicación nuestra y nadie puede ocultarle que hay que retirarla.
    expect(entregadas.has(cancelId)).toBe(true);
    expect((await rowOf(cancelId)).status).toBe("claimed");
  });

  it("§016: un DISPARO (BUY_DUAL) nunca se retiene — el precio ya tocó el nivel", async () => {
    const id = await ingest(entryPayload(`${TEST_PREFIX}_TRIG`, { timestamp: Date.now() }));

    const entregadas = await claimTestQueue(HOLD_LARGO);

    expect(entregadas.has(id)).toBe(true);
  });
});
