"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "../status.module.css";

type Role = "super_admin" | "admin";

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
  const [inviteRole, setInviteRole] = useState<Role>("admin");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

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

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteMsg(null);
    try {
      const res = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const json = await res.json();
      if (!json.ok) {
        setInviteMsg(`Error: ${json.error ?? "no se pudo invitar"}`);
        return;
      }
      setInviteMsg(json.is_existing ? "Rol actualizado y correo enviado." : "Invitación enviada.");
      setInviteEmail("");
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
            Clientes
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
            onChange={(e) => setInviteRole(e.target.value as Role)}
            className={styles.settingsInput}
          >
            <option value="admin">Admin</option>
            <option value="super_admin">Super Admin</option>
          </select>
          <button type="submit" className={styles.navLink} disabled={inviting}>
            {inviting ? "Enviando…" : "Invitar"}
          </button>
        </form>
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
