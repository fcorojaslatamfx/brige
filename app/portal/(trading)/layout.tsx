"use client";

import { PortalDataProvider, usePortal } from "./PortalData";
import Sidebar from "./Sidebar";
import { C, MONO } from "@/lib/portal-helpers";
import "./trading.css";

/**
 * Layout del Trading Portal.
 *
 * El proveedor de datos vive AQUÍ, por encima del router, para que navegar
 * entre las siete páginas no relance ninguna petición. Va en un grupo de rutas
 * `(trading)` de modo que /portal —la vista de señales, que los clientes ya
 * tienen enlazada— conserve su propia pantalla y su propio layout intactos.
 */
export default function TradingLayout({ children }: { children: React.ReactNode }) {
  return (
    <PortalDataProvider>
      <Shell>{children}</Shell>
    </PortalDataProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { token, loading, error } = usePortal();

  // Sin token no se pinta el armazón: se manda al cliente a la pantalla de
  // acceso que ya existe en /portal, en vez de duplicar aquí un segundo
  // formulario de entrada con el mismo token.
  if (!token && !loading) return <NeedsToken />;

  return (
    <div className="tradingPortal" style={{ display: "flex", height: "100vh", background: C.bg, overflow: "hidden" }}>
      <Sidebar />
      <main style={{ flex: 1, overflow: "auto", padding: "28px 32px" }}>
        {error && (
          <div style={{
            background: C.redBg, border: `1px solid ${C.red}`, borderRadius: 10,
            padding: "12px 16px", marginBottom: 18, fontSize: 12, color: C.red,
          }}>
            {error}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

function NeedsToken() {
  return (
    <div className="tradingPortal" style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, color: C.muted, fontFamily: MONO }}>Necesitas tu token de acceso.</div>
      <a href="/portal" style={{ fontSize: 13, color: C.green, textDecoration: "none" }}>Ir a la pantalla de acceso →</a>
    </div>
  );
}
