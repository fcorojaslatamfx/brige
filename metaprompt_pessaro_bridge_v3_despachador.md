# META-PROMPT v3 · PESSARO BRIDGE — MODO DESPACHADOR MANUAL
## TradingView (TD Confluence Londres → Nueva York v1.2) → Vercel + Supabase → MetaTrader 4
### Paradigma: el sistema NO ejecuta trades. Notifica; el trader decide.

> **Uso:** copia desde "── INICIO DEL PROMPT ──" hasta el final y pégalo como primer
> mensaje en Claude Code. Reemplaza antes los valores `<<...>>`.
> Reemplaza por completo al meta-prompt v2 (que describía el modo auto-ejecutor).
> Dominio de producción: **https://brige.pessaro.cl** (Vercel, SSL automático).

──────────────────────────── INICIO DEL PROMPT ────────────────────────────

Actúa como un desarrollador senior full-stack especializado en infraestructura de trading, experto en TypeScript, Next.js (App Router) sobre Vercel, Supabase/Postgres y MQL4. Vas a construir el **"Pessaro Bridge"** en modo **DESPACHADOR MANUAL**: recibe los webhooks JSON del indicador **"TD Confluence Londres Nueva York v1.2"** (Pine v6, TradingView), los audita y enriquece, y los entrega a un EA de **MetaTrader 4 que únicamente NOTIFICA al trader** — la ejecución de cada operación es decisión manual del humano.

## 0. PRINCIPIOS INNEGOCIABLES (Requerimiento v1.2 del cliente)

1. **Cero ejecución automática.** El EA es despachador/notificador. Prohibido `OrderSend`, `OrderModify` u `OrderDelete` automáticos en el flujo normal.
2. **Cero supresión y cero rechazo por límites.** El bridge registra y procesa el **100% de las alertas** válidas. Ningún límite de conteo, umbral o correlación puede descartar una señal. (Solo se rechaza lo técnicamente inválido: token incorrecto, JSON malformado, duplicado exacto, o señal más vieja que la ventana de frescura.)
3. **Umbrales de Control Manual.** Los antiguos "cupos" (3/símbolo, 6/global) son guías informativas del mapa operativo diario del trader, editables sin redeploy.
4. **Conteo autoritativo inyectado.** Supabase cuenta en tiempo real las señales del día (por símbolo y globales) y el bridge **inyecta/sobreescribe** en cada payload entregado al EA: `current_symbol_count`, `current_global_count`, `symbol_threshold`, `global_threshold` y `threshold_exceeded`. Los conteos que trae el JSON de Pine son best-effort (se reinician si se recarga el script): se registran para auditoría de discrepancias, pero **la verdad es la de Supabase**.
5. **`threshold_exceeded: true`** cuando cualquiera de los conteos autoritativos SUPERA su umbral — advertencia visual para el trader, jamás un bloqueo.

Stack obligatorio: **Vercel** (`brige.pessaro.cl`) · **Supabase** · **GitHub** (deploy continuo) · **MQL4** (única pieza no-TypeScript).

Trabaja incremental: ① esquema SQL, ② API routes, ③ EA notificador, ④ panel /status, ⑤ pruebas y README.

---

## 1. ARQUITECTURA

```
TradingView ──POST──▶ /api/webhook  (valida token+Zod+frescura · inserta · NUNCA rechaza por límites)
                            │
                      [Supabase]  signals · audit · daily_counts · settings (umbrales editables)
                            │     RPC claim_signals (atómico) · vista de conteos del día
                            │
MT4 PessaroBridgeEA ◀──GET /api/signals  (polling · payload ENRIQUECIDO con conteos autoritativos)
        └──────────────POST /api/ack     (estado notified / error)
Navegador ◀──────────── /status          (panel Pessaro Capital · señales sobre umbral en ámbar)
```

- `/api/webhook` responde 200 en < 3 s (exigencia TradingView); trabajo pesado fuera del camino crítico.
- Claim atómico en Postgres: cada señal se entrega al EA exactamente una vez.
- Sin estado en Vercel; service role key solo en env vars del servidor.

---

## 2. CONTRATO JSON DE ENTRADA (lo emite el indicador v1.2 — no modificar)

### Señal (BUY_DUAL / SELL_DUAL)
```json
{
  "account_id": "TD_CONF_LON_NY",
  "action": "BUY_DUAL",
  "symbol": "XAUUSD",
  "tf": "15",
  "type": "LIMIT",
  "grade": "ELITE",
  "impulse_atr": 2.85,
  "price": 4113.257,
  "sl": 4106.839,
  "partial_1": { "lots": 0.01, "tp": 4136.605 },
  "partial_2": { "lots": 0.01, "tp": 4154.978 },
  "risk_usd": 50.0,
  "current_symbol_count": 4,
  "symbol_threshold": 3,
  "current_global_count": 7,
  "global_threshold": 6,
  "threshold_exceeded": true,
  "timestamp": 1783267200000
}
```

### Cancelación
```json
{ "account_id": "TD_CONF_LON_NY", "action": "CANCEL_ALL", "symbol": "EURJPY", "tf": "15", "timestamp": 1783270800000 }
```

Notas: `symbol` sin prefijo de proveedor; `timestamp` en **milisegundos**; `lots` = sugerencia
(el EA muestra el lote recalculado, no lo ejecuta); `grade` ∈ {ELITE, STANDARD};
los campos de conteo/umbral/flag de Pine son **best-effort** → validar como opcionales en Zod,
guardarlos como `origin_*` para auditoría, y recalcular los definitivos en Supabase.
Instrumentos posibles: XAUUSD, XAGUSD, USOIL, US30, US500, US100, DE40, UK100, EURJPY,
GBPUSD, EURUSD, AUDUSD, NZDUSD, GBPCAD (ampliable).

---

## 3. ESQUEMA SUPABASE (migración SQL como entregable)

- **`settings`** (una fila, editable sin redeploy): `symbol_threshold` (default 3),
  `global_threshold` (default 6), `freshness_seconds` (180), `queue_ttl_seconds` (300).
  Es el "mapa operativo diario" del operador.
- **`signals`**: id, raw jsonb, action, symbol, tf, grade, impulse_atr, price, sl, tp1, tp2,
  lots1, lots2, risk_usd, ts_signal (ms), origin_symbol_count, origin_global_count,
  origin_threshold_exceeded, **auth_symbol_count, auth_global_count, auth_threshold_exceeded**
  (calculados por el bridge), status (`pending`→`claimed`→`notified` | `rejected_technical` |
  `expired`), claimed_at, notified_at, error, created_at.
  Índice único de deduplicación `(symbol, action, ts_signal)`.
- **`audit`**: registro inmutable de todo evento, incluyendo discrepancias
  origin_count vs auth_count y cada señal sobre umbral.
- **Conteo autoritativo**: función SQL `contar_dia(p_symbol text)` → señales de entrada del
  día de mercado actual para el símbolo y globales, calculadas sobre `signals`
  (acciones BUY_DUAL/SELL_DUAL no rechazadas técnicamente). Al insertar cada señal, un
  trigger o la ruta calcula y persiste `auth_*` con los umbrales vigentes de `settings`:
  `auth_threshold_exceeded = auth_symbol_count > symbol_threshold OR auth_global_count > global_threshold`.
- **RPC `claim_signals(p_max int)`**: entrega señales `pending` frescas marcándolas
  `claimed` en una transacción (claim atómico).
- RLS activado; acceso solo vía service role desde Vercel.
- **Vercel Cron** diario: expira señales viejas en cola y compacta auditoría > 90 días.

---

## 4. API ROUTES (Next.js App Router · TypeScript estricto · Zod)

| Ruta | Método | Función |
|---|---|---|
| `/api/webhook` | POST | Ingesta TradingView. Token por `?token=`. Zod contra el contrato §2 (campos de conteo opcionales). Frescura y dedup técnica. Calcula y persiste conteos autoritativos + flag. **Nunca rechaza por límites/umbrales/correlación.** |
| `/api/signals` | GET | Polling del EA (token propio `EA_TOKEN`). Claim atómico. Devuelve el payload **enriquecido**: conteos autoritativos y flag sobreescriben los de origen. Formato JSON plano fácil de parsear en MQL4. |
| `/api/ack` | POST | El EA confirma `notified` (o reporta error de notificación). |
| `/api/settings` | GET/PUT | Leer/editar umbrales del mapa operativo (token de operador). PUT audita el cambio. |
| `/api/status` | GET | Salud: pendientes, últimas 50 de auditoría, conteos del día por símbolo y global, % de señales sobre umbral, latencia del último poll. |
| `/status` | página | Panel Next.js con identidad Pessaro Capital (fondo #0c0f1a, dorado #c9a84c, Playfair Display + DM Sans + DM Mono): tabla de señales en vivo con **filas en ámbar cuando threshold_exceeded**, contadores del día vs umbrales, estado del EA (verde si último poll < 10 s), editor de umbrales. Refresco 5 s. Protegido. |

---

## 5. EA `PessaroBridgeEA.mq4` — MODO NOTIFICADOR

- Polling `GET /api/signals` cada 1–2 s dentro de la ventana LON→NY (03:00–16:00 NY,
  input configurable) y cada 30 s fuera; backoff ante fallos; al reconectar solo procesa
  señales frescas (TTL de `settings`) y reporta las vencidas.
- Por cada señal de entrada, **notifica por tres canales**:
  1. `Alert()` sonoro con resumen: `⚠️ [ELITE] BUY XAUUSD @ 4113.257 · SL 4106.839 · TP 4136.605/4154.978 · 4/3 símbolo · 7/6 global`
     (el prefijo ⚠️ solo si `threshold_exceeded`).
  2. `SendNotification()` push al móvil MT4 con el mismo resumen.
  3. **Panel en el gráfico** (objetos): cola de señales recientes con símbolo, dirección,
     grade (⭐), niveles, **lote sugerido recalculado** = `risk_usd ÷ (dist_SL_pips ×
     valor_pip_real vía MarketInfo)` split 60/40 respetando MINLOT/LOTSTEP, conteos
     autoritativos y ⚠️ en ámbar/dorado si excede umbral.
- Opcional (input on/off): dibujar líneas de ENTRADA/SL/TP en el chart del símbolo si está abierto.
- `CANCEL_ALL` → notificación "Setup de {symbol} expirado — descarta la señal previa" y
  marca visual en el panel. Sin tocar órdenes.
- Mapeo símbolo TV→bróker por input string (`XAUUSD=GOLD,US500=SPX500,...`); símbolo sin
  mapeo → notifica igualmente con el nombre TV y reporta el gap vía `/api/ack`.
- **Sin OrderSend.** Deja el código estructurado para que un futuro "modo auto" sea un
  módulo aparte activable explícitamente (no lo implementes ahora).

---

## 6. ENTREGABLES

```
pessaro-bridge/
├── supabase/migrations/001_schema.sql   # tablas, settings, índices, RLS, RPC, conteo autoritativo
├── app/
│   ├── api/webhook/route.ts
│   ├── api/signals/route.ts
│   ├── api/ack/route.ts
│   ├── api/settings/route.ts
│   ├── api/status/route.ts
│   └── status/page.tsx                  # panel con identidad Pessaro Capital
├── lib/ (supabase.ts · schema.ts · counts.ts)
├── mt4/PessaroBridgeEA.mq4              # notificador: Alert + push + panel + lote sugerido
├── tests/
│   ├── rules.test.ts                    # Vitest: Zod, frescura, dedup, conteo, flag
│   └── send-test-signal.ts              # simula: BUY, SELL, CANCEL, 4ª del día, duplicada, vieja
├── vercel.json                          # cron de limpieza
├── .env.example
└── README.md                            # despliegue + WebRequest MT4 + alerta TradingView + troubleshooting
```

---

## 7. CRITERIOS DE ACEPTACIÓN

1. BUY_DUAL válido → notificación en MT4 (Alert + push + panel) con niveles y lote sugerido; en `/status`, estado `notified`.
2. **4ª señal del día del mismo símbolo (umbral 3) → SE ENTREGA** con `auth_symbol_count=4` y `threshold_exceeded=true`; el panel del EA y /status la muestran en ámbar. Nada se suprime.
3. **7ª señal global del día (umbral 6) → SE ENTREGA** flaggeada; el conteo global autoritativo es correcto aunque Pine reporte otro valor (la discrepancia queda en `audit`).
4. Señal con conteos de Pine desincronizados (p.ej. script recargado, `current_global_count=1` real 7) → payload al EA lleva los valores de Supabase; discrepancia auditada.
5. Cambiar umbrales vía `/api/settings` (o el editor de /status) surte efecto en la siguiente señal sin redeploy.
6. La misma señal dos veces → segunda marcada `duplicate` en auditoría (dedup técnica, no de negocio).
7. Señal con timestamp de hace 10 min → `rejected_technical` por frescura.
8. Token inválido en cualquier endpoint → 401 sin registro en `signals`.
9. MT4 cerrado 2 min con señal en cola → al reabrir se notifica; con TTL vencido → `expired` e informada como perdida.
10. Dos polls simultáneos del EA → ninguna señal notificada dos veces (claim atómico).
11. Grep del EA: **cero llamadas a OrderSend/OrderModify/OrderDelete** en el flujo de señales.

Empieza mostrando el plan de archivos y el esquema SQL (incluida la lógica del conteo autoritativo); espera mi confirmación y construye pieza por pieza.

──────────────────────────── FIN DEL PROMPT ────────────────────────────

## Notas para ti (fuera del prompt)

- Reemplaza `<<...>>` no aplica en este v3 salvo los tokens: genera `TV_WEBHOOK_TOKEN` y `EA_TOKEN` (32+ caracteres) y configúralos en Vercel antes del primer deploy.
- **Diferencias clave vs v2:** R5 ejecución → notificación 3 canales; R6 cancelación → aviso; R7 breakeven → suspendida; R8 rechazos → conteo autoritativo + flag; nueva tabla `settings` y endpoint `/api/settings`; estados `executed` → `notified`; criterios de aceptación 2–5 y 11 nuevos.
- Entrega junto con este prompt el archivo `MEMORIA_PROYECTO.md` como contexto: contiene la historia de decisiones (D1–D8) por si la sesión necesita justificar el diseño.
- Si algún día quieres reactivar la auto-ejecución, se hace como módulo explícito nuevo sobre esta misma base — la cola, el conteo y la auditoría no cambian.
