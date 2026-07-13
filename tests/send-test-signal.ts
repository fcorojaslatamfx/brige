/**
 * Simulador manual de señales para probar el bridge sin depender de
 * TradingView. Envía la secuencia: BUY, SELL, CANCEL, 4 señales seguidas del
 * mismo símbolo (para ver el umbral excedido sin que nada se suprima),
 * duplicada exacta y señal vieja.
 *
 * Uso:
 *   npm run send-test-signal
 *   BRIDGE_BASE_URL=https://brige.pessaro.cl npm run send-test-signal
 *   TEST_SYMBOL=EURJPY npm run send-test-signal
 */
import { config } from "dotenv";

config({ path: ".env.local" });

const BASE_URL = process.env.BRIDGE_BASE_URL ?? "http://localhost:3000";
const TV_TOKEN = process.env.TV_WEBHOOK_TOKEN;
const SYMBOL = process.env.TEST_SYMBOL ?? "XAUUSD";

if (!TV_TOKEN) {
  console.error("Falta TV_WEBHOOK_TOKEN en el entorno (revisa .env.local).");
  process.exit(1);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function entryPayload(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "TD_CONF_LON_NY",
    action: "BUY_DUAL",
    symbol: SYMBOL,
    tf: "15",
    type: "LIMIT",
    grade: "ELITE",
    impulse_atr: 2.85,
    price: 4113.257,
    sl: 4106.839,
    partial_1: { lots: 0.01, tp: 4136.605 },
    partial_2: { lots: 0.01, tp: 4154.978 },
    risk_usd: 50.0,
    timestamp: Date.now(),
    ...overrides,
  };
}

async function send(label: string, payload: unknown) {
  const res = await fetch(`${BASE_URL}/api/webhook?token=${TV_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[${label}] HTTP ${res.status} ->`, JSON.stringify(body));
  return body;
}

async function main() {
  console.log("Pessaro Bridge · simulador de señales");
  console.log(`Destino: ${BASE_URL}  ·  símbolo de prueba: ${SYMBOL}\n`);
  if (!BASE_URL.includes("localhost")) {
    console.log(
      "ADVERTENCIA: BRIDGE_BASE_URL no es localhost — esto va a sumar al conteo diario REAL del símbolo.\n",
    );
  }

  await send("1. BUY_DUAL", entryPayload({ action: "BUY_DUAL" }));
  await sleep(50);

  await send("2. SELL_DUAL", entryPayload({ action: "SELL_DUAL", timestamp: Date.now() }));
  await sleep(50);

  await send("3. CANCEL_ALL", {
    account_id: "TD_CONF_LON_NY",
    action: "CANCEL_ALL",
    symbol: SYMBOL,
    tf: "15",
    timestamp: Date.now(),
  });
  await sleep(50);

  console.log(
    "\n-- 4 señales BUY_DUAL seguidas del mismo símbolo (umbral default 3; la 4ª debe llegar con threshold_exceeded=true, nunca suprimida) --",
  );
  let lastPayload = entryPayload();
  for (let i = 0; i < 4; i++) {
    lastPayload = entryPayload({ timestamp: Date.now() + i });
    await send(`4.${i + 1} BUY_DUAL`, lastPayload);
    await sleep(50);
  }

  console.log("\n-- 5. duplicada exacta (mismo symbol+action+timestamp que la señal anterior) --");
  await send("5. duplicada", lastPayload);
  await sleep(50);

  console.log("\n-- 6. señal vieja (timestamp de hace 10 minutos, fuera de la ventana de frescura) --");
  await send("6. vieja", entryPayload({ timestamp: Date.now() - 10 * 60 * 1000 }));

  console.log("\nListo. Revisa /status o la tabla `signals` en Supabase para confirmar los resultados.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
