"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "../status.module.css";

type Role = "super_admin" | "admin";

/**
 * Lo que se puede dar de alta desde este formulario. "cliente" NO es un `Role`:
 * no se guarda en `user_roles`, no da acceso al panel y por debajo toma el
 * camino de `client_tokens`. Comparte formulario porque para el operador es el
 * mismo gesto — dar de alta a alguien — pero los tipos los mantienen separados.
 */
type InviteKind = Role | "cliente";
type Expiry = "7d" | "14d" | "30d" | "never";

type AdminOption = { user_id: string; email: string | null; role: string };

type UserRow = {
  user_id: string;
  email: string | null;
  role: Role;
  created_at: string;
  created_by: string | null;
  created_by_email: string | null;
  last_sign_in_at: string | null;
};

const ROLE_LABEL: Record<Role, string> = { super_admin: "Super Admin", admin: "Admin" };

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteKind>("admin");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  // Campos que solo aplican al alta de cliente.
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [cName, setCName] = useState("");
  const [cLastName, setCLastName] = useState("");
  const [cPhone, setCPhone] = useState("");
  const [cBroker, setCBroker] = useState("");
  const [cAccountType, setCAccountType] = useState<"demo" | "real">("demo");
  const [cAccountNumber, setCAccountNumber] = useState("");
  const [cBrokerServer, setCBrokerServer] = useState("");
  const [cAssignedAdmin, setCAssignedAdmin] = useState("");
  const [cExpiry, setCExpiry] = useState<Expiry>("30d");

  const esCliente = inviteRole === "cliente";

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "No se pudieron cargar los usuarios.");
        return;
      }
      setUsers(json.users);
      setError(null);
    } catch {
      setError("No se pudo contactar al bridge.");
    }
  }, []);

  // La lista de admins se usa solo para asignar un cliente a su admin dueño.
  // Se pide una vez, no en cada render del formulario.
  const fetchAdmins = useCallback(async () => {
    try {
      const res = await fetch("/api/clients", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      if (json.ok) setAdmins(json.admins ?? []);
    } catch {
      // Sin lista de admins el alta sigue siendo posible: queda "sin asignar".
    }
  }, []);

  useEffect(() => {
    fetchUsers();
    fetchAdmins();
  }, [fetchUsers, fetchAdmins]);

  function limpiarFormulario() {
    setInviteEmail("");
    setCName("");
    setCLastName("");
    setCPhone("");
    setCBroker("");
    setCAccountType("demo");
    setCAccountNumber("");
    setCBrokerServer("");
    setCAssignedAdmin("");
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    if (esCliente && (!cName.trim() || !cLastName.trim() || !cPhone.trim() || !cBroker.trim() || !cAccountNumber.trim() || !cBrokerServer.trim())) {
      return;
    }

    setInviting(true);
    setInviteMsg(null);
    try {
      const payload = esCliente
        ? {
            role: "cliente",
            email: inviteEmail.trim(),
            client_name: cName.trim(),
            client_last_name: cLastName.trim(),
            client_phone: cPhone.trim(),
            broker: cBroker.trim(),
            account_type: cAccountType,
            account_number: cAccountNumber.trim(),
            broker_server: cBrokerServer.trim(),
            assigned_admin: cAssignedAdmin || undefined,
            expiry: cExpiry,
          }
        : { email: inviteEmail.trim(), role: inviteRole };

      const res = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.ok) {
        setInviteMsg(`Error: ${json.error ?? "no se pudo invitar"}`);
        return;
      }

      if (json.kind === "cliente") {
        setInviteMsg(
          json.email_warning
            ? `Cliente creado, pero ${json.email_warning}. Su token está en la sección Invitación.`
            : "Cliente invitado: se le envió su token y se avisó a los super admin.",
        );
      } else {
        setInviteMsg(json.is_existing ? "Rol actualizado y correo enviado." : "Invitación enviada.");
      }

      limpiarFormulario();
      await fetchUsers();
    } catch {
      setInviteMsg("No se pudo contactar al bridge.");
    } finally {
      setInviting(false);
    }
  }

  async function handleChangeRole(u: UserRow) {
    const nextRole: Role = u.role === "super_admin" ? "admin" : "super_admin";
    if (!window.confirm(`¿Cambiar el rol de ${u.email ?? u.user_id} a ${ROLE_LABEL[nextRole]}?`)) return;

    setBusyId(u.user_id);
    try {
      const res = await fetch("/api/users/role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: u.user_id, role: nextRole }),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error ?? "No se pudo cambiar el rol.");
      else await fetchUsers();
    } catch {
      setError("No se pudo cambiar el rol.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevoke(u: UserRow) {
    if (!window.confirm(`¿Revocar el acceso de ${u.email ?? u.user_id}? Podrás volver a invitarlo después.`)) return;

    setBusyId(u.user_id);
    try {
      const res = await fetch("/api/users/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: u.user_id }),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error ?? "No se pudo revocar el acceso.");
      else await fetchUsers();
    } catch {
      setError("No se pudo revocar el acceso.");
    } finally {
      setBusyId(null);
    }
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
        <div className={styles.banner}>No autorizado — esta sección es solo para Super Admin.</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>PESSARO BRIDGE</h1>
          <p className={styles.subtitle}>Usuarios del panel</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/status/clients" className={styles.navLink} style={{ textDecoration: "none" }}>
            Invitación
          </Link>
          <Link href="/status" className={styles.gateButton} style={{ textDecoration: "none" }}>
            Volver al panel
          </Link>
        </div>
      </header>

      {error && <div className={styles.banner}>{error}</div>}

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Invitar usuario</h2>
        <form onSubmit={handleInvite} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="correo@ejemplo.com"
            className={styles.settingsInput}
            style={{ minWidth: 240 }}
            required
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as InviteKind)}
            className={styles.settingsInput}
          >
            <option value="admin">Admin</option>
            <option value="super_admin">Super Admin</option>
            <option value="cliente">Cliente</option>
          </select>

          {esCliente && (
            <>
              <input
                type="text"
                value={cName}
                onChange={(e) => setCName(e.target.value)}
                placeholder="Nombre"
                className={styles.settingsInput}
                style={{ minWidth: 140 }}
                required
              />
              <input
                type="text"
                value={cLastName}
                onChange={(e) => setCLastName(e.target.value)}
                placeholder="Apellido"
                className={styles.settingsInput}
                style={{ minWidth: 140 }}
                required
              />
              <input
                type="tel"
                value={cPhone}
                onChange={(e) => setCPhone(e.target.value)}
                placeholder="+56 9 1234 5678"
                className={styles.settingsInput}
                style={{ minWidth: 150 }}
                required
              />
              <input
                type="text"
                value={cBroker}
                onChange={(e) => setCBroker(e.target.value)}
                placeholder="Bróker (ej. Tradeview)"
                className={styles.settingsInput}
                style={{ minWidth: 160 }}
                required
              />
              <select
                value={cAccountType}
                onChange={(e) => setCAccountType(e.target.value as "demo" | "real")}
                className={styles.settingsInput}
                style={cAccountType === "real" ? { color: "var(--red)", fontWeight: 700 } : undefined}
                required
              >
                <option value="demo">Cuenta Demo</option>
                <option value="real">Cuenta Real</option>
              </select>
              <input
                type="text"
                value={cAccountNumber}
                onChange={(e) => setCAccountNumber(e.target.value)}
                placeholder="N° de cuenta"
                className={styles.settingsInput}
                style={{ minWidth: 130 }}
                required
              />
              <input
                type="text"
                value={cBrokerServer}
                onChange={(e) => setCBrokerServer(e.target.value)}
                placeholder="Servidor (ej. Tradeview-Demo)"
                className={styles.settingsInput}
                style={{ minWidth: 180 }}
                required
              />
              <select
                value={cAssignedAdmin}
                onChange={(e) => setCAssignedAdmin(e.target.value)}
                className={styles.settingsInput}
              >
                <option value="">Admin (sin asignar)</option>
                {admins.map((a) => (
                  <option key={a.user_id} value={a.user_id}>
                    {a.email ?? a.user_id}
                  </option>
                ))}
              </select>
              <select
                value={cExpiry}
                onChange={(e) => setCExpiry(e.target.value as Expiry)}
                className={styles.settingsInput}
              >
                <option value="7d">Caduca en 7 días</option>
                <option value="14d">Caduca en 14 días</option>
                <option value="30d">Caduca en 30 días</option>
                <option value="never">Indefinido</option>
              </select>
            </>
          )}

          <button type="submit" className={styles.navLink} disabled={inviting}>
            {inviting ? "Enviando…" : "Invitación"}
          </button>
        </form>
        {esCliente && (
          <p className={styles.hint}>
            Un cliente NO accede al panel: no se le crea cuenta ni contraseña. Recibe por correo su token de señales
            para configurarlo en el EA de MetaTrader, y todos los Super Admin reciben un aviso del alta. Aparece en la
            sección <Link href="/status/clients">Invitación</Link>, no en la tabla de abajo.
          </p>
        )}
        {inviteMsg && <p className={styles.hint}>{inviteMsg}</p>}
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Usuarios con acceso</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Correo</th>
              <th>Rol</th>
              <th>Creado</th>
              <th>Invitado por</th>
              <th>Último acceso</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.user_id}>
                <td>{u.email ?? "—"}</td>
                <td>
                  <Badge role={u.role} />
                </td>
                <td className={styles.mono}>{new Date(u.created_at).toLocaleString("es-CL")}</td>
                <td>{u.created_by_email ?? "—"}</td>
                <td className={styles.mono}>
                  {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString("es-CL") : "nunca"}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => handleChangeRole(u)}
                      className={styles.gateButton}
                      style={{ padding: "4px 10px", fontSize: 11 }}
                      disabled={busyId === u.user_id}
                    >
                      Cambiar rol
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(u)}
                      className={styles.gateButton}
                      style={{ padding: "4px 10px", fontSize: 11 }}
                      disabled={busyId === u.user_id}
                    >
                      Revocar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {users && users.length === 0 && (
              <tr>
                <td colSpan={6} className={styles.emptyRow}>
                  Sin usuarios
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Badge({ role }: { role: Role }) {
  const toneClass = role === "super_admin" ? styles.badge_gold : styles.badge_neutral;
  return <span className={`${styles.badge} ${toneClass}`}>{ROLE_LABEL[role]}</span>;
}
