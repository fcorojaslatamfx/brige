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

## Estado del proyecto

🚧 En construcción — desarrollado a partir del meta-prompt v3 (modo despachador manual).

**Completado:** esquema SQL (Supabase), API routes (Next.js), EA notificador
(MQL4), panel `/status` con identidad Pessaro Capital.
**Pendiente:** pruebas automatizadas (Vitest) y README de despliegue completo.

## Documentación

- `docs/metaprompt.md` — especificación funcional completa para el desarrollo del bridge.
- `docs/memoria-proyecto.md` — historial de decisiones de todo el sistema (indicador + bridge).

## Licencia

Propiedad de Pessaro Capital. Uso interno — no distribuir.
