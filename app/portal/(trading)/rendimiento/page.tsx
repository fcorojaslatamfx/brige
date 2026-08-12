"use client";

import { useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";
import { usePortal } from "../PortalData";
import { C, MONO, fmtUSD, fmtPnl, fmtDur, computeStats, buildEquityCurve, buildSymbolStats } from "@/lib/portal-helpers";
import { Card, ChartTip, StatRow, Spinner, EmptyChart, WaitingForTerminal } from "../ui";

export default function RendimientoPage() {
  const { account, trades, loading } = usePortal();

  const stats = useMemo(() => computeStats(trades), [trades]);
  const curve = useMemo(() => buildEquityCurve(trades, account?.initial_balance ?? 0), [trades, account]);
  const symStats = useMemo(() => buildSymbolStats(trades), [trades]);
  const last60 = useMemo(() => trades.slice(0, 60).reverse(), [trades]);

  if (loading) return <Spinner />;
  if (!account) return <WaitingForTerminal />;

  const totalReturn = account.initial_balance > 0
    ? ((account.balance - account.initial_balance) / account.initial_balance) * 100
    : null;

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 3 }}>Rendimiento</h1>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 22 }}>
        Análisis detallado · {stats.total} operaciones cerradas
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }}>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Resumen financiero</div>
          {([
            ["Balance inicial", account.initial_balance > 0 ? fmtUSD(account.initial_balance) : "—", C.text],
            ["Balance actual", fmtUSD(account.balance), C.text],
            ["Ganancia neta", stats.total ? fmtPnl(stats.net) : "—", stats.net >= 0 ? C.green : C.red],
            ["Ganancia bruta", stats.total ? "+" + fmtUSD(stats.gP) : "—", C.green],
            ["Pérdida bruta", stats.total ? "-" + fmtUSD(stats.gL) : "—", C.red],
            ["Profit factor", stats.pf ? String(stats.pf) : "—", "#ffbb38"],
            ["Rendimiento total", totalReturn === null ? "—" : `${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`, totalReturn !== null && totalReturn < 0 ? C.red : C.green],
            ["Max drawdown", stats.maxDD ? `-${stats.maxDD}%` : "—", C.red],
          ] as [string, string, string][]).map(([k, v, c]) => <StatRow key={k} label={k} value={v} color={c} />)}
        </Card>

        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Estadísticas de operaciones</div>
          {([
            ["Total operaciones", stats.total ? String(stats.total) : "—", C.text],
            ["Ganadoras", stats.total ? `${stats.wins} (${stats.winRate}%)` : "—", C.green],
            ["Perdedoras", stats.total ? `${stats.losses} (${(100 - stats.winRate).toFixed(1)}%)` : "—", C.red],
            ["Ganancia media", stats.avgW ? "+" + fmtUSD(stats.avgW) : "—", C.green],
            ["Pérdida media", stats.avgL ? "-" + fmtUSD(stats.avgL) : "—", C.red],
            ["Mejor operación", stats.best ? "+" + fmtUSD(stats.best) : "—", C.green],
            ["Peor operación", stats.worst ? "-" + fmtUSD(Math.abs(stats.worst)) : "—", C.red],
            ["Duración media", stats.avgDur ? fmtDur(stats.avgDur) : "—", C.text],
          ] as [string, string, string][]).map(([k, v, c]) => <StatRow key={k} label={k} value={v} color={c} />)}
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }}>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>P&L últimas 60 operaciones</div>
          {last60.length === 0 ? (
            <EmptyChart label="Sin operaciones" height={190} />
          ) : (
            <ResponsiveContainer width="100%" height={190}>
              <BarChart data={last60} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis hide />
                <YAxis tick={{ fill: C.faint, fontSize: 10, fontFamily: MONO }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `$${v}`} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
                <Tooltip content={({ active, payload }: { active?: boolean; payload?: { value?: number }[] }) => {
                  const v = payload?.[0]?.value;
                  if (!active || v === undefined) return null;
                  return (
                    <div style={{
                      background: "#091929", border: `1px solid ${C.border}`, borderRadius: 8,
                      padding: "8px 12px", fontSize: 12, fontFamily: MONO,
                      color: v >= 0 ? C.green : C.red,
                    }}>
                      {v >= 0 ? "+" : ""}${v}
                    </div>
                  );
                }} />
                <Bar dataKey="profit_loss" radius={[2, 2, 0, 0]}>
                  {last60.map((t, i) => <Cell key={i} fill={t.profit_loss >= 0 ? C.green : C.red} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>P&L por símbolo</div>
          {symStats.length === 0 ? (
            <EmptyChart label="Sin datos" height={190} />
          ) : (
            <div style={{ overflowY: "auto", maxHeight: 200 }}>
              {symStats.map((s) => {
                const mx = Math.max(...symStats.map((x) => Math.abs(x.pnl))) || 1;
                return (
                  <div key={s.symbol} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid rgba(80,140,220,0.06)" }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
                    <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, width: 66, flexShrink: 0 }}>{s.symbol}</div>
                    <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.07)", borderRadius: 2 }}>
                      <div style={{ height: "100%", width: `${(Math.abs(s.pnl) / mx) * 100}%`, background: s.pnl >= 0 ? C.green : C.red, borderRadius: 2 }} />
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: s.pnl >= 0 ? C.green : C.red, width: 62, textAlign: "right", flexShrink: 0 }}>
                      {s.pnl >= 0 ? "+" : "-"}${Math.abs(s.pnl).toFixed(0)}
                    </div>
                    <div style={{ fontSize: 10, color: C.faint, width: 32, textAlign: "right", flexShrink: 0 }}>{s.wr}%</div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Curva de equity completa</div>
        {curve.length < 2 ? (
          <EmptyChart label="Necesitas al menos 2 operaciones cerradas" height={240} />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={curve} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="gFull" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.green} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={C.green} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(80,140,220,0.08)" />
              <XAxis dataKey="date" tick={{ fill: C.faint, fontSize: 10, fontFamily: MONO }} axisLine={false} tickLine={false} interval={Math.max(1, Math.floor(curve.length / 8))} />
              <YAxis tick={{ fill: C.faint, fontSize: 10, fontFamily: MONO }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTip />} />
              <Area type="monotone" dataKey="equity" name="Equity" stroke={C.green} strokeWidth={2} fill="url(#gFull)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>
    </div>
  );
}
