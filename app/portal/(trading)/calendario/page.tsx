"use client";

import { useEffect, useMemo, useState } from "react";
import { usePortal } from "../PortalData";
import { C, UI, MONO, buildCalendar } from "@/lib/portal-helpers";
import { Card, Spinner, WaitingForTerminal } from "../ui";

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

export default function CalendarioPage() {
  const { account, trades, loading } = usePortal();

  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(null);

  // Arranca en el último mes CON operaciones, no en el mes actual: si el
  // cliente lleva dos semanas sin operar, abrir en un calendario vacío
  // parecería que se perdieron sus datos.
  useEffect(() => {
    if (year !== null) return;
    if (trades.length) {
      const last = new Date(Math.max(...trades.map((t) => new Date(t.close_time).getTime())));
      setYear(last.getFullYear());
      setMonth(last.getMonth());
    } else if (!loading) {
      const now = new Date();
      setYear(now.getFullYear());
      setMonth(now.getMonth());
    }
  }, [trades, loading, year]);

  const calData = useMemo(
    () => (year === null || month === null ? {} : buildCalendar(trades, year, month)),
    [trades, year, month],
  );

  const monthsWithTrades = useMemo(() => {
    const seen = new Map<string, { year: number; month: number; label: string }>();
    for (const t of trades) {
      const d = new Date(t.close_time);
      const y = d.getFullYear();
      const m = d.getMonth();
      const key = `${y}-${m}`;
      if (!seen.has(key)) seen.set(key, { year: y, month: m, label: `${MONTHS[m] ?? m} ${y}` });
    }
    return [...seen.values()].sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
  }, [trades]);

  if (!loading && !account) return <WaitingForTerminal />;
  if (year === null || month === null) return <Spinner />;

  function navigate(delta: number) {
    let m = (month as number) + delta;
    let y = year as number;
    if (m > 11) { m = 0; y++; } else if (m < 0) { m = 11; y--; }
    setMonth(m);
    setYear(y);
  }

  const firstDOW = new Date(year, month, 1).getDay();
  const daysInMon = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array<number | null>(firstDOW).fill(null)
    .concat(Array.from({ length: daysInMon }, (_, i) => i + 1));

  const monthTrades = trades.filter((t) => {
    const d = new Date(t.close_time);
    return d.getFullYear() === year && d.getMonth() === month;
  });
  const monthPnl = monthTrades.reduce((s, t) => s + t.profit_loss, 0);
  const monthWins = monthTrades.filter((t) => t.profit_loss > 0).length;

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 3 }}>Calendario P&L</h1>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 20 }}>Rendimiento diario por mes</div>

      {monthsWithTrades.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {monthsWithTrades.map((m) => {
            const on = year === m.year && month === m.month;
            return (
              <button key={m.label} onClick={() => { setYear(m.year); setMonth(m.month); }} style={{
                padding: "4px 10px", borderRadius: 7, fontSize: 11, fontFamily: UI, cursor: "pointer",
                background: on ? "rgba(0,229,160,0.12)" : C.card,
                color: on ? C.green : C.muted,
                border: `1px solid ${on ? "rgba(0,229,160,0.3)" : C.border}`,
              }}>{m.label}</button>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <button onClick={() => navigate(-1)} style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text, padding: "7px 14px", borderRadius: 8, fontSize: 15, cursor: "pointer" }}>‹</button>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", minWidth: 180, textAlign: "center" }}>{MONTHS[month]} {year}</div>
        <button onClick={() => navigate(1)} style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text, padding: "7px 14px", borderRadius: 8, fontSize: 15, cursor: "pointer" }}>›</button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 14 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: C.faint }}>
            <span style={{ width: 10, height: 10, background: C.greenBg, border: `1px solid ${C.green}`, borderRadius: 3, display: "inline-block" }} />Ganancia
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: C.faint }}>
            <span style={{ width: 10, height: 10, background: C.redBg, border: `1px solid ${C.red}`, borderRadius: 3, display: "inline-block" }} />Pérdida
          </span>
        </div>
      </div>

      <Card style={{ padding: 18, marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 6 }}>
          {DAYS.map((d) => <div key={d} style={{ textAlign: "center", fontSize: 10, color: C.faint, padding: "3px 0", fontWeight: 600 }}>{d}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
          {cells.map((day, i) => {
            if (!day) return <div key={i} />;
            const data = calData[day];
            const p = data?.pnl ?? 0;
            const alpha = data ? Math.min(Math.abs(p) / 400, 1) * 0.28 + 0.07 : 0;
            return (
              <div key={i} style={{
                background: data ? (p >= 0 ? `rgba(0,229,160,${alpha})` : `rgba(255,77,106,${alpha})`) : "rgba(80,140,220,0.03)",
                border: `1px solid ${data ? (p >= 0 ? "rgba(0,229,160,0.22)" : "rgba(255,77,106,0.22)") : "rgba(80,140,220,0.07)"}`,
                borderRadius: 8, padding: "7px 7px", minHeight: 62,
              }}>
                <div style={{ fontSize: 11, color: C.faint, marginBottom: 4 }}>{day}</div>
                {data && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO, color: p >= 0 ? C.green : C.red, lineHeight: 1.2 }}>
                      {p >= 0 ? "+" : "-"}${Math.abs(p).toFixed(0)}
                    </div>
                    <div style={{ fontSize: 10, color: C.faint, marginTop: 3 }}>{data.cnt} op{data.cnt > 1 ? "s" : ""}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 12 }}>
        {[
          { k: "P&L del mes", v: monthTrades.length ? `${monthPnl >= 0 ? "+" : "-"}$${Math.abs(monthPnl).toFixed(0)}` : "—", c: monthPnl >= 0 ? C.green : C.red },
          { k: "Operaciones", v: monthTrades.length || "—", c: C.text },
          { k: "Win rate", v: monthTrades.length ? `${((monthWins / monthTrades.length) * 100).toFixed(0)}%` : "—", c: C.green },
          { k: "Días activos", v: Object.keys(calData).length || "—", c: C.text },
        ].map(({ k, v, c }) => (
          <div key={k} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "13px 16px" }}>
            <div style={{ fontSize: 9, color: C.faint, textTransform: "uppercase", letterSpacing: "2px", marginBottom: 7, fontFamily: UI }}>{k}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: c, fontFamily: MONO }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
