"use client";

import { useMemo, useState } from "react";
import { usePortal } from "../PortalData";
import type { PortalTrade } from "@/lib/portal-account";
import { C, UI, MONO, SYM_COLOR, fmtUSD, fmtDur, fmtDate, fmtTime, exportCSV } from "@/lib/portal-helpers";
import { Card, Pill, PnLVal, TH, TD, SymbolCell, WaitingForTerminal } from "../ui";

type SortKey = keyof Pick<PortalTrade, "ticket" | "open_time" | "close_time" | "symbol" | "position_type" | "lots" | "duration_mins" | "profit_loss" | "running_balance">;

const COLS: { k: SortKey; l: string }[] = [
  { k: "ticket", l: "Ticket" },
  { k: "open_time", l: "Apertura" },
  { k: "close_time", l: "Cierre" },
  { k: "symbol", l: "Símbolo" },
  { k: "position_type", l: "Tipo" },
  { k: "lots", l: "Lotes" },
  { k: "duration_mins", l: "Duración" },
  { k: "profit_loss", l: "P&L" },
  { k: "running_balance", l: "Balance" },
];

export default function OperacionesPage() {
  const { account, trades, trades_total, loading } = usePortal();
  const [symF, setSymF] = useState("Todos");
  const [typeF, setTypeF] = useState<"Todos" | "BUY" | "SELL">("Todos");
  const [srch, setSrch] = useState("");
  const [sortK, setSortK] = useState<SortKey>("close_time");
  const [sortD, setSortD] = useState<"asc" | "desc">("desc");

  // Los símbolos del filtro salen de las operaciones REALES del cliente, no de
  // una lista fija: el bróker puede usar sufijos (XAUUSDm, EURUSD.r) y una
  // whitelist cableada dejaría fuera justo los símbolos que este cliente opera.
  const symbols = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades]);

  const filtered = useMemo(() => {
    let t = [...trades];
    if (symF !== "Todos") t = t.filter((x) => x.symbol === symF);
    if (typeF !== "Todos") t = t.filter((x) => x.position_type === typeF);
    if (srch) t = t.filter((x) => x.symbol.toLowerCase().includes(srch.toLowerCase()));
    t.sort((a, b) => {
      const av = a[sortK] ?? 0;
      const bv = b[sortK] ?? 0;
      return sortD === "desc" ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
    });
    return t;
  }, [trades, symF, typeF, srch, sortK, sortD]);

  function handleSort(k: SortKey) {
    if (k === sortK) setSortD((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortK(k); setSortD("desc"); }
  }

  if (!loading && !account) return <WaitingForTerminal />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 3 }}>Historial de operaciones</h1>
          <div style={{ fontSize: 12, color: C.muted }}>
            {filtered.length} de {trades_total} operaciones
          </div>
        </div>
        <button onClick={() => exportCSV(filtered)} style={{
          display: "flex", alignItems: "center", gap: 6, background: C.greenBg,
          border: "1px solid rgba(0,229,160,0.3)", color: C.green, padding: "8px 16px",
          borderRadius: 8, fontSize: 12, fontFamily: UI, fontWeight: 600, cursor: "pointer",
        }}>⬇ Exportar CSV</button>
      </div>

      <div style={{ display: "flex", gap: 7, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={srch}
          onChange={(e) => setSrch(e.target.value)}
          placeholder="Buscar símbolo…"
          style={{
            background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: "7px 12px", fontSize: 12, color: C.text, fontFamily: UI, width: 145, outline: "none",
          }}
        />
        {["Todos", ...symbols].map((s) => (
          <button key={s} onClick={() => setSymF(s)} style={{
            padding: "5px 9px", borderRadius: 7, fontSize: 11, fontFamily: UI, cursor: "pointer",
            background: symF === s ? C.greenBg : C.card,
            color: symF === s ? C.green : C.muted,
            border: `1px solid ${symF === s ? "rgba(0,229,160,0.3)" : C.border}`,
          }}>{s}</button>
        ))}
        <button
          onClick={() => setTypeF((f) => (f === "Todos" ? "BUY" : f === "BUY" ? "SELL" : "Todos"))}
          style={{
            padding: "5px 12px", borderRadius: 7, fontSize: 11, fontFamily: UI, marginLeft: 2, cursor: "pointer",
            background: typeF === "BUY" ? C.greenBg : typeF === "SELL" ? C.redBg : C.card,
            color: typeF === "BUY" ? C.green : typeF === "SELL" ? C.red : C.muted,
            border: `1px solid ${C.border}`,
          }}>{typeF === "Todos" ? "Tipo: Todos" : typeF}</button>
      </div>

      <Card style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: "center", color: C.faint, fontFamily: MONO, fontSize: 12 }}>Cargando operaciones…</div>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {COLS.map((col) => (
                      <TH key={col.k} active={sortK === col.k} onClick={() => handleSort(col.k)}>
                        {col.l}{sortK === col.k ? (sortD === "desc" ? " ↓" : " ↑") : ""}
                      </TH>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <tr key={t.ticket}>
                      <TD><span style={{ fontFamily: MONO, fontSize: 11, color: C.faint }}>{t.ticket}</span></TD>
                      <TD><span style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{fmtDate(t.open_time)} {fmtTime(t.open_time)}</span></TD>
                      <TD><span style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{fmtDate(t.close_time)} {fmtTime(t.close_time)}</span></TD>
                      <TD><SymbolCell symbol={t.symbol} color={SYM_COLOR[t.symbol]} /></TD>
                      <TD><Pill type={t.position_type} /></TD>
                      <TD><span style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{t.lots}</span></TD>
                      <TD><span style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{fmtDur(t.duration_mins ?? 0)}</span></TD>
                      <TD><PnLVal v={t.profit_loss} /></TD>
                      <TD><span style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{t.running_balance ? fmtUSD(t.running_balance) : "—"}</span></TD>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={COLS.length} style={{ padding: "24px 12px", textAlign: "center", color: C.faint, fontSize: 12 }}>Sin operaciones que coincidan</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {/* El servidor pagina a 200; el original traía el historial entero
                con un select('*') sin límite y luego recortaba en el navegador. */}
            {trades_total > trades.length && (
              <div style={{ padding: "11px 16px", textAlign: "center", fontSize: 11, color: C.faint, borderTop: `1px solid ${C.border}` }}>
                Mostrando las {trades.length} más recientes de {trades_total} · Exporta el CSV para trabajar con ellas
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
