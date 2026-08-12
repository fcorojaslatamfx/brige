"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../status/status.module.css";

type DeliveredSignal = {
  status: "claimed" | "notified" | "error";
  claimed_at: string;
  notified_at: string | null;
  symbol: string;
  action: string;
  grade: string | null;
  type: string | null;
  price: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  ts_signal: number;
  created_at: string;
};

type Report = {
  total: number;
  bySymbol: { symbol: string; count: number }[];
  byGrade: { grade: string; count: number }[];
  byStatus: { status: string; count: number }[];
  lastReceivedAt: string | null;
};

type PortalData = {
  ok: true;
  client: {
    name: string | null;
    email: string;
    token: string;
    expires_at: string | null;
    status: string;
    last_used_at: string | null;
  };
  signals: DeliveredSignal[];
  report: Report;
};

const STORAGE_KEY = "pessaro_client_token";
const REFRESH_MS = 10000;

export default function PortalPage() {
  const [token, setToken] = useState<string>("");
  const [input, setInput] = useState<string>("");
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealToken, setRevealToken] = useState(false);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (saved) setToken(saved);
  }, []);

  const fetchData = useCallback(async (t: string) => {
    try {
      const res = await fetch(`/api/portal?token=${encodeURIComponent(t)}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "No se pudo cargar tu información.");
        setData(null);
        return;
      }
      setData(json);
      setError(null);
    } catch {
      setError("No se pudo contactar al bridge.");
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetchData(token).finally(() => setLoading(false));
    const id = setInterval(() => fetchData(token), REFRESH_MS);
    return () => clearInterval(id);
  }, [token, fetchData]);

  function handleEnter(e: React.FormEvent) {
    e.preventDefault();
    const t = input.trim();
    if (!t) return;
    window.localStorage.setItem(STORAGE_KEY, t);
    setToken(t);
    setInput("");
  }

  function handleExit() {
    window.localStorage.removeItem(STORAGE_KEY);
    setToken("");
    setData(null);
    setError(null);
  }

  // ── Pantalla de acceso (sin token válido) ──────────────────────────────────
  if (!token || (!data && error)) {
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>PESSARO BRIDGE</h1>
            <p className={styles.subtitle}>Portal del cliente</p>
          </div>
        </header>
        <section className={styles.panel} style={{ maxWidth: 480 }}>
          <h2 className={styles.panelTitle}>Ingresa tu token de acceso</h2>
          <form onSubmit={handleEnter} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Pega aquí tu token"
              className={styles.settingsInput}
              style={{ flex: 1, minWidth: 240 }}
              autoFocus
            />
            <button type="submit" className={styles.saveButton}>
              Entrar
            </button>
          </form>
          {error && <div className={styles.banner} style={{ marginTop: 12 }}>{error}</div>}
          <p className={styles.hint}>
            Es el mismo token que configuraste en tu Expert Advisor de MetaTrader. Si no lo tienes, pídelo a tu contacto
            de Pessaro Capital.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>PESSARO BRIDGE</h1>
          <p className={styles.subtitle}>
            {data?.client.name ? `Hola, ${data.client.name}` : "Portal del cliente"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Mismo token, misma clave de localStorage: el cliente cruza al
              Trading Portal sin volver a autenticarse. */}
          <a href="/portal/resumen" className={styles.gateButton} style={{ textDecoration: "none" }}>
            Mi cuenta →
          </a>
          <button type="button" onClick={handleExit} className={styles.gateButton}>
            Salir
          </button>
        </div>
      </header>

      <section className={styles.statGrid}>
        <StatTile label="Señales recibidas" value={data ? String(data.report.total) : "—"} />
        <StatTile label="Símbolos" value={data ? String(data.report.bySymbol.length) : "—"} />
        <StatTile
          label="Última señal"
          value={data?.report.lastReceivedAt ? formatRelative(data.report.lastReceivedAt) : "—"}
        />
        <StatTile
          label="Vigencia"
          value={
            data
              ? data.client.expires_at
                ? new Date(data.client.expires_at).toLocaleDateString("es-CL")
                : "Indefinida"
              : "—"
          }
        />
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Tu token</h2>
        <p className={styles.mono}>
          {revealToken ? data?.client.token : "•".repeat(24)}
          <button
            type="button"
            onClick={() => setRevealToken((v) => !v)}
            className={styles.gateButton}
            style={{ padding: "2px 8px", fontSize: 11, marginLeft: 8 }}
          >
            {revealToken ? "Ocultar" : "Ver"}
          </button>
          <button
            type="button"
            onClick={() => data && navigator.clipboard.writeText(data.client.token)}
            className={styles.gateButton}
            style={{ padding: "2px 8px", fontSize: 11, marginLeft: 6 }}
          >
            Copiar
          </button>
        </p>
        <p className={styles.hint}>
          Configúralo en el campo <span className={styles.mono}>InpEaToken</span> de tu Expert Advisor. Es personal e
          intransferible.
        </p>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Símbolos recibidos</h2>
        {data && data.report.bySymbol.length > 0 ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {data.report.bySymbol.map((s) => (
              <span key={s.symbol} className={`${styles.badge} ${styles.badge_neutral}`}>
                {s.symbol} · {s.count}
              </span>
            ))}
          </div>
        ) : (
          <p className={styles.emptyRow}>Aún no has recibido señales</p>
        )}
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Reporte</h2>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <ReportBlock title="Por calidad" items={data?.report.byGrade.map((g) => ({ k: g.grade, n: g.count })) ?? []} />
          <ReportBlock
            title="Por estado"
            items={data?.report.byStatus.map((s) => ({ k: STATUS_LABEL[s.status] ?? s.status, n: s.count })) ?? []}
          />
        </div>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Señales recibidas</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Símbolo</th>
              <th>Acción</th>
              <th>Calidad</th>
              <th>Precio</th>
              <th>SL</th>
              <th>TP1/TP2</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {(data?.signals ?? []).map((s, i) => (
              <tr key={`${s.ts_signal}-${s.symbol}-${i}`}>
                <td className={styles.mono}>{new Date(s.claimed_at).toLocaleString("es-CL")}</td>
                <td>{s.symbol}</td>
                <td>{actionLabel(s.action, s.type)}</td>
                <td>{s.grade === "ELITE" ? <span className={`${styles.badge} ${styles.badge_gold}`}>★ ELITE</span> : (s.grade ?? "—")}</td>
                <td className={styles.mono}>{fmt(s.price)}</td>
                <td className={styles.mono}>{fmt(s.sl)}</td>
                <td className={styles.mono}>
                  {fmt(s.tp1)}/{fmt(s.tp2)}
                </td>
                <td>{STATUS_LABEL[s.status] ?? s.status}</td>
              </tr>
            ))}
            {data && data.signals.length === 0 && (
              <tr>
                <td colSpan={8} className={styles.emptyRow}>
                  Sin señales todavía
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {loading && !data && <p className={styles.hint}>Cargando…</p>}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  claimed: "Entregada",
  notified: "Notificada",
  error: "Error",
};

function actionLabel(action: string, type: string | null): string {
  const tipo = type === "STOP" ? "STOP" : type === "MARKET" ? "MARKET" : "LIMIT";
  switch (action) {
    case "BUY_DUAL":
      return `◆ BUY ${tipo}`;
    case "SELL_DUAL":
      return `◆ SELL ${tipo}`;
    case "SETUP_BUY":
      return `◇ SETUP BUY ${tipo}`;
    case "SETUP_SELL":
      return `◇ SETUP SELL ${tipo}`;
    case "CANCEL_ALL":
    case "SETUP_CANCEL":
      return "CANCELAR";
    default:
      return action;
  }
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.statTile}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

function ReportBlock({ title, items }: { title: string; items: { k: string; n: number }[] }) {
  return (
    <div>
      <p className={styles.statLabel}>{title}</p>
      {items.length === 0 ? (
        <p className={styles.hint} style={{ margin: 0 }}>
          —
        </p>
      ) : (
        items.map((it) => (
          <p key={it.k} className={styles.mono} style={{ margin: "2px 0" }}>
            {it.k}: {it.n}
          </p>
        ))
      )}
    </div>
  );
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  let s = n.toFixed(5);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (!s.includes(".")) s += ".0";
  return s;
}

function formatRelative(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}
