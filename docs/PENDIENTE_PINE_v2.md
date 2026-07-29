# Pendiente en TradingView — Pine v2.0

**Estado: sin publicar.** Es la causa raíz de que los setups del indicador no se
reflejen en MT4, y no se puede arreglar desde este repo: el indicador vive en
TradingView.

## La evidencia, contra producción (2026-07-29)

```sql
-- 0 filas en todo el histórico
select count(*) from public.signals where action like 'SETUP%';

-- Las 5 señales más recientes: sin `schema`, sin `bar_time`,
-- y ts_signal == bar_time == apertura exacta de vela de 15m
select action, symbol, raw->>'schema', raw ? 'bar_time', ts_signal, bar_time
from public.signals order by created_at desc limit 5;
```

Conclusión: **el indicador publicado sigue siendo el v1.x.** El bridge acepta
`SETUP_BUY` / `SETUP_SELL` / `SETUP_CANCEL` desde la migración 008, la base los
admite en el CHECK, `toEaPayload()` los traduce, `/status` los pinta con `◇` y el
EA v2.0 los procesa. Toda la cadena está lista y **nadie los emite**.

Daño colateral del mismo defecto (1-A, `timestamp` = apertura de vela en vez de
`timenow`), medido sobre el histórico:

| Rechazo | Filas |
|---|---|
| `stale` (el disparo intrabarra llega con hasta 897 s de "retraso" aparente) | 149 |
| `duplicate` (el lote entero se reemite ~9 s después) | 215 |

## Qué hay que cambiar, en orden

El detalle completo con los bloques de Pine está en
`docs/metaprompt_pessaro_bridge_v3_despachador.md` §4.1–4.3 y en
`METAPROMPT_PESSARO_BRIDGE_v3.md` §4. Resumen accionable:

### 1. `f_json()` y `f_jsonCancel()` — separar frescura de dedup

```pine
',"bar_time":'  + str.tostring(time)    +   // apertura de vela → dedup
',"timestamp":' + str.tostring(timenow) +   // instante real → frescura
',"schema":"2.0"}'
```

`timestamp` pasa de `time` a `timenow`. Es el arreglo del defecto 1-A.

### 2. `f_engine()` — emitir el armado, con detección de flanco

Ampliar la tupla de retorno con `eventoSetup` e `impAtrArmado`:

```pine
var int   dirPrev      = 0
var float impAtrArmado = 0.0

if (dir == 2 or dir == -2) and dirPrev != dir
    float recorrido = math.abs(fin - ini)
    impAtrArmado := atrValor > 0 ? recorrido / atrValor : 0.0

int eventoSetup = ((dir == 2 or dir == -2) and dirPrev != dir) ? dir : 0
dirPrev := dir   // AL FINAL del bloque, después de calcular eventoSetup
```

Tres cuidados, los tres con precedente de bug en este proyecto:

- **La detección de flanco es obligatoria.** Sin ella el setup se reemite en
  cada barra mientras `dir` siga en `±2`.
- **`dirPrev := dir` va al final.** El bug histórico B3 fue exactamente un
  problema de orden de bloques.
- **`impAtrArmado` tiene que ser `var`.** El paso 5 resetea `dir := 0` al
  disparar; sin `var` el valor se pierde (defecto 5).

`f_slot()` debe reenviar ambos valores o solo emitirá setups el gráfico
anfitrión, no los 14 slots.

### 3. Emisión

```pine
f_grade(float impAtr) => impAtr >= umbralElite ? "ELITE" : "STANDARD"

if eventoSetupG == 2
    alert(f_json("SETUP_BUY", syminfo.ticker, "LIMIT", f_grade(impAtrG), impAtrG,
                 nivelEntrada, nivelSL, nivelTP1, nivelTP2, loteTP1, loteTP2),
          alert.freq_once_per_bar)

if eventoSetupG == -2
    alert(f_json("SETUP_SELL", ...), alert.freq_once_per_bar)
```

`BUY_DUAL` / `SELL_DUAL` **se mantienen**: son eventos distintos y ambos sirven.
El armado dice "coloca la pendiente"; el disparo dice "el precio tocó tu nivel".

### 4. Limpiar las alertas duplicadas en TradingView

Hay más de una alerta activa sobre el mismo indicador con **"Any alert()
function call"**, y cada una envía el lote completo. Hoy lo tapa el índice de
dedup por `bar_time`.

> ⚠ **Orden de despliegue obligatorio.** Esta limpieza va **antes o junto** con
> el punto 1. Mientras `timestamp` sea la apertura de vela, los duplicados
> comparten valor y el índice los frena. En cuanto pase a `timenow`, cada
> reemisión trae un valor distinto en milisegundos, pasa el dedup, y el trader
> recibe **cada alerta dos veces con sonido y push** — una regresión peor que el
> defecto original. La migración `007_bar_time.sql` documenta esto y por eso
> conserva el índice viejo junto al nuevo.

## Cómo verificar que quedó bien

```sql
-- Deben aparecer filas, y con schema '2.0'
select action, symbol, raw->>'schema' as schema, bar_time, ts_signal,
       ts_signal - bar_time as lag_intrabarra_ms
from public.signals
where action like 'SETUP%'
order by created_at desc limit 20;
```

- `lag_intrabarra_ms > 0` en los disparos confirma que `timestamp` ya es
  `timenow` (con Pine v1.x este valor es siempre 0).
- En `/status`, las filas de armado se distinguen con `◇ SETUP BUY` / `◇ SETUP SELL`.
- En MT4 (EA v2.0), el panel muestra `◇ BUY LIMIT` para el armado y
  `◆ BUY LIMIT` para el disparo.
- Los armados que se cancelen dentro de `setup_hold_seconds` **no** deben sonar
  en el terminal: quedan como `SUPRIMIDA` en `/status` y con un evento
  `setup_suppressed` en `audit` (migración 016).
