"use client";

import type { CSSProperties, ReactNode } from "react";
import { C, MONO, UI, fmtUSD } from "@/lib/portal-helpers";

/**
 * Primitivas visuales del Trading Portal, portadas desde
 * pessaro-trading-portal/src/components/ui/index.jsx. Estilos idénticos: lo
 * único que cambia es el tipado y el "use client" que Next necesita.
 */

export function Card({ children, style = {} }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: "20px 24px", ...style }}>
      {children}
    </div>
  );
}

export function KPICard({
  label, value, sub, color, pct,
}: { label: string; value: ReactNode; sub?: ReactNode; color?: string; pct?: number }) {
  return (
    <Card>
      <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: "2px", marginBottom: 10, fontFamily: UI }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? C.text, fontFamily: MONO, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{sub}</div>}
      {pct !== undefined && (
        <div style={{ height: 3, background: "rgba(255,255,255,0.07)", borderRadius: 2, marginTop: 10 }}>
          <div style={{ height: "100%", width: `${Math.min(Math.max(pct, 0), 100)}%`, background: color ?? C.green, borderRadius: 2 }} />
        </div>
      )}
    </Card>
  );
}

export function Pill({ type }: { type: string }) {
  const isBuy = type === "BUY" || type === "buy";
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 20,
      fontSize: 10, fontWeight: 700, fontFamily: MONO, letterSpacing: "0.5px",
      background: isBuy ? C.greenBg : C.redBg, color: isBuy ? C.green : C.red,
    }}>
      {isBuy ? "BUY" : "SELL"}
    </span>
  );
}

export function PnLVal({ v }: { v: number }) {
  return (
    <span style={{ color: v >= 0 ? C.green : C.red, fontFamily: MONO, fontSize: 12, fontWeight: 500 }}>
      {v >= 0 ? "+" : "-"}{fmtUSD(v)}
    </span>
  );
}

export function SymbolCell({ symbol, color }: { symbol: string; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: color ?? "#888", flexShrink: 0 }} />
      <span style={{ fontFamily: MONO, fontSize: 12 }}>{symbol}</span>
    </div>
  );
}

export function TH({ children, active, onClick }: { children: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <th onClick={onClick} style={{
      textAlign: "left", padding: "9px 12px", color: active ? C.green : C.faint,
      fontWeight: 500, fontSize: 10, textTransform: "uppercase", letterSpacing: "1px",
      borderBottom: `1px solid ${C.border}`, cursor: onClick ? "pointer" : "default",
      fontFamily: UI, userSelect: "none", whiteSpace: "nowrap",
    }}>
      {children}
    </th>
  );
}

export function TD({ children, style = {} }: { children: ReactNode; style?: CSSProperties }) {
  return <td style={{ padding: "9px 12px", borderBottom: "1px solid rgba(80,140,220,0.05)", ...style }}>{children}</td>;
}

type TipPayload = { color?: string; name?: string; value?: number };

export function ChartTip({ active, payload, label }: { active?: boolean; payload?: TipPayload[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#091929", border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 12, fontFamily: MONO }}>
      <div style={{ color: C.muted, marginBottom: 5 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color ?? C.text }}>
          {p.name}: ${p.value?.toLocaleString?.()}
        </div>
      ))}
    </div>
  );
}

export function StatRow({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(80,140,220,0.06)" }}>
      <span style={{ fontSize: 12, color: C.muted }}>{label}</span>
      <span style={{ fontSize: 12, color: color ?? C.text, fontFamily: MONO, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

export function Spinner() {
  return <div style={{ textAlign: "center", padding: 40, color: C.faint, fontFamily: MONO, fontSize: 12 }}>Cargando…</div>;
}

export function EmptyChart({ label, height = 200 }: { label: string; height?: number }) {
  return (
    <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: C.faint, fontSize: 12 }}>
      {label}
    </div>
  );
}

/**
 * Estado "el terminal aún no ha reportado". Es distinto de un error y de una
 * cuenta vacía: el cliente tiene token válido pero su EA todavía no ha
 * mandado telemetría, y decirlo explícitamente evita que interprete unos
 * ceros como que perdió su dinero.
 */
export function WaitingForTerminal() {
  return (
    <Card style={{ textAlign: "center", padding: "48px 24px" }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 8 }}>Esperando a tu terminal</div>
      <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7, maxWidth: 460, margin: "0 auto" }}>
        Tu acceso está activo, pero todavía no hemos recibido datos de tu cuenta MT4.
        Comprueba que el asesor experto <strong style={{ color: C.text }}>PessaroBridgeEA v3</strong> está
        adjunto a un gráfico, con el icono sonriente, y que la telemetría está activada.
      </div>
    </Card>
  );
}
