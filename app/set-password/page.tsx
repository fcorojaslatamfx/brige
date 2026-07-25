"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import styles from "../status/status.module.css";

export default function SetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // El link de invitación/recuperación entrega access_token+refresh_token
    // en el hash de la URL. Hay que canjearlos explícitamente con
    // setSession() en vez de confiar en getSession()/onAuthStateChange: si
    // el navegador ya tenía una sesión activa (por ejemplo, un admin que
    // sigue logueado y abre el link de OTRO usuario en la misma pestaña),
    // getSession() devuelve esa sesión vieja en vez de la del link, y
    // updateUser() termina cambiando la contraseña de la cuenta equivocada
    // sin ningún error visible.
    const supabase = createSupabaseBrowserClient();
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");

    if (!accessToken || !refreshToken) {
      setError("Link inválido o expirado. Pedí que te reenvíen la invitación.");
      return;
    }

    supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(({ error: sessionError }) => {
      if (sessionError) {
        setError("Link inválido o expirado. Pedí que te reenvíen la invitación.");
        return;
      }
      setReady(true);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setLoading(true);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError("No se pudo actualizar la contraseña: " + updateError.message);
      setLoading(false);
      return;
    }

    router.push("/status");
    router.refresh();
  }

  return (
    <div className={styles.page}>
      <div className={styles.gate}>
        <h1 className={styles.gateTitle}>PESSARO BRIDGE</h1>
        <p className={styles.gateSubtitle}>Define tu contraseña de acceso</p>
        {!ready ? (
          !error && <p className={styles.hint}>Verificando el enlace de invitación…</p>
        ) : (
          <form onSubmit={handleSubmit} className={styles.gateForm} style={{ flexDirection: "column" }}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Nueva contraseña"
              className={styles.gateInput}
              autoComplete="new-password"
              autoFocus
              required
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirmar contraseña"
              className={styles.gateInput}
              autoComplete="new-password"
              required
            />
            <button type="submit" className={styles.saveButton} disabled={loading}>
              {loading ? "Guardando…" : "Guardar y entrar"}
            </button>
          </form>
        )}
        {error && <p className={styles.errorText}>{error}</p>}
      </div>
    </div>
  );
}
