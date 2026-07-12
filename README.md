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

## Estado del proyecto

🚧 En construcción — desarrollado a partir del meta-prompt v3 (modo despachador manual).

## Documentación

- `docs/metaprompt.md` — especificación funcional completa para el desarrollo del bridge.
- `docs/memoria-proyecto.md` — historial de decisiones de todo el sistema (indicador + bridge).

## Licencia

Propiedad de Pessaro Capital. Uso interno — no distribuir.
