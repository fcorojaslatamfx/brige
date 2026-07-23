import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ackSchema, settingsUpdateSchema, webhookPayloadSchema } from "../lib/schema";
import { isFresh, safeTokenEquals, toEaPayload, type SignalRow } from "../lib/counts";
import { getToken, type TokenKind } from "../lib/tokens";
import { supabase } from "../lib/supabase";
import { POST as webhookPOST } from "../app/api/webhook/route";
import { GET as signalsGET } from "../app/api/signals/route";
import { POST as ackPOST } from "../app/api/ack/route";

// Presencia de credenciales en el entorno: chequeo síncrono barato para
// decidir si intentar la suite de integración. Los valores REALES usados
// por los tests (TV_TOKEN/EA_TOKEN) se resuelven desde la tabla `tokens`
// en el beforeAll de abajo — la env var solo sirve para sembrarla si viene
// vacía (bootstrap local/CI), nunca como fallback en tiempo de request.
const ENV_TV_TOKEN = process.env.TV_WEBHOOK_TOKEN;
const ENV_EA_TOKEN = process.env.EA_TOKEN;
let TV_TOKEN: string | undefined;
let EA_TOKEN: string | undefined;
const BASE = "http://localhost";

// Prefijo único por corrida: ningún instrumento real (XAUUSD, EURJPY, ...)
// empieza así, y dos corridas de la suite nunca chocan entre sí.
const TEST_PREFIX = `TESTSUITE${Date.now()}`;
const SYM_BASIC = `${TEST_PREFIX}_BASIC`;
const SYM_DUP = `${TEST_PREFIX}_DUP`;
const SYM_STALE = `${TEST_PREFIX}_STALE`;
const SYM_THRESHOLD = `${TEST_PREFIX}_THRESH`;
const SYM_CLAIM = `${TEST_PREFIX}_CLAIM`;
const SYM_ACK = `${TEST_PREFIX}_ACK`;

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
    ts_signal: 1_700_000_000_000,
    origin_symbol_count: 1, // Pine cree que es la 1ª (p.ej. script recargado)
    origin_global_count: 1,
    origin_threshold_exceeded: false,
    auth_symbol_count: 4, // Supabase sabe que en realidad es la 4ª
    auth_global_count: 7,
    auth_threshold_exceeded: true,
    symbol_threshold_snapshot: 3,
    global_threshold_snapshot: 6,
    status: "pending",
    error: null,
    duplicate_of: null,
    claimed_at: null,
    notified_at: null,
    created_at: new Date().toISOString(),
  };

  it("usa auth_* aunque origin_* traiga otro valor (discrepancia Pine)", () => {
    const payload = toEaPayload(baseRow);
    expect(payload.current_symbol_count).toBe(4);
    expect(payload.current_global_count).toBe(7);
    expect(payload.symbol_threshold).toBe(3);
    expect(payload.global_threshold).toBe(6);
    expect(payload.threshold_exceeded).toBe(true);
  });

  it("CANCEL_ALL no lleva campos de niveles/conteo", () => {
    const payload = toEaPayload({ ...baseRow, action: "CANCEL_ALL", symbol: "EURJPY" });
    expect(payload).not.toHaveProperty("price");
    expect(payload).not.toHaveProperty("current_symbol_count");
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
  ENV_TV_TOKEN && ENV_EA_TOKEN && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

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

  it("la 4ª señal de entrada del día (umbral 3) SE ENTREGA con threshold_exceeded=true — nada se suprime", async () => {
    let last: { ok: boolean; auth_symbol_count?: number; auth_threshold_exceeded?: boolean } = { ok: false };
    for (let i = 0; i < 4; i++) {
      const res = await webhookPOST(
        jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_THRESHOLD, { timestamp: Date.now() + i })),
      );
      last = await res.json();
      expect(last.ok).toBe(true); // ninguna de las 4 se rechaza por umbral
    }
    expect(last.auth_symbol_count).toBe(4);
    expect(last.auth_threshold_exceeded).toBe(true);
  });

  it("claim atómico: GET /api/signals no entrega la misma señal dos veces", async () => {
    await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_CLAIM)));

    const first = await signalsGET(httpRequest(`/api/signals?token=${EA_TOKEN}&max=100`));
    const firstBody = await first.json();
    const claimedIds = new Set<string>(firstBody.signals.map((s: { id: string }) => s.id));
    expect(claimedIds.size).toBeGreaterThan(0);

    const second = await signalsGET(httpRequest(`/api/signals?token=${EA_TOKEN}&max=100`));
    const secondBody = await second.json();
    const overlap = secondBody.signals.filter((s: { id: string }) => claimedIds.has(s.id));
    expect(overlap.length).toBe(0);
  });

  it("POST /api/ack marca notified y es idempotente en un segundo ack", async () => {
    const ingest = await webhookPOST(jsonRequest(`/api/webhook?token=${TV_TOKEN}`, entryPayload(SYM_ACK)));
    const { id } = await ingest.json();

    const claimRes = await signalsGET(httpRequest(`/api/signals?token=${EA_TOKEN}&max=100`));
    const claimed = (await claimRes.json()).signals.find((s: { id: string }) => s.id === id);
    expect(claimed).toBeTruthy();

    const ackRes = await ackPOST(jsonRequest(`/api/ack?token=${EA_TOKEN}`, { id, status: "notified" }));
    const ackBody = await ackRes.json();
    expect(ackBody.ok).toBe(true);
    expect(ackBody.status).toBe("notified");

    const secondAck = await ackPOST(jsonRequest(`/api/ack?token=${EA_TOKEN}`, { id, status: "notified" }));
    expect((await secondAck.json()).ok).toBe(true); // no-op idempotente, no revienta
  });
});
