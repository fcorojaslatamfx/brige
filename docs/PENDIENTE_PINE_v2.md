# Pendiente en TradingView — Pine v2.0

**Estado: escrito, sin publicar.** El código ya vive en el repo
(`tradingview/TD_Confluence_LON_NY_v2.pine`) y emite todo lo que el bridge
espera. Lo que falta no se puede hacer desde aquí: **el indicador corre en
TradingView y hay que pegarlo, guardarlo y dejar una sola alerta viva.**

Mientras eso no ocurra sigue publicado el v1.x y no habrá setups en MT4.

## Qué ya está resuelto en el archivo

Los cuatro puntos que este documento pedía están implementados. Se dejan
anotados con el porqué, porque son el tipo de detalle que se pierde al
recompaginar el script:

1. **`timestamp` = `timenow` y `bar_time` = `time`** (`f_json` / `f_jsonCancel`),
   más `"schema":"2.0"`. Separa frescura de dedup — el defecto 1-A.
2. **Armado con detección de flanco** en `f_engine`: `dirPrev` comparado contra
   `dir`, `dirPrev := dir` **al final** de la función (después de que el paso 5
   pueda resetear `dir`), e `impAtrArm` declarado `var` para que sobreviva a ese
   reset. Sin el flanco el setup se reemitiría en cada vela; sin el `var`, un
   disparo en la misma vela del armado reportaría impulso 0.
3. **Emisión** de `SETUP_BUY` / `SETUP_SELL` y de `SETUP_CANCEL` al expirar, en
   el gráfico anfitrión y en los 14 slots (`f_slot` reenvía `eventoSetup` e
   `impulsoATR`). `BUY_DUAL` / `SELL_DUAL` se mantienen: el armado dice "coloca
   la pendiente", el disparo dice "el precio tocó tu nivel".
4. **`grade` / `impulse_atr`** con umbral ELITE configurable, y `risk_usd`
   calculado con el perfil de cada símbolo en vez del gráfico anfitrión.

## Lo que falta hacer, en orden

### 1. Limpiar las alertas duplicadas — ANTES o junto con el paso 2

Hay más de una alerta activa sobre el mismo indicador con **"Any alert()
function call"**, y cada una envía el lote completo.

> ⚠ **Orden obligatorio.** Mientras `timestamp` sea la apertura de vela, los
> duplicados comparten valor y el índice viejo de dedup los frena. Publicar el
> v2.0 sin limpiar deja cada reemisión con un `timenow` distinto en
> milisegundos; el dedup nuevo por `bar_time` las sigue tapando, pero cualquier
> alerta de más ya no aporta nada y consume cupo de la cuenta. La migración
> `007_bar_time.sql` documenta por qué se conservan los dos índices.

### 2. Publicar el indicador

1. Pine Editor → pegar el contenido de `tradingview/TD_Confluence_LON_NY_v2.pine`.
2. Guardar y **Añadir al gráfico** (uno solo, con la watchlist en los 14 slots).
3. Crear **una** alerta: condición "Any alert() function call", webhook a
   `https://brige.pessaro.cl/api/webhook?token=<TV_WEBHOOK_TOKEN>`.

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
- En MT4 (EA v2.1), el panel muestra `◇ BUY LIMIT` para el armado y
  `◆ BUY LIMIT` para el disparo, y la señal aparece en el CSV de `MQL4/Files`.
- Los armados que se cancelen dentro de `setup_hold_seconds` **no** deben sonar
  en el terminal: quedan como `SUPRIMIDA` en `/status` y con un evento
  `setup_suppressed` en `audit` (migraciones 016 y 018).

## La evidencia que motivó todo esto, contra producción (2026-07-29)

```sql
-- 0 filas en todo el histórico
select count(*) from public.signals where action like 'SETUP%';

-- Las 5 señales más recientes: sin `schema`, sin `bar_time`,
-- y ts_signal == bar_time == apertura exacta de vela de 15m
select action, symbol, raw->>'schema', raw ? 'bar_time', ts_signal, bar_time
from public.signals order by created_at desc limit 5;
```

Daño colateral del defecto 1-A, medido sobre el histórico:

| Rechazo | Filas |
|---|---|
| `stale` (el disparo intrabarra llega con hasta 897 s de "retraso" aparente) | 149 |
| `duplicate` (el lote entero se reemite ~9 s después) | 215 |
