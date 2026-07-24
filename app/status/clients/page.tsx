"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import styles from "../status.module.css";

type Role = "super_admin" | "admin";

type ClientStatus = "active" | "expired" | "revoked";
type Expiry = "7d" | "14d" | "30d" | "never";

type ClientRow = {
  id: string;
  token: string;
  client_name: string | null;
  client_email: string;
  client_phone: string;
  assigned_admin: string | null;
  assigned_admin_email: string | null;
  expires_at: string | null;
  created_by_email: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  status: ClientStatus;
};

type AdminOption = { user_id: string; email: string | null; role: string };

const EXPIRY_LABEL: Record<Expiry, string> = {
  "7d": "7 días",
  "14d": "14 días",
  "30d": "30 días",
  never: "Indefinido",
};

const ONLINE_THRESHOLD_MS = 15_000;

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
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [assignedAdmin, setAssignedAdmin] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("30d");
  const [creating, setCreating] = useState(false);

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

  useEffect(() => {
    fetchClients();
    const id = setInterval(fetchClients, 5000);
    return () => clearInterval(id);
  }, [fetchClients]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !phone.trim()) return;
    setCreating(true);
    setNotice(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: name.trim() || undefined,
          client_email: email.trim(),
          client_phone: phone.trim(),
          assigned_admin: assignedAdmin || undefined,
          expiry,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "No se pudo crear el cliente.");
        return;
      }
      setName("");
      setEmail("");
      setPhone("");
      setAssignedAdmin("");
      setRevealed((prev) => new Set(prev).add(json.client.id));
      setNotice("Cliente creado. Su token ya está visible abajo — cópialo o compártelo por correo.");
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
            {isSuper ? "Clientes · tokens de señales por lead/contacto" : "Mis clientes · tokens compartidos por Pessaro"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {isSuper ? (
            <>
              <Link href="/status/users" className={styles.gateButton} style={{ textDecoration: "none" }}>
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
        <h2 className={styles.panelTitle}>Generar token de cliente</h2>
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nombre (opcional)"
            className={styles.settingsInput}
            style={{ minWidth: 160 }}
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
            <option value="7d">Caduca en 7 días</option>
            <option value="14d">Caduca en 14 días</option>
            <option value="30d">Caduca en 30 días</option>
            <option value="never">Indefinido</option>
          </select>
          <button type="submit" className={styles.saveButton} disabled={creating}>
            {creating ? "Generando…" : "Generar token"}
          </button>
        </form>
        <p className={styles.hint}>
          Solo el Super Admin puede generar tokens. Cada token pertenece a un único cliente (correo + móvil) y se
          configura en el campo <span className={styles.mono}>InpEaToken</span> del EA de MetaTrader del cliente.
        </p>
      </section>
      )}

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>{isSuper ? "Clientes con token" : "Mis clientes"}</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Cliente</th>
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
                  <div>{c.client_name ?? "—"}</div>
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
                <td className={styles.mono}>
                  {c.expires_at ? new Date(c.expires_at).toLocaleDateString("es-CL") : "Indefinido"}
                </td>
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
                      <button
                        type="button"
                        onClick={() => handleRevoke(c)}
                        className={styles.gateButton}
                        style={{ padding: "4px 10px", fontSize: 11 }}
                        disabled={busyId === c.id || c.status === "revoked"}
                      >
                        Revocar
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {clients && clients.length === 0 && (
              <tr>
                <td colSpan={isSuper ? 7 : 6} className={styles.emptyRow}>
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

function formatPoll(iso: string | null): string {
  if (!iso) return "nunca";
  const diffMs = Date.now() - new Date(iso).getTime();
  const online = diffMs < ONLINE_THRESHOLD_MS;
  const s = Math.max(0, Math.floor(diffMs / 1000));
  const rel = s < 60 ? `hace ${s}s` : s < 3600 ? `hace ${Math.floor(s / 60)}m` : `hace ${Math.floor(s / 3600)}h`;
  return online ? `● ${rel}` : rel;
}
