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
Navegador ◀──────────── /status           (panel de monitoreo, login Supabase Auth)
                    ├─── /status/tokens   (ver/regenerar TV_WEBHOOK_TOKEN, EA_TOKEN, OPERATOR_TOKEN)
                    └─── /status/users    (invitar/gestionar usuarios del panel — solo Super Admin)
/api/users/invite ──▶ [Resend] ──▶ email con link de "configurar contraseña" ──▶ /set-password
/api/auth/forgot-password ──▶ [Resend] ──▶ email con link de recuperación ──▶ /set-password
```

Los tres tokens de integración (`tv_webhook`, `ea`, `operator`) viven en la tabla `tokens` de Supabase, no en env vars — se ven y regeneran desde `/status/tokens` sin redeploy. `/api/webhook`, `/api/signals` y `/api/ack` siguen validando un `?token=` estático (TradingView y MT4 no pueden manejar sesión), ahora leído de esa tabla. `/status` y `/api/settings` exigen sesión Supabase Auth (login); `/api/status` y `/api/settings` además aceptan el `OPERATOR_TOKEN` vigente como credencial alterna para scripts externos.

Acceso al dashboard: tener sesión Supabase Auth ya no alcanza — hace falta además una fila en la tabla `user_roles` (`super_admin` o `admin`). Un `super_admin` invita usuarios desde `/status/users`; el invitado recibe un email (vía Resend) con un link de recuperación de Supabase que lo lleva a `/set-password` para definir su propia contraseña — nunca se envían contraseñas en texto plano. Revocar acceso borra la fila de `user_roles` sin tocar la cuenta de Supabase Auth (reversible con solo re-invitar).

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
| `app/api/settings/` | GET/PUT de los umbrales editables (sesión Supabase Auth u `OPERATOR_TOKEN`). |
| `app/api/status/` | Datos que alimenta el panel `/status`. |
| `app/api/tokens/` | GET/regenerate de los tokens de integración (solo sesión, sin fallback). |
| `app/api/users/` | GET (lista), `invite`, `role`, `revoke` — gestión de usuarios, solo `super_admin`. |
| `app/api/cron/cleanup/` | Job diario (Vercel Cron) de limpieza/compactado de auditoría. |
| `app/login/` | Login del dashboard (correo + contraseña, Supabase Auth), identidad visual Pessaro Capital + link "¿Olvidaste tu contraseña?". |
| `app/api/auth/forgot-password/` | Reenvía el link de recuperación de Supabase a cuentas existentes en `user_roles` (público, no crea usuarios, no revela si un correo tiene acceso). |
| `app/set-password/` | Página pública donde un usuario invitado o que recupera su contraseña la define (canjea el token del hash de la URL con `setSession()`). |
| `app/status/` | Panel de monitoreo con identidad Pessaro Capital. |
| `app/status/tokens/` | Ver/copiar/regenerar los tres tokens de integración. |
| `app/status/users/` | Invitar usuarios, cambiar rol, revocar acceso — solo `super_admin`. |
| `middleware.ts` | Protege `/status/*` y `/login` con la sesión de Supabase Auth. |
| `lib/schema.ts` | Esquemas Zod del contrato JSON (webhook, ack, settings, tokens, usuarios). |
| `lib/supabase.ts` | Cliente de Supabase (service role) — signals/settings/audit/tokens/user_roles. |
| `lib/supabase-server.ts` / `lib/supabase-browser.ts` | Clientes Supabase Auth (`@supabase/ssr`) para Route Handlers y componentes de cliente. |
| `lib/tokens.ts` | Lookup/regeneración de tokens desde la tabla `tokens`. |
| `lib/users.ts` | Lookup/gestión de usuarios y roles desde `user_roles` + Supabase Auth Admin API. |
| `lib/email.ts` | Envío de emails (invitación + recuperación de contraseña) vía Resend, con `emailShell()` compartido que agrega el disclaimer legal de Pessaro Capital a todo correo saliente. |
| `lib/pessaro-logo.ts` | Logo de Pessaro Capital embebido en base64 para `/login`. |
| `lib/auth.ts` | Gate dual (sesión con rol vigente u `OPERATOR_TOKEN`) para `/api/status` y `/api/settings`. |
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
| `NEXT_PUBLIC_SUPABASE_URL` | Igual a `SUPABASE_URL`, expuesta al navegador para el login |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key pública (RLS deniega todo a `anon`/`authenticated`, solo sirve para el intercambio de sesión de Auth) |
| `TV_WEBHOOK_TOKEN` / `EA_TOKEN` / `OPERATOR_TOKEN` | Solo para el backfill inicial (`scripts/backfill-tokens.ts`) y bootstrap de tests locales — en runtime la fuente de verdad es la tabla `tokens`, gestionada desde `/status/tokens` |
| `CRON_SECRET` | Valida el `Authorization: Bearer` que envía el cron de Vercel |
| `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` | Solo para el setup inicial (`scripts/create-admin-user.ts`), no se usan en runtime |
| `RESEND_API_KEY` | Envío de emails de invitación (`app/api/users/invite`, `lib/email.ts`) |
| `APP_URL` | Base URL pública para el link de "configurar contraseña" del email de invitación; cae a `https://brige.pessaro.cl` si no está seteada — en local conviene `http://localhost:3000` |

Generar tokens con `openssl rand -hex 32`.

Migraciones SQL en `supabase/migrations/`, **aplicar en orden**: `001_schema.sql` → `002_function_search_path.sql` → `003_grant_service_role.sql` → `004_tokens.sql` → `005_user_roles.sql` → `006_ea_last_poll.sql`. La `003` no es opcional: sin ella, `service_role` no tiene permisos sobre `signals`/`audit`/`settings` y todas las rutas API fallan con `permission denied` aunque RLS esté bien configurado. La `006` agrega `tokens.last_used_at`, el heartbeat que usa `/status` para el badge EA online/offline (independiente de si hay señales pendientes que reclamar).

En el dashboard de Supabase (Authentication → URL Configuration), el **Site URL** y los **Redirect URLs** deben apuntar al dominio real (`https://brige.pessaro.cl/set-password`), no a `localhost` — si quedan apuntando a localhost, los links de invitación/recuperación enviados por correo llevan a los usuarios a una URL inaccesible. Es config del dashboard de Supabase, no del código.

### Setup inicial de admin, tokens y usuarios (una sola vez)

```bash
ADMIN_EMAIL=... ADMIN_INITIAL_PASSWORD=... npx tsx scripts/create-admin-user.ts   # crea el usuario y su fila super_admin en user_roles
npx tsx scripts/backfill-tokens.ts   # siembra tokens desde las env vars, sin repegar nada en TradingView/MT4
```

En el dashboard de Supabase (Authentication → Providers → Email), **desactivar "Allow new user signups"** apenas la anon key quede pública en el frontend — no hay flujo de registro público en la app, los usuarios se crean solo por invitación desde `/status/users`. En Authentication → URL Configuration → Redirect URLs, agregar `https://brige.pessaro.cl/set-password` (y `http://localhost:3000/set-password` para desarrollo) — `generateLink` valida `redirectTo` contra esa lista. Una vez confirmado que `/status/tokens` muestra los tres tokens y que el webhook/EA siguen funcionando, se pueden borrar `TV_WEBHOOK_TOKEN`, `EA_TOKEN` y `OPERATOR_TOKEN` de Vercel.

## Despliegue

Se despliega en **Vercel** (`vercel.json` ya declara el cron diario a `/api/cron/cleanup`, `0 3 * * *`, límite del plan Hobby):

1. Importar el repo en Vercel y configurar las variables de entorno de la tabla anterior.
2. Deploy.
3. Agregar el dominio `brige.pessaro.cl` en Vercel → Domains y crear el CNAME correspondiente en el DNS de `pessaro.cl`.
4. Configurar la alerta de TradingView apuntando a `https://brige.pessaro.cl/api/webhook?token=<TV_WEBHOOK_TOKEN>`.
5. Instalar y configurar `mt4/PessaroBridgeEA.mq4` en el terminal MT4 (compilar en MetaEditor, habilitar WebRequest hacia el dominio, configurar `InpEaToken`, `InpSymbolMap` y `InpBrokerToNyOffsetHours`).

Los pasos detallados (whitelisting de WebRequest, cálculo del offset horario NY↔bróker con fechas de DST, checklist end-to-end, troubleshooting) están en `docs/metaprompt_pessaro_bridge_v3_despachador.md` — no se duplican aquí para no desincronizarse.

## Estado actual / últimas piezas implementadas

Según `git log`, el bridge está **completo y en producción** (`brige.pessaro.cl`) en su modo despachador manual (meta-prompt v3):

1. Esquema SQL, API routes, EA notificador MQL4 (piezas 1–3).
2. Panel `/status` con identidad visual Pessaro Capital (pieza 4).
3. Migración aplicada a Supabase + correcciones post-deploy detectadas en producción.
4. Pruebas Vitest y documentación de despliegue (pieza 5).
5. **Dashboard de admin — login Supabase Auth + gestión de usuarios (pieza 6):** `user_roles` (`super_admin`/`admin`), invitación por correo vía Resend con link de Supabase a `/set-password`, `app/api/users/*` (list/invite/role/revoke) + `app/status/users` (UI, solo `super_admin`). Commiteado (`6efca47`) y desplegado. Probado end-to-end en producción con una cuenta de prueba: invitar → correo real (Resend) → `/set-password` → login, las 4 etapas confirmadas. En la prueba se encontraron y corrigieron 2 bugs: Supabase Auth Site URL/Redirect URLs apuntaban a `localhost` (config del dashboard de Supabase, corregida manualmente) y `/set-password` (`7c05547`) confiaba en la sesión ya activa del navegador en vez de canjear explícitamente el token del link con `setSession()` — podía sobreescribir la contraseña de la cuenta equivocada si el invitador tenía sesión abierta en la misma pestaña. Ya corregido.
6. Fix de heartbeat del EA (`8375fc5`): el badge "EA online/offline" y "último poll" en `/status` dependían de `signals.claimed_at`, que solo avanza si hay una señal pendiente — con la cola vacía (caso normal) marcaba "EA OFFLINE" pese a que el EA autenticaba bien. Se agregó `tokens.last_used_at` (migración `006_ea_last_poll.sql`) como heartbeat real, actualizado en cada `GET /api/signals` con token válido. Fix relacionado (`a1f5d3e`): el cálculo de "hace Ns" en el navegador podía dar negativo por desfase de reloj del cliente; acotado con `Math.max(0, ...)`.
7. **Rediseño de `/login` + recuperar contraseña + disclaimer legal (`581237d`):** `/login` con fondo `public/brige-login.jpg` y logo oficial de Pessaro Capital (mismo tratamiento visual que pessaro.cl), estilos propios en `app/login/login.module.css`. Nuevo flujo "¿Olvidaste tu contraseña?" vía `POST /api/auth/forgot-password` (público, nunca crea usuarios ni revela si un correo tiene acceso, solo reenvía el link a cuentas ya en `user_roles`). `lib/email.ts` centraliza un `emailShell()` que agrega el disclaimer legal obligatorio de Pessaro Capital (riesgo, exención de responsabilidad, RUT/domicilio) a todo correo saliente. Verificado en producción con `fcorojas.fx@gmail.com`.

**Modelo de roles:** se comparó con `pessaro-crm` (repo hermano, 3 roles + tabla de perfil extendido `crm_staff_profiles`) y se decidió **mantener el modelo simple de 2 roles** (`super_admin`/`admin`) en Bridge — solo gestiona acceso al panel, no un CRM con múltiples módulos de equipo.

**Pendiente / a vigilar:**
- Los links de recuperación entregados por email llegaron con el token ya invalidado (`otp_expired`) en 2 intentos vía Gmail, mientras que un link generado directo funcionó a la primera — sugiere que algo en el camino de entrega (Gmail y/o el proxy de Resend) pre-visita el link de un solo uso. No investigado a fondo; si se repite con invitaciones reales, considerar que el email lleve a una página propia con un botón a clickear en vez de un link GET directo al endpoint de Supabase.

## Documentación

- `docs/metaprompt_pessaro_bridge_v3_despachador.md` — especificación funcional completa del bridge (arquitectura, reglas, despliegue paso a paso, troubleshooting).
- `MEMORIA_PROYECTO.md` (raíz del repo) — historial de decisiones de todo el sistema Pessaro (indicador TradingView + bridge), incluyendo el contrato JSON vigente y el roadmap general.

## Licencia

Propiedad de Pessaro Capital. Uso interno — no distribuir.
