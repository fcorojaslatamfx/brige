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
  updated_at: string;
  updated_by: string | null;
};

type DayCount = { symbol: string; symbol_count: number; global_count: number };

type SignalRow = {
  id: string;
  action: "BUY_DUAL" | "SELL_DUAL" | "CANCEL_ALL";
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
  created_at: string;
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
};

type SettingsForm = Partial<Pick<Settings, "symbol_threshold" | "global_threshold" | "freshness_seconds" | "queue_ttl_seconds">>;

const REFRESH_MS = 5000;

export default function StatusPage() {
  const router = useRouter();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [form, setForm] = useState<SettingsForm>({});

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.status === 401) {
        router.push("/login");
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
  }, [router]);

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
          <Link href="/status/tokens" className={styles.saveButton} style={{ textDecoration: "none" }}>
            Tokens
          </Link>
          <button type="button" onClick={handleLogout} className={styles.gateButton}>
            Cerrar sesión
          </button>
        </div>
      </header>

      {error && <div className={styles.banner}>{error}</div>}

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
        </div>
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

type BadgeTone = "ok" | "warning" | "critical" | "neutral" | "gold" | "buy" | "sell";

function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  const toneClass = styles[`badge_${tone}` as keyof typeof styles];
  return <span className={`${styles.badge} ${toneClass}`}>{children}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: BadgeTone; label: string }> = {
    pending: { tone: "neutral", label: "PENDIENTE" },
    claimed: { tone: "neutral", label: "RECLAMADA" },
    notified: { tone: "ok", label: "NOTIFICADA" },
    rejected_technical: { tone: "critical", label: "RECHAZADA" },
    expired: { tone: "warning", label: "EXPIRADA" },
    error: { tone: "critical", label: "ERROR" },
  };
  const m = map[status] ?? { tone: "neutral", label: status.toUpperCase() };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

function DirectionBadge({ action }: { action: SignalRow["action"] }) {
  if (action === "CANCEL_ALL") return <Badge tone="neutral">CANCEL</Badge>;
  return <Badge tone={action === "BUY_DUAL" ? "buy" : "sell"}>{action === "BUY_DUAL" ? "BUY" : "SELL"}</Badge>;
}

function EaStatusBadge({ data }: { data: StatusResponse | null }) {
  if (!data) return <Badge tone="neutral">CARGANDO…</Badge>;
  return data.ea_online ? <Badge tone="ok">● EA ONLINE</Badge> : <Badge tone="critical">● EA OFFLINE</Badge>;
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
