"use client";

import { useEffect, useRef, useState } from "react";
import { C, UI, MONO, SYM_COLOR } from "@/lib/portal-helpers";
import { Card } from "../ui";

/**
 * Gráfico de mercado.
 *
 * Usa los widgets embebidos de TradingView, no datos propios. Por eso la
 * fusión elimina la tabla tp_ohlc: habría sido con diferencia la más grande
 * del sistema —una fila por símbolo, timeframe y vela— para alimentar a un
 * componente que nunca se llegó a renderizar. Las velas las sirve TradingView
 * gratis y mejor.
 */

const SYMBOLS = Object.keys(SYM_COLOR);

type Timeframe = { label: string; tv: string };

const TIMEFRAMES: Timeframe[] = [
  { label: "1m", tv: "1" },
  { label: "5m", tv: "5" },
  { label: "15m", tv: "15" },
  { label: "1h", tv: "60" },
  { label: "4h", tv: "240" },
  { label: "1D", tv: "D" },
];

/** 1h por defecto. Constante propia para no indexar TIMEFRAMES en el estado inicial. */
const DEFAULT_TF: Timeframe = { label: "1h", tv: "60" };

const TV_SYMBOL: Record<string, string> = {
  "EUR/USD": "OANDA:EURUSD", "GBP/USD": "OANDA:GBPUSD", "XAU/USD": "OANDA:XAUUSD",
  NAS100: "NASDAQ:NDX", "USD/JPY": "OANDA:USDJPY", "GBP/JPY": "OANDA:GBPJPY",
  "EUR/JPY": "OANDA:EURJPY", "AUD/USD": "OANDA:AUDUSD", "BTC/USD": "BITSTAMP:BTCUSD",
  "EUR/GBP": "OANDA:EURGBP", SPX500: "SP:SPX", OIL: "NYMEX:CL1!",
};

export default function GraficoPage() {
  const [symbol, setSymbol] = useState("EUR/USD");
  const [tf, setTf] = useState<Timeframe>(DEFAULT_TF);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 3 }}>Gráfico de mercado</h1>
        <div style={{ fontSize: 12, color: C.muted }}>Análisis técnico en tiempo real — TradingView</div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {SYMBOLS.map((s) => (
          <button key={s} onClick={() => setSymbol(s)} style={{
            padding: "6px 11px", borderRadius: 8, fontSize: 11, fontFamily: UI, cursor: "pointer",
            background: symbol === s ? "rgba(0,229,160,0.12)" : C.card,
            color: symbol === s ? C.green : C.muted,
            border: `1px solid ${symbol === s ? "rgba(0,229,160,0.35)" : C.border}`,
            display: "flex", alignItems: "center", gap: 5, transition: "all 0.15s",
          }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: SYM_COLOR[s], flexShrink: 0 }} />
            {s}
          </button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {TIMEFRAMES.map((t) => (
            <button key={t.label} onClick={() => setTf(t)} style={{
              padding: "6px 11px", borderRadius: 8, fontSize: 11, fontFamily: MONO, cursor: "pointer",
              background: tf.label === t.label ? "rgba(77,144,255,0.12)" : C.card,
              color: tf.label === t.label ? C.blue : C.muted,
              border: `1px solid ${tf.label === t.label ? "rgba(77,144,255,0.35)" : C.border}`,
              transition: "all 0.15s",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      <Card style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
        <TvWidget
          script="embed-widget-advanced-chart.js"
          height={580}
          config={{
            autosize: true, symbol: tvSym(symbol), interval: tf.tv,
            timezone: "America/Santiago", theme: "dark", style: "1", locale: "es",
            enable_publishing: false, hide_top_toolbar: false, save_image: true,
            allow_symbol_change: false,
            studies: ["RSI@tv-basicstudies", "MACD@tv-basicstudies"],
            backgroundColor: "#0a1e33", gridColor: "rgba(80,140,220,0.07)",
            support_host: "https://www.tradingview.com",
          }}
        />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <WidgetHeader title="Análisis técnico" />
          <TvWidget
            script="embed-widget-technical-analysis.js"
            height={280}
            config={{
              interval: "1h", width: "100%", isTransparent: false, height: 280,
              backgroundColor: "#030b1c", symbol: tvSym(symbol),
              showIntervalTabs: true, locale: "es", colorTheme: "dark",
            }}
          />
        </Card>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <WidgetHeader title="Mini gráfico 3M" />
          <TvWidget
            script="embed-widget-mini-symbol-overview.js"
            height={280}
            config={{
              symbol: tvSym(symbol), width: "100%", height: 280, locale: "es",
              dateRange: "3M", colorTheme: "dark", isTransparent: false, backgroundColor: "#030b1c",
            }}
          />
        </Card>
      </div>
    </div>
  );
}

function tvSym(symbol: string): string {
  return TV_SYMBOL[symbol] ?? symbol.replace("/", "");
}

function WidgetHeader({ title }: { title: string }) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between" }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
      <span style={{ fontSize: 10, color: C.faint }}>TradingView</span>
    </div>
  );
}

/**
 * Los tres widgets del portal original eran tres componentes con el mismo
 * cuerpo copiado. Aquí es uno solo parametrizado: el script y la configuración
 * son lo único que cambiaba entre ellos.
 */
function TvWidget({ script, config, height }: { script: string; config: Record<string, unknown>; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const serialized = JSON.stringify(config);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.innerHTML = "";
    const s = document.createElement("script");
    s.src = `https://s3.tradingview.com/external-embedding/${script}`;
    s.type = "text/javascript";
    s.async = true;
    s.innerHTML = serialized;
    c.appendChild(s);
    return () => { c.innerHTML = ""; };
  }, [script, serialized]);

  return <div ref={ref} style={{ height, width: "100%", background: C.card }} />;
}
