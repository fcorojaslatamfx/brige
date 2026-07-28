# Changelog · Pessaro Bridge

Registro unificado de cada cambio del repo, del más reciente al más antiguo.
Una entrada por cambio, con su commit, sus migraciones SQL y su estado de despliegue.

**Ruta de trabajo:** `feature/*` → `staging` → `main` → producción (`brige.pessaro.cl`).
Vercel despliega preview por rama y producción desde `main`.

**Documentos hermanos:**
- `README.md` — cómo está construido y cómo se corre/despliega hoy (estado, no historia).
- `MEMORIA_PROYECTO.md` — decisiones de diseño y el porqué de todo el sistema Pessaro (indicador + bridge).
- `docs/metaprompt_pessaro_bridge_v3_despachador.md` — especificación funcional del bridge.
- `METAPROMPT_*.md` — el prompt de entrada de cada iteración grande (insumo, no documentación viva).

---

## [Sin liberar] — rama `feature/broker-cuenta-cliente`

### Guardarraíles de rol en la invitación + rescate por CLI · `507fa62` · 27-jul-2026

Invitar un correo que **ya** tiene acceso reescribe su rol vía `upsert`. Sin
protección, un tipeo del propio correo como `admin` degradaba en silencio al
`super_admin` que estaba invitando: `/status/users` pasaba a responder 403 y no
quedaba nadie capaz de revertirlo desde el panel.

- `app/api/users/invite/route.ts`: bloquea cambiar el rol propio desde una
  invitación (400) y bloquea degradar al último `super_admin` (400). El segundo
  guardarraíl es defensa en profundidad — como la ruta ya exige que quien invita
  sea `super_admin`, en la práctica el primero atrapa el caso antes.
- `scripts/set-user-role.ts` (nuevo): red de rescate fuera de la UI
  (`npx tsx scripts/set-user-role.ts <correo> <super_admin|admin>`) por si igual
  se llega a quedar sin ningún `super_admin` vivo.
- Sin migraciones. Build limpio, 42/42 tests.
- **Sin cobertura automatizada:** `tests/rules.test.ts` cubre reglas de trading,
  no rutas de gestión de usuarios. Los dos guardarraíles se verifican a mano.

### Datos de cuenta de broker por cliente + filtro por broker · `f121ecd` · 24-jul-2026

Meta-prompt `METAPROMPT_BROKER_ACCOUNT_v1.md`. Alcance: alta de cliente y panel general.

- **Migración `015_client_broker_account.sql`** (aplicada a producción, 0 filas, no-op):
  `client_tokens` gana `broker` / `account_type` (`'demo'|'real'`, CHECK) /
  `account_number` / `broker_server`, todos `NOT NULL` con backfill idempotente
  `'SIN_DATO'` para filas previas.
- `lib/schema.ts` (`createClientSchema`): los 4 campos **sin** `.optional()` —
  obligatorios de verdad, no solo el `required` de HTML. `lib/clients.ts`:
  `ClientTokenRow` + insert.
- `/status/clients`: 4 inputs nuevos en el alta (solo `super_admin`), reset tras
  crear, y columna "Cuenta" en **ambas** vistas (super_admin y admin) — REAL en
  rojo, DEMO neutro, SIN_DATO en ámbar.
- `/status`: filtro "Broker" dinámico, poblado desde `client_tokens` sin whitelist.
  Como `signals` no conoce el broker, filtra por señales **entregadas** a clientes
  de ese broker vía `client_deliveries` (dos pasos, centinela UUID contra un
  `.in([])` vacío). `delivery_funnel` / `latency_stats` quedan por origen (decisión).
- Sin cambios en `/status/users` (usuarios internos, fuera de alcance).

---

## En `main` / producción

### `/login` compacto con imagen de fondo visible · `77c843d` · 24-jul-2026

Overlay bajado al 25% para que se vea la foto de fondo, se quita la línea "Panel
de administrador" y el recuadro queda más compacto y premium.

### Unificación UX con el sistema de diseño de pessaro.cl · `7c7d5fa` · 24-jul-2026

Meta-prompt `METAPROMPT_UNIFICACION_UX_v1.md`. **Solo capa visual** (CSS/JSX):
cero cambios de lógica, rutas, Zod, SQL o contrato.

- **Causa raíz corregida:** cada `.module.css` declaraba su propia copia de la
  paleta, y así se desincronizaron `/login` y `/status`. Ahora `app/theme.css`
  (nuevo) es la única fuente de tokens de marca — navy 950→600, púrpura, dorado,
  semánticos, timings — importado **una vez** en `layout.tsx`.
- **Jerarquía semántica de color:** PÚRPURA = navegación / CTA / foco;
  DORADO = premium (Entrar, Guardar, set-password) y calidad ELITE. Antes el
  dorado servía para todo y diluía la señal ELITE.
- Animación importada (la técnica, no el HTML de marketing): barrido de brillo en
  `<button>`, `card-premium` en stat tiles y panels, reveal al montar, header
  sticky con glass, punto pulsante en EA ONLINE.
  `@media (prefers-reduced-motion: reduce)` global.
- **Fuera de alcance — siguen con la identidad vieja** (`#0c0f1a` / `#c9a84c`):
  el EA `.mq4` (constantes `PC_*`) y los manuales HTML del indicador.
- Ver detalle en `MEMORIA_PROYECTO.md` §15.

### Tokens de cliente + dashboards por rol · `67a169e` · 24-jul-2026

Feature Clientes bajo Usuarios, un portal propio por cliente, sobre un modelo de
entrega de señales **por difusión**.

- **Migración `014_client_tokens.sql`:** `client_tokens` (token por lead, correo +
  móvil, caducidad 7/14/30 días o indefinido, admin asignado) y `client_deliveries`
  (una fila por señal × cliente).
- `claim_signals_for_client`: **difusión** — cada cliente recibe cada señal fresca
  entregable aún no entregada a él, sin consumir la cola del operador. El
  `claim_signals` del EA (consumo único) queda intacto.
- `/api/signals` y `/api/ack` ramifican por token (operador `ea` vs cliente);
  cliente caducado/revocado → 403, inexistente → 401.
- **Tres roles:** `super_admin` ve el panel completo; `admin` es redirigido a
  `/status/clients` y ve **solo** sus clientes (`assigned_admin`), sin generar,
  revocar ni configurar el bridge; `cliente` entra a `/portal` sin login Supabase,
  autenticándose con su token (localStorage), solo lectura.
- **Endurecimiento:** las rutas que **configuran** el bridge (settings GET+PUT,
  status GET, tokens, tokens/regenerate) ahora exigen `super_admin` vía
  `isSuperAdminOrOperator` — antes un `admin` con sesión podía alterarlas.
- Ver detalle en `MEMORIA_PROYECTO.md` §13 y §14.

### Contrato v2.0 del bridge · `065b64f` · 24-jul-2026

Corrige los seis defectos raíz del meta-prompt v3.0 (`METAPROMPT_PESSARO_BRIDGE_v3.md`).
Capas DB + bridge; Pine y EA quedan como piezas externas.

- **Contrato v2.0** (`lib/schema.ts`): `ts_signal` (`timenow`) = frescura vs
  `bar_time` (`time`) = dedup — antes un solo timestamp servía a los dos fines.
  `bar_time` opcional con fallback para Pine v1.x. Acciones nuevas
  `SETUP_BUY`/`SETUP_SELL`/`SETUP_CANCEL`. Guardia de reloj > 1h → 400.
- **Umbrales autoritativos** (migr. `010_authoritative_thresholds.sql`): el bridge
  es la única fuente de verdad; el bloque `thresholds` va completo o se omite
  entero, nunca ceros; semántica `>=`; nunca suprime la señal.
- **Aislamiento del test suite en 3 capas:** DB (`origin`/`is_test`/`env` + CHECK
  de coherencia + vista `signals_deliverable` + `claim_signals` solo producción),
  bridge (`lib/origin.ts` deriva el origen del token + `PESSARO_ENV`, cola de
  prueba `claim_signals_test` solo con token operator vía `?include_test=true`),
  y EA (externo). Vitest corre con `PESSARO_ENV=test`.
- Panel `/status`: embudo de entrega, latencia con línea de frescura, aviso "EA sin
  polling", filtro de origen (migr. `012_status_analytics.sql`).
- `013_lockdown_calc_thresholds.sql` cierra una regresión: `calc_thresholds`
  (SECURITY DEFINER) quedaba ejecutable por `anon` vía PostgREST → revocado a
  `service_role`.
- Migraciones **007–013** aplicadas a producción. El índice de dedup viejo se
  conserva junto al nuevo hasta que Pine v2.0 esté vivo.
- Ver detalle en `MEMORIA_PROYECTO.md` §12.

### Fondo de `/login` + MEMORIA a la raíz · `cd2968c` · 23-jul-2026

### Redirección de dominio raíz a `/login` + ajuste de identidad · `447b379` · 23-jul-2026

### Rediseño de `/login` + recuperar contraseña + disclaimer legal · `581237d` · 23-jul-2026

- `/login` con fondo `public/brige-login.jpg` y logo oficial de Pessaro Capital.
- Flujo "¿Olvidaste tu contraseña?" vía `POST /api/auth/forgot-password` — público,
  nunca crea usuarios ni revela si un correo tiene acceso; solo reenvía el link a
  cuentas ya presentes en `user_roles`.
- `lib/email.ts` centraliza `emailShell()`, que agrega el disclaimer legal
  obligatorio de Pessaro Capital (riesgo, exención de responsabilidad, RUT/domicilio)
  a **todo** correo saliente.

### Fix crítico: `/set-password` podía cambiar la contraseña de la cuenta equivocada · `7c05547` · 23-jul-2026

La página confiaba en la sesión ya activa del navegador en vez de canjear
explícitamente el token del link con `setSession()`. Si el invitador tenía sesión
abierta en la misma pestaña, el invitado sobreescribía **su** contraseña.
Encontrado en la prueba end-to-end en producción.

### Gestión de usuarios del dashboard · `6efca47` · 23-jul-2026

**Migración `005_user_roles.sql`.** Roles `super_admin`/`admin`, invitación por
Resend con link de Supabase a `/set-password`, `app/api/users/*` (list/invite/
role/revoke) + `app/status/users` (UI, solo `super_admin`). Probado end-to-end en
producción: invitar → correo real → `/set-password` → login.

**Modelo de roles:** se comparó con `pessaro-crm` (repo hermano, 3 roles + tabla
de perfil extendido) y se decidió mantener el modelo simple en Bridge, que solo
gestiona acceso al panel. (La feature Clientes agregó después el rol `cliente`,
que no es un usuario del panel sino un destinatario de señales.)

### Fix del badge EA online / último poll · `8375fc5`, `a1f5d3e` · 23-jul-2026

**Migración `006_ea_last_poll.sql`.** El badge dependía de `signals.claimed_at`,
que solo avanza si hay una señal pendiente — con la cola vacía (el caso normal)
marcaba "EA OFFLINE" pese a que el EA autenticaba bien. Se agregó
`tokens.last_used_at` como heartbeat real, actualizado en cada `GET /api/signals`
con token válido. `a1f5d3e`: el "hace Ns" podía dar negativo por desfase del reloj
del cliente; acotado con `Math.max(0, …)`.

### Dashboard de admin con login Supabase Auth + tokens · `637a285` · 22-jul-2026

**Migración `004_tokens.sql`.** Los tres tokens de integración (`tv_webhook`, `ea`,
`operator`) pasan de env vars a la tabla `tokens`: se ven y regeneran desde
`/status/tokens` **sin redeploy**.

### Esquema Zod del webhook relajado para el indicador v1.0 · `71dddce` · 22-jul-2026

### Piezas 1–5 del build inicial · `232d9bd`, `0b600e8`, `a9630bd`, `0e1ec50` · jul-2026

Esquema SQL (`001`–`003`), API routes, EA notificador MQL4, panel `/status`,
migración aplicada a Supabase con correcciones post-deploy, pruebas Vitest y
README de despliegue.

`003_grant_service_role.sql` no es opcional: sin ella `service_role` no tiene
permisos sobre `signals`/`audit`/`settings` y **todas** las rutas fallan con
`permission denied` aunque RLS esté bien configurado.

---

## Pendientes / a vigilar

- **Piezas externas del meta-prompt v3.0**, que no viven en este repo: Pine v2.0 en
  TradingView, EA v2.0 en MT4 y la limpieza de alertas duplicadas. Hasta que Pine
  v2.0 esté vivo, `bar_time` sigue siendo opcional con fallback y se conserva el
  índice de dedup viejo.
- **Links de recuperación pre-visitados:** en 2 intentos vía Gmail el token llegó ya
  invalidado (`otp_expired`), mientras que un link generado directo funcionó a la
  primera — sugiere que algo en el camino de entrega (Gmail y/o el proxy de Resend)
  visita el link de un solo uso. No investigado a fondo. Si se repite con
  invitaciones reales, considerar que el correo lleve a una página propia con un
  botón, en vez de un link GET directo al endpoint de Supabase.
- **Cobertura de tests de las rutas de usuarios:** `tests/rules.test.ts` cubre el
  contrato y las reglas de señales; la gestión de usuarios/clientes no tiene tests
  automatizados de sus barreras de autorización.
