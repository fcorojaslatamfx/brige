"use client";

import { usePortal } from "../PortalData";
import { C, UI, MONO, fmtUSD, fmtAgo, fmtDateTime } from "@/lib/portal-helpers";
import { Card, StatRow, Spinner } from "../ui";

/**
 * Cuenta.
 *
 * NO es un puerto literal de src/pages/Configuracion.jsx. Aquella pantalla eran
 * 597 líneas de formularios de "Vincular bróker" y "Credenciales MT5" para el
 * flujo de MetaApi — con el botón «Conectar cuenta» sin handler, porque nunca
 * llegó a existir el backend que lo respaldara. Pedirle al cliente la
 * contraseña de su cuenta de trading dejó de tener sentido en el momento en
 * que la conexión la hace su propio terminal: el EA ya está dentro de MT4 y no
 * necesita credenciales para leer lo que tiene delante.
 *
 * Lo que el cliente necesita saber aquí es si su terminal está reportando y
 * qué hacer si no. Eso es lo que muestra.
 */
export default function CuentaPage() {
  const { account, client, loading, stale_seconds, trades_total, positions, signOut } = usePortal();

  if (loading) return <Spinner />;

  const live = stale_seconds !== null && stale_seconds < 150;

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 3 }}>Cuenta</h1>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 22 }}>Estado de la conexión y datos de tu cuenta</div>

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Estado del terminal</div>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 7, borderRadius: 20, padding: "5px 13px",
            fontSize: 11, fontFamily: MONO, fontWeight: 700,
            background: live ? C.greenBg : C.redBg,
            color: live ? C.green : C.red,
            border: `1px solid ${live ? "rgba(0,229,160,0.3)" : "rgba(255,77,106,0.3)"}`,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: live ? C.green : C.red, display: "inline-block" }} />
            {live ? "Conectado" : "Sin señal"}
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.faint, marginBottom: 14 }}>
          {stale_seconds === null
            ? "Tu asesor experto todavía no ha enviado datos."
            : `Último reporte de tu terminal ${fmtAgo(stale_seconds)}.`}
        </div>

        {!live && (
          <div style={{
            background: "rgba(80,140,220,0.05)", border: `1px solid ${C.border}`,
            borderRadius: 10, padding: "14px 16px", fontSize: 12, color: C.muted, lineHeight: 1.8,
          }}>
            <div style={{ color: C.text, fontWeight: 600, marginBottom: 6 }}>Cómo restablecer la conexión</div>
            1. Abre MetaTrader 4 y comprueba que <strong style={{ color: C.text }}>PessaroBridgeEA v3</strong> está adjunto a un gráfico.<br />
            2. El icono del asesor, arriba a la derecha, tiene que estar sonriente. Si está triste, activa «AutoTrading».<br />
            3. En Herramientas → Opciones → Asesores Expertos, permite la URL <code style={{ fontFamily: MONO, color: C.green }}>https://brige.pessaro.cl</code>.<br />
            4. En las propiedades del asesor, comprueba que <code style={{ fontFamily: MONO, color: C.green }}>InpEnableTelemetry</code> está en <code style={{ fontFamily: MONO, color: C.green }}>true</code>.
          </div>
        )}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Datos de la cuenta</div>
          <StatRow label="Titular" value={client?.name ?? "—"} />
          <StatRow label="Número de cuenta" value={account?.account_number ?? client?.account_number ?? "—"} color={C.green} />
          <StatRow label="Tipo" value={account?.account_type ?? client?.account_type ?? "—"} />
          <StatRow label="Bróker" value={account?.broker ?? client?.broker ?? "—"} />
          <StatRow label="Servidor" value={account?.server ?? client?.broker_server ?? "—"} />
          <StatRow label="Divisa" value={account?.currency ?? "—"} />
          <StatRow label="Apalancamiento" value={account?.leverage ?? "—"} />
        </Card>

        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Situación actual</div>
          <StatRow label="Balance" value={account ? fmtUSD(account.balance) : "—"} />
          <StatRow label="Equity" value={account ? fmtUSD(account.equity) : "—"} color={C.green} />
          <StatRow label="Margen usado" value={account ? fmtUSD(account.margin_used) : "—"} />
          <StatRow label="Margen libre" value={account ? fmtUSD(account.free_margin) : "—"} color={C.blue} />
          <StatRow label="Nivel de margen" value={account ? `${account.margin_level.toFixed(1)}%` : "—"} />
          <StatRow label="Posiciones abiertas" value={String(positions.length)} />
          <StatRow label="Operaciones cerradas" value={String(trades_total)} />
        </Card>
      </div>

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Acceso</div>
        <StatRow
          label="Vigencia de tu acceso"
          value={client?.expires_at ? fmtDateTime(client.expires_at) : "—"}
          color={C.amber}
        />
        <div style={{ fontSize: 11, color: C.faint, marginTop: 12, lineHeight: 1.7 }}>
          El capital inicial de referencia lo fija tu asesor de Pessaro Capital; si el rendimiento no
          te cuadra, escríbele. Para renovar tu acceso antes de que venza, contacta también con él.
        </div>
        <button onClick={signOut} style={{
          marginTop: 16, background: "transparent", border: `1px solid ${C.border}`,
          color: C.muted, padding: "8px 16px", borderRadius: 8,
          fontSize: 12, fontFamily: UI, cursor: "pointer",
        }}>Cerrar sesión en este dispositivo</button>
      </Card>
    </div>
  );
}
