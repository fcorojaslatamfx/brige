# Pessaro Bridge

**Pessaro Bridge** es el puente (bridge) entre el indicador de TradingView **"TD Confluence Londres Nueva York"** y un Expert Advisor (EA) de **MetaTrader 4**. Recibe las alertas del indicador vía webhook, las audita y enriquece con Supabase, y las entrega al EA por polling para que este **notifique** al trader (alerta sonora, push, panel en el gráfico).

> ⚠️ **No ejecuta trades automáticamente.** Toda decisión de entrar al mercado es manual del trader; el EA solo avisa.

Dominio de producción: **`brige.pessaro.cl`**

## Arquitectura

```
TradingView ──POST──▶ /api/webhook   (valida token + esquema Zod + frescura)
                            │
                      [Supabase]     signals · audit · settings
                            │        conteo autoritativo en tiempo real
                            │
MT4 PessaroBridgeEA ◀──GET /api/signals   (polling · payload enriquecido)
        └──────────────POST /api/ack      (confirmación de notificación)
Navegador ◀──────────── /status           (panel de monitoreo, protegido por token)
```

Cada señal trae, sobrescritos por Supabase, `current_symbol_count`, `current_global_count` y `threshold_exceeded` — los umbrales diarios (por símbolo y globales) son informativos y editables en caliente desde `/status` (vía `/api/settings`), sin bloquear ninguna señal técnicamente válida.

## Stack tecnológico

- **Next.js 15** (App Router) + **React 19** + **TypeScript** — hosting y cron en **Vercel**.
- **Supabase** (Postgres) — cola de señales, auditoría y configuración de umbrales.
- **Zod** — validación del contrato JSON del webhook.
- **MQL4** — Expert Advisor para MetaTrader 4 (no se compila ni corre en este repo, ver más abajo).
- **Vitest** — pruebas unitarias y de integración.

## Estructura de carpetas clave

| Carpeta / archivo | Contenido |
|---|---|
| `app/api/webhook/` | Recibe la alerta de TradingView (token + esquema + frescura + dedup). |
| `app/api/signals/` | El EA hace polling aquí para reclamar señales pendientes. |
| `app/api/ack/` | El EA confirma que ya notificó una señal. |
| `app/api/settings/` | GET/PUT de los umbrales editables (protegido con `OPERATOR_TOKEN`). |
| `app/api/status/` | Datos que alimenta el panel `/status`. |
| `app/api/cron/cleanup/` | Job diario (Vercel Cron) de limpieza/compactado de auditoría. |
| `app/status/` | Panel de monitoreo con identidad Pessaro Capital. |
| `lib/schema.ts` | Esquemas Zod del contrato JSON (webhook, ack, settings). |
| `lib/supabase.ts` | Cliente de Supabase (service role). |
| `lib/counts.ts` | Lógica de conteo autoritativo por símbolo/global. |
| `mt4/PessaroBridgeEA.mq4` | Expert Advisor MQL4 — notificador, sin `OrderSend`. |
| `supabase/migrations/` | Esquema SQL, ajuste de `search_path` y grants de `service_role` (en orden). |
| `tests/` | Suite Vitest (`rules.test.ts`) y simulador manual (`send-test-signal.ts`). |
| `docs/` | Especificación funcional y memoria histórica del proyecto (ver abajo). |

## Cómo correr en desarrollo

```bash
npm install
npm run dev              # levanta Next.js en http://localhost:3000
npm run send-test-signal # simula señales (BUY, SELL, CANCEL, duplicada, vieja, 4ª del día)
```

## Cómo correr los tests (Vitest)

```bash
npm test
```

Corre dos capas (ver detalle de cada caso en `tests/rules.test.ts`):

- **Unitarias** (sin red): esquema Zod, `isFresh`, `safeTokenEquals`, sobrescritura de conteos autoritativos.
- **De integración** (contra el Supabase real de `.env.local`): ejercitan los route handlers de verdad porque dedup/conteo/flag viven en SQL. Usan símbolos sintéticos que se autolimpian en `afterAll`; si faltan credenciales, esta capa se salta sola.

## Variables de entorno / Supabase

Copiar `.env.example` a `.env.local` y completar:

| Variable | Uso |
|---|---|
| `SUPABASE_URL` | Proyecto Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Ídem (secreta, solo servidor) |
| `SUPABASE_DB_PASSWORD` | Para conexión directa/CLI si hace falta |
| `TV_WEBHOOK_TOKEN` | Token que valida el webhook de TradingView |
| `EA_TOKEN` | Token que valida el polling del EA (distinto del anterior) |
| `OPERATOR_TOKEN` | Protege `/status` y `/api/settings` |
| `CRON_SECRET` | Valida el `Authorization: Bearer` que envía el cron de Vercel |

Generar tokens con `openssl rand -hex 32`.

Migraciones SQL en `supabase/migrations/`, **aplicar en orden**: `001_schema.sql` → `002_function_search_path.sql` → `003_grant_service_role.sql`. La `003` no es opcional: sin ella, `service_role` no tiene permisos sobre `signals`/`audit`/`settings` y todas las rutas API fallan con `permission denied` aunque RLS esté bien configurado.

## Despliegue

Se despliega en **Vercel** (`vercel.json` ya declara el cron diario a `/api/cron/cleanup`, `0 3 * * *`, límite del plan Hobby):

1. Importar el repo en Vercel y configurar las variables de entorno de la tabla anterior.
2. Deploy.
3. Agregar el dominio `brige.pessaro.cl` en Vercel → Domains y crear el CNAME correspondiente en el DNS de `pessaro.cl`.
4. Configurar la alerta de TradingView apuntando a `https://brige.pessaro.cl/api/webhook?token=<TV_WEBHOOK_TOKEN>`.
5. Instalar y configurar `mt4/PessaroBridgeEA.mq4` en el terminal MT4 (compilar en MetaEditor, habilitar WebRequest hacia el dominio, configurar `InpEaToken`, `InpSymbolMap` y `InpBrokerToNyOffsetHours`).

Los pasos detallados (whitelisting de WebRequest, cálculo del offset horario NY↔bróker con fechas de DST, checklist end-to-end, troubleshooting) están en `docs/metaprompt_pessaro_bridge_v3_despachador.md` — no se duplican aquí para no desincronizarse.

## Estado actual / últimas piezas implementadas

Según `git log`, el bridge está **completo** en su modo despachador manual (meta-prompt v3):

1. Esquema SQL, API routes, EA notificador MQL4 (piezas 1–3).
2. Panel `/status` con identidad visual Pessaro Capital (pieza 4).
3. Migración aplicada a Supabase + correcciones post-deploy detectadas en producción.
4. Pruebas Vitest y documentación de despliegue (pieza 5, commit más reciente).

**Pendiente de quien despliega:** compilar el `.mq4` en MetaEditor (no disponible en este entorno de desarrollo), confirmar el CNAME de `brige.pessaro.cl`, cargar las variables de entorno en Vercel, y correr la verificación end-to-end contra producción.

## Documentación

- `docs/metaprompt_pessaro_bridge_v3_despachador.md` — especificación funcional completa del bridge (arquitectura, reglas, despliegue paso a paso, troubleshooting).
- `docs/MEMORIA_PROYECTO.md` — historial de decisiones de todo el sistema Pessaro (indicador TradingView + bridge), incluyendo el contrato JSON vigente y el roadmap general.

## Licencia

Propiedad de Pessaro Capital. Uso interno — no distribuir.
