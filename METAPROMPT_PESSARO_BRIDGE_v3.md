# META-PROMPT · PESSARO BRIDGE v3.0
## Corrección del contrato de señales, aislamiento del test suite y panel premium del EA

**Destinatario:** Claude Code
**Autor:** Pessaro Capital
**Fecha:** 24 de julio de 2026
**Repositorio:** `github.com/fcorojaslatamfx/brige` (privado)
**Proyecto Supabase:** `clyhqxzrmakteuraeaau`
**Dominio:** `https://brige.pessaro.cl`
**Estado:** el puente está desplegado y recibiendo tráfico real. Este documento
corrige defectos **verificados con datos de producción**, no hipótesis.

---

## 0. CÓMO USAR ESTE DOCUMENTO

Este meta-prompt es la **fuente de verdad** para la iteración v3.0. Está
organizado así:

| Sección | Contenido |
|---|---|
| §1 | Evidencia forense recogida en Supabase (números reales) |
| §2 | Los seis defectos raíz, con causa y prueba |
| §3 | Contrato JSON v2.0 (nuevo estándar del sistema) |
| §4 | Cambios en el indicador Pine Script |
| §5 | Cambios en el bridge (Next.js / Vercel) |
| §6 | Migraciones de Supabase |
| §7 | El Expert Advisor v2.0 (ya entregado, cómo integrarlo) |
| §8 | Aislamiento del test suite |
| §9 | Criterios de aceptación |
| §10 | Plan de ejecución por fases |
| §11 | Anexo de queries de verificación |

**Regla innegociable que atraviesa todo el documento:**
el EA **no ejecuta órdenes**. Cero `OrderSend`, `OrderModify`, `OrderDelete`,
`OrderClose`. El sistema notifica; el trader decide y ejecuta a mano. Cualquier
propuesta que introduzca ejecución automática debe rechazarse.

---

## 1. EVIDENCIA FORENSE — PRODUCCIÓN, 23–24 JULIO 2026

Datos extraídos directamente de `public.signals` y `public.audit`.

### 1.1 Distribución de estados (171 señales totales)

| Estado | n | % | Lectura |
|---|---:|---:|---|
| `rejected_technical` | **103** | 60,2 % | Nunca entraron en la cola |
| `expired` | 39 | 22,8 % | Entraron y caducaron sin ser reclamadas |
| `notified` | 23 | 13,5 % | **Único tramo que llegó al trader** |
| `error` | 6 | 3,5 % | El EA no encontró el símbolo en el bróker |

**Solo el 13,5 % del flujo llega al destino.** De ese 13,5 %, **14 de 23 son
`CANCEL_ALL`**: es decir, el trader recibe mayoritariamente cancelaciones de
señales de entrada que nunca vio.

### 1.2 Motivos de rechazo técnico

| Motivo | n |
|---|---:|
| `duplicate` | 60 |
| `stale` | 43 |

### 1.3 Latencia `ts_signal → created_at` (la prueba decisiva)

| Acción | n | lag medio | lag mín | lag máx | > 180 s |
|---|---:|---:|---:|---:|---:|
| `BUY_DUAL` | 75 | 175 s | 2 s | **897 s** | 25 |
| `SELL_DUAL` | 51 | 220 s | 2 s | **784 s** | 18 |
| `CANCEL_ALL` | 45 | **8 s** | 3 s | 20 s | **0** |

`freshness_seconds` en `public.settings` = **180**.
El máximo de 897 s es prácticamente idéntico a **900 s = una vela de 15 m**.

### 1.4 Contenido real del payload (muestra de `signals.raw`)

```json
{
  "sl": 28466.3, "tf": "15", "type": "LIMIT", "grade": "STANDARD",
  "price": 28320.7206, "action": "SELL_DUAL", "symbol": "NAS100",
  "risk_usd": 50, "partial_1": {"tp": 28096.1, "lots": 0.02},
  "partial_2": {"tp": 27912.75, "lots": 0.01},
  "timestamp": 1784907000000, "account_id": "TD_CONF_LON_NY",
  "impulse_atr": 0
}
```

Observaciones sobre esta muestra:

- `impulse_atr` es **0 en el 100 % de los registros** de la tabla.
- `grade` es **`STANDARD` en el 100 % de los registros**. Nunca hay `ELITE`.
- **No existe ningún campo de umbrales** en el payload.
- **No existe ningún evento de setup armado.** Solo disparos y cancelaciones.

### 1.5 Columnas de umbrales en la base de datos

`public.signals` tiene definidas:

```
origin_symbol_count · origin_global_count · origin_threshold_exceeded
auth_symbol_count   · auth_global_count   · auth_threshold_exceeded
symbol_threshold_snapshot · global_threshold_snapshot
```

**Las ocho están en `NULL` en las 171 filas.** El esquema se construyó para los
umbrales pero **ninguna capa los escribe**.

`public.settings` vigente: `symbol_threshold = 10`, `global_threshold = 100`,
`freshness_seconds = 180`, `queue_ttl_seconds = 300`.

### 1.6 Otros hallazgos

- `public.tokens`: `kind='ea'` tiene `last_used_at` actualizado al minuto →
  **el EA está vivo y haciendo polling**. `kind='tv_webhook'` tiene
  `last_used_at = NULL` pese a haber recibido 171 webhooks → **el endpoint de
  webhook no actualiza `last_used_at`** (defecto menor de observabilidad).
- 12 eventos `invalid_token` el 23-jul (configuración inicial, ya resuelto).
- 6 `ack_error` con patrón `symbol_gap:NAS100->NAS100`, `symbol_gap:US30->US30`
  → el EA está corriendo con `InpSymbolMap` vacío.
- **No existe columna `is_test` ni `origin`** en `public.signals`. Hoy es
  imposible distinguir una señal del test suite de una señal real.
- El archivo Pine adjunto por el operador (`td_confluence_londres_nueva_york.pine`)
  es la **v1.0** y no emite `grade` ni `impulse_atr`; la versión desplegada en
  TradingView sí los emite. **El repositorio y TradingView están desincronizados.**
  Primera tarea de higiene: exportar el Pine vivo y versionarlo en el repo.

---

## 2. LOS SEIS DEFECTOS RAÍZ

### DEFECTO 1 · Los BUY LIMIT y SELL LIMIT no llegan al EA
**Severidad: crítica. Es la respuesta a la pregunta 1 del operador.**

Hay **tres causas encadenadas**, no una.

#### 1-A · `timestamp` usa la hora de apertura de la vela, no la hora del disparo

En `f_json()` y `f_jsonCancel()` el indicador construye:

```pine
'"timestamp":' + str.tostring(time)
```

En Pine Script, `time` es la **hora de apertura de la barra en curso**, no el
instante real de emisión. Para eso existe `timenow`.

El disparo de entrada es **intrabarra**: `trigCompra = dir == 2 and low <= entrada`.
Ocurre en cualquier momento dentro de la vela de 15 m. Por lo tanto:

```
lag = (instante real del disparo) − (apertura de la vela) ∈ [0 s, 900 s]
```

Con `freshness_seconds = 180`, **toda entrada que dispare pasados 3 minutos del
inicio de la vela se rechaza como `stale`** — es decir, el 80 % de la duración
de cada vela es zona ciega.

**Prueba cruzada definitiva:** `CANCEL_ALL` se evalúa por conteo de barras
(`bar_index - velaAct > expiraVelas`), es decir **en la apertura de la vela**.
Su lag medio es de 8 s y tiene **cero rechazos por `stale`**. Las entradas, que
disparan intrabarra, tienen lag medio de 175–220 s y máximo de 897 s.

Este es el motivo por el que el trader recibe cancelaciones de operaciones que
nunca le fueron notificadas.

#### 1-B · La etiqueta del gráfico dice "BUY LIMIT" pero el JSON dice `BUY_DUAL`

El indicador pinta `label.new(... "BUY LIMIT" ...)` pero el contrato transporta
`action: "BUY_DUAL"` y `type: "LIMIT"` por separado. El EA v1.0 lee `action`,
lo traduce a `"BUY"` y **descarta el campo `type`**. El operador ve "BUY LIMIT"
en TradingView y "BUY" en MT4, y concluye que el tipo de orden se perdió. Es
exacto: se perdió, pero es un defecto de presentación, no de transporte.

#### 1-C · Tormenta de duplicados

60 de 171 señales se rechazan por `duplicate`. El patrón horario es inequívoco:

```
17:08:55.596  EURUSD BUY_DUAL   ts=1784912400000
17:08:55.627  USDJPY SELL_DUAL  ts=1784912400000
17:08:56.399  XAGUSD BUY_DUAL   ts=1784912400000
17:09:04.349  EURUSD BUY_DUAL   ts=1784912400000   ← duplicado
17:09:04.581  XAGUSD BUY_DUAL   ts=1784912400000   ← duplicado
17:09:04.652  GBPUSD BUY_DUAL   ts=1784912400000   ← duplicado
```

El **lote completo** se reemite ~9 segundos después. Eso no es un artefacto del
indicador: es **más de una alerta configurada en TradingView sobre el mismo
indicador con condición "Any alert() function call"**. Cada `alert()` se envía
una vez por alerta activa.

El índice único de deduplicación está haciendo bien su trabajo, pero enmascara
el problema y contamina las métricas. Además, **cuando se aplique el fix 1-A el
deduplicador dejará de funcionar**, porque pasará a comparar `timenow`, que es
distinto en cada emisión. Los dos cambios deben desplegarse juntos (ver §3.3).

---

### DEFECTO 2 · Los SETUP BUY y SETUP SELL no llegan al EA
**Severidad: alta. Es la respuesta a la pregunta 2 del operador.**

**Causa: no existen. El indicador nunca los emite.**

Auditoría del Pine: las únicas llamadas a `alert()` son

```pine
if senalG == 1   → f_json("BUY_DUAL", ...)
if senalG == -1  → f_json("SELL_DUAL", ...)
if senalG == 2   → f_jsonCancel(...)
```

y sus equivalentes por slot. `senal` solo toma los valores `1`, `-1`, `2`, `0`.

El estado de setup armado vive en la variable `estado`, con valores `±2`, y se
usa **exclusivamente** para pintar la tabla del dashboard (`"🟢 SETUP LONG"` /
`"🔴 SETUP SHORT"`), las líneas de nivel y las cajas de riesgo/beneficio.

```pine
bool setupActivo = (estadoG == 2 or estadoG == -2) and not na(nivelEntrada)
```

Ese valor **jamás cruza a la capa de webhooks**. No hay `SETUP_BUY` ni
`SETUP_SELL` en `f_json()`, ni en el esquema Zod del bridge, ni en el CHECK
constraint de Postgres (`action = ANY (ARRAY['BUY_DUAL','SELL_DUAL','CANCEL_ALL'])`),
ni en el EA.

**Consecuencia operativa, y es grave:** el setup armado es el momento en que
existe una **orden límite pendiente real y colocable**. El disparo (`BUY_DUAL`)
ocurre cuando el precio **ya tocó** el nivel de entrada. Hoy el sistema notifica
el evento tarde: cuando el operador recibe el aviso, el precio ya pasó por el
límite. Emitir el setup armado no es una mejora cosmética, es **la corrección
que hace utilizable el flujo de órdenes pendientes**.

---

### DEFECTO 3 · El test suite puede llegar al EA
**Severidad: alta. Es la respuesta a la pregunta 3 del operador.**

**Estado actual: no hay ninguna barrera.**

`public.signals` **no tiene columna `origin` ni `is_test`**. Una señal generada
por Vitest, por un smoke test de despliegue o por un `curl` de verificación se
inserta en la misma cola, con el mismo `account_id`, y `GET /api/signals` se la
entrega al EA, que hace sonar la alerta y envía el push al móvil del trader.

Hoy la tabla está limpia (las 171 filas son `TD_CONF_LON_NY` con símbolos
reales), pero eso es **suerte operativa, no una garantía arquitectónica**. En
cuanto el test suite se ejecute contra el proyecto de producción, contaminará la
cola y disparará notificaciones falsas.

Se requiere **defensa en tres capas** (§8): esquema, endpoint y EA.

---

### DEFECTO 4 · Los umbrales muestran 0/0
**Severidad: media. Es la respuesta a la pregunta 4 del operador.**

#### Qué son los "Umbrales de Control Manual"

Son **contadores informativos de cupo diario**, no filtros. Nacen del principio
de diseño del proyecto: *nunca suprimir señales programáticamente*. Su función
es que el trader vea, en el instante en que recibe un aviso, cuánta exposición
lleva acumulada:

| Campo | Significado |
|---|---|
| `symbol_count / symbol_threshold` | Señales de entrada emitidas hoy para **ese símbolo** vs. cupo blando configurado |
| `global_count / global_threshold` | Señales de entrada emitidas hoy en **toda la cartera** vs. cupo blando |
| `exceeded` | `true` si se superó cualquiera de los dos |

`exceeded = true` marca la señal en ámbar y **la entrega igualmente**. Es una
señal de "estás fuera de tu plan de riesgo diario, decide con eso en mente", no
un bloqueo. El bloqueo duro fue eliminado deliberadamente en la v1.2 por crear
lógica autodestructiva.

#### Por qué se ve 0/0

Cadena rota en tres puntos simultáneos:

1. **El indicador no los emite.** No hay `current_symbol_count` ni equivalentes
   en `f_json()`. Y estructuralmente **no puede emitirlos bien**: los contextos
   `request.security` de los 14 slots no pueden leer variables del gráfico
   anfitrión (limitación de Pine ya documentada como decisión D4). Un contador
   global calculado en Pine sería incorrecto por construcción.
2. **El bridge no los calcula.** Las columnas `auth_symbol_count`,
   `auth_global_count`, `auth_threshold_exceeded`, `symbol_threshold_snapshot`
   y `global_threshold_snapshot` están al 100 % en `NULL`.
3. **El EA lee nombres que nadie escribe.** El EA v1.0 hace
   `JsonNumber(obj, "current_symbol_count", 0)`; como la clave no existe,
   devuelve el default `0`. El panel imprime `0/0 símbolo · 0/0 global`.

**Ese `0/0` no significa "cupo agotado" ni "cupo libre": significa contrato
incompleto.** El EA v2.0 entregado distingue explícitamente ambas situaciones
y muestra "Sin datos · el bridge no está enviando el bloque thresholds" en vez
de fingir un cero.

#### Decisión de arquitectura

**El bridge es la única fuente de verdad de los umbrales.** Motivos:

- Es la única capa con visión de cartera completa (los 14 slots + el gráfico).
- Ya tiene `public.settings` con los valores configurables y auditables.
- Ya tiene el historial completo en Postgres para contar sin ambigüedad.
- Elimina la necesidad de resolver una limitación de Pine que no tiene solución.

El indicador **deja de intentar** emitir contadores. Si en el futuro se quisiera
comparar la visión local con la autoritativa, las columnas `origin_*` quedan
disponibles, pero no son requisito de esta versión.

---

### DEFECTO 5 · `impulse_atr` siempre 0 y `grade` siempre `STANDARD`
**Severidad: media. Detectado durante la investigación, no reportado.**

La clasificación ELITE **no funciona en producción**: las 171 filas tienen
`impulse_atr = 0`, por lo que la comparación contra el umbral (2.0 × ATR) nunca
se cumple y todo se etiqueta `STANDARD`.

Causa probable, a confirmar contra el Pine vivo: el recorrido del impulso se
calcula a partir de `fin - ini`, pero en el paso 5 del motor el disparo ejecuta

```pine
if trigCompra or trigVenta
    dir := 0
    velaAct := na
```

y el JSON se construye **después**, cuando el rango del impulso ya no es
recuperable. El valor debe **congelarse en el momento en que se arma el setup**
y persistirse en una variable `var` hasta la emisión.

---

### DEFECTO 6 · `symbol_gap` y señales caducadas
**Severidad: media-baja. Operativo, no de código.**

- **6 `symbol_gap`**: `NAS100->NAS100`, `US30->US30`. El EA corre con
  `InpSymbolMap` vacío y el bróker (Tradeview MT4) nombra los índices de otra
  forma. Se resuelve rellenando el input; el EA v2.0 además intenta sufijos
  habituales (`m`, `.r`, `_i`, `micro`) antes de rendirse.
- **39 `expired`**: `queue_ttl_seconds = 300`. Se concentran en las franjas
  08:00–12:00 UTC, cuando el terminal no estaba corriendo. A partir de las
  13:00 UTC las caducidades casi desaparecen. **No es un defecto del bridge**,
  es disponibilidad del terminal. Se mitiga, no se elimina: ver §5.5.

---

## 3. CONTRATO JSON v2.0 — FUENTE DE VERDAD

### 3.1 Payload TradingView → `POST /api/webhook`

```json
{
  "account_id": "TD_CONF_LON_NY",
  "action": "SETUP_BUY",
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
  "bar_time": 1784912400000,
  "timestamp": 1784912940000,
  "schema": "2.0"
}
```

**Cambios respecto de v1.1:**

| Campo | Cambio | Razón |
|---|---|---|
| `action` | Añade `SETUP_BUY`, `SETUP_SELL`, `SETUP_CANCEL` | Defecto 2 |
| `bar_time` | **Nuevo, obligatorio.** `time` en ms (apertura de la vela) | Clave de deduplicación estable |
| `timestamp` | Pasa a ser `timenow` en ms (instante real de emisión) | Defecto 1-A |
| `schema` | **Nuevo.** Literal `"2.0"` | Permite convivencia durante el despliegue |
| `impulse_atr` | Debe llevar valor real | Defecto 5 |

`SETUP_CANCEL` reutiliza la forma reducida de `CANCEL_ALL`:

```json
{
  "account_id": "TD_CONF_LON_NY", "action": "SETUP_CANCEL",
  "symbol": "EURJPY", "tf": "15",
  "bar_time": 1784913300000, "timestamp": 1784913312000, "schema": "2.0"
}
```

`CANCEL_ALL` se mantiene como alias aceptado por retrocompatibilidad.

### 3.2 Respuesta de `GET /api/signals` → EA

```json
{
  "ok": true,
  "count": 1,
  "server_time": 1784913400000,
  "signals": [
    {
      "id": "8f1c...uuid",
      "account_id": "TD_CONF_LON_NY",
      "action": "SETUP_BUY",
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
      "bar_time": 1784912400000,
      "ts_signal": 1784912940000,
      "thresholds": {
        "symbol_count": 2,
        "symbol_threshold": 10,
        "global_count": 7,
        "global_threshold": 100,
        "exceeded": false
      },
      "is_test": false,
      "env": "production",
      "origin": "tradingview"
    }
  ]
}
```

El objeto `thresholds` es **obligatorio en toda entrada y setup**. Si por
cualquier razón no puede calcularse, debe omitirse **entero** — nunca enviarse
con ceros. El EA distingue ambos casos.

`is_test`, `env` y `origin` son la última barrera de la defensa en profundidad:
aunque el filtrado del endpoint fallara, el EA v2.0 pone en cuarentena todo lo
que no sea `is_test:false` + `env:"production"` + `origin:"tradingview"`.

### 3.3 ⚠️ Orden de despliegue obligatorio

Los fixes 1-A y 1-C están acoplados. Si se cambia `time` → `timenow` **sin**
migrar antes la clave de deduplicación, cada duplicado de TradingView pasará el
filtro (porque `timestamp` diferirá en milisegundos) y el trader recibirá cada
alerta **por duplicado**, con sonido y push. Regresión peor que el defecto.

**Secuencia estricta:**

1. Migración SQL: añadir `bar_time`, crear el nuevo índice único sobre
   `(symbol, action, bar_time)`, **conservando** el índice anterior.
2. Desplegar el bridge aceptando `bar_time` opcional (con fallback
   `bar_time = timestamp` si el payload es `schema` v1.x).
3. Verificar en producción que llegan filas con `bar_time` poblado.
4. Solo entonces, publicar el Pine v2.0 con `timenow`.
5. Eliminar el índice único antiguo.

---

## 4. CAMBIOS EN EL INDICADOR (Pine Script v6)

> **Higiene previa:** exportar el Pine actualmente publicado en TradingView y
> commitearlo como `indicator/td_confluence_lon_ny_v1_1.pine` **antes** de
> tocar nada. El archivo del repositorio es la v1.0 y no coincide con producción.

### 4.1 Timestamps (Defecto 1-A)

```pine
f_json(string accion, string simbolo, string tipoOrden, string calidad,
       float impAtr, float en, float sl_, float t1, float t2,
       float l1, float l2) =>
    '{"account_id":"TD_CONF_LON_NY"' +
    ',"action":"'      + accion            + '"' +
    ',"symbol":"'      + simbolo           + '"' +
    ',"tf":"'          + timeframe.period  + '"' +
    ',"type":"'        + tipoOrden         + '"' +
    ',"grade":"'       + calidad           + '"' +
    ',"impulse_atr":'  + str.tostring(impAtr, "#.###") +
    ',"price":'        + str.tostring(en)  +
    ',"sl":'           + str.tostring(sl_) +
    ',"partial_1":{"lots":' + str.tostring(l1) + ',"tp":' + str.tostring(t1) + '}' +
    ',"partial_2":{"lots":' + str.tostring(l2) + ',"tp":' + str.tostring(t2) + '}' +
    ',"risk_usd":'     + str.tostring(montoArriesgar) +
    ',"bar_time":'     + str.tostring(time)    +   // apertura de vela → dedup
    ',"timestamp":'    + str.tostring(timenow) +   // instante real → frescura
    ',"schema":"2.0"}'
```

Aplicar el mismo par `bar_time` / `timestamp` a `f_jsonCancel()`.

### 4.2 Eventos de setup armado (Defecto 2)

`f_engine()` debe exponer un evento adicional. Añadir estado local y ampliar la
tupla de retorno:

```pine
f_engine(bool bloqueado) =>
    // ... estado existente ...
    var int   dirPrev        = 0
    var float impAtrArmado   = 0.0     // Defecto 5: congelar al armar

    // ... pasos 1 a 4 sin cambios ...

    // Congelar la calidad del impulso en el instante del armado
    if (dir == 2 or dir == -2) and dirPrev != dir
        float recorrido = math.abs(fin - ini)
        impAtrArmado := atrValor > 0 ? recorrido / atrValor : 0.0

    // Evento de setup recién armado (detección de flanco)
    int eventoSetup = ((dir == 2 or dir == -2) and dirPrev != dir) ? dir : 0
    dirPrev := dir

    // ... paso 5: gatillos y expiración, sin cambios ...

    [senal, estado, entrada, sl, tp1, tp2, l1, l2, tradesHoy, eventoSetup, impAtrArmado]
```

Puntos de cuidado, con precedente en este proyecto:

- **La detección de flanco es obligatoria.** Sin ella, el setup reemitiría en
  cada barra mientras `dir` permanezca en `±2`.
- **`dirPrev := dir` debe ir al final del bloque**, después de calcular
  `eventoSetup`. El bug histórico B3 de este proyecto fue exactamente un
  problema de orden de bloques.
- **`impAtrArmado` debe ser `var`.** Si no persiste, el paso 5 resetea `dir := 0`
  al disparar y el valor se pierde — que es justamente el Defecto 5.
- `f_slot()` debe reenviar `eventoSetup` e `impAtrArmado` para que los 14 slots
  emitan setups, no solo el gráfico anfitrión.

Emisión:

```pine
f_grade(float impAtr) => impAtr >= umbralElite ? "ELITE" : "STANDARD"

// Gráfico anfitrión
if eventoSetupG == 2
    alert(f_json("SETUP_BUY", syminfo.ticker, "LIMIT", f_grade(impAtrG), impAtrG,
                 nivelEntrada, nivelSL, nivelTP1, nivelTP2, loteTP1, loteTP2),
          alert.freq_once_per_bar)

if eventoSetupG == -2
    alert(f_json("SETUP_SELL", syminfo.ticker, "LIMIT", f_grade(impAtrG), impAtrG,
                 nivelEntrada, nivelSL, nivelTP1, nivelTP2, loteTP1, loteTP2),
          alert.freq_once_per_bar)
```

Los disparos `BUY_DUAL` / `SELL_DUAL` se mantienen: son eventos distintos y
ambos son útiles. El setup dice "coloca la pendiente"; el disparo dice "el
precio tocó tu nivel". Un `SETUP_CANCEL` sustituye a `CANCEL_ALL` cuando el
setup expira sin ser tocado.

### 4.3 Umbral ELITE

Exponer como input:

```pine
umbralElite = input.float(2.0, title="⭐ Umbral ELITE (× ATR)",
                          minval=1.0, maxval=6.0, step=0.1,
                          group="⚡ IMPULSO")
```

Añadir al dashboard una fila "Calidad setup" que muestre
`str.tostring(impAtrG, "#.##") + "× ATR"` para poder calibrar el umbral con
datos reales.

### 4.4 Presupuesto de llamadas `request.security`

Recuento actual: 14 slots + 1 correlación + motor del gráfico ≈ 16. El límite de
Pine es 40. Los cambios de esta sección **no añaden llamadas nuevas**, solo
amplían las tuplas de retorno. Verificar tras compilar y dejar constancia del
tiempo de carga inicial (histórico: 10–30 s).

### 4.5 Alertas en TradingView (Defecto 1-C)

**Acción manual del operador, no de código.** En TradingView:

1. Abrir el gestor de alertas.
2. Confirmar que existe **exactamente una** alerta sobre este indicador con
   condición "Any alert() function call".
3. Eliminar cualquier duplicado.
4. Verificar que la URL del webhook está marcada y apunta a
   `https://brige.pessaro.cl/api/webhook`.
5. Vigilar la caducidad (~2 meses en plan Essential) y que el navegador
   permanezca abierto (las alertas server-side requieren Premium).

Verificación posterior con la query de §11.4: los `duplicate` deben caer a cero.

---

## 5. CAMBIOS EN EL BRIDGE (Next.js / TypeScript / Vercel)

### 5.1 Esquema Zod de `/api/webhook`

```ts
const AccionEntrada = z.enum(["BUY_DUAL", "SELL_DUAL", "SETUP_BUY", "SETUP_SELL"]);
const AccionCancel  = z.enum(["CANCEL_ALL", "SETUP_CANCEL"]);

const Parcial = z.object({ lots: z.number(), tp: z.number() });

const SenalEntrada = z.object({
  account_id : z.string(),
  action     : AccionEntrada,
  symbol     : z.string().min(1).max(20),
  tf         : z.string().optional(),
  type       : z.enum(["LIMIT", "STOP", "MARKET"]).default("LIMIT"),
  grade      : z.enum(["ELITE", "STANDARD"]).default("STANDARD"),
  impulse_atr: z.number().nonnegative().default(0),
  price      : z.number(),
  sl         : z.number(),
  partial_1  : Parcial,
  partial_2  : Parcial,
  risk_usd   : z.number().positive(),
  bar_time   : z.number().int().optional(),   // ← opcional durante la transición
  timestamp  : z.number().int(),
  schema     : z.string().optional(),
});

const SenalCancel = z.object({
  account_id: z.string(),
  action    : AccionCancel,
  symbol    : z.string().min(1).max(20),
  tf        : z.string().optional(),
  bar_time  : z.number().int().optional(),
  timestamp : z.number().int(),
  schema    : z.string().optional(),
});

const Senal = z.discriminatedUnion("action", [ /* … */ ]);
```

**Reglas de normalización en el handler:**

- `barTime = payload.bar_time ?? payload.timestamp` (compatibilidad v1.x).
- La comprobación de frescura usa **`timestamp`**, nunca `bar_time`.
- La deduplicación usa **`bar_time`**, nunca `timestamp`.
- Rechazar con `400` si `Math.abs(timestamp - Date.now()) > 3_600_000`: un
  desfase de más de una hora indica reloj roto, no señal tardía.
- Actualizar `tokens.last_used_at` para `kind='tv_webhook'` en cada request
  autenticado (§1.6).

### 5.2 Cálculo autoritativo de umbrales (Defecto 4)

En el momento del ingest, tras validar y antes de insertar. Idealmente dentro de
la misma función RPC transaccional que hace el insert, para evitar carreras.

```sql
create or replace function public.calc_thresholds(p_symbol text)
returns table (
  symbol_count int, global_count int,
  symbol_threshold int, global_threshold int,
  exceeded boolean
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with cfg as (
    select symbol_threshold, global_threshold from public.settings where id = 1
  ),
  hoy as (
    select * from public.signals
    where created_at >= date_trunc('day', now() at time zone 'America/New_York')
                        at time zone 'America/New_York'
      and action in ('BUY_DUAL','SELL_DUAL','SETUP_BUY','SETUP_SELL')
      and status not in ('rejected_technical')
      and coalesce(is_test, false) = false
  )
  select
    (select count(*)::int from hoy where hoy.symbol = p_symbol),
    (select count(*)::int from hoy),
    cfg.symbol_threshold,
    cfg.global_threshold,
    (select count(*) from hoy where hoy.symbol = p_symbol) >= cfg.symbol_threshold
      or (select count(*) from hoy) >= cfg.global_threshold
  from cfg;
$$;

grant execute on function public.calc_thresholds(text) to service_role;
```

> **Recordatorio con precedente en este proyecto:** un `GRANT` ausente a
> `service_role` produce `permission denied` silencioso en lugar de un 500
> visible. Verificar los grants explícitamente después de aplicar la migración.

Persistir el resultado en `auth_symbol_count`, `auth_global_count`,
`auth_threshold_exceeded`, `symbol_threshold_snapshot`, `global_threshold_snapshot`.

**El resultado nunca suprime la señal.** `exceeded = true` es un adjetivo, no un
verbo. Escribir un test que falle si algún camino de código llega a descartar
una señal por umbral.

### 5.3 `GET /api/signals`

- Filtrar **siempre**: `is_test = false AND origin = 'tradingview'`.
- Serializar el objeto `thresholds` desde las columnas `auth_*` y los snapshots.
  Si alguna es `NULL`, **omitir el objeto entero** — no rellenar con ceros.
- Incluir `bar_time`, `ts_signal`, `is_test`, `env`, `origin`.
- Ampliar `claim_signals` para que las nuevas acciones sean reclamables.
- Añadir `server_time` a la respuesta, para que el EA pueda detectar deriva de
  reloj entre el terminal y el bridge.

### 5.4 Panel `/status`

Añadir, con la identidad Pessaro Capital (`#0c0f1a`, dorado `#c9a84c`,
Playfair Display / DM Sans / DM Mono):

- **Embudo de entrega**: recibidas → validadas → encoladas → notificadas, con
  el desglose de rechazos por motivo. Este panel habría hecho evidente el
  problema de `stale` en el primer día.
- **Histograma de latencia** `timestamp → created_at`, con la línea de
  `freshness_seconds` marcada.
- **Estado del EA**: `tokens.last_used_at` para `kind='ea'` y semáforo.
- **Cupos del día** por símbolo y de cartera, con las mismas barras del EA.
- **Filtro de origen** (`tradingview` / `test` / `manual`) por defecto en
  `tradingview`, con un badge visible cuando se está viendo tráfico de prueba.

### 5.5 Mitigación de caducidades

`queue_ttl_seconds = 300` es correcto para no notificar señales rancias. Se
mantiene. Añadir en su lugar:

- Cuando una señal pasa a `expired`, registrar un evento `audit` con el tiempo
  que estuvo en cola y si el EA había hecho polling en ese intervalo.
- En `/status`, un aviso claro cuando `tokens.last_used_at` (kind `ea`) lleve
  más de 120 s sin actualizarse durante la ventana LON→NY. La causa real de las
  39 caducidades es el terminal apagado, y eso solo se corrige haciéndolo visible.

---

## 6. MIGRACIONES DE SUPABASE

Proyecto `clyhqxzrmakteuraeaau`. Ejecutar en orden. Cada una como migración
versionada con `search_path` fijo (el proyecto ya tuvo que corregir esto en la
migración 002; no repetir el error).

### Migración 003 — `bar_time` y deduplicación

```sql
alter table public.signals add column if not exists bar_time bigint;

update public.signals set bar_time = ts_signal where bar_time is null;

create unique index if not exists signals_dedup_bar_time
  on public.signals (symbol, action, bar_time)
  where status <> 'rejected_technical';

-- El índice antiguo sobre (symbol, action, ts_signal) se conserva hasta
-- completar el paso 5 de §3.3, y solo entonces se elimina.
```

### Migración 004 — Nuevas acciones

```sql
alter table public.signals drop constraint if exists signals_action_check;

alter table public.signals add constraint signals_action_check
  check (action = any (array[
    'BUY_DUAL', 'SELL_DUAL', 'CANCEL_ALL',
    'SETUP_BUY', 'SETUP_SELL', 'SETUP_CANCEL'
  ]));
```

### Migración 005 — Aislamiento del test suite

```sql
alter table public.signals
  add column if not exists origin  text not null default 'tradingview',
  add column if not exists is_test boolean not null default false,
  add column if not exists env     text not null default 'production';

alter table public.signals add constraint signals_origin_check
  check (origin = any (array['tradingview','test','manual','replay']));

-- Coherencia forzada por la base, no por la aplicación
alter table public.signals add constraint signals_test_coherence
  check ( (origin = 'tradingview' and is_test = false and env = 'production')
       or (origin <> 'tradingview') );

create index if not exists signals_delivery_idx
  on public.signals (status, created_at)
  where is_test = false and origin = 'tradingview';
```

### Migración 006 — Umbrales autoritativos

`create or replace function public.calc_thresholds(...)` de §5.2, más el
`GRANT ... TO service_role`.

### Migración 007 — Vista de entrega para el EA

```sql
create or replace view public.signals_deliverable as
  select * from public.signals
  where is_test = false
    and origin  = 'tradingview'
    and env     = 'production';

grant select on public.signals_deliverable to service_role;
```

`claim_signals` debe pasar a operar sobre esta vista (o replicar sus tres
condiciones en el `WHERE`). Objetivo: que sea **imposible por construcción**
que `/api/signals` sirva una fila de prueba.

---

## 7. EXPERT ADVISOR v2.0

El archivo `PessaroBridgeEA_v2.mq4` se entrega **por separado**, ya
implementado. Cambios incorporados:

| Ref | Cambio | Defecto |
|---|---|---|
| R1 | Lee `type` y muestra `BUY LIMIT` / `SELL LIMIT` en panel, alerta y push | 1-B |
| R2 | Acepta `SETUP_BUY` / `SETUP_SELL` / `SETUP_CANCEL`, diferenciados en el panel (`◇` armado vs `◆` disparado) | 2 |
| R3 | Lee el objeto `thresholds` con fallback al contrato plano v1 | 4 |
| R4 | Cuarentena por `is_test` / `env` / `origin` / `account_id` | 3 |
| R5 | Estado ONLINE/OFFLINE corregido | — |
| R6 | Reloj de polling basado en `GetTickCount()` | — |
| R7 | Panel premium con identidad Pessaro Capital + franja inferior | 5 (pregunta 5) |
| R8 | Muestra `grade` e `impulse_atr`, marca ELITE con `★` | 5 |

### 7.1 Dos defectos del EA v1.0 detectados durante la investigación

**El estado siempre decía OFFLINE.** El v1.0 evaluaba:

```mql4
bool online = (g_lastPollAt > 0) && (TimeCurrent() - g_lastPollAt < 10);
```

Fuera de la ventana operativa el polling es de 30 s, con lo que la condición
`< 10` es falsa el 66 % del tiempo aun con el puente perfectamente sano. Con
backoff exponencial tras un fallo, la tolerancia llegaba a 300 s contra una
ventana de 10 s: OFFLINE permanente. El v2.0 usa
`tolerancia = intervalo_vigente × 2 + 5`.

**El polling podía congelarse.** El v1.0 usaba `TimeCurrent()` como reloj.
`TimeCurrent()` devuelve la hora del **último tick recibido** y no avanza si el
símbolo del gráfico no cotiza (fin de semana, instrumento ilíquido, feriado del
bróker). Si el EA está adjunto a un gráfico tranquilo, el planificador deja de
disparar. El v2.0 usa `GetTickCount()` para la cadencia y `TimeLocal()` para las
marcas de tiempo mostradas.

### 7.2 Diseño del panel premium

Inspirado en el panel de referencia aportado por el operador (Wyckoff + Fib MA
Pro), reinterpretado con la identidad de Pessaro Capital:

```
┌────────────────────────────────────────────────────────────┐
│ ⬥ PESSARO BRIDGE · DISPATCHER              ● ONLINE   v2.0 │  ← cabecera dorada
├────────────────────────────────────────────────────────────┤
│ ──────────────── ESTADO DEL PUENTE ─────────────────       │
│ Ventana:        LON→NY ACTIVA  ·  poll 2s                  │
│ Último poll:    17:42:31   (hace 2s)                       │
│ Fallos consec.: 0                                          │
│ Endpoint:       https://brige.pessaro.cl                   │
│ Modo:           DESPACHADOR MANUAL · cero OrderSend        │
│                                                            │
│ ────────── UMBRALES DE CONTROL MANUAL ──────────           │
│ SÍMBOLO XAUUSD  ███░░░░░░░░░                   2/10        │  ← gauge
│ CARTERA         █░░░░░░░░░░░                   7/100       │
│ ✓ Dentro de los umbrales configurados                      │
│                                                            │
│ ────────── FLUJO DE SEÑALES · SESIÓN ──────────            │
│ Recibidas 12    Setups 5     Disparos 4                    │
│ Cancel. 3       Cuarentena 0  Symbol-gap 0                 │
│                                                            │
│ ─────────────── ÚLTIMOS EVENTOS ────────────────           │
│ HH:MM  SÍMBOLO     TIPO       ENTRADA   SL        LOTES    │
│ 17:41  XAUUSD      ◇★BUY LIMIT 4113.257 4106.839  0.60+0.40│
│ 17:15  EURJPY      ◆ SELL LIMIT 186.240 186.580   0.12+0.08│
│ 16:45  UK100       CANCELADO — retira pendientes           │
│ ◇ setup armado (pendiente)   ◆ disparado   ★ ELITE         │
└────────────────────────────────────────────────────────────┘

  PUENTE: ONLINE │ VENTANA: LON→NY ACTIVA │ ÚLTIMA: XAUUSD BUY LIMIT @ 4113.257 │ CUPOS: 2/10 · 7/100 │ EVENTOS: 12
  ↑ franja inferior fija, ancho completo
```

Implementación: `OBJ_RECTANGLE_LABEL` para el chasis y `OBJ_LABEL` en Consolas
para el texto. Paleta exacta de marca definida como constantes `PC_*` en la
cabecera del archivo.

### 7.3 Configuración obligatoria al instalar

1. `InpEaToken` = valor de `EA_TOKEN` en Vercel.
2. URL permitida en Herramientas > Opciones > Expert Advisors > WebRequest.
3. **`InpSymbolMap` es obligatorio**: el default trae un mapeo de partida, pero
   debe ajustarse a los nombres reales de la cuenta Tradeview MT4 (la evidencia
   muestra `NAS100` y `US30` inexistentes con ese nombre). Verificar uno por
   uno en Observación del Mercado.
4. `InpBrokerToNyOffsetHours`: calcular como
   `hora_NY − hora_servidor_MT4` y revisarlo en cada cambio de DST.
5. `InpRejectTestSignals = true` en producción, **siempre**.

---

## 8. AISLAMIENTO DEL TEST SUITE — DEFENSA EN TRES CAPAS

Respuesta completa a la pregunta 3 del operador. Una sola capa no basta: el
riesgo es que el trader reciba un push al móvil por una señal falsa y actúe
sobre ella.

### Capa 1 · Base de datos (imposibilidad estructural)

- Columnas `origin`, `is_test`, `env` con `NOT NULL` y defaults (migración 005).
- `CHECK` de coherencia: `origin='tradingview'` obliga a
  `is_test=false AND env='production'`.
- Vista `signals_deliverable` y `claim_signals` operando **solo** sobre ella.

### Capa 2 · Bridge (segregación en el ingest)

- `/api/webhook` deriva `origin` del **tipo de token**, no de un campo del
  payload: el token `tv_webhook` produce `origin='tradingview'`; cualquier otro
  camino produce `origin='test'` o `'manual'`.
- Nunca aceptar `origin` desde el body: sería trivialmente falsificable.
- `/api/signals` filtra por la vista. Si alguien pide explícitamente
  `?include_test=true`, exigir el token `operator`, **nunca** el `ea`.
- Variable de entorno `PESSARO_ENV`; si distinto de `production`, marcar todo
  el tráfico como `is_test=true` automáticamente.

### Capa 3 · EA (cuarentena en el receptor)

Ya implementada en el v2.0 (`IsQuarantined()`): descarta `is_test`,
`env != production`, `origin ∈ {test, vitest, e2e, fixture}` y `account_id`
distinto del configurado. Las cuarentenas se **contabilizan y muestran** en el
panel, y se ackean como `notified` con el motivo, para que quede rastro en
`audit` sin bloquear la cola.

### Política de ejecución de Vitest

- **Prohibido** apuntar Vitest al proyecto de producción.
- Usar `Supabase branch` (`create_branch`) para las pruebas de integración, o un
  proyecto separado. Las migraciones se aplican solas sobre la rama.
- Los tests que necesiten tocar producción (smoke post-deploy) deben insertar
  con `origin='test'` y verificar **explícitamente** que
  `GET /api/signals` **no** devuelve la fila. Ese es el test más importante de
  toda la suite.
- Añadir un test de regresión: "una señal con `is_test=true` nunca aparece en la
  respuesta de `/api/signals` con token de EA".

---

## 9. CRITERIOS DE ACEPTACIÓN

Cada punto debe verificarse con evidencia (query SQL o captura), no por
inspección de código.

| # | Criterio | Verificación |
|---|---|---|
| 1 | Cero rechazos `stale` en 48 h de operación | §11.1 |
| 2 | Cero rechazos `duplicate` tras eliminar la alerta redundante | §11.4 |
| 3 | Aparecen filas con `action IN ('SETUP_BUY','SETUP_SELL')` | §11.2 |
| 4 | El EA muestra `BUY LIMIT` / `SELL LIMIT`, no `BUY` / `SELL` | Captura del panel |
| 5 | `auth_symbol_count` y `auth_global_count` no nulos en toda entrada nueva | §11.3 |
| 6 | El panel del EA muestra barras de cupo con valores reales | Captura |
| 7 | Una señal `exceeded=true` **se entrega igualmente**, marcada en ámbar | Test e2e |
| 8 | `impulse_atr > 0` y existe al menos un `grade='ELITE'` | §11.5 |
| 9 | Una fila con `is_test=true` **nunca** aparece en `/api/signals` | Test automatizado |
| 10 | El EA muestra ONLINE de forma estable dentro y fuera de la ventana | Observación 1 h |
| 11 | Cero `symbol_gap` con el `InpSymbolMap` configurado | §11.6 |
| 12 | Ratio `notified / total` > 85 % en una sesión completa | §11.1 |
| 13 | `grep -rn "OrderSend\|OrderModify\|OrderDelete\|OrderClose" *.mq4` → sin resultados | Comando |
| 14 | `tokens.last_used_at` se actualiza para `kind='tv_webhook'` | §11.7 |

El criterio 13 no es negociable y debe integrarse como paso de CI.

---

## 10. PLAN DE EJECUCIÓN

### Fase 0 · Higiene (antes de tocar código)
1. Exportar el Pine vivo de TradingView y commitearlo. El repo está desfasado.
2. Congelar el estado actual de `signals` con un `pg_dump` de la tabla.
3. Eliminar la alerta duplicada en TradingView (§4.5) y **medir el efecto
   aislado durante 24 h**. Debería eliminar 60 de 171 rechazos sin escribir una
   sola línea de código.

### Fase 1 · Base de datos
Migraciones 003 a 007. Verificar grants a `service_role`.

### Fase 2 · Bridge
Zod v2.0, normalización `bar_time`, `calc_thresholds`, filtrado por la vista,
`last_used_at` del token TV. Desplegar. **Confirmar que sigue aceptando el
payload v1.x sin romperse.**

### Fase 3 · Indicador
Pine v2.0 con `timenow`, `bar_time`, eventos de setup, `impulse_atr` congelado.
Publicar. Confirmar que el índice de dedup nuevo está activo **antes** de este
paso (§3.3).

### Fase 4 · EA
Instalar `PessaroBridgeEA_v2.mq4`, configurar `InpSymbolMap` contra la lista
real de símbolos del bróker, validar el panel.

### Fase 5 · Observación
48 h de operación real. Recolectar las queries de §11 y comparar contra la línea
base de §1. Documentar los resultados en `MEMORIA_PROYECTO.md`.

### Fase 6 · Limpieza
Eliminar el índice de dedup antiguo. Retirar el fallback `bar_time = timestamp`
del bridge una vez confirmado que ningún payload v1.x sigue llegando.

---

## 11. ANEXO · QUERIES DE VERIFICACIÓN

### 11.1 Embudo de entrega
```sql
select status, error, count(*) n,
       round(100.0 * count(*) / sum(count(*)) over (), 1) pct
from public.signals
where created_at > now() - interval '48 hours'
group by 1, 2 order by n desc;
```

### 11.2 Eventos de setup
```sql
select action, count(*) n, min(created_at) prim, max(created_at) ult
from public.signals
where action like 'SETUP%'
group by 1;
```

### 11.3 Cobertura de umbrales
```sql
select count(*) total,
       count(auth_symbol_count) con_umbral,
       count(*) - count(auth_symbol_count) sin_umbral
from public.signals
where created_at > now() - interval '48 hours'
  and action in ('BUY_DUAL','SELL_DUAL','SETUP_BUY','SETUP_SELL');
```

### 11.4 Latencia y duplicados
```sql
select action, count(*) n,
       round(avg(extract(epoch from (created_at - to_timestamp(ts_signal/1000.0))))::numeric, 1) lag_medio,
       max(extract(epoch from (created_at - to_timestamp(ts_signal/1000.0)))::int) lag_max,
       sum((error = 'stale')::int)     stale,
       sum((error = 'duplicate')::int) duplicados
from public.signals
where created_at > now() - interval '48 hours'
group by 1;
```

### 11.5 Clasificación ELITE
```sql
select grade, count(*) n,
       round(min(impulse_atr), 2) min_atr,
       round(avg(impulse_atr), 2) med_atr,
       round(max(impulse_atr), 2) max_atr
from public.signals
where action in ('BUY_DUAL','SELL_DUAL','SETUP_BUY','SETUP_SELL')
  and created_at > now() - interval '48 hours'
group by 1;
```

### 11.6 Symbol gaps
```sql
select symbol, error, count(*) n
from public.signals
where status = 'error' and error like 'symbol_gap%'
group by 1, 2 order by n desc;
```

### 11.7 Salud de tokens
```sql
select kind, last_used_at, now() - last_used_at antiguedad
from public.tokens order by kind;
```

### 11.8 Fugas del test suite (debe devolver 0)
```sql
select count(*) as fugas
from public.signals
where (is_test or origin <> 'tradingview')
  and status in ('claimed','notified');
```

---

## 12. RESTRICCIONES PERMANENTES

1. **El EA no ejecuta.** Cero llamadas de órdenes. Verificado por CI.
2. **Nunca suprimir señales por umbral.** Los umbrales informan, no filtran.
3. **`origin` nunca se lee del body del webhook.** Se deriva del token.
4. **Vitest no toca producción.** Rama de Supabase o proyecto separado.
5. **Los `lots` del JSON son referenciales.** El EA recalcula siempre con
   `MarketInfo` del símbolo real del bróker.
6. **Umbrales fijos en pips están prohibidos** en sistemas multi-instrumento
   (aprendizaje D1: el impulso debe ser adaptativo por ATR).
7. **Toda función SQL lleva `search_path` fijo** y `GRANT` explícito a
   `service_role`.
8. **`MEMORIA_PROYECTO.md` se actualiza** al cerrar cada fase.

---

*Pessaro Capital · Meta-prompt v3.0 · 24 de julio de 2026*
