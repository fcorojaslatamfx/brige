"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import styles from "./status.module.css";

type Settings = {
  symbol_threshold: number;
  global_threshold: number;
  freshness_seconds: number;
  queue_ttl_seconds: number;
  setup_hold_seconds: number;
  suppress_orphan_cancels: boolean;
  updated_at: string;
  updated_by: string | null;
};

type DayCount = { symbol: string; symbol_count: number; global_count: number };

type SignalAction = "BUY_DUAL" | "SELL_DUAL" | "SETUP_BUY" | "SETUP_SELL" | "CANCEL_ALL" | "SETUP_CANCEL";

type OriginFilter = "tradingview" | "test" | "manual" | "replay" | "all";

type SignalRow = {
  id: string;
  action: SignalAction;
  symbol: string;
  tf: string | null;
  grade: "ELITE" | "STANDARD" | null;
  price: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  status: string;
  auth_symbol_count: number | null;
  auth_global_count: number | null;
  auth_threshold_exceeded: boolean | null;
  error: string | null;
  duplicate_of: string | null;
  origin: string;
  is_test: boolean;
  created_at: string;
};

type FunnelRow = { status: string; error: string | null; n: number; pct: number };
type LatencyRow = {
  action: string;
  n: number;
  lag_avg: number | null;
  lag_min: number | null;
  lag_max: number | null;
  over_fresh: number;
};

type AuditRow = {
  id: number;
  signal_id: string | null;
  event_type: string;
  detail: unknown;
  created_at: string;
};

type StatusResponse = {
  ok: true;
  settings: Settings;
  origin: OriginFilter;
  broker: string;
  brokers: string[];
  pending_count: number;
  recent_signals: SignalRow[];
  recent_audit: AuditRow[];
  day_counts: DayCount[];
  global_count: number;
  global_threshold_exceeded: boolean;
  symbols_over_threshold: number;
  last_poll_at: string | null;
  last_poll_latency_seconds: number | null;
  ea_online: boolean;
  delivery_funnel: FunnelRow[];
  latency_stats: LatencyRow[];
};

type SettingsForm = Partial<
  Pick<
    Settings,
    | "symbol_threshold"
    | "global_threshold"
    | "freshness_seconds"
    | "queue_ttl_seconds"
    | "setup_hold_seconds"
    | "suppress_orphan_cancels"
  >
>;

const REFRESH_MS = 5000;

export default function StatusPage() {
  const router = useRouter();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [form, setForm] = useState<SettingsForm>({});
  const [origin, setOrigin] = useState<OriginFilter>("tradingview");
  const [broker, setBroker] = useState<string>("all");

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/status?origin=${origin}&broker=${encodeURIComponent(broker)}`, { cache: "no-store" });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      // Un admin (rol normal) no ve el panel operativo completo: su dashboard
      // es /status/clients (solo sus clientes, sin config del bridge).
      if (res.status === 403) {
        router.replace("/status/clients");
        return;
      }
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Error desconocido");
        return;
      }
      setData(json);
      setError(null);
    } catch {
      setError("No se pudo contactar al bridge.");
    }
  }, [router, origin, broker]);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  useEffect(() => {
    if (data?.settings) {
      setForm({
        symbol_threshold: data.settings.symbol_threshold,
        global_threshold: data.settings.global_threshold,
        freshness_seconds: data.settings.freshness_seconds,
        queue_ttl_seconds: data.settings.queue_ttl_seconds,
        setup_hold_seconds: data.settings.setup_hold_seconds,
        suppress_orphan_cancels: data.settings.suppress_orphan_cancels,
      });
    }
  }, [data?.settings]);

  async function handleSaveSettings() {
    setSavingSettings(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error ?? "No se pudo guardar la configuración.");
      else await fetchStatus();
    } catch {
      setError("No se pudo guardar la configuración.");
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleLogout() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>PESSARO BRIDGE</h1>
          <p className={styles.subtitle}>Modo despachador manual · el trader decide</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <EaStatusBadge data={data} />
          <Link href="/status/tokens" className={styles.navLink} style={{ textDecoration: "none" }}>
            Tokens
          </Link>
          <Link href="/status/users" className={styles.navLink} style={{ textDecoration: "none" }}>
            Usuarios
          </Link>
          <button type="button" onClick={handleLogout} className={styles.gateButton}>
            Cerrar sesión
          </button>
        </div>
      </header>

      {error && <div className={styles.banner}>{error}</div>}

      {data && !data.ea_online && (
        <div className={styles.banner}>
          ⚠ El EA no está haciendo polling
          {data.last_poll_at ? ` (último poll ${formatRelative(data.last_poll_at)})` : " (sin registro de poll)"}. Durante
          la ventana LON→NY esto significa señales caducando sin ser entregadas — revisa que el terminal esté encendido.
        </div>
      )}

      <section className={styles.panel} style={{ paddingTop: 12, paddingBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className={styles.statLabel}>Origen del tráfico</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["tradingview", "test", "manual", "replay", "all"] as OriginFilter[]).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOrigin(o)}
                className={styles.gateButton}
                style={{
                  opacity: origin === o ? 1 : 0.5,
                  textTransform: "none",
                }}
              >
                {o === "all" ? "todos" : o}
              </button>
            ))}
          </div>
          {origin !== "tradingview" && <Badge tone="warning">VIENDO TRÁFICO NO-PRODUCCIÓN</Badge>}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
          <span className={styles.statLabel}>Bróker</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["all", ...(data?.brokers ?? [])] as string[]).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBroker(b)}
                className={styles.gateButton}
                style={{ opacity: broker === b ? 1 : 0.5, textTransform: "none" }}
              >
                {b === "all" ? "todos" : b}
              </button>
            ))}
          </div>
          {broker !== "all" && <Badge tone="purple">SEÑALES ENTREGADAS A {broker.toUpperCase()}</Badge>}
        </div>
      </section>

      <section className={styles.statGrid}>
        <StatTile label="Pendientes en cola" value={data ? String(data.pending_count) : "—"} />
        <StatTile
          label="Global hoy"
          value={data ? `${data.global_count}/${data.settings.global_threshold}` : "—"}
          warning={data?.global_threshold_exceeded}
        />
        <StatTile
          label="Símbolos sobre umbral"
          value={data ? String(data.symbols_over_threshold) : "—"}
          warning={!!data && data.symbols_over_threshold > 0}
        />
        <StatTile
          label="Último poll del EA"
          value={data?.last_poll_at ? formatRelative(data.last_poll_at) : "sin datos"}
          warning={!!data && !data.ea_online}
        />
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Conteo del día por símbolo</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Símbolo</th>
              <th>Señales</th>
              <th>Umbral</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {(data?.day_counts ?? []).map((d) => {
              const exceeded = d.symbol_count > (data?.settings.symbol_threshold ?? 0);
              return (
                <tr key={d.symbol} className={exceeded ? styles.rowWarning : undefined}>
                  <td>{d.symbol}</td>
                  <td className={styles.mono}>{d.symbol_count}</td>
                  <td className={styles.mono}>{data?.settings.symbol_threshold}</td>
                  <td>{exceeded ? <Badge tone="warning">SOBRE UMBRAL</Badge> : <Badge tone="ok">OK</Badge>}</td>
                </tr>
              );
            })}
            {data && data.day_counts.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.emptyRow}>
                  Sin señales de entrada hoy
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Umbrales — mapa operativo (editable, sin redeploy)</h2>
        <div className={styles.settingsGrid}>
          <SettingsField
            label="Umbral por símbolo"
            value={form.symbol_threshold}
            onChange={(v) => setForm((f) => ({ ...f, symbol_threshold: v }))}
          />
          <SettingsField
            label="Umbral global"
            value={form.global_threshold}
            onChange={(v) => setForm((f) => ({ ...f, global_threshold: v }))}
          />
          <SettingsField
            label="Frescura ingesta (s)"
            value={form.freshness_seconds}
            onChange={(v) => setForm((f) => ({ ...f, freshness_seconds: v }))}
          />
          <SettingsField
            label="TTL de cola (s)"
            value={form.queue_ttl_seconds}
            onChange={(v) => setForm((f) => ({ ...f, queue_ttl_seconds: v }))}
          />
          <SettingsField
            label="Retención de armados (s)"
            value={form.setup_hold_seconds}
            onChange={(v) => setForm((f) => ({ ...f, setup_hold_seconds: v }))}
          />
        </div>
        <label className={styles.hint} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={form.suppress_orphan_cancels ?? true}
            onChange={(e) => setForm((f) => ({ ...f, suppress_orphan_cancels: e.target.checked }))}
          />
          Ocultar cancelaciones huérfanas
        </label>
        <p className={styles.hint}>
          Retención: un SETUP BUY/SELL espera esos segundos antes de salir al terminal. Si en ese lapso llega su
          cancelación, la pareja se marca SUPRIMIDA y no suena en MT4. 0 desactiva la retención. Los disparos
          (BUY/SELL) nunca se retienen. Tiene que ser menor que el TTL de cola.
        </p>
        <p className={styles.hint}>
          Cancelaciones huérfanas: una cancelación se entrega solo si hay una entrada de ese símbolo que sí salió al
          terminal y que todavía no fue cerrada. Si no hay nada vivo que cancelar, no es información — es la
          cancelación de algo que nunca se te notificó (murió por TTL o con el terminal apagado). Desmarca la casilla
          para volver al comportamiento anterior; el guardarraíl no se toca, con algo vivo detrás siempre se entrega.
        </p>
        <button className={styles.saveButton} onClick={handleSaveSettings} disabled={savingSettings}>
          {savingSettings ? "Guardando…" : "Guardar umbrales"}
        </button>
        {data?.settings.updated_at && (
          <p className={styles.hint}>
            Última edición: {new Date(data.settings.updated_at).toLocaleString("es-CL")}
            {data.settings.updated_by ? ` · ${data.settings.updated_by}` : ""}
          </p>
        )}
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Embudo de entrega · últimas 48 h</h2>
        <DeliveryFunnel rows={data?.delivery_funnel ?? []} />
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>
          Latencia de ingesta ts_signal → recepción · línea de frescura {data?.settings.freshness_seconds ?? "—"}s
        </h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Acción</th>
              <th>n</th>
              <th>Lag medio</th>
              <th>Lag mín</th>
              <th>Lag máx</th>
              <th>Sobre frescura</th>
            </tr>
          </thead>
          <tbody>
            {(data?.latency_stats ?? []).map((l) => (
              <tr key={l.action} className={l.over_fresh > 0 ? styles.rowWarning : undefined}>
                <td>
                  <DirectionBadge action={l.action as SignalAction} />
                </td>
                <td className={styles.mono}>{l.n}</td>
                <td className={styles.mono}>{l.lag_avg ?? "—"}s</td>
                <td className={styles.mono}>{l.lag_min ?? "—"}s</td>
                <td className={styles.mono}>{l.lag_max ?? "—"}s</td>
                <td className={styles.mono}>
                  {l.over_fresh > 0 ? <Badge tone="critical">{l.over_fresh}</Badge> : <Badge tone="ok">0</Badge>}
                </td>
              </tr>
            ))}
            {data && data.latency_stats.length === 0 && (
              <tr>
                <td colSpan={6} className={styles.emptyRow}>
                  Sin señales en la ventana
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Señales en vivo</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Símbolo</th>
              <th>Acción</th>
              <th>Grade</th>
              <th>Precio</th>
              <th>SL</th>
              <th>TP1/TP2</th>
              <th>Estado</th>
              <th>Conteo sím/glb</th>
            </tr>
          </thead>
          <tbody>
            {(data?.recent_signals ?? []).map((s) => (
              <tr key={s.id} className={s.auth_threshold_exceeded ? styles.rowWarning : undefined}>
                <td className={styles.mono}>{new Date(s.created_at).toLocaleTimeString("es-CL")}</td>
                <td>{s.symbol}</td>
                <td>
                  <DirectionBadge action={s.action} />
                </td>
                <td>{s.grade === "ELITE" ? <Badge tone="gold">★ ELITE</Badge> : s.grade ?? "—"}</td>
                <td className={styles.mono}>{fmt(s.price)}</td>
                <td className={styles.mono}>{fmt(s.sl)}</td>
                <td className={styles.mono}>
                  {fmt(s.tp1)}/{fmt(s.tp2)}
                </td>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td className={styles.mono}>
                  {s.auth_symbol_count ?? "—"}/{data?.settings.symbol_threshold ?? "—"} · {s.auth_global_count ?? "—"}/
                  {data?.settings.global_threshold ?? "—"}
                  {s.auth_threshold_exceeded ? " ⚠" : ""}
                </td>
              </tr>
            ))}
            {data && data.recent_signals.length === 0 && (
              <tr>
                <td colSpan={9} className={styles.emptyRow}>
                  Sin señales todavía
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Auditoría reciente</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Evento</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {(data?.recent_audit ?? []).map((a) => (
              <tr key={a.id}>
                <td className={styles.mono}>{new Date(a.created_at).toLocaleTimeString("es-CL")}</td>
                <td>{a.event_type}</td>
                <td className={styles.detailCell}>{JSON.stringify(a.detail)}</td>
              </tr>
            ))}
            {data && data.recent_audit.length === 0 && (
              <tr>
                <td colSpan={3} className={styles.emptyRow}>
                  Sin eventos
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ==================== subcomponentes ====================

function StatTile({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className={`${styles.statTile} ${warning ? styles.statTileWarning : ""}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

type BadgeTone = "ok" | "warning" | "critical" | "neutral" | "gold" | "buy" | "sell" | "purple";

function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  const toneClass = styles[`badge_${tone}` as keyof typeof styles];
  return <span className={`${styles.badge} ${toneClass}`}>{children}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: BadgeTone; label: string }> = {
    pending: { tone: "purple", label: "PENDIENTE" },
    claimed: { tone: "purple", label: "RECLAMADA" },
    notified: { tone: "ok", label: "NOTIFICADA" },
    rejected_technical: { tone: "critical", label: "RECHAZADA" },
    expired: { tone: "warning", label: "EXPIRADA" },
    error: { tone: "critical", label: "ERROR" },
    suppressed: { tone: "neutral", label: "SUPRIMIDA" },
  };
  const m = map[status] ?? { tone: "neutral", label: status.toUpperCase() };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

function DirectionBadge({ action }: { action: SignalAction }) {
  // ◇ setup armado (pendiente colocable) · ◆ disparo (el precio tocó el nivel)
  switch (action) {
    case "CANCEL_ALL":
    case "SETUP_CANCEL":
      return <Badge tone="neutral">CANCEL</Badge>;
    case "BUY_DUAL":
      return <Badge tone="buy">◆ BUY</Badge>;
    case "SELL_DUAL":
      return <Badge tone="sell">◆ SELL</Badge>;
    case "SETUP_BUY":
      return <Badge tone="buy">◇ SETUP BUY</Badge>;
    case "SETUP_SELL":
      return <Badge tone="sell">◇ SETUP SELL</Badge>;
    default:
      return <Badge tone="neutral">{action}</Badge>;
  }
}

function DeliveryFunnel({ rows }: { rows: FunnelRow[] }) {
  if (rows.length === 0) return <p className={styles.emptyRow}>Sin señales en la ventana</p>;

  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const by = (pred: (r: FunnelRow) => boolean) => rows.filter(pred).reduce((s, r) => s + r.n, 0);

  // Embudo: recibidas → validadas (no rechazadas) → notificadas.
  const rejected = by((r) => r.status === "rejected_technical");
  const validated = total - rejected;
  const notified = by((r) => r.status === "notified");
  const rejectionsByReason = rows
    .filter((r) => r.status === "rejected_technical")
    .map((r) => ({ reason: r.error ?? "—", n: r.n }));

  const steps = [
    { label: "Recibidas", value: total },
    { label: "Validadas", value: validated },
    { label: "Notificadas", value: notified },
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        {steps.map((s) => (
          <div key={s.label} className={styles.statTile} style={{ flex: "1 1 120px" }}>
            <span className={styles.statLabel}>{s.label}</span>
            <span className={styles.statValue}>{s.value}</span>
            <span className={styles.hint}>{total > 0 ? `${Math.round((100 * s.value) / total)}%` : "—"}</span>
          </div>
        ))}
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Estado</th>
            <th>Motivo</th>
            <th>n</th>
            <th>%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.status}-${r.error ?? "none"}-${i}`}>
              <td>
                <StatusBadge status={r.status} />
              </td>
              <td>{r.error ?? "—"}</td>
              <td className={styles.mono}>{r.n}</td>
              <td className={styles.mono}>{r.pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rejectionsByReason.length > 0 && (
        <p className={styles.hint}>
          Rechazos técnicos: {rejectionsByReason.map((r) => `${r.reason} ${r.n}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

function EaStatusBadge({ data }: { data: StatusResponse | null }) {
  if (!data) return <Badge tone="neutral">CARGANDO…</Badge>;
  return data.ea_online ? (
    <Badge tone="ok">
      <span className={styles.liveDot} /> EA ONLINE
    </Badge>
  ) : (
    <Badge tone="critical">
      <span className={styles.dotStatic} /> EA OFFLINE
    </Badge>
  );
}

function SettingsField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  return (
    <label className={styles.settingsField}>
      <span>{label}</span>
      <input
        type="number"
        min={1}
        value={value ?? ""}
        onChange={(e) => onChange(Number(e.target.value))}
        className={styles.settingsInput}
      />
    </label>
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
  const diffMs = Date.now() - new Date(iso).getTime();
  // Math.max(0, ...): el reloj del navegador puede ir unos segundos
  // atrasado respecto al servidor que puso el timestamp — sin el clamp,
  // un poll recién registrado se mostraba como "hace -135s" en vez de
  // "hace 0s".
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  return `hace ${h}h`;
}
