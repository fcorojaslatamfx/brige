"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import { PESSARO_LOGO_DATA_URI } from "@/lib/pessaro-logo";
import styles from "./login.module.css";

type Mode = "login" | "forgot";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function toggleMode() {
    setMode((m) => (m === "login" ? "forgot" : "login"));
    setError(null);
    setMessage(null);
  }

  async function handleLogin(e: React.FormEvent) {
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

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // el mensaje de abajo es genérico a propósito, no depende del resultado real
    }

    setMessage("Si el correo tiene acceso al panel, te enviamos un enlace para restablecer tu contraseña.");
    setLoading(false);
  }

  return (
    <div className={styles.page}>
      <div className={styles.backdrop} />
      <div className={styles.backdropOverlay} />
      <div className={styles.card}>
        <div className={styles.logoWrap}>
          <img src={PESSARO_LOGO_DATA_URI} alt="Pessaro Capital" className={styles.logo} />
        </div>
        <h1 className={styles.title}>PESSARO BRIDGE</h1>
        <p className={styles.subtitle}>
          {mode === "login" ? "Panel de administrador — ingresa con tu cuenta" : "Recuperar acceso al panel"}
        </p>

        {mode === "login" ? (
          <form onSubmit={handleLogin} className={styles.form}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="correo@ejemplo.com"
              className={styles.input}
              autoComplete="email"
              autoFocus
              required
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Contraseña"
              className={styles.input}
              autoComplete="current-password"
              required
            />
            <button type="submit" className={styles.button} disabled={loading}>
              {loading ? "Ingresando…" : "Entrar"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleForgot} className={styles.form}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="correo@ejemplo.com"
              className={styles.input}
              autoComplete="email"
              autoFocus
              required
            />
            <button type="submit" className={styles.button} disabled={loading}>
              {loading ? "Enviando…" : "Enviar enlace de recuperación"}
            </button>
          </form>
        )}

        <button type="button" onClick={toggleMode} className={styles.linkButton}>
          {mode === "login" ? "¿Olvidaste tu contraseña?" : "Volver a iniciar sesión"}
        </button>

        {error && <p className={styles.errorText}>{error}</p>}
        {message && <p className={styles.successText}>{message}</p>}
      </div>
    </div>
  );
}
