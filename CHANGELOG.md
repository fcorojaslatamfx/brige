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

## [Sin liberar]

### Supresión de cancelaciones huérfanas · `9fed5e5` · 29-jul-2026

Decisión del operador sobre el pendiente que había quedado abierto en la 016.
Medido en producción: **43 `CANCEL_ALL` notificadas frente a 134 entradas
muertas como `expired`**. El trader recibía cancelaciones de operaciones que
nunca se le notificaron — no por efímeras (eso ya lo cubría la 016), sino porque
el armado murió por TTL o con el terminal apagado. Es la queja original.

- `supabase/migrations/018_orphan_cancel_suppression.sql` (nuevo, **aplicada**).
  La regla: **una cancelación se entrega solo si existe una entrada de ese
  símbolo que salió de verdad al terminal y que todavía no fue cerrada por una
  cancelación ya entregada.** Sin nada vivo detrás no es información, es ruido.
- **Generaliza el guardarraíl de la 016 en vez de añadir una regla nueva.** Allí
  la cancelación se suprimía si (a) había matado un armado pendiente dentro de la
  ventana Y (b) no quedaba una entrada despachada sin cerrar. Resulta que (b) por
  sí solo era el predicado correcto; (a) solo restringía el caso a las parejas
  efímeras. Al quitarlo, el mismo mecanismo cubre también las huérfanas.
- **La ventana deja de intervenir en la supresión.** Las víctimas de una
  cancelación pasan a ser TODAS las entradas del símbolo que sigan en cola y
  nunca se hayan despachado, sin límite de tiempo: entregar un armado que una
  cancelación posterior ya invalidó es el mismo ruido, dé igual cuánto pasó.
  `setup_hold_seconds` sigue siendo necesaria pero su único trabajo ahora es
  RETENER lo suficiente para que la cancelación alcance al armado. Por eso
  `suppress_ephemeral_setups` pierde el parámetro `p_hold_seconds`.
- **La cadena se cierra sola, sin ventana de tiempo arbitraria:** cuando una
  cancelación se entrega, la entrada que la motivó queda cerrada, así que las
  siguientes del mismo símbolo vuelven a ser huérfanas. Una entrada despachada y
  jamás cancelada conserva su derecho a la cancelación por vieja que sea. Hay un
  test que fija ese cierre.
- `settings.suppress_orphan_cancels` (default `true`) con casilla en `/status`:
  es un cambio en CUÁNDO le llega una cancelación al trader y merece
  interruptor. Apagarlo revierte solo esto; el guardarraíl no se toca.
- 57/57 tests (4 nuevos: huérfana pura, armado muerto en cola, guardarraíl con
  entrada despachada, y segunda cancelación ya huérfana).
- `scripts/send-test-emails.ts` (nuevo): manda correos de prueba reales a una
  casilla para revisar el formato en Gmail/Outlook, no solo en el navegador.
  Complementa a `preview-emails.ts`, que no envía nada.

### Revisión estática del EA v2.0: alto del panel y repintado · `91a074a` · 29-jul-2026

El EA v2.0 se entregó sin haber pasado nunca por un compilador (no hay MetaEditor
en el entorno donde se escribió). Revisión estática en busca de lo que frenaría
al operador en MetaEditor o se vería mal en el gráfico. Dos defectos reales:

- **El fondo del panel se quedaba corto.** `CreateBackground()` recibía un alto
  calculado con la constante `200 + filas × 15`, pero el contenido real ronda los
  280 px con 0 filas: la franja inferior caía fuera del recuadro. El alto no se
  puede saber por adelantado porque las filas son variables y el bloque de cupo
  aparece o no. Se parte en dos: `EnsureBackground()` crea el rectángulo primero
  —en MT4 los objetos del mismo plano se dibujan en orden de creación, así que
  tiene que nacer antes que las etiquetas o las taparía— y `SizeBackground()` lo
  dimensiona al final, con la `y` ya medida.
- **Faltaba `ChartRedraw()`.** Es el mismo defecto que el R6 pero en el
  repintado: MT4 refresca los objetos cuando llega un evento del gráfico, y en un
  símbolo que no cotiza no llega ninguno. El polling avanzaría por
  `GetTickCount()` y el trader seguiría viendo el estado de hace horas — peor que
  verlo OFFLINE, porque parece fresco.

Lo que sí quedó verificado: las 17 llamadas a `StringFormat` cuadran en número de
especificadores y argumentos; llaves 105/105 y paréntesis 570/570 balanceados
ignorando comentarios y literales; 48 bloques de nivel 0 abiertos y cerrados; y
las 50 llamadas a la plataforma existen todas en MQL4 build 600+, sin API de
MQL5 colada. **Esto no sustituye a compilar:** sigue pendiente abrirlo en
MetaEditor y pulsar F7.

### Invitación de clientes con correos, y correos con la identidad de pessaro.cl · `62530ec` · 29-jul-2026

Cuatro pedidos del operador: nombre/apellido/móvil/correo en la sección de
clientes con aviso por correo al invitado y al super admin, rol cliente en el
formulario de invitar usuario, renombrar el botón a «Invitación», y correos con
la paleta y el footer de pessaro.cl.

- `supabase/migrations/017_client_first_last_name.sql` (nuevo, **aplicada**):
  `client_tokens.client_last_name`, y `client_name` pasa a ser el NOMBRE DE
  PILA. Ambos `NOT NULL` con backfill idempotente `'SIN_DATO'` (precedente de la
  015). La tabla tenía 0 filas, así que el backfill fue un no-op. La columna no
  se renombró a propósito: la leen `lib/clients.ts`, el portal y el panel, y
  renombrarla obligaba a tocar todo eso a cambio de nada.
- **Rol «cliente» en Invitar usuario.** El desplegable de `/status/users` suma
  Cliente; con ese rol aparecen los campos del cliente y el alta toma el camino
  de `client_tokens`. **No** entra en `roleSchema`: un cliente no tiene fila en
  `user_roles`, no inicia sesión y no se le crea cuenta en Supabase Auth.
  Meterlo en `roleSchema` lo habría hecho asignable desde `/api/users/role` y
  habría chocado con el CHECK de la tabla. `inviteSchema` es una unión
  discriminada por `role`; hay un test que fija esa barrera.
- `lib/client-onboarding.ts` (nuevo): el alta, el correo al cliente y el aviso a
  los super_admin viven juntos porque hay DOS puertas al mismo gesto
  (`/api/clients` y `/api/users/invite` con `role="cliente"`). Duplicar el flujo
  garantizaba que una de las dos dejara de mandar algún correo.
  - Los correos **no** abortan el alta: el token ya existe y es visible en el
    panel, así que si Resend falla se devuelve `email_warning` y el operador
    reenvía con Compartir. Fallar ahí borraría de la respuesta un cliente creado.
  - Los destinatarios del aviso se resuelven en cada envío con
    `listSuperAdminEmails()`, no desde una lista fija: quien deja de ser
    super_admin deja de recibirlos sin que nadie tenga que acordarse.
  - El aviso **no lleva el token**: un correo de notificación se reenvía y se
    archiva; el token vive en el correo del cliente y en el panel, bajo sesión.
- **Correos con la identidad de pessaro.cl** (`lib/email.ts` reescrito): paleta
  navy/púrpura/dorado calcada de `pessarocl/src/index.css`, CTA púrpura
  (`.btn-primary` del sitio) y dorado reservado a lo premium — el token del
  cliente y el wordmark.
  - Footer legal calcado del footer real del sitio
    (`pessarocl/src/components/Layout.tsx` + la clase `.legal-box`): las tres
    cajas comparten UNA paleta navy, sin el borde ámbar ni el rojo que tenían
    antes (el FIX v6.1 del sitio las unificó para que ninguna advertencia
    pareciera más grave que otra por su color).
  - ⚠ **Cambio de copy legal:** el sitio dejó de exponer «SpA» y el RUT en el
    párrafo de Advertencia Legal Obligatoria (decisión del 24-jul-2026, ver
    `pessarocl/FIX_v6.1_footer_dedup_paleta.md`) y el correo seguía con el texto
    viejo. Ahora coinciden. La identificación completa sigue en
    `LEGAL_SOURCE.md`, que es documento de registro, no copy público.
  - El wordmark va como texto y no como el logo de `lib/pessaro-logo.ts`: ese
    asset es `.webp` y Outlook lo dejaría como un hueco en cada correo.
  - `build*` puros (asunto + HTML) separados de los `send*`, y
    `scripts/preview-emails.ts` para revisar los 5 correos en el navegador sin
    mandar nada ni necesitar `RESEND_API_KEY`. Verificados visualmente.
- Renombres: el enlace de navegación «Clientes» y el botón de alta pasan a
  «Invitación»; el panel de la sección se llama «Invitar cliente».
- 53/53 tests (4 nuevos de esquema), `tsc --noEmit` y `next build` limpios.

### EA v2.0 + supresión de setups efímeros · `5744b14` · 29-jul-2026

Investigación de tres preguntas del operador: (1) los setups del indicador no se
reflejan en MT4, (2) tampoco el `BUY LIMIT` / `SELL LIMIT`, (3) las señales que
se cancelan en un rango corto de tiempo no deberían ser visibles en MT4.

**Causa de (1): no existen. Nada las emite.** Verificado contra producción:
`select count(*) from signals where action like 'SETUP%'` → **0** en todo el
histórico; ningún payload trae `schema` ni `bar_time`; `ts_signal = bar_time` =
apertura exacta de vela → el indicador vivo sigue siendo el Pine v1.x. La cadena
del bridge estaba completa desde la migración 008 y sin nada que transportar. El
pendiente, con los bloques de Pine y el orden de despliegue, quedó en
`docs/PENDIENTE_PINE_v2.md` (no se puede resolver desde este repo).

**Causa de (2): el dato llega y el EA lo tiraba.** Las 513 entradas del histórico
(263 `BUY_DUAL` + 250 `SELL_DUAL`) traen `type='LIMIT'`, sin una sola excepción. `HandleEntrySignal()` del EA v1.0 leía `action`, lo
traducía a `"BUY"`/`"SELL"` y nunca leía `type`. Defecto de presentación en el
consumidor, no de transporte.

**(3) es preventivo, no correctivo.** Hoy el caso es imposible de observar: el
mínimo entre una entrada y una cancelación posterior del mismo símbolo es de
**11.699 s (3 h 15 min)** y la mediana de 21 h, porque `CANCEL_ALL` se evalúa por
conteo de barras. Cero cancelaciones dentro de 300 s en todo el histórico. Se
vuelve real en cuanto Pine emita `SETUP_*`, que sí pueden armarse y desarmarse
intrabarra.

- `mt4/PessaroBridgeEA_v2.mq4` (nuevo, reemplaza al v1.0):
  - **R1** lee `type` → `BUY LIMIT` / `SELL LIMIT` / `BUY STOP` / … en panel,
    alerta y push.
  - **R2** procesa `SETUP_BUY` / `SETUP_SELL` / `SETUP_CANCEL`, con `◇` armado vs
    `◆` disparo. El v1.0 los ignoraba con un `Print` **y sin ackear**, así que la
    señal se quedaba `claimed` hasta morir `expired`: en `/status` era
    indistinguible de un terminal apagado. Ahora incluso una acción desconocida
    se ackea como `error`.
  - **R3** lee el `thresholds` anidado con fallback al plano v1, vía un
    `JsonHasKey()` que distingue presencia de valor: sin datos escribe `s/d`,
    nunca `0/0`.
  - **R4** cuarentena por `is_test` / `env` / `origin` / `account_id`: no suena,
    no vibra, se cuenta aparte y se ackea con el motivo.
  - **R5** `online` con tolerancia `intervalo × 2 + 5`. El umbral fijo de 10 s
    del v1.0 marcaba OFFLINE el 66 % del tiempo con el puente sano, porque fuera
    de ventana el polling es de 30 s.
  - **R6** cadencia con `GetTickCount()`: `TimeCurrent()` es la hora del último
    tick recibido y no avanza en un símbolo que no cotiza, así que en un gráfico
    tranquilo el polling del v1.0 se congelaba.
  - **R7/R8** panel con identidad Pessaro, gauges de cupo, contadores de sesión,
    `grade` con `★` e `impulse_atr`. El panel ya no se borra y recrea entero cada
    segundo (parpadeo): reutiliza etiquetas y solo purga el excedente.
  - Sondeo de sufijos de símbolo (`m`, `.r`, `_i`, `micro`…) antes de rendirse.
- `supabase/migrations/016_ephemeral_setup_suppression.sql` (nuevo):
  `settings.setup_hold_seconds` (default 45, CHECK `< queue_ttl_seconds`), estado
  `suppressed`, `signals.superseded_by`, `signal_dispatched()` y
  `suppress_ephemeral_setups()`. Los tres claims (operador, prueba, clientes)
  suprimen antes de expirar por TTL y retienen los `SETUP_*`; `calc_thresholds()`
  y `today_counts()` dejan de contar lo suprimido.
  - La retención **solo** aplica a `SETUP_BUY`/`SETUP_SELL`. Un disparo significa
    "el precio ya tocó tu nivel" y no se retrasa ni un segundo; sí se suprime si
    su cancelación llega mientras sigue en cola (latencia cero añadida).
  - **Guardarraíl duro:** la cancelación solo se suprime si no queda ninguna
    entrada despachada y sin cerrar de ese símbolo. "Despachada" mira
    `claimed_at` **y** `client_deliveries` — los EA de cliente reciben por
    difusión sin tocar `signals.status`, así que usar el status habría dejado a
    los clientes con órdenes pendientes cuya cancelación se suprimió.
  - Orden obligatorio en el claim: suprimir → expirar por TTL → seleccionar. Al
    revés, un armado ya caducado deja de ser `pending` y su cancelación se
    entrega huérfana, que es el ruido que veníamos a eliminar.
- `lib/schema.ts` / `lib/counts.ts` / `app/status/page.tsx`: `setup_hold_seconds`
  editable en caliente, estado `SUPRIMIDA`, `superseded_by`.
- `app/api/settings/route.ts`: el CHECK `setup_hold_seconds < queue_ttl_seconds`
  se traduce a un 400 legible en vez de un 500 opaco.
- Tests: 5 de integración sobre la cola de prueba (pareja efímera suprimida,
  retención que bloquea, retención agotada que entrega, guardarraíl de la
  cancelación de un armado ya despachado, disparo no retenido) + 3 puros. La
  ventana se pasa explícita por `p_hold_seconds` para no mutar la configuración
  de producción mientras la suite corre.

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
