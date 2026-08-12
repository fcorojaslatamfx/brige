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

### Redespliegue tras un build caído por Google Fonts · `81cdf08` · 12-ago-2026

Commit vacío para relanzar el build. No hubo cambio de código: el despliegue de
producción de `ab5c774` quedó en `ERROR` por una descarga externa fallida.

```
next/font error: Failed to fetch `DM Sans` from Google Fonts
app/layout.tsx → Build failed because of webpack errors
```

- `staging` y `main` se construyeron con **100 ms de diferencia** sobre el mismo
  árbol. El de staging consiguió la fuente y quedó `READY`; el de producción
  agotó los tres reintentos contra `fonts.gstatic.com`.
- El síntoma llegó disfrazado y costó media hora de diagnóstico: el EA v3
  recibía **405** en cada poll, porque `brige.pessaro.cl` seguía sirviendo el
  código anterior —el que solo exporta `GET`— mientras el build fallido no
  reemplazaba nada. Parecía un problema de token o de cliente y no lo era.
- ⚠️ **Pendiente:** `app/layout.tsx` usa `next/font` con Google Fonts, así que
  cada build depende de una descarga externa en el camino crítico. Con dos
  ramas construyendo a la vez la probabilidad de que vuelva a pasar no es
  despreciable. Bajar el `.woff2` al repo y cargarlo con `next/font/local` lo
  elimina.

### Frescura del snapshot de equity · `008f72d` · 12-ago-2026

Corrige un defecto introducido por la 020 el mismo día. `tp_snapshot_equity()`
copiaba `tp_accounts` a `tp_equity_snapshots` cada noche **sin comprobar si el
dato estaba fresco**. Un EA vive dentro de MetaTrader: cuando el cliente apaga
el PC, deja de reportar. Con el terminal cinco días caído, el cron escribía
cinco snapshots diarios con las MISMAS cifras congeladas y la curva salía una
línea plana, indistinguible de cinco jornadas sin operar. Son dos hechos
distintos y el gráfico los mostraba igual.

- `supabase/migrations/022_equity_snapshot_freshness.sql` (nuevo, **aplicada**).
  Una cuenta entra al snapshot solo si su telemetría es más reciente que
  `p_max_staleness_hours`. Si no, no se escribe fila y la curva muestra un
  **hueco**: un hueco dice "no sabemos", una línea plana afirma "el balance fue
  este", y esa afirmación no la respalda ningún dato.
- El daño no se quedaba en el gráfico. Al volver el terminal, el EA sube las
  operaciones que cerraron mientras estuvo apagado, así que el balance de esos
  días **sí** había cambiado; los snapshots ya escritos seguían mintiendo,
  porque el cron solo toca `current_date` y nunca revisita el pasado.
- **El umbral es 26 h y no dos** porque no mide "¿está vivo ahora?" sino "¿supimos
  de este terminal en algún momento del día?". Muchos clientes apagan el PC de
  noche y el cron corre a las 03:00 UTC: a esa hora su último reporte puede
  tener ocho horas y seguir siendo una observación legítima de la jornada.
- La función pasa de `int` a `jsonb` (`written` / `stale`) y el cron registra un
  `warning` cuando `stale > 0`. Eso convierte el job diario en el **detector de
  terminales caídos** que no existía: hasta ahora el operador solo se enteraba
  entrando a `/status/clients` a mirar badges uno a uno — que es exactamente por
  lo que el EA del operador llevó cinco días sin pollear sin que saltara nada.
  Requiere `drop` + `create`: Postgres no deja cambiar el tipo de retorno con
  `create or replace`.
- Verificado con dos cuentas en una transacción revertida, una fresca y otra
  envejecida cinco días: devuelve `written 1, stale 1`.

### Fusión del Trading Portal y telemetría de cuenta en el EA · `7141789` · 12-ago-2026

Unifica el proyecto Supabase del Trading Portal (`ckouxsidjkqhqfwvmakn`) dentro
del proyecto del bridge y sustituye la integración planificada con **MetaApi**
por telemetría enviada desde el propio terminal del cliente. El portal estaba
**vacío** —0 filas en sus cinco tablas—, así que la fusión fue DDL puro sin
migración de datos: la razón para hacerla ahora y no en seis meses.

El hallazgo que ordena todo lo demás: **el EA ya está instalado en cada MT4 y ya
hace un request cada 2 s** para recibir señales. El reporte de cuenta puede
viajar DENTRO de ese request, así que cuesta cero peticiones nuevas. Con eso
desaparecen —sin llegar a construirse— la suscripción a MetaApi (facturada por
cuenta conectada), las edge functions `broker-connect`/`broker-sync`, el
`pg_cron` cada 15–30 s y Realtime, además de un proyecto Supabase de pago.

**1 · Esquema.**

- `supabase/migrations/020_trading_portal.sql` (nuevo, **aplicada**). Las tablas
  `tp_*` cuelgan de `client_tokens`, no de `auth.users`: los clientes del bridge
  se autentican con su token opaco y no tienen cuenta en Supabase Auth.
  Mantener las dos identidades habría obligado a sincronizarlas de por vida.
- `unique (account_id, ticket)` es la **clave de idempotencia del ingest**. Sin
  ella, un reenvío del EA tras reiniciar el terminal duplica el historial del
  cliente.
- `tp_ingest_telemetry()` escribe cuenta, posiciones e historial en **un solo
  round-trip**, con el rate-limit dentro del `on conflict … where`: así es
  atómico frente a polls concurrentes del mismo EA y no cuesta un `SELECT`
  extra por request. Cortar por frecuencia descarta solo el bloque `account`;
  los cierres se procesan igual, porque un cierre es un hecho irrepetible.
- Fuera del esquema original: **`tp_ohlc`** (los gráficos usan el widget externo
  de TradingView y el componente de lightweight-charts nunca se renderizaba —
  habría sido la tabla más grande del sistema para alimentar a nadie),
  **Realtime** (con telemetría a 60 s no aporta frescura y obliga a poner la
  anon key en el navegador) y **`pg_cron`** (estaba creada y sin usar).
- `019_client_token_expiry_required.sql` se versiona por fin: ya estaba aplicada
  pero seguía sin trackear, y la 020 depende de ella.

**2 · `supabase/migrations/021_hot_path_index.sql` (nuevo, aplicada) — el índice
que faltaba.**

El `UPDATE` de expiración que `claim_signals` corre en **cada** poll (~82.000
al mes, medido en `pg_stat_statements`) no tenía índice: `idx_signals_pending`
está restringido a `where status = 'pending'`, así que el planificador **no
puede** usarlo para un predicado `status in ('pending','claimed')`. El `EXPLAIN`
acababa recorriendo ~972 filas por `ux_signals_dedup_bar_time` y filtrando a
mano. Con `idx_signals_open` pasa de `Bitmap Heap Scan` coste **226.53** a
`Index Scan` coste **22.30**. `claim_signals` se recrea con una guarda
`if exists` y la lógica de supresión de 016/018 intacta palabra por palabra.

**3 · Contrato del EA.** `/api/signals` exporta `GET` y `POST` sobre un
`handle()` común. Los EA v2 ya instalados siguen funcionando por GET
**indefinidamente**: el despliegue del v3 es cliente a cliente y nadie tiene que
actualizar para seguir recibiendo señales. La telemetría se procesa antes del
claim y su fallo nunca corta la entrega — al trader le llega su entrada aunque
el reporte de balance falle.

**4 · `mt4/PessaroBridgeEA_v3.mq4` (nuevo).** Copia del v2.1 con la lógica de
señales intacta.

- El hash del conjunto de posiciones **excluye `current_price` y `profit`** a
  propósito: cambian en cada tick, y meterlos convertiría "mandar cuando algo
  cambie" en "mandar siempre", perdiendo el ahorro entero del diseño.
- El historial solo se escanea cuando algo pudo haber cerrado, no cada 2 s:
  `OrdersHistoryTotal()` puede tener decenas de miles de filas.
- La **marca de agua la sirve el servidor**, no el terminal: un reinicio de MT4
  no deja huecos ni obliga a persistir estado en disco.
- `InpEnableSignals` / `InpEnableTelemetry` cubren cualquier combinación de
  contratación: solo señales, solo portal, o ambas.
- Anti-suplantación: el número de cuenta del terminal debe coincidir con el
  registrado en `client_tokens`, o 409 + fila en `audit` y cero escrituras.
  Atrapa sobre todo el caso real de adjuntar el EA al terminal equivocado.

**5 · Portal.** Las siete páginas pasan a `app/portal/(trading)/` como
componentes cliente, bajo un solo proveedor en el layout: antes cada página
montaba sus propios hooks y navegar relanzaba tres consultas sin caché alguna.
El navegador **ya no habla con Supabase** — se acabaron la anon key en el
bundle, las políticas RLS del portal y el canal de Realtime por pestaña.
Desaparecen los valores demo cableados (`?? 24850`, `?? 'MT4-284751'`) que
mostraban cifras plausibles ajenas cuando no había datos; ahora se dice
explícitamente que se espera al terminal. La pantalla de Cuenta **no** es un
puerto literal de `Configuracion.jsx`: eran 597 líneas de formularios de
credenciales MT5 para MetaApi, con el botón «Conectar cuenta» sin handler.

**6 · Coste del camino caliente.** El heartbeat pasa de escribirse en cada poll
a una vez cada 30 s: eran **71.435 `UPDATE` mensuales sobre la MISMA fila** para
alimentar un badge. El umbral online/offline sube en consecuencia de 10 s a
75 s — los dos valores están acoplados y viven juntos en `lib/heartbeat.ts`, un
módulo **sin imports** para que el cliente service-role no acabe en el bundle
del navegador. El refresco de `/status` baja de 5 s a 15 s (nueve consultas por
refresco y por pestaña abierta).

- ⚠️ Arrastra `lib/schema.ts` y `lib/clients.ts` con la feature de renovación de
  tokens que estaba en el árbol de trabajo, porque `tests/rules.test.ts` la
  referencia y sin ella el commit no compila aislado. Su route handler
  (`app/api/clients/renew/`) sigue sin commitear; las funciones quedan sin usar
  hasta entonces.
- Verificación: `tsc` limpio y `next build` correcto sobre el árbol commiteado
  **solo**, en un worktree aparte sin `.env.local` ni cambios sin commitear. La
  suite de tests **no se corrió**: golpea el proyecto Supabase real y escribiría
  señales de prueba en producción. Se adaptó el test del heartbeat, que asumía
  el umbral de 10 s.

### Pine v2.0, exportación de señales en MT4 y caducidad obligatoria de tokens · `e824212` · 03-ago-2026

Tres frentes de una misma petición: que el **setup** que el indicador dibuja
(ENTRADA + SL + TP1 60 % + TP2 40 %) llegue al terminal, que lo que llegó se
pueda descargar, y que ningún acceso de cliente quede abierto para siempre.

**1 · `tradingview/TD_Confluence_LON_NY_v2.pine` (nuevo).** Cierra el pendiente
que llevaba abierto desde la migración 007: el indicador vivo seguía siendo el
v1.x y **nadie emitía `SETUP_*`** aunque el bridge, la base y el EA los
aceptaran desde hacía tres iteraciones.

- `timestamp` pasa de `time` a `timenow` y la apertura de vela viaja aparte en
  `bar_time`. Es el defecto 1-A: 149 señales muertas como `stale` y 215 como
  `duplicate` en el histórico auditado.
- **Emisión del armado con detección de flanco** (`dirPrev`), en el gráfico y en
  los 14 slots. Sin el flanco, el setup se reemitiría en cada vela mientras
  `dir` siguiera en ±2. `impAtrArm` es `var` porque el disparo resetea `dir` en
  la misma vela y si no el impulso llegaría en 0.
- El armado y el disparo pueden coincidir en una vela (el precio toca el nivel
  antes del cierre): son dos `alert()` independientes, no un `else`.
- La expiración de un setup pasa de `CANCEL_ALL` a `SETUP_CANCEL`, que es su
  pareja real. El bridge ya trataba las dos igual (018), así que no hay cambio
  de comportamiento en la supresión.
- `grade` / `impulse_atr` (umbral ELITE configurable) y `risk_usd` calculado con
  el perfil de CADA slot — antes todos reportaban el del gráfico anfitrión.
- El filtrado de ruido **no** se toca aquí: sigue en el bridge (016 y 018), que
  es la única capa que sabe si algo llegó de verdad al terminal.
- ⚠️ Falta el paso que no se puede hacer desde el repo: pegarlo en TradingView y
  dejar **una sola** alerta activa (ver `docs/PENDIENTE_PINE_v2.md`).

**2 · `mt4/PessaroBridgeEA_v2.mq4` → v2.1.**

- **R10 · exportación a CSV en `MQL4/Files`**, automática (se agrega al archivo
  del día en cuanto llega la señal) y manual (botón «EXPORTAR CSV» que vuelca
  toda la sesión). Búfer de historial aparte del panel: exportar solo las 10
  filas visibles habría dejado el botón en adorno justo el día con movimiento.
  Solo señales **efectivas** — la cuarentena no se exporta porque nunca se
  notificó. Separador `;` para que abra en columnas en un Excel es-CL.
- **R9 · paleta unificada con el indicador**: los tres temas (Dorado Elite,
  Cyberpunk, Azul Naval) con los mismos hexes, banda de cabecera y zebrado de
  filas. Los siete `input color` sueltos se reemplazan por un único `InpTema`.
- El fondo, las franjas y el botón se crean en `OnInit` y en ese orden: MT4
  dibuja por orden de creación y un rectángulo creado después tapa el texto.

**3 · Caducidad obligatoria y renovación de tokens de cliente.**

- `supabase/migrations/019_client_token_expiry_required.sql` (nuevo, **aplicada
  el 12-ago-2026**, junto con la 020 que depende de ella). `expires_at` pasa a
  `NOT NULL`; desaparece la opción "indefinido".
  Backfill con `now() + 30 días` y no `created_at + 30 días`: fechar desde la
  creación dejaría vencidos en el instante del deploy a clientes que están
  usando su token hoy.
- `POST /api/clients/renew` (nuevo, solo `super_admin`): extiende por 7, 14 o 30
  días **sin cambiar el token** — el cliente no reconfigura su EA ni recibe un
  secreto nuevo por correo cada mes. La vigencia cuenta desde el instante de la
  operación, nunca acumulando sobre el saldo anterior.
- El body lleva `client_email` como confirmación de identidad: el panel se
  refresca cada 5 s y renovar por 30 días al cliente equivocado es un error
  silencioso. El `UPDATE` filtra por `revoked_at is null` en la propia consulta,
  no en un chequeo previo, para que una revocación concurrente no se deshaga.
- Un token **caducado** se renueva (es el caso normal); uno **revocado** no —
  se cortó a propósito y se devuelve el acceso dando de alta uno nuevo.
- Correo de renovación al cliente (sin token) + entrada `client_token_renewed`
  en `audit` con la vigencia anterior y la nueva.
- `clientStatus()` cambia de criterio: sin fecha ya no es "vigente para
  siempre" sino caducado. Ante un dato que la 019 prohíbe, se cierra la puerta.
- 59/59 tests (2 nuevos sobre el contrato de alta y renovación).

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
