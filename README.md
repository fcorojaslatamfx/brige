# Pessaro Bridge

**Pessaro Bridge** es el puente (bridge) entre el indicador de TradingView **"TD Confluence Londres Nueva York"** y un Expert Advisor (EA) de **MetaTrader 4**. Recibe las alertas del indicador vía webhook, las audita y enriquece con Supabase, y las entrega al EA por polling para que este **notifique** al trader (alerta sonora, push, panel en el gráfico).

> ⚠️ **No ejecuta trades automáticamente.** Toda decisión de entrar al mercado es manual del trader; el EA solo avisa.

Dominio de producción: **`brige.pessaro.cl`**

## Arquitectura

```
TradingView ──POST──▶ /api/webhook   (valida token + esquema Zod v2.0 + frescura)
                            │
                      [Supabase]     signals · audit · settings · client_deliveries
                            │        conteo autoritativo en tiempo real
                            │
MT4 PessaroBridgeEA ◀──GET /api/signals   (polling · consumo único · payload enriquecido)
        └──────────────POST /api/ack      (confirmación de notificación)
Cliente ◀──────────────GET /api/signals   (mismo endpoint, token de cliente · difusión)
        └───────────── /portal            (portal de solo lectura, sin login Supabase)
Navegador ◀──────────── /status           (panel de monitoreo, login Supabase Auth)
                    ├─── /status/tokens   (ver/regenerar TV_WEBHOOK_TOKEN, EA_TOKEN, OPERATOR_TOKEN)
                    ├─── /status/users    (invitar/gestionar usuarios del panel — solo Super Admin)
                    └─── /status/clients  (alta/compartir/revocar tokens de cliente)
/api/users/invite ──▶ [Resend] ──▶ email con link de "configurar contraseña" ──▶ /set-password
/api/auth/forgot-password ──▶ [Resend] ──▶ email con link de recuperación ──▶ /set-password
/api/clients/share ──▶ [Resend] ──▶ email con el token de cliente ──▶ /portal
```

Los tres tokens de integración (`tv_webhook`, `ea`, `operator`) viven en la tabla `tokens` de Supabase, no en env vars — se ven y regeneran desde `/status/tokens` sin redeploy. `/api/webhook`, `/api/signals` y `/api/ack` siguen validando un `?token=` estático (TradingView y MT4 no pueden manejar sesión), ahora leído de esa tabla. `/status` y `/api/settings` exigen sesión Supabase Auth (login); `/api/status` y `/api/settings` además aceptan el `OPERATOR_TOKEN` vigente como credencial alterna para scripts externos.

Acceso al dashboard: tener sesión Supabase Auth ya no alcanza — hace falta además una fila en la tabla `user_roles` (`super_admin` o `admin`). Un `super_admin` invita usuarios desde `/status/users`; el invitado recibe un email (vía Resend) con un link de recuperación de Supabase que lo lleva a `/set-password` para definir su propia contraseña — nunca se envían contraseñas en texto plano. Revocar acceso borra la fila de `user_roles` sin tocar la cuenta de Supabase Auth (reversible con solo re-invitar).

Invitar un correo que **ya** tiene acceso reescribe su rol (`upsert`), así que la invitación tiene dos guardarraíles: no se puede cambiar el rol propio desde ahí, ni degradar al último `super_admin`. Si aun así el sistema queda sin ningún `super_admin` vivo, `/status/users` responde 403 y la única salida es fuera de la UI: `npx tsx scripts/set-user-role.ts <correo> super_admin`.

**Tres roles, dos poblaciones distintas.** `super_admin` y `admin` son usuarios internos del panel (`user_roles`); `cliente` no es usuario del panel sino destinatario de señales (`client_tokens`), entra a `/portal` con su token y sin login Supabase. Los dos se dan de alta desde el mismo formulario de **Invitar usuario** (`/status/users`) porque para el operador es el mismo gesto, pero por debajo son caminos distintos: elegir rol `cliente` despliega los campos del cliente y crea su token — **no** crea cuenta en Supabase Auth ni fila en `user_roles`. Por eso `cliente` no está en `roleSchema`: si lo estuviera sería asignable desde `/api/users/role` y chocaría con el CHECK de `user_roles`. La sección **Invitación** (`/status/clients`) hace lo mismo con el formulario completo. Un `super_admin` ve el panel completo; un `admin` es redirigido a `/status/clients` y ve solo los clientes que tiene asignados, sin poder generar ni revocar tokens ni configurar el bridge — las rutas que **configuran** el bridge (`/api/settings` GET+PUT, `/api/status`, `/api/tokens`, `/api/tokens/regenerate`) exigen `super_admin`.

**Entrega de señales: dos colas con semánticas opuestas.** El EA del operador consume la cola (`claim_signals`, consumo único: una señal reclamada sale de la cola). Los clientes reciben por **difusión** (`claim_signals_for_client`): cada cliente recibe cada señal fresca entregable que aún no se le ha entregado, sin consumir la cola del operador. `client_deliveries` lleva una fila por señal × cliente.

Cada señal trae, sobrescritos por Supabase, `current_symbol_count`, `current_global_count` y `threshold_exceeded` — los umbrales diarios (por símbolo y globales) son informativos y editables en caliente desde `/status` (vía `/api/settings`), sin bloquear ninguna señal técnicamente válida. El bridge es la **única fuente de verdad** de esos umbrales: el bloque `thresholds` va completo o se omite entero, nunca en ceros.

**Contrato v2.0:** `ts_signal` (`timenow` de Pine) mide **frescura** y `bar_time` (`time` de la vela) sirve para **dedup** — antes un solo timestamp cumplía ambos fines y se pisaban entre sí. `bar_time` es opcional con fallback mientras Pine v1.x siga vivo. Acciones soportadas: `BUY`/`SELL`/`CANCEL` y `SETUP_BUY`/`SETUP_SELL`/`SETUP_CANCEL`.

**Retención de armados (`setup_hold_seconds`, por defecto 45 s).** Un `SETUP_BUY`/`SETUP_SELL` espera esa ventana antes de ser entregable. Si dentro de ella llega su cancelación, la pareja pasa a `status='suppressed'` y **no llega al terminal**: un setup que se arma y se desarma en segundos nunca tuvo una pendiente colocable, así que notificarlo es solo ruido (dos alertas, dos push y dos filas de panel para un evento que no existió). Los **disparos** (`BUY_DUAL`/`SELL_DUAL`) significan "el precio ya tocó tu nivel" y **nunca se retienen**, aunque sí se suprimen si su cancelación llega mientras siguen en cola. Guardarraíl duro: la cancelación solo se suprime si no queda ninguna entrada **ya despachada y sin cerrar** de ese símbolo — si el trader tiene una pendiente colocada por indicación nuestra, su cancelación se entrega siempre. "Despachada" cuenta tanto la cola del operador (`claimed_at`) como la difusión a clientes (`client_deliveries`). Editable en caliente desde `/status`; `0` desactiva la retención y con ella la supresión.

**Aislamiento del tráfico de prueba (3 capas):** en DB (`origin` / `is_test` / `env` con CHECK de coherencia, vista `signals_deliverable`, `claim_signals` solo producción), en el bridge (`lib/origin.ts` deriva el origen del token + `PESSARO_ENV`; la cola de prueba `claim_signals_test` solo se alcanza con token operator vía `?include_test=true`) y en el EA (externo). Cualquier `PESSARO_ENV` distinto de `production` marca **todo** el tráfico entrante como de prueba y lo excluye de la cola del EA — por eso los previews de Vercel deben tenerlo seteado.

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
| `app/api/users/` | GET (lista), `invite`, `role`, `revoke` — gestión de usuarios internos, solo `super_admin`. |
| `app/api/clients/` | GET (lista), POST (alta), `share`, `revoke` — tokens de cliente. |
| `app/api/portal/` | Datos del portal de cliente, autenticado por token de cliente (no por sesión). |
| `app/api/cron/cleanup/` | Job diario (Vercel Cron) de limpieza/compactado de auditoría. |
| `app/login/` | Login del dashboard (correo + contraseña, Supabase Auth), identidad visual Pessaro Capital + link "¿Olvidaste tu contraseña?". |
| `app/api/auth/forgot-password/` | Reenvía el link de recuperación de Supabase a cuentas existentes en `user_roles` (público, no crea usuarios, no revela si un correo tiene acceso). |
| `app/set-password/` | Página pública donde un usuario invitado o que recupera su contraseña la define (canjea el token del hash de la URL con `setSession()`). |
| `app/status/` | Panel de monitoreo con identidad Pessaro Capital. |
| `app/status/tokens/` | Ver/copiar/regenerar los tres tokens de integración. |
| `app/status/users/` | Invitar usuarios, cambiar rol, revocar acceso — solo `super_admin`. |
| `app/status/clients/` | Alta de cliente (con datos de cuenta de broker), compartir por correo, revocar. |
| `app/portal/` | Portal del cliente: su token, señales, símbolos y reporte. Solo lectura, sin login Supabase. |
| `app/theme.css` | **Única** fuente de tokens de marca (navy / púrpura / dorado, semánticos, timings). Los `.module.css` consumen `var(--…)` y no declaran hexes. |
| `middleware.ts` | Protege `/status/*` y `/login` con la sesión de Supabase Auth. |
| `lib/schema.ts` | Esquemas Zod del contrato JSON (webhook, ack, settings, tokens, usuarios). |
| `lib/supabase.ts` | Cliente de Supabase (service role) — signals/settings/audit/tokens/user_roles. |
| `lib/supabase-server.ts` / `lib/supabase-browser.ts` | Clientes Supabase Auth (`@supabase/ssr`) para Route Handlers y componentes de cliente. |
| `lib/tokens.ts` | Lookup/regeneración de tokens desde la tabla `tokens`. |
| `lib/users.ts` | Lookup/gestión de usuarios y roles desde `user_roles` + Supabase Auth Admin API. |
| `lib/clients.ts` | Tokens de cliente: alta, vigencia, entrega por difusión, reporte del portal. |
| `lib/origin.ts` | Deriva `origin`/`is_test`/`env` del token + `PESSARO_ENV` (aislamiento del tráfico de prueba). |
| `lib/email.ts` | Envío de emails (invitación + recuperación de contraseña) vía Resend, con `emailShell()` compartido que agrega el disclaimer legal de Pessaro Capital a todo correo saliente. |
| `lib/pessaro-logo.ts` | Logo de Pessaro Capital embebido en base64 para `/login`. |
| `lib/auth.ts` | Gate dual (sesión con rol vigente u `OPERATOR_TOKEN`) para `/api/status` y `/api/settings`. |
| `lib/counts.ts` | Lógica de conteo autoritativo por símbolo/global. |
| `mt4/PessaroBridgeEA_v2.mq4` | **Expert Advisor vigente** (contrato v2.0) — notificador, sin `OrderSend`. |
| `mt4/PessaroBridgeEA.mq4` | EA v1.0, superado por el v2.0. Se conserva solo como referencia histórica. |
| `supabase/migrations/` | Esquema SQL — **aplicar en orden**, ver más abajo. |
| `scripts/` | `create-admin-user.ts` y `backfill-tokens.ts` (setup inicial), `set-user-role.ts` (rescate de roles). |
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
| `RESEND_API_KEY` | Envío de emails de invitación y de token de cliente (`lib/email.ts`) |
| `PESSARO_ENV` | `production` solo en el despliegue real. Cualquier otro valor marca **todo** el tráfico entrante como `is_test=true` / `origin='test'` y lo excluye de la cola del EA — setear a `preview`/`local` en previews y desarrollo |
| `APP_URL` | Base URL pública para el link de "configurar contraseña" del email de invitación; cae a `https://brige.pessaro.cl` si no está seteada — en local conviene `http://localhost:3000` |

Generar tokens con `openssl rand -hex 32`.

Migraciones SQL en `supabase/migrations/`, **aplicar en orden `001` → `015`**. Todas están aplicadas en el proyecto de producción.

| Migración | Qué agrega |
|---|---|
| `001_schema.sql` | Esquema base: `signals`, `audit`, `settings`. |
| `002_function_search_path.sql` | Fija `search_path` de las funciones SQL. |
| `003_grant_service_role.sql` | **No es opcional:** sin ella `service_role` no tiene permisos sobre `signals`/`audit`/`settings` y **todas** las rutas API fallan con `permission denied` aunque RLS esté bien configurado. |
| `004_tokens.sql` | Tabla `tokens` — los tres tokens de integración salen de las env vars. |
| `005_user_roles.sql` | `user_roles` (`super_admin`/`admin`). |
| `006_ea_last_poll.sql` | `tokens.last_used_at`: heartbeat real del EA para el badge online/offline, independiente de si hay señales pendientes que reclamar. |
| `007_bar_time.sql` | Separa `bar_time` (dedup) de `ts_signal` (frescura) — contrato v2.0. |
| `008_setup_actions.sql` | Acciones `SETUP_BUY` / `SETUP_SELL` / `SETUP_CANCEL`. |
| `009_test_isolation.sql` | `origin` / `is_test` / `env` + CHECK de coherencia. |
| `010_authoritative_thresholds.sql` | `calc_thresholds`: el bridge como única fuente de verdad de los umbrales. |
| `011_deliverable_view.sql` | Vista `signals_deliverable`; `claim_signals` solo entrega producción. |
| `012_status_analytics.sql` | `delivery_funnel` y `latency_stats` para el panel. |
| `013_lockdown_calc_thresholds.sql` | Cierra una regresión: `calc_thresholds` (SECURITY DEFINER) quedaba ejecutable por `anon` vía PostgREST → revocado a `service_role`. |
| `014_client_tokens.sql` | `client_tokens` + `client_deliveries` + `claim_signals_for_client` (difusión). |
| `015_client_broker_account.sql` | `client_tokens` gana `broker` / `account_type` (`demo`\|`real`) / `account_number` / `broker_server`, `NOT NULL` con backfill `'SIN_DATO'`. |
| `016_ephemeral_setup_suppression.sql` | Retención de armados (`settings.setup_hold_seconds`), estado `suppressed` + `signals.superseded_by`, `suppress_ephemeral_setups()` y `signal_dispatched()`. Los tres claims retienen los `SETUP_*` y suprimen las parejas efímeras; lo suprimido no consume cupo diario. |
| `017_client_first_last_name.sql` | `client_tokens.client_last_name`; `client_name` pasa a ser el nombre de pila. Ambos `NOT NULL` con backfill `'SIN_DATO'`. |

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
5. Instalar y configurar `mt4/PessaroBridgeEA_v2.mq4` en el terminal MT4 (compilar en MetaEditor, habilitar WebRequest hacia el dominio, configurar `InpEaToken`, `InpExpectedAccountId`, `InpSymbolMap` y `InpBrokerToNyOffsetHours`). Si el terminal tiene cargado el v1.0, quitarlo del gráfico antes: los dos EA polleando el mismo token se roban señales entre sí, porque la cola del operador es de consumo único.

Los pasos detallados (whitelisting de WebRequest, cálculo del offset horario NY↔bróker con fechas de DST, checklist end-to-end, troubleshooting) están en `docs/metaprompt_pessaro_bridge_v3_despachador.md` — no se duplican aquí para no desincronizarse.

## Estado actual / últimas piezas implementadas

El bridge está **completo y en producción** (`brige.pessaro.cl`) en su modo despachador manual (meta-prompt v3). El detalle cronológico de cada cambio, con su commit y sus migraciones, está en **`CHANGELOG.md`** — abajo va solo el resumen.

**Ruta de trabajo:** `feature/*` → `staging` → `main` → producción. Vercel despliega preview por rama y producción desde `main`.

1. **Piezas 1–5 del build inicial:** esquema SQL, API routes, EA notificador MQL4, panel `/status` con identidad Pessaro Capital, migración aplicada con correcciones post-deploy, pruebas Vitest y documentación de despliegue.
2. **Dashboard de admin — login Supabase Auth + gestión de usuarios:** `user_roles`, invitación por Resend, `app/api/users/*` + `app/status/users`. Probado end-to-end en producción (invitar → correo real → `/set-password` → login). La prueba destapó un bug crítico ya corregido (`7c05547`): `/set-password` confiaba en la sesión activa del navegador en vez de canjear el token del link con `setSession()`, y podía sobreescribir la contraseña de la cuenta equivocada.
3. **Tokens de integración en base de datos:** se ven y regeneran desde `/status/tokens` sin redeploy.
4. **Fix del heartbeat del EA:** `tokens.last_used_at` como señal real de vida, independiente de si hay señales pendientes que reclamar.
5. **Rediseño de `/login` + recuperar contraseña + disclaimer legal:** flujo público que no crea usuarios ni revela si un correo tiene acceso; `emailShell()` agrega el disclaimer legal de Pessaro Capital a todo correo saliente.
6. **Contrato v2.0 del bridge:** frescura y dedup separados, acciones `SETUP_*`, umbrales autoritativos y aislamiento del tráfico de prueba en 3 capas (migraciones 007–013).
7. **Tokens de cliente + dashboards por rol:** entrega por difusión, portal de cliente, y endurecimiento de las rutas que configuran el bridge a `super_admin` (migración 014).
8. **Unificación UX con pessaro.cl:** `app/theme.css` como única fuente de tokens de marca, con jerarquía semántica de color (púrpura = navegación/CTA, dorado = premium y ELITE).
9. **Datos de cuenta de broker por cliente + filtro por broker en `/status`** (migración 015).
10. **Guardarraíles de rol en la invitación** + `scripts/set-user-role.ts` como rescate por CLI.
11. **EA v2.0 + supresión de setups efímeros** (migración 016): el EA pasa a mostrar el tipo de orden (`BUY LIMIT`/`SELL LIMIT`), procesa y ackea los `SETUP_*`, lee el bloque `thresholds` anidado con fallback plano y escribe `s/d` en vez de `0/0`, pone en cuarentena el tráfico que no sea real, y corrige el estado ONLINE y el reloj de polling. En el bridge, las parejas armado+cancelación resueltas dentro de `setup_hold_seconds` ya no llegan al terminal.
12. **Invitación de clientes con correos + identidad de pessaro.cl en el correo** (migración 017): nombre y apellido obligatorios, aviso por correo al cliente y a todos los super admin en cada alta, rol `cliente` en el formulario de invitar usuario, y los correos con la paleta y el footer legal calcados del sitio. `npx tsx scripts/preview-emails.ts` renderiza los 5 correos a HTML local para revisarlos sin enviar nada ni necesitar `RESEND_API_KEY`.

**Modelo de roles:** se comparó con `pessaro-crm` (repo hermano, 3 roles + tabla de perfil extendido `crm_staff_profiles`) y se decidió mantener el modelo simple en Bridge, que solo gestiona acceso al panel y no un CRM con múltiples módulos de equipo. El rol `cliente` que llegó después no contradice eso: no es un usuario del panel sino un destinatario de señales, y vive en `client_tokens`, no en `user_roles`.

**Pendiente / a vigilar:**
- 🔴 **Pine v2.0 sigue sin publicarse en TradingView, y es la causa raíz de que no haya setups en MT4.** Verificado contra producción el 2026-07-29: `select count(*) from signals where action like 'SETUP%'` da **0** en todo el histórico, ningún payload trae `schema` ni `bar_time`, y `ts_signal = bar_time` (apertura de vela) en las señales más recientes → el indicador vivo es el v1.x. El bridge, la base y el EA v2.0 ya aceptan `SETUP_*`; **nada los emite**. Los pasos exactos están en `docs/PENDIENTE_PINE_v2.md`. Efecto colateral medido del mismo defecto (1-A): 149 señales rechazadas por `stale` y 215 por `duplicate`.
- **Limpieza de alertas duplicadas en TradingView**: hay más de una alerta activa sobre el mismo indicador con "Any alert() function call", y el lote entero se reemite ~9 s después. Hoy lo tapa el índice de dedup; cuando entre Pine v2.0 dejará de taparlo (ver orden de despliegue en `007_bar_time.sql`).
- Hasta que Pine v2.0 esté vivo, `bar_time` sigue siendo opcional con fallback y se conserva el índice de dedup viejo junto al nuevo.
- **Cancelaciones huérfanas** (distinto de las parejas efímeras que ya suprime la migración 016): 43 `CANCEL_ALL` notificadas frente a 134 entradas muertas por `expired`, así que el operador recibe cancelaciones de operaciones que nunca se le notificaron por TTL o terminal apagado, no por ser efímeras. Suprimirlas también es una decisión operativa pendiente de tomar, no un bug.
- Los links de recuperación entregados por email llegaron con el token ya invalidado (`otp_expired`) en 2 intentos vía Gmail, mientras que un link generado directo funcionó a la primera — sugiere que algo en el camino de entrega (Gmail y/o el proxy de Resend) pre-visita el link de un solo uso. No investigado a fondo; si se repite con invitaciones reales, considerar que el email lleve a una página propia con un botón a clickear en vez de un link GET directo al endpoint de Supabase.
- **Cobertura de tests:** `tests/rules.test.ts` cubre el contrato y las reglas de señales; las barreras de autorización de las rutas de usuarios y clientes no tienen tests automatizados.

## Documentación

| Archivo | Qué es |
|---|---|
| `README.md` (este archivo) | Cómo está construido y cómo se corre/despliega **hoy**. Estado, no historia. |
| `CHANGELOG.md` | Registro unificado de cada cambio, con su commit, sus migraciones y su estado de despliegue. |
| `MEMORIA_PROYECTO.md` | Decisiones de diseño y el porqué de todo el sistema Pessaro (indicador TradingView + bridge), con el contrato JSON vigente y el roadmap general. |
| `docs/metaprompt_pessaro_bridge_v3_despachador.md` | Especificación funcional completa del bridge (arquitectura, reglas, despliegue paso a paso, troubleshooting). |
| `METAPROMPT_*.md` | El prompt de entrada de cada iteración grande. Insumo histórico, no documentación viva — si contradicen al README, manda el README. |

Al iniciar una sesión de trabajo sobre este proyecto, el contexto mínimo útil es `MEMORIA_PROYECTO.md` + `CHANGELOG.md`.

## Licencia

Propiedad de Pessaro Capital. Uso interno — no distribuir.
