# MEMORIA DEL PROYECTO · TD CONFLUENCE LONDRES → NUEVA YORK
### Pessaro Capital · Infraestructura de Trading Algorítmico
**Última actualización:** 24 de julio de 2026 · **Versión vigente del indicador:** v1.1 · **Contrato del bridge:** v2.0

> **⚠ Iteración v3.0 del bridge aplicada el 24-jul-2026 (capas DB + bridge).** Ver
> §12 al final de este documento. Falta la parte externa (Pine v2.0 en TradingView,
> EA v2.0 en MT4, limpieza de alertas duplicadas) que no vive en el repo.

> Este documento es la memoria viva del proyecto. Sirve como contexto completo para
> cualquier sesión futura (Claude, Claude Code u otro desarrollador): qué se construyó,
> por qué se tomó cada decisión, qué contratos existen y qué queda pendiente.
> Mantenerlo actualizado con cada cambio relevante.

---

## 1. RESUMEN EJECUTIVO

Sistema de trading algorítmico de Pessaro Capital compuesto por:

1. **Indicador TradingView** ("TD Confluence Londres Nueva York v1.1", Pine Script v6):
   estrategia de pivotes Tom DeMark + retrocesos Fibonacci, multi-instrumento (14 slots),
   ventana operativa continua Londres→NY, impulso adaptativo por ATR, clasificación de
   señales ELITE, doble cupo de trades (símbolo + global) y servidor de webhooks desde
   un solo gráfico.
2. **Pessaro Bridge** (especificado, en desarrollo): puente de webhooks en
   `brige.pessaro.cl` con stack Vercel (Next.js/TypeScript) + Supabase (Postgres) +
   GitHub, que entrega las señales a un EA de MetaTrader 4 vía polling.
3. **Documentación**: manuales interactivos HTML con la identidad de Pessaro Capital
   y meta-prompts de desarrollo.

---

## 2. CRONOLOGÍA Y EVOLUCIÓN DE VERSIONES

| # | Versión | Hito |
|---|---------|------|
| 1 | "Versión Gemini TD Fibo Confluence" (v5, heredado) | Script original de terceros. **No compilaba ni generaba señales** (ver §5, bugs B1–B4). |
| 2 | "Versión Claude Fable TD Fibo Confluence" (v5) | Reescritura correctiva: pivotes TD reales, motor encapsulado en función, dashboard funcional, niveles dibujados. |
| 3 | "— Multi-Instrumento" (v6) | Perfiles automáticos A/B/C por símbolo, escalado por TF (√(min/5)), scanner de 6 símbolos, 3 temas de dashboard. |
| 4 | **"TD Confluence Londres Nueva York"** (v6) | Ventana continua LON→NY (0300–1600 NY), **impulso adaptativo por ATR** (fix definitivo de FX sin señales), Perfil D Índices/Energía, servidor de webhooks de 14 símbolos, contador diario + cooldown, campo `tf` y `risk_usd` en JSON. |
| 5 | **v1.1 (vigente)** | ① Cupo global diario de cartera (capa de envío de webhooks). ② Señales ⭐ ELITE por recorrido ≥ N×ATR, con `grade` e `impulse_atr` en el JSON. ③ Timeframe operativo configurable con rango permitido editable y detección de flanco en alertas. |

---

## 3. ESTADO ACTUAL (23-jul-2026)

- **Indicador v1.1** entregado; la versión LON→NY previa está **validada en producción
  demo** (capturas del 7–9 de julio confirman señales correctas en XAUUSD, XAGUSD, WTI,
  US30, SP500, US2000, UK100, GBPCAD; log "SELL DISPARADO #1 hoy" y watchlist en vivo).
- **Bridge**: construido en Claude Code y desplegado en Vercel (`brige.pessaro.cl`).
  Modo despachador manual completo: webhook, cola Supabase, EA MQL4, panel `/status`,
  tokens gestionables sin redeploy. Detalle vigente en `README.md` del repo del bridge.
- **Dashboard de admin del bridge (completo, en producción)**: login Supabase Auth +
  gestión de usuarios (`user_roles`: `super_admin`/`admin`), invitación por correo vía
  Resend → `/set-password`, más recuperación de contraseña (`/api/auth/forgot-password`)
  y rediseño de `/login` con identidad Pessaro Capital (23-jul-2026). Probado
  end-to-end en producción (invitar → correo → `/set-password` → login); en la prueba
  se encontraron y corrigieron 2 bugs (Supabase Auth Redirect URLs apuntando a
  localhost, y `/set-password` que podía sobreescribir la contraseña de la cuenta
  equivocada si el navegador ya tenía sesión activa). Se comparó con el dashboard de
  `pessaro-crm` y se decidió mantener el modelo simple de 2 roles en vez de los 3
  niveles + perfil de staff extendido que usa el CRM. Detalle completo en `README.md`
  del bridge, sección "Estado actual".
- **JSON v1.1** añade `grade` e `impulse_atr` → el esquema Zod del bridge ya los
  incluye.

---

## 4. CONTRATO JSON VIGENTE (v1.1)

Emitido por `alert()` del indicador; una sola alerta "Any alert() function call" cubre
los 14 slots + símbolo del gráfico (el slot coincidente con el gráfico se excluye para
evitar duplicados).

### Entrada (BUY_DUAL / SELL_DUAL)
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
  "timestamp": 1783267200000
}
```

### Cancelación (CANCEL_ALL)
```json
{ "account_id": "TD_CONF_LON_NY", "action": "CANCEL_ALL", "symbol": "EURJPY", "tf": "15", "timestamp": 1783270800000 }
```

Reglas del contrato:
- `symbol` en formato corto sin prefijo de proveedor.
- `timestamp` en **milisegundos** Unix.
- `lots` son **referenciales**: el EA recalcula con `risk_usd ÷ (dist_SL_pips × valor_pip_real)`, split 60/40.
- `grade` ∈ {ELITE, STANDARD}; `impulse_atr` = recorrido del impulso ÷ ATR(14).
- Cancelaciones **nunca** se suprimen por cupo global; entradas sí.

---

## 5. DECISIONES DE DISEÑO Y APRENDIZAJES CLAVE

### Bugs del script original (referencia histórica)
- **B1** `username` no existe en Pine → no compilaba. Protección real: publicación Invite-Only.
- **B2** TD Points comparaban `low < low` (vela contra sí misma, siempre falso) → cero pivotes. Fix: pivote nivel 2 (`low[2]` vs 2 velas a cada lado), confirmación con 2 velas de retraso (no repinta).
- **B3** Orden de bloques autodestructivo: un Supply completaba el impulso alcista y la línea siguiente lo sobrescribía; un Demand impedía completar bajistas → las ventas nunca disparaban. Fix: primero completar, luego iniciar, con guardas.
- **B4** Variable mutable global en `request.security` → error de compilación. Fix estructural: **motor encapsulado en función autónoma con estado local** (`f_engine`), reutilizable en cualquier contexto security.

### Decisiones estructurales
- **D1 · Impulso adaptativo por ATR** (la decisión más importante): los umbrales fijos
  en pips crearon asimetría fatal — en 15m EURJPY exigía 69.3 pips entre pivotes
  adyacentes (imposible), majors 43.3, mientras el "pip" del oro (0.1) hacía su umbral
  trivial. Resultado: metales/índices disparaban, FX en silencio. Con
  `minImpulso = ATR(14) × 1.2 × ajustePerfil`, cada instrumento exige lo proporcional a
  su volatilidad. **Regla general: umbrales fijos en pips son incompatibles con sistemas
  multi-activo.**
- **D2 · Un gráfico = servidor de watchlist**: `alert()` solo dispara desde el gráfico
  anfitrión, pero `request.security` ejecuta el motor completo por símbolo (el grafo de
  dependencias, incluido `syminfo`, se re-evalúa en el contexto solicitado → la
  autodetección de perfil funciona por slot). 14 slots + correlación + doble motor del
  gráfico ≈ 16 llamadas security (límite Pine: 40). Costo: carga inicial 10–30 s.
- **D3 · Perfiles por instrumento**: A JPY/Metales (fibo 0.786, riesgo 0.5%, ATR×1.15) ·
  B Oceanía (0.618, 1.0%, ×0.90) · C Majors (0.618 — bajado desde 0.705 para tasa de
  llenado, 0.75%, ×1.00) · D Índices/Energía (0.618, 0.5%, ×1.05). Detección por
  ticker/currency; JPY tiene prioridad en cruces.
- **D4 · Doble cupo (v1.1)**: el límite por símbolo vive en el motor; el **global vive en
  la capa de envío de webhooks** porque los contextos security no pueden leer variables
  del gráfico (limitación de Pine). Señal suprimida = registrada, visible, no enviada.
- **D5 · TF operativo (v1.1)**: motor ejecutado vía security en TF elegido. Con TF
  custom: correlación AUD/NZD del gráfico se delega al bridge (no se pueden anidar
  security), triángulos TD del gráfico se ocultan, y las alertas usan **detección de
  flanco** (`senal != senal[1]`) para no repetirse dentro de una vela del TF mayor.
- **D6 · Ventana única LON→NY** (0300–1600 America/New_York) en vez de dos ventanas de
  3h; sombreados visuales de Londres y NY se mantienen solo como referencia.
- **D7 · Stack del bridge**: se descartó Python/FastAPI en VPS a favor de
  **Vercel + Supabase + TypeScript** (stack existente del cliente): HTTPS y deploy
  automáticos, cola en Postgres con claim atómico, cero servidores que mantener.
  Lo único innegociable: el EA es MQL4.

### Limitaciones conocidas (aceptadas y documentadas)
- Los `lots` del JSON usan un valor de pip global → recalculo obligatorio en el EA.
- El filtro de correlación AUD/NZD entre slots de la watchlist no existe en Pine → regla R8 del bridge.
- Pivotes confirmados con 2 velas de retraso (anti-repintado, inherente al método).
- VIX, USDT.D, TOTAL2 no son operables: prohibidos en los slots.

---

## 6. PESSARO BRIDGE — ESPECIFICACIÓN RESUMIDA

**Dominio:** `https://brige.pessaro.cl` (CNAME → Vercel, SSL automático).
**Especificación completa:** `metaprompt_pessaro_bridge_v2_vercel_supabase.md`.

### Arquitectura
```
TradingView ──POST──▶ /api/webhook (Vercel · valida token+Zod+frescura+R8 · inserta)
                           │
                      [Supabase]  signals · audit · daily_stats · RPC claim_signals
                           │
MT4 PessaroBridgeEA ◀──GET /api/signals (polling 1–2 s en ventana, 30 s fuera)
        └──────────── POST /api/ack (tickets o error de OrderSend)
Navegador ◀────────── /status (panel Next.js con identidad Pessaro Capital)
```

### Reglas R1–R10 (síntesis)
R1 tokens separados TV/EA en env vars · R2 frescura 180 s + dedup por índice único
`(symbol, action, ts_signal)` · R3 recalculo de lotes en el EA con MarketInfo · R4 mapeo
símbolo TV→bróker por input del EA · R5 dos órdenes límite (magic 772601/772602,
comentario TD_CONF_LON_NY) · R6 CANCEL_ALL solo pendientes propias del símbolo ·
R7 breakeven de la parcial 2 al ejecutarse TP1 · R8 defensa en profundidad: máx.
diario por símbolo + correlación AUD/NZD en SQL · R9 auditoría total consultable en
/status · R10 polling eficiente cadenciado a la ventana LON→NY con backoff y TTL 5 min.

### Cambio pendiente por v1.1
Esquema Zod del webhook: añadir `grade: z.enum(["ELITE","STANDARD"])` e
`impulse_atr: z.number()`. Oportunidad: política ELITE en el EA (ponderar lote,
priorizar o filtrar) y ranking histórico de calidad en Supabase.

### Criterios de aceptación (10)
Señal test → 2 Buy Limit correctas · duplicada descartada · vieja rechazada ·
4ª del día rechazada · NZDUSD bloqueado con AUDUSD operado · CANCEL_ALL selectivo ·
token inválido = 401 · breakeven < 5 s · TTL de cola respetado · claim atómico sin
doble entrega.

---

## 7. INVENTARIO DE ARTEFACTOS DEL PROYECTO

| Archivo | Descripción |
|---|---|
| `td_confluence_londres_nueva_york_v1_1.pine` | **Indicador vigente** (Pine v6). |
| `td_confluence_londres_nueva_york.pine` | v1.0 LON→NY (histórico). |
| `claude_fable_td_fibo_confluence_multi.pine` | Multi-instrumento 3–15m (histórico). |
| `claude_fable_td_fibo_confluence.pine` | Primera corrección del script Gemini (histórico). |
| `manual_td_confluence_v1_1.html` | **Manual interactivo vigente** (identidad Pessaro Capital: #0c0f1a / dorado #c9a84c / Playfair Display + DM Sans + DM Mono). |
| `manual_td_confluence_londres_nueva_york.html` | Manual v1.0 (histórico). |
| `metaprompt_pessaro_bridge_v2_vercel_supabase.md` | **Meta-prompt vigente del bridge** (Vercel+Supabase+TS+MQL4). |
| `metaprompt_pessaro_bridge.md` | Meta-prompt v1 Python/VPS (descartado, referencia). |
| `MEMORIA_PROYECTO.md` | Este documento. |

**Identidad de marca Pessaro Capital:** fondo `#0c0f1a` (y capas `#141826/#1c2030/#252a3d`),
acento dorado `#c9a84c` (claro `#f0d080`, profundo `#a8862c`), verde `#00d084`, rojo
`#ff4d6d`; tipografías Playfair Display (títulos), DM Sans (cuerpo), DM Mono (código).

---

## 8. PARÁMETROS OPERATIVOS RECOMENDADOS (punto de partida)

- Multiplicador ATR **1.2** (bajar a 1.0 si faltan señales FX; subir a 1.4–1.5 si hay ruido)
- Umbral ELITE **2.0×ATR** (calibrar con la fila "Calidad setup")
- Cupos: **3/día por símbolo · 6/día global** · Cooldown **6 velas** · Expiración **12 velas**
- TF operativo **15m** (= gráfico anfitrión) · Ventana **0300–1600 America/New_York**
- Riesgo por perfil: A/D 0.5% · C 0.75% · B 1.0% · Split parciales **60/40**

## 9. ROADMAP / PENDIENTES

- [x] Construir Pessaro Bridge en Claude Code con el meta-prompt v2 (incluir campos v1.1 en Zod)
- [x] CNAME `brige.pessaro.cl` → Vercel + env vars (SUPABASE_URL, SERVICE_ROLE_KEY, TV_WEBHOOK_TOKEN, EA_TOKEN)
- [x] Dashboard de admin del bridge: probado end-to-end (invitar → email Resend → `/set-password` → login) y commiteado
- [x] Confirmar migración `005_user_roles.sql` aplicada en el Supabase remoto de producción
- [ ] EA `PessaroBridgeEA.mq4`: mapeo de símbolos del bróker real + política ELITE
- [ ] Validación en demo ≥ 1 semana (frecuencia de señales, tasa de llenado del 0.618/0.786, distribución STANDARD/ELITE)
- [ ] Definir política ELITE del EA (ej. +25% lote o "solo ELITE")
- [ ] Publicación Invite-Only del indicador en TradingView (protección de IP)
- [ ] Futuro: port del EA a MQL5; estadísticas de rendimiento por grade en Supabase

---

## 12. ITERACIÓN v3.0 DEL BRIDGE (24-jul-2026)

Corrección de los seis defectos raíz verificados con datos de producción
(meta-prompt `METAPROMPT_PESSARO_BRIDGE_v3.md`). Se implementaron las **capas
que viven en el repo** (base de datos + bridge Next.js + test suite); las capas
externas quedan pendientes (ver "Pendiente" abajo).

### Qué se aplicó

**Contrato v2.0** (`lib/schema.ts`). Se separan dos conceptos que antes
colapsaban en `timestamp`:
- `ts_signal` (= `timenow`, instante real del disparo) → **frescura**.
- `bar_time` (= `time`, apertura de la vela) → **deduplicación**.

Antes, el disparo intrabarra llegaba con `time` (apertura), y contra
`freshness_seconds=180` el 60 % del flujo moría como `stale` (lag hasta 897 s).
Ahora la frescura se mide contra `timestamp` y el dedup contra `bar_time`.
`bar_time` es **opcional**: si no viene (Pine v1.x) cae a `timestamp`, así el
bridge sigue aceptando el payload viejo sin romperse.

Nuevas acciones `SETUP_BUY` / `SETUP_SELL` / `SETUP_CANCEL`: el setup armado
(orden límite pendiente colocable) que antes nunca salía del gráfico. Guardia de
reloj: se rechaza con 400 todo `timestamp` con desfase > 1 h (reloj roto ≠ señal
tardía).

**Umbrales autoritativos** (migración 010, `calc_thresholds`). El bridge es la
única fuente de verdad. Se calculan también para los setups; el bloque
`thresholds` del payload al EA es **obligatorio o se omite entero** — nunca se
manda con ceros (el `0/0` del panel era "contrato incompleto", no "cupo").
Semántica `>=` (se marca al ALCANZAR el umbral). **Nunca suprime** la señal:
`exceeded=true` es un adjetivo, no un verbo.

**Aislamiento del test suite en 3 capas** (defecto 3, el más peligroso: un push
falso al móvil del trader):
1. **DB** (009/011): columnas `origin`/`is_test`/`env` con `NOT NULL`, CHECK de
   coherencia, vista `signals_deliverable` y `claim_signals` que **sólo** ve
   `origin='tradingview' + is_test=false + env='production'`. Imposible por
   construcción que el EA reciba una fila de prueba.
2. **Bridge** (`lib/origin.ts`): `origin` se deriva del **token + `PESSARO_ENV`**,
   jamás del body. `claim_signals_test` (cola de prueba separada) sólo se sirve
   con el token `operator` vía `?include_test=true`, nunca con el del EA.
3. **EA**: cuarentena en el receptor (parte externa, EA v2.0).
   Vitest corre con `PESSARO_ENV='test'` (`tests/setup.ts`) → todo su tráfico es
   `is_test`. Test de regresión crítico añadido (§11.8): una señal `is_test`
   nunca aparece en la cola del EA. **Verificado en producción: 0 fugas.**

**Panel `/status`** (§5.4): embudo de entrega 48 h, latencia por acción con línea
de frescura, aviso EA sin polling, filtro de origen (default `tradingview`, badge
al ver tráfico no-producción). Funciones `delivery_funnel` / `latency_stats`
(migración 012).

**Observabilidad**: `tokens.last_used_at` para `kind='tv_webhook'` se toca en cada
webhook (§1.6). Evento `audit` `expired_in_queue` con segundos en cola y si el EA
polleó durante la espera (§5.5) — para probar que las 39 caducidades eran el
terminal apagado, no el bridge.

### Migraciones aplicadas a producción (`clyhqxzrmakteuraeaau`)

`007_bar_time` · `008_setup_actions` · `009_test_isolation` ·
`010_authoritative_thresholds` · `011_deliverable_view` · `012_status_analytics` ·
`013_lockdown_calc_thresholds`.

- El índice de dedup **antiguo** `ux_signals_dedup_live (symbol, action, ts_signal)`
  se **conserva** junto al nuevo `ux_signals_dedup_bar_time` hasta que el Pine
  v2.0 esté vivo (§3.3 / Fase 6). No eliminar antes.
- `013` cierra una regresión: `calc_thresholds` es `SECURITY DEFINER` y quedaba
  ejecutable por `anon`/`authenticated` vía PostgREST (bypass de RLS). Revocado a
  sólo `service_role`. Advisor de seguridad limpio salvo avisos preexistentes.
- Suite completa: **29/29 verde** (integración real contra Supabase, aislada).

### Pendiente (fuera del repo)

- **Fase 0 higiene**: exportar el Pine vivo de TradingView y commitearlo (el repo
  no tiene `.pine`; TradingView y repo están desincronizados).
- **Pine v2.0** (§4): `timenow`, `bar_time`, eventos de setup, `impulse_atr`
  congelado al armar. **Publicar sólo después** de confirmar que llegan filas con
  `bar_time` poblado (orden §3.3).
- **EA v2.0** `PessaroBridgeEA_v2.mq4` (§7): entregado por separado, no está en el
  repo. Lee `type`, acepta setups, lee `thresholds`, cuarentena `is_test`, panel
  premium. Configurar `InpSymbolMap` contra los símbolos reales del bróker.
- **Alertas TradingView** (§4.5): dejar **una sola** alerta "Any alert()" para
  matar los 60 duplicados. Medir efecto aislado 24 h.
- **Fase 6**: eliminar el índice de dedup antiguo y el fallback `bar_time=timestamp`
  del bridge, sólo cuando ningún payload v1.x siga llegando.

---
*Documento mantenido por Pessaro Capital. Al iniciar una nueva sesión de trabajo sobre
este proyecto, compartir este archivo como contexto inicial.*
