"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import { EA_ONLINE_THRESHOLD_SECONDS } from "@/lib/heartbeat";
import styles from "../status.module.css";

type Role = "super_admin" | "admin";

type ClientStatus = "active" | "expired" | "revoked";
type Expiry = "7d" | "14d" | "30d";

type ClientRow = {
  id: string;
  token: string;
  client_name: string;
  client_last_name: string;
  client_email: string;
  client_phone: string;
  broker: string;
  account_type: "demo" | "real";
  account_number: string;
  broker_server: string;
  assigned_admin: string | null;
  assigned_admin_email: string | null;
  // NOT NULL desde la migración 019, pero se sigue tipando nullable: si el
  // código llega a producción antes que la migración, la tabla es lo único que
  // manda y "Invalid Date" en la columna de vencimiento sería peor que decirlo.
  expires_at: string | null;
  created_by_email: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  status: ClientStatus;
};

type AdminOption = { user_id: string; email: string | null; role: string };

const EXPIRY_OPTIONS: { value: Expiry; label: string }[] = [
  { value: "7d", label: "7 días" },
  { value: "14d", label: "14 días" },
  { value: "30d", label: "30 días" },
];

const EXPIRY_DAYS: Record<Expiry, number> = { "7d": 7, "14d": 14, "30d": 30 };

// Atado a HEARTBEAT_MIN_INTERVAL_SECONDS de lib/tokens.ts: el heartbeat de un
// cliente solo se persiste una vez cada 30 s, así que un umbral menor pintaría
// "offline" a EAs perfectamente vivos durante la mayor parte de cada ventana.
// Se importa la constante en vez de repetir el número para que bajar la
// cadencia de escritura no pueda dejar este badge desincronizado en silencio.
const ONLINE_THRESHOLD_MS = EA_ONLINE_THRESHOLD_SECONDS * 1000;

export default function ClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [role, setRole] = useState<Role>("admin");
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const isSuper = role === "super_admin";

  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [broker, setBroker] = useState("");
  const [accountType, setAccountType] = useState<"demo" | "real">("demo");
  const [accountNumber, setAccountNumber] = useState("");
  const [brokerServer, setBrokerServer] = useState("");
  const [assignedAdmin, setAssignedAdmin] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("30d");
  const [creating, setCreating] = useState(false);
  // Plazo elegido por fila para renovar. Fuera del estado de alta: son dos
  // decisiones distintas y compartir el selector haría que elegir "7 días" para
  // renovar a un cliente cambiara sin avisar el plazo del formulario de alta.
  const [renewExpiry, setRenewExpiry] = useState<Record<string, Expiry>>({});

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch("/api/clients", { cache: "no-store" });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "No se pudieron cargar los clientes.");
        return;
      }
      setClients(json.clients);
      setAdmins(json.admins ?? []);
      if (json.role) setRole(json.role);
      setError(null);
    } catch {
      setError("No se pudo contactar al bridge.");
    }
  }, []);

  async function handleLogout() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  // 15 s en vez de 5: lo único que cambia solo en esta pantalla es el badge
  // online/offline, y su heartbeat ya solo se persiste una vez cada 30 s
  // (EA_ONLINE_THRESHOLD_SECONDS), así que refrescar cada 5 s consultaba tres
  // veces por cada dato nuevo que podía existir.
  useEffect(() => {
    fetchClients();
    const id = setInterval(fetchClients, 15000);
    return () => clearInterval(id);
  }, [fetchClients]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (
      !name.trim() ||
      !lastName.trim() ||
      !email.trim() ||
      !phone.trim() ||
      !broker.trim() ||
      !accountNumber.trim() ||
      !brokerServer.trim()
    )
      return;
    setCreating(true);
    setNotice(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: name.trim(),
          client_last_name: lastName.trim(),
          client_email: email.trim(),
          client_phone: phone.trim(),
          assigned_admin: assignedAdmin || undefined,
          expiry,
          broker: broker.trim(),
          account_type: accountType,
          account_number: accountNumber.trim(),
          broker_server: brokerServer.trim(),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "No se pudo crear el cliente.");
        return;
      }
      setName("");
      setLastName("");
      setEmail("");
      setPhone("");
      setBroker("");
      setAccountType("demo");
      setAccountNumber("");
      setBrokerServer("");
      setAssignedAdmin("");
      setRevealed((prev) => new Set(prev).add(json.client.id));
      setNotice(
        json.email_warning
          ? `Cliente creado, pero ${json.email_warning}. Su token está visible abajo: puedes reenviarlo con Compartir.`
          : "Cliente invitado. Se le envió su token por correo y se avisó a los super admin.",
      );
      await fetchClients();
    } catch {
      setError("No se pudo crear el cliente.");
    } finally {
      setCreating(false);
    }
  }

  async function handleShare(c: ClientRow) {
    if (!window.confirm(`¿Enviar el token por correo a ${c.client_email}?`)) return;
    setBusyId(c.id);
    setNotice(null);
    try {
      const res = await fetch("/api/clients/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id }),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error ?? "No se pudo enviar el correo.");
      else setNotice(`Token enviado a ${c.client_email}.`);
    } catch {
      setError("No se pudo enviar el correo.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRenew(c: ClientRow) {
    const opcion = renewExpiry[c.id] ?? "30d";
    const hasta = new Date(Date.now() + EXPIRY_DAYS[opcion] * 86_400_000).toLocaleDateString("es-CL");
    // El diálogo repite nombre, correo y móvil: el token está ligado a esa
    // identidad y es lo que el operador tiene que reconocer antes de extenderle
    // el acceso a alguien por un mes.
    const ok = window.confirm(
      `¿Renovar por ${EXPIRY_DAYS[opcion]} días el acceso de ${c.client_name} ${c.client_last_name}?\n\n` +
        `Correo: ${c.client_email}\nMóvil: ${c.client_phone}\n\n` +
        `Su token no cambia (no reconfigura su EA) y quedará vigente hasta el ${hasta}.`,
    );
    if (!ok) return;

    setBusyId(c.id);
    setNotice(null);
    try {
      const res = await fetch("/api/clients/renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id, client_email: c.client_email, expiry: opcion }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "No se pudo renovar.");
        return;
      }
      setNotice(
        json.email_warning
          ? `Vigencia extendida hasta el ${hasta}, pero ${json.email_warning}.`
          : `Acceso de ${c.client_email} renovado hasta el ${hasta}. Se le avisó por correo.`,
      );
      await fetchClients();
    } catch {
      setError("No se pudo renovar.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevoke(c: ClientRow) {
    if (!window.confirm(`¿Revocar el acceso de ${c.client_email}? Su EA dejará de recibir señales.`)) return;
    setBusyId(c.id);
    try {
      const res = await fetch("/api/clients/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id }),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error ?? "No se pudo revocar.");
      else await fetchClients();
    } catch {
      setError("No se pudo revocar.");
    } finally {
      setBusyId(null);
    }
  }

  function toggleReveal(id: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyValue(value: string) {
    await navigator.clipboard.writeText(value);
    setNotice("Token copiado al portapapeles.");
  }

  if (forbidden) {
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>PESSARO BRIDGE</h1>
          <Link href="/status" className={styles.gateButton} style={{ textDecoration: "none" }}>
            Volver al panel
          </Link>
        </header>
        <div className={styles.banner}>No autorizado — la gestión de clientes es solo para Super Admin.</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>PESSARO BRIDGE</h1>
          <p className={styles.subtitle}>
            {isSuper
              ? "Invitación · clientes con token de señales"
              : "Mis clientes · tokens compartidos por Pessaro"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {isSuper ? (
            <>
              <Link href="/status/users" className={styles.navLink} style={{ textDecoration: "none" }}>
                Usuarios
              </Link>
              <Link href="/status" className={styles.gateButton} style={{ textDecoration: "none" }}>
                Volver al panel
              </Link>
            </>
          ) : (
            <button type="button" onClick={handleLogout} className={styles.gateButton}>
              Cerrar sesión
            </button>
          )}
        </div>
      </header>

      {error && <div className={styles.banner}>{error}</div>}
      {notice && <p className={styles.hint} style={{ marginTop: 0 }}>{notice}</p>}

      {!isSuper && (
        <p className={styles.hint} style={{ marginTop: 0 }}>
          Estos son los tokens que Pessaro te asignó para tus leads y contactos. Puedes copiarlos o enviarlos por correo
          al cliente. La generación y revocación las gestiona el Super Admin.
        </p>
      )}

      {isSuper && (
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Invitar cliente</h2>
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nombre"
            className={styles.settingsInput}
            style={{ minWidth: 140 }}
            required
          />
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Apellido"
            className={styles.settingsInput}
            style={{ minWidth: 140 }}
            required
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="correo@cliente.com"
            className={styles.settingsInput}
            style={{ minWidth: 200 }}
            required
          />
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+56 9 1234 5678"
            className={styles.settingsInput}
            style={{ minWidth: 150 }}
            required
          />
          <input
            type="text"
            value={broker}
            onChange={(e) => setBroker(e.target.value)}
            placeholder="Bróker (ej. Tradeview)"
            className={styles.settingsInput}
            style={{ minWidth: 160 }}
            required
          />
          <select
            value={accountType}
            onChange={(e) => setAccountType(e.target.value as "demo" | "real")}
            className={styles.settingsInput}
            style={accountType === "real" ? { color: "var(--red)", fontWeight: 700 } : undefined}
            required
          >
            <option value="demo">Cuenta Demo</option>
            <option value="real">Cuenta Real</option>
          </select>
          <input
            type="text"
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
            placeholder="N° de cuenta"
            className={styles.settingsInput}
            style={{ minWidth: 130 }}
            required
          />
          <input
            type="text"
            value={brokerServer}
            onChange={(e) => setBrokerServer(e.target.value)}
            placeholder="Servidor (ej. Tradeview-Demo)"
            className={styles.settingsInput}
            style={{ minWidth: 180 }}
            required
          />
          <select
            value={assignedAdmin}
            onChange={(e) => setAssignedAdmin(e.target.value)}
            className={styles.settingsInput}
          >
            <option value="">Admin (sin asignar)</option>
            {admins.map((a) => (
              <option key={a.user_id} value={a.user_id}>
                {a.email ?? a.user_id}
              </option>
            ))}
          </select>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)} className={styles.settingsInput}>
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                Caduca en {o.label}
              </option>
            ))}
          </select>
          <button type="submit" className={styles.navLink} disabled={creating}>
            {creating ? "Enviando…" : "Invitación"}
          </button>
        </form>
        <p className={styles.hint}>
          Solo el Super Admin puede invitar clientes. Al enviar, el cliente recibe su token por correo y todos los
          Super Admin reciben un aviso del alta. Cada token pertenece a un único cliente (correo + nombre + móvil) y se
          configura en el campo <span className={styles.mono}>InpEaToken</span> del EA de MetaTrader del cliente.
          Todo acceso caduca: se otorga por 7, 14 o 30 días y se extiende con <strong>Renovar</strong> por esos mismos
          plazos, sin cambiar el token ni la identidad a la que quedó ligado.
        </p>
      </section>
      )}

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>{isSuper ? "Clientes con token" : "Mis clientes"}</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Cuenta</th>
              {isSuper && <th>Admin</th>}
              <th>Token</th>
              <th>Caducidad</th>
              <th>Estado</th>
              <th>Último poll</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(clients ?? []).map((c) => (
              <tr key={c.id} className={c.status !== "active" ? styles.rowWarning : undefined}>
                <td>
                  <div>{`${c.client_name} ${c.client_last_name}`.trim()}</div>
                  <div className={styles.hint} style={{ margin: 0 }}>
                    {c.client_email}
                    {" · "}
                    <a
                      href={`https://wa.me/${c.client_phone.replace(/[^0-9]/g, "")}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "inherit" }}
                    >
                      {c.client_phone}
                    </a>
                  </div>
                </td>
                <td>
                  <div>
                    {c.broker === "SIN_DATO" ? (
                      <span className={`${styles.badge} ${styles.badge_warning}`}>SIN DATO</span>
                    ) : (
                      <>
                        {c.broker}{" "}
                        <span
                          className={`${styles.badge} ${c.account_type === "real" ? styles.badge_critical : styles.badge_neutral}`}
                        >
                          {c.account_type === "real" ? "REAL" : "DEMO"}
                        </span>
                      </>
                    )}
                  </div>
                  <div className={styles.hint} style={{ margin: 0 }}>
                    {c.account_number} · {c.broker_server}
                  </div>
                </td>
                {isSuper && <td>{c.assigned_admin_email ?? "—"}</td>}
                <td className={styles.mono}>
                  {revealed.has(c.id) ? c.token : "•".repeat(16)}
                  <button
                    type="button"
                    onClick={() => toggleReveal(c.id)}
                    className={styles.gateButton}
                    style={{ padding: "2px 8px", fontSize: 11, marginLeft: 6 }}
                  >
                    {revealed.has(c.id) ? "Ocultar" : "Ver"}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyValue(c.token)}
                    className={styles.gateButton}
                    style={{ padding: "2px 8px", fontSize: 11, marginLeft: 6 }}
                  >
                    Copiar
                  </button>
                </td>
                <td className={styles.mono}>{formatExpiry(c.expires_at)}</td>
                <td>
                  <StatusBadge status={c.status} />
                </td>
                <td className={styles.mono}>{formatPoll(c.last_used_at)}</td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => handleShare(c)}
                      className={styles.gateButton}
                      style={{ padding: "4px 10px", fontSize: 11 }}
                      disabled={busyId === c.id || c.status !== "active"}
                    >
                      Compartir
                    </button>
                    {isSuper && (
                      <>
                        <select
                          value={renewExpiry[c.id] ?? "30d"}
                          onChange={(e) =>
                            setRenewExpiry((prev) => ({ ...prev, [c.id]: e.target.value as Expiry }))
                          }
                          className={styles.settingsInput}
                          style={{ padding: "2px 4px", fontSize: 11 }}
                          disabled={c.status === "revoked"}
                          aria-label={`Plazo de renovación para ${c.client_email}`}
                        >
                          {EXPIRY_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleRenew(c)}
                          className={styles.gateButton}
                          style={{ padding: "4px 10px", fontSize: 11 }}
                          // Un token caducado SÍ se renueva: es el caso normal.
                          // Uno revocado no — se cortó a propósito y se devuelve
                          // el acceso dando de alta uno nuevo.
                          disabled={busyId === c.id || c.status === "revoked"}
                        >
                          Renovar
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRevoke(c)}
                          className={styles.gateButton}
                          style={{ padding: "4px 10px", fontSize: 11 }}
                          disabled={busyId === c.id || c.status === "revoked"}
                        >
                          Revocar
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {clients && clients.length === 0 && (
              <tr>
                <td colSpan={isSuper ? 8 : 7} className={styles.emptyRow}>
                  {isSuper ? "Sin clientes todavía" : "Aún no tienes clientes asignados"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: ClientStatus }) {
  const map: Record<ClientStatus, { cls: string; label: string }> = {
    active: { cls: "badge_ok", label: "ACTIVO" },
    expired: { cls: "badge_warning", label: "CADUCADO" },
    revoked: { cls: "badge_critical", label: "REVOCADO" },
  };
  const m = map[status];
  return <span className={`${styles.badge} ${styles[m.cls as keyof typeof styles]}`}>{m.label}</span>;
}

/**
 * Fecha de vencimiento + cuánto queda.
 *
 * Los días restantes son el dato que decide si hay que renovar; una fecha suelta
 * obliga a calcularlo mentalmente fila por fila.
 */
function formatExpiry(iso: string | null): string {
  if (!iso) return "sin fecha — renovar";
  const fecha = new Date(iso).toLocaleDateString("es-CL");
  const dias = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (dias < 0) return `${fecha} (vencido)`;
  if (dias === 0) return `${fecha} (hoy)`;
  return `${fecha} (${dias}d)`;
}

function formatPoll(iso: string | null): string {
  if (!iso) return "nunca";
  const diffMs = Date.now() - new Date(iso).getTime();
  const online = diffMs < ONLINE_THRESHOLD_MS;
  const s = Math.max(0, Math.floor(diffMs / 1000));
  const rel = s < 60 ? `hace ${s}s` : s < 3600 ? `hace ${Math.floor(s / 60)}m` : `hace ${Math.floor(s / 3600)}h`;
  return online ? `● ${rel}` : rel;
}
