"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import styles from "../status/status.module.css";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError("Correo o contraseña incorrectos.");
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
        <p className={styles.gateSubtitle}>Panel de administrador — ingresa con tu cuenta</p>
        <form onSubmit={handleSubmit} className={styles.gateForm} style={{ flexDirection: "column" }}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="correo@ejemplo.com"
            className={styles.gateInput}
            autoComplete="email"
            autoFocus
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Contraseña"
            className={styles.gateInput}
            autoComplete="current-password"
            required
          />
          <button type="submit" className={styles.gateButton} disabled={loading}>
            {loading ? "Ingresando…" : "Entrar"}
          </button>
        </form>
        {error && <p className={styles.errorText}>{error}</p>}
      </div>
    </div>
  );
}
