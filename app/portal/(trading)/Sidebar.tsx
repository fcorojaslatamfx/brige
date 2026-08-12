"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, TrendingUp, List, BarChart2, Calendar, ShieldAlert, Settings2, Radio } from "lucide-react";
import { usePortal } from "./PortalData";
import { fmtAgo } from "@/lib/portal-helpers";

const NAV = [
  { to: "/portal/resumen", label: "Resumen", Icon: LayoutDashboard },
  { to: "/portal/rendimiento", label: "Rendimiento", Icon: TrendingUp },
  { to: "/portal/operaciones", label: "Operaciones", Icon: List },
  { to: "/portal/grafico", label: "Gráfico", Icon: BarChart2 },
  { to: "/portal/calendario", label: "Calendario P&L", Icon: Calendar },
  { to: "/portal/riesgo", label: "Riesgo", Icon: ShieldAlert },
  { to: "/portal/cuenta", label: "Cuenta", Icon: Settings2 },
  // Puente hacia la vista de señales, que sigue viviendo en /portal con el
  // MISMO token. Un cliente entra una vez y tiene las dos cosas.
  { to: "/portal", label: "Mis señales", Icon: Radio },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { client, account, stale_seconds } = usePortal();

  // Verde solo si el terminal reportó dentro de dos ciclos de telemetría.
  // Un punto "En vivo" fijo mentiría justo cuando más importa: cuando el EA
  // del cliente se cayó y sus cifras están congeladas.
  const live = stale_seconds !== null && stale_seconds < 150;

  return (
    <aside style={{
      width: 224, background: "var(--app-surface)", borderRight: "1px solid var(--app-border)",
      display: "flex", flexDirection: "column", flexShrink: 0,
    }}>
      <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid var(--app-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", color: "var(--app-text)" }}>
            PESSARO <span style={{ color: "var(--app-accent)" }}>TRADE</span>
          </span>
        </div>
      </div>

      <nav style={{ flex: 1, padding: "10px 0", overflowY: "auto" }}>
        <div style={{ fontSize: 9, color: "var(--app-muted-2)", letterSpacing: "2px", textTransform: "uppercase", padding: "0 20px 8px" }}>
          Navegación
        </div>

        {NAV.map(({ to, label, Icon }) => {
          const isActive = pathname === to;
          return (
            <Link key={to} href={to} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 20px", fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? "var(--app-accent)" : "var(--app-muted)",
              background: isActive ? "var(--app-up-bg)" : "transparent",
              borderLeft: `2px solid ${isActive ? "var(--app-accent)" : "transparent"}`,
              textDecoration: "none", transition: "color 0.15s, background 0.15s, border-color 0.15s",
            }}>
              <Icon size={16} strokeWidth={1.75} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div style={{ padding: "14px 16px", borderTop: "1px solid var(--app-border)" }}>
        <div style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border)", borderRadius: 10, padding: "11px 14px" }}>
          <div style={{ fontSize: 9, color: "var(--app-muted-2)", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 6 }}>
            Cuenta activa
          </div>
          <div style={{ fontSize: 12, color: "var(--app-accent)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
            {account?.account_number ?? client?.account_number ?? "—"}
          </div>

          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8,
            padding: "4px 10px", borderRadius: 9999,
            background: live ? "var(--app-up-bg)" : "rgba(255,255,255,0.05)",
            border: `1px solid ${live ? "oklch(0.72 0.20 150 / 0.30)" : "var(--app-border)"}`,
            fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700,
            color: live ? "var(--app-accent)" : "var(--app-muted-2)",
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%", flexShrink: 0, display: "inline-block",
              background: live ? "var(--app-accent)" : "var(--app-muted-2)",
            }} />
            {live ? "En vivo" : fmtAgo(stale_seconds)}
          </div>
        </div>
      </div>
    </aside>
  );
}
