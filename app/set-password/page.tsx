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
    const supabase = createSupabaseBrowserClient();

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });

    return () => subscription.unsubscribe();
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
          <p className={styles.hint}>Verificando el enlace de invitación…</p>
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
            <button type="submit" className={styles.gateButton} disabled={loading}>
              {loading ? "Guardando…" : "Guardar y entrar"}
            </button>
          </form>
        )}
        {error && <p className={styles.errorText}>{error}</p>}
      </div>
    </div>
  );
}
