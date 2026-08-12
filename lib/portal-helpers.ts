import type { PortalTrade } from "./portal-account";

/**
 * Utilidades de presentación del Trading Portal.
 *
 * Portadas desde pessaro-trading-portal/src/lib/helpers.js sin cambios de
 * lógica: son funciones puras sobre las operaciones cerradas y no tocan
 * Supabase. Lo único que se añade son tipos.
 */

// ── TEMA — tokens del design system (design/colors_and_type.css) ──────────
export const C = {
  bg: "var(--app-bg)",
  surface: "var(--app-surface)",
  card: "var(--app-surface)",
  border: "var(--app-border)",
  green: "var(--app-accent)",
  greenBg: "var(--app-up-bg)",
  blue: "var(--app-trust)",
  blueBg: "oklch(0.65 0.20 220 / 0.10)",
  red: "var(--app-down)",
  redBg: "var(--app-down-bg)",
  amber: "var(--app-warn)",
  text: "var(--app-text)",
  muted: "var(--app-muted)",
  faint: "var(--app-muted-2)",
} as const;

export const MONO = "'JetBrains Mono', monospace";
export const UI = "'Plus Jakarta Sans', sans-serif";

export const SYM_COLOR: Record<string, string> = {
  "EUR/USD": "#4d90ff", "GBP/USD": "#9b72ff", "XAU/USD": "#ffbb38",
  NAS100: "#00e5a0", "USD/JPY": "#ff4d6a", "GBP/JPY": "#ff77aa",
  "EUR/JPY": "#a3e635", "AUD/USD": "#22d3ee", "BTC/USD": "#fb923c",
  "EUR/GBP": "#c084fc", SPX500: "#60a5fa", OIL: "#fbbf24",
};

// ── FORMATO ──────────────────────────────────────────────────────────────
export const fmtUSD = (v: number) =>
  "$" + Math.abs(v).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtPnl = (v: number) => (v >= 0 ? "+" : "-") + fmtUSD(v);

export const fmtPct = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

export const fmtDur = (mins: number) => `${Math.floor(mins / 60)}h ${mins % 60}m`;

export const fmtDate = (ts: string | number | Date) =>
  new Date(ts).toLocaleDateString("es-ES", { day: "2-digit", month: "short" });

export const fmtTime = (ts: string | number | Date) =>
  new Date(ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

export const fmtDateTime = (ts: string | number | Date) => `${fmtDate(ts)} ${fmtTime(ts)}`;

/** "hace 42s" / "hace 3m". La frescura del dato es parte del dato. */
export function fmtAgo(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `hace ${seconds}s`;
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `hace ${Math.floor(seconds / 3600)}h`;
  return `hace ${Math.floor(seconds / 86400)}d`;
}

// ── ESTADÍSTICAS ─────────────────────────────────────────────────────────
export type TradeStats = {
  total: number; wins: number; losses: number; winRate: number;
  net: number; gP: number; gL: number; pf: number;
  avgW: number; avgL: number; best: number; worst: number;
  avgDur: number; maxDD: number;
};

const EMPTY_STATS: TradeStats = {
  total: 0, wins: 0, losses: 0, winRate: 0, net: 0, gP: 0, gL: 0,
  pf: 0, avgW: 0, avgL: 0, best: 0, worst: 0, avgDur: 0, maxDD: 0,
};

export function computeStats(trades: PortalTrade[]): TradeStats {
  if (!trades.length) return EMPTY_STATS;
  const wins = trades.filter((t) => t.profit_loss > 0);
  const losses = trades.filter((t) => t.profit_loss < 0);
  const gP = wins.reduce((s, t) => s + t.profit_loss, 0);
  const gL = Math.abs(losses.reduce((s, t) => s + t.profit_loss, 0));
  const net = gP - gL;

  let peak = 0, maxDD = 0, running = 0;
  for (const t of trades) {
    running += t.profit_loss;
    if (running > peak) peak = running;
    const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +((wins.length / trades.length) * 100).toFixed(1),
    net: +net.toFixed(2),
    gP: +gP.toFixed(2),
    gL: +gL.toFixed(2),
    pf: gL > 0 ? +(gP / gL).toFixed(2) : 0,
    avgW: wins.length ? +(gP / wins.length).toFixed(2) : 0,
    avgL: losses.length ? +(gL / losses.length).toFixed(2) : 0,
    best: +Math.max(...trades.map((t) => t.profit_loss)).toFixed(2),
    worst: +Math.min(...trades.map((t) => t.profit_loss)).toFixed(2),
    avgDur: Math.round(trades.reduce((s, t) => s + (t.duration_mins ?? 0), 0) / trades.length),
    maxDD: +maxDD.toFixed(2),
  };
}

// ── CURVA DE EQUITY ──────────────────────────────────────────────────────
export type EquityPoint = { date: string; equity: number; ts: number };

export function buildEquityCurve(trades: PortalTrade[], startBalance = 0): EquityPoint[] {
  const byDate = new Map<string, EquityPoint>();
  let running = startBalance;
  [...trades]
    .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())
    .forEach((t) => {
      running += t.profit_loss;
      const key = fmtDate(t.close_time);
      byDate.set(key, { date: key, equity: +running.toFixed(2), ts: new Date(t.close_time).getTime() });
    });
  return [...byDate.values()].sort((a, b) => a.ts - b.ts);
}

// ── CALENDARIO ───────────────────────────────────────────────────────────
export type CalendarDay = { pnl: number; cnt: number };

export function buildCalendar(trades: PortalTrade[], year: number, month: number): Record<number, CalendarDay> {
  const map: Record<number, CalendarDay> = {};
  trades
    .filter((t) => {
      const d = new Date(t.close_time);
      return d.getFullYear() === year && d.getMonth() === month;
    })
    .forEach((t) => {
      const day = new Date(t.close_time).getDate();
      if (!map[day]) map[day] = { pnl: 0, cnt: 0 };
      map[day].pnl += t.profit_loss;
      map[day].cnt++;
    });
  return map;
}

// ── ESTADÍSTICA POR SÍMBOLO ──────────────────────────────────────────────
export type SymbolStat = { symbol: string; cnt: number; wins: number; pnl: number; color: string; wr: number };

export function buildSymbolStats(trades: PortalTrade[]): SymbolStat[] {
  const map: Record<string, Omit<SymbolStat, "wr">> = {};
  for (const t of trades) {
    const entry = map[t.symbol] ??
      (map[t.symbol] = { symbol: t.symbol, cnt: 0, wins: 0, pnl: 0, color: SYM_COLOR[t.symbol] ?? "#888" });
    entry.cnt++;
    if (t.profit_loss > 0) entry.wins++;
    entry.pnl += t.profit_loss;
  }
  return Object.values(map)
    .map((s) => ({ ...s, pnl: +s.pnl.toFixed(2), wr: +((s.wins / s.cnt) * 100).toFixed(0) }))
    .sort((a, b) => b.pnl - a.pnl);
}

// ── MAPA DE CALOR ────────────────────────────────────────────────────────
export function buildHeatmap(trades: PortalTrade[]): Record<string, { cnt: number; pnl: number }> {
  const map: Record<string, { cnt: number; pnl: number }> = {};
  for (const t of trades) {
    const d = new Date(t.open_time);
    const k = `${d.getDay()}-${d.getHours()}`;
    if (!map[k]) map[k] = { cnt: 0, pnl: 0 };
    map[k].cnt++;
    map[k].pnl += t.profit_loss;
  }
  return map;
}

// ── EXPORTACIÓN CSV ──────────────────────────────────────────────────────
export function exportCSV(trades: PortalTrade[]) {
  const header = "Ticket,Símbolo,Tipo,Lotes,Apertura,Cierre,Duración,P&L,Balance\n";
  const rows = trades
    .map((t) =>
      [
        t.ticket, t.symbol, t.position_type, t.lots,
        fmtDateTime(t.open_time), fmtDateTime(t.close_time),
        fmtDur(t.duration_mins ?? 0), t.profit_loss, t.running_balance ?? "",
      ].join(","),
    )
    .join("\n");
  const url = URL.createObjectURL(new Blob([header + rows], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: "operaciones_pessaro.csv" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
