# brige

**Pessaro Bridge** — backend intermedio (bridge/puente) diseñado para recibir alertas y señales en tiempo real desde el indicador de TradingView **"TD Confluence Londres Nueva York"** y entregarlas, ya auditadas y enriquecidas, a un Expert Advisor (EA) de MetaTrader 4 que actúa como **despachador y notificador**.

> ⚠️ **El sistema no ejecuta trades automáticamente.** El EA solo notifica al trader (alerta sonora, push y panel en el gráfico); toda decisión de ejecución es manual.

Dominio de producción: **`brige.pessaro.cl`**

---

## Arquitectura

```
TradingView ──POST──▶ /api/webhook   (Vercel · valida token + esquema + frescura)
                            │
                      [Supabase]     signals · audit · settings (umbrales editables)
                            │        conteo autoritativo en tiempo real
                            │
MT4 PessaroBridgeEA ◀──GET /api/signals   (polling · payload enriquecido)
        └──────────────POST /api/ack      (confirmación de notificación)
Navegador ◀──────────── /status           (panel de monitoreo)
```

**Stack:** Next.js (App Router) + TypeScript · Vercel (hosting + cron) · Supabase (Postgres) · MQL4 (EA).

---

## Principios de diseño

1. **Cero ejecución automática.** El EA nunca envía `OrderSend`. Solo notifica.
2. **Cero supresión de señales.** El bridge procesa el 100% de las alertas válidas. Ningún límite de conteo bloquea una señal — solo se rechaza lo técnicamente inválido (token, esquema, duplicado, antigüedad).
3. **Umbrales de Control Manual.** Los límites diarios (por símbolo y globales) son guías informativas del mapa operativo del trader, editables sin redeploy vía `/api/settings`.
4. **Conteo autoritativo.** Supabase cuenta las señales del día en tiempo real y sobreescribe los conteos que trae el JSON de origen antes de entregar al EA. Cada payload incluye `current_symbol_count`, `current_global_count` y `threshold_exceeded`.

---

## Contrato JSON (emitido por el indicador Pine v6)

```json
{
  "account_id": "TD_CONF_LON_NY",
  "action": "BUY_DUAL",
  "symbol": "XAUUSD",
  "tf": "15",
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

`action` puede ser `BUY_DUAL`, `SELL_DUAL` o `CANCEL_ALL`. Ver especificación completa en `docs/`.

---

## Configuración del EA · ventana horaria y ajuste de DST

El EA (`mt4/PessaroBridgeEA.mq4`) solo debe estar "activo" (polling cada 1-2 s)
dentro de la ventana operativa **03:00–16:00 hora de Nueva York**. Fuera de esa
ventana hace polling cada 30 s. El problema: **MT4 no tiene base de datos de
zonas horarias** — solo conoce la hora del servidor del bróker. Por eso la
ventana se calcula con un input manual:

```
input int InpBrokerToNyOffsetHours = -7;   // mt4/PessaroBridgeEA.mq4, línea ~29
```

Este valor son las horas que hay que **sumar** a la hora del servidor del
bróker para obtener la hora de Nueva York (`IsInActiveWindow()` en el EA hace
`nyHour = (brokerHour + InpBrokerToNyOffsetHours) mod 24`).

### Cómo calcularlo

```
InpBrokerToNyOffsetHours = (offset UTC de Nueva York) − (offset UTC del servidor del bróker)
```

1. **Offset UTC del servidor del bróker**: no lo asume el EA. Revísalo en
   MT4 (hora que muestra la ventana "Mercado" / el Journal al conectar) o
   pregúntale al bróker. La mayoría de los brokers MT4 corren en **UTC+2
   (EET, invierno) / UTC+3 (EEST, verano)**, pero varía — no lo des por
   sentado.
2. **Offset UTC de Nueva York**: **UTC−5 (EST)** en horario estándar,
   **UTC−4 (EDT)** en horario de verano (ver fechas abajo).
3. Resta ambos. Ejemplo con un bróker en UTC+2 (EET, sin DST propio):
   - NY en EDT (UTC−4): `InpBrokerToNyOffsetHours = -4 - 2 = -6`
   - NY en EST (UTC−5): `InpBrokerToNyOffsetHours = -5 - 2 = -7`

### Fechas de DST a vigilar (recalcular el input cuando cambien)

Hay **dos relojes independientes** que pueden moverse en fechas distintas:
el horario de verano de EE.UU. (afecta el offset de Nueva York) y el horario
de verano del servidor del bróker (si aplica; muchos brokers siguen el
calendario europeo, que no coincide exactamente con el de EE.UU.).

| Fecha | Evento | Acción |
|---|---|---|
| **domingo 25-oct-2026** | Fin DST Unión Europea (servidores en horario europeo vuelven a invierno) | Si tu bróker sigue el calendario europeo, su offset UTC baja 1h → recalcula `InpBrokerToNyOffsetHours` |
| **domingo 1-nov-2026, 02:00 NY** | Fin DST EE.UU. (Nueva York pasa de EDT a EST) | Recalcula: el offset de NY baja de −4 a −5 |
| **domingo 14-mar-2027, 02:00 NY** | Inicio DST EE.UU. (Nueva York pasa de EST a EDT) | Recalcula: el offset de NY sube de −5 a −4 |
| **domingo 28-mar-2027** | Inicio DST Unión Europea | Si tu bróker sigue el calendario europeo, su offset UTC sube 1h → recalcula |

⚠️ Entre el fin del DST europeo y el fin del DST de EE.UU. (este año: **25-oct
al 1-nov-2026**, una ventana de ~1 semana) los dos relojes están
desincronizados — revisa el offset **dos veces** en ese período, no una sola.

Estas son las próximas transiciones conocidas al momento de escribir esto;
más adelante hay que verificar el calendario oficial de DST de EE.UU. (regla:
2.º domingo de marzo → 1.er domingo de noviembre) y el calendario específico
de tu bróker (que puede no seguir ni el europeo ni el americano — confírmalo
con soporte del bróker).

**Recomendación operativa:** el trader/operador debe revisar el valor de
`InpBrokerToNyOffsetHours` en el calendario de arriba y, si hace falta,
editarlo en las propiedades del EA en MT4 (no requiere recompilar) al
comienzo de cada ventana de cambio de horario.

---

## Despliegue

### 1. Supabase

1. Crear un proyecto Supabase (o usar el existente).
2. Aplicar las migraciones **en orden** — `supabase/migrations/001_schema.sql`,
   `002_function_search_path.sql`, `003_grant_service_role.sql` — desde el
   SQL Editor del dashboard, o con la CLI de Supabase (`supabase db push`) si
   tienes el proyecto vinculado localmente.
3. Copiar `Project Settings → API → Project URL` y `service_role` key — son
   `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.

⚠️ La `003` no es opcional: sin ella, `service_role` no tiene
`SELECT/INSERT/UPDATE/DELETE` sobre `settings`/`signals`/`audit` (los
privilegios por defecto del proyecto no se los otorgan) y **todas** las
rutas API fallan con `permission denied for table X` aunque RLS esté bien
configurado. Es un hallazgo real de este proyecto, no una precaución teórica.

### 2. Vercel

1. Importar el repo de GitHub en Vercel.
2. Configurar las variables de entorno (Project Settings → Environment
   Variables) — ver `.env.example`:

   | Variable | De dónde sale |
   |---|---|
   | `SUPABASE_URL` | Supabase → Project Settings → API |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (secreta, solo servidor) |
   | `TV_WEBHOOK_TOKEN` | Generar: `openssl rand -hex 32` |
   | `EA_TOKEN` | Generar: `openssl rand -hex 32` (**distinto** del anterior) |
   | `OPERATOR_TOKEN` | Generar: `openssl rand -hex 32` — protege `/status` y `/api/settings` |
   | `CRON_SECRET` | Generar: `openssl rand -hex 32` — Vercel lo manda como `Authorization: Bearer` al cron |

3. Deploy. `vercel.json` ya declara el cron diario a `/api/cron/cleanup`
   (plan Hobby = 1x/día; en plan Pro se puede subir la frecuencia editando
   el `schedule`).
4. Dominio: agregar `brige.pessaro.cl` en Vercel → Domains, y crear el CNAME
   correspondiente en el DNS del dominio `pessaro.cl` apuntando al valor que
   Vercel indique. SSL es automático.

### 3. TradingView — configurar la alerta

1. Abrir el indicador **"TD Confluence Londres Nueva York v1.2"** en el
   gráfico anfitrión (el que sirve los 14 slots de la watchlist).
2. Crear una alerta nueva: **Condition** → el indicador → **"Any alert()
   function call"** (una sola alerta cubre todos los slots; el propio script
   arma el JSON de cada señal).
3. En **Notifications**, activar **"Webhook URL"** y pegar:
   ```
   https://brige.pessaro.cl/api/webhook?token=<TV_WEBHOOK_TOKEN>
   ```
4. Dejar el **Message** con el valor por defecto de Pine (`{{strategy.order.alert_message}}`
   o el que el script use internamente) — no reescribir el JSON a mano, el
   contrato del §2 lo genera el indicador.
5. Expiration: sin expiración (o revisar periódicamente que siga activa —
   TradingView desactiva alertas tras cierto tiempo según el plan).

### 4. MT4 — instalar y configurar el EA

1. Copiar `mt4/PessaroBridgeEA.mq4` a la carpeta `MQL4/Experts` del
   terminal (Archivo → Abrir carpeta de datos) y **compilarlo en
   MetaEditor** (F7) — este entorno de desarrollo no tiene MetaEditor, así
   que la compilación real queda pendiente de hacer ahí antes de producción.
2. **Habilitar WebRequest** (obligatorio, si no el EA no puede hacer polling):
   Herramientas → Opciones → Expert Advisors → marcar *"Permitir WebRequest
   para las URL siguientes"* → agregar `https://brige.pessaro.cl`.
3. Adjuntar el EA a un gráfico. En la pestaña **Common** del diálogo de
   propiedades, confirmar que *"Allow WebRequest for listed URL"* también
   esté marcado ahí (además del paso 2 — MT4 lo pide en ambos lugares).
4. Configurar los inputs clave:
   - `InpBridgeBaseUrl` → `https://brige.pessaro.cl`
   - `InpEaToken` → el mismo valor que `EA_TOKEN` en Vercel
   - `InpSymbolMap` → mapeo de símbolos TV→bróker, p.ej.
     `XAUUSD=GOLD,US500=SPX500,EURJPY=EURJPYm`
   - `InpBrokerToNyOffsetHours` → ver la sección de arriba
     ["Configuración del EA · ventana horaria y ajuste de DST"](#configuración-del-ea--ventana-horaria-y-ajuste-de-dst)
5. Habilitar notificaciones push: Terminal → Opciones → Notificaciones →
   configurar el **MetaQuotes ID** de tu móvil (el EA usa `SendNotification()`,
   no funciona sin esto).
6. Confirmar que **"Algo Trading"/"AutoTrading"** esté activo en la barra de
   herramientas — lo necesita el EA para correr `OnTimer()`, aunque nunca
   envíe órdenes.

### 5. Verificación end-to-end

```bash
# contra un servidor local
npm run dev
npm run send-test-signal

# contra producción (usa el TV_WEBHOOK_TOKEN real — ver advertencia en el script)
BRIDGE_BASE_URL=https://brige.pessaro.cl npm run send-test-signal
```

Revisar `https://brige.pessaro.cl/status` (con el `OPERATOR_TOKEN`) y
confirmar en MT4 que llegaron el `Alert()`, la notificación push y las
filas en el panel del gráfico.

---

## Pruebas

```bash
npm test                 # Vitest: Zod, frescura, tokens, y reglas de negocio
                          # (dedup/conteo/flag) contra el Supabase de .env.local
npm run send-test-signal # simulador manual vía HTTP: BUY, SELL, CANCEL,
                          # 4ª señal del día, duplicada y vieja
```

`npm test` corre dos capas:

- **Unitarias** (sin red): esquema Zod del contrato, `isFresh`,
  `safeTokenEquals`, y que `toEaPayload` sobreescriba con los conteos
  autoritativos aunque `origin_*` traiga otro valor.
- **De integración** (contra el Supabase real de `.env.local`): llaman a los
  route handlers de verdad porque dedup/conteo/flag viven en SQL (el trigger
  y `contar_dia`), no hay forma fiel de probarlos solo en JS. Usan símbolos
  sintéticos (`TESTSUITE<timestamp>_...`) que ningún instrumento real usa y
  se autolimpian en `afterAll` — pero sí escriben en la base mientras corren.
  Si faltan credenciales en el entorno, esta capa se salta sola
  (`describe.skipIf`).

---

## Troubleshooting

| Síntoma | Causa probable | Qué revisar |
|---|---|---|
| El EA no hace polling / log dice `WebRequest error` | La URL no está en la whitelist de MT4 | Herramientas → Opciones → Expert Advisors, y la pestaña Common del EA (ver §4 arriba) |
| `401` en cualquier endpoint | Token mal copiado entre Vercel y el consumidor | Comparar carácter a carácter `TV_WEBHOOK_TOKEN`/`EA_TOKEN`/`OPERATOR_TOKEN` en Vercel vs. la alerta de TradingView / inputs del EA / URL del panel |
| Push no llega al móvil | MetaQuotes ID no configurado, o notificaciones apagadas en la app MT4 | Terminal → Opciones → Notificaciones; confirmar que la app móvil tiene push habilitado |
| `/status` muestra "EA OFFLINE" con el EA corriendo | El EA no está reclamando señales (`claimed_at` no avanza) | Revisar el log de Expertos en MT4 por errores de `WebRequest`/token; confirmar `InpEaToken` |
| Señales no llegan aunque TradingView dispara la alerta | Alerta mal configurada o rechazada por el bridge | Revisar el historial de alertas en TradingView (🔔 → History); revisar `recent_audit` en `/status` por `invalid_token`/`invalid_payload`/`stale_rejected` |
| `permission denied for table X` en cualquier ruta | Falta la migración `003_grant_service_role.sql` | Confirmarla aplicada en Supabase (`list_migrations` o SQL Editor) |
| El cron de limpieza no corre nunca | Plan Hobby de Vercel = crons 1x/día | Es esperado — por eso `claim_signals` expira señales vencidas en tiempo real en cada poll (no depende del cron); el cron es solo el respaldo diario + compactado de `audit` |
| Umbral editado en `/status` no surte efecto | El operador no tiene el token correcto, o el PUT falló silenciosamente | Revisar la consola del navegador / respuesta del `fetch` a `/api/settings`; confirmar `OPERATOR_TOKEN` |

---

## Estado del proyecto

✅ Completo según el meta-prompt v3 (modo despachador manual): esquema SQL
aplicado en Supabase, API routes, EA notificador (MQL4), panel `/status` con
identidad Pessaro Capital, y pruebas (Vitest + simulador manual).

**Pendiente de quien despliega:** compilar el `.mq4` en MetaEditor (no
disponible en este entorno de desarrollo), configurar el CNAME de
`brige.pessaro.cl`, cargar las variables de entorno en Vercel, y correr la
verificación end-to-end del §5 de Despliegue contra producción.

## Documentación

- `docs/metaprompt_pessaro_bridge_v3_despachador.md` — especificación funcional completa para el desarrollo del bridge.
- `docs/MEMORIA_PROYECTO.md` — historial de decisiones de todo el sistema (indicador + bridge).

## Licencia

Propiedad de Pessaro Capital. Uso interno — no distribuir.
