"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "../status.module.css";

type TokenKind = "tv_webhook" | "ea" | "operator";

type TokenRow = {
  kind: TokenKind;
  value: string;
  updated_at: string;
  updated_by: string | null;
};

const LABELS: Record<TokenKind, string> = {
  tv_webhook: "TradingView (webhook)",
  ea: "EA MetaTrader",
  operator: "Operador (API)",
};

const REGEN_WARNING: Record<TokenKind, string> = {
  tv_webhook:
    "Al regenerar hay que volver a pegar el nuevo token en la URL del webhook de la alerta de TradingView. ¿Continuar?",
  ea: "Al regenerar hay que volver a pegar el nuevo token en el campo InpEaToken del EA en MT4. ¿Continuar?",
  operator: "El login ya reemplaza este token para el panel; solo lo usan scripts externos. ¿Continuar?",
};

export default function TokensPage() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<TokenKind>>(new Set());
  const [regenerating, setRegenerating] = useState<TokenKind | null>(null);

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch("/api/tokens", { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "No se pudieron cargar los tokens.");
        return;
      }
      setTokens(json.tokens);
      setError(null);
    } catch {
      setError("No se pudo contactar al bridge.");
    }
  }, []);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  function toggleReveal(kind: TokenKind) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  async function copyValue(value: string) {
    await navigator.clipboard.writeText(value);
  }

  async function handleRegenerate(kind: TokenKind) {
    if (!window.confirm(REGEN_WARNING[kind])) return;

    setRegenerating(kind);
    try {
      const res = await fetch("/api/tokens/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "No se pudo regenerar el token.");
        return;
      }
      await fetchTokens();
      setRevealed((prev) => new Set(prev).add(kind));
    } catch {
      setError("No se pudo regenerar el token.");
    } finally {
      setRegenerating(null);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>PESSARO BRIDGE</h1>
          <p className={styles.subtitle}>Tokens de integración</p>
        </div>
        <Link href="/status" className={styles.gateButton} style={{ textDecoration: "none" }}>
          Volver al panel
        </Link>
      </header>

      {error && <div className={styles.banner}>{error}</div>}

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Tokens vigentes</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Integración</th>
              <th>Valor</th>
              <th>Última actualización</th>
              <th>Por</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(tokens ?? []).map((t) => (
              <tr key={t.kind}>
                <td>{LABELS[t.kind]}</td>
                <td className={styles.mono}>
                  {revealed.has(t.kind) ? t.value : "•".repeat(16)}{" "}
                  <button
                    type="button"
                    onClick={() => toggleReveal(t.kind)}
                    className={styles.gateButton}
                    style={{ padding: "2px 8px", fontSize: 11, marginLeft: 6 }}
                  >
                    {revealed.has(t.kind) ? "Ocultar" : "Ver"}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyValue(t.value)}
                    className={styles.gateButton}
                    style={{ padding: "2px 8px", fontSize: 11, marginLeft: 6 }}
                  >
                    Copiar
                  </button>
                </td>
                <td className={styles.mono}>{new Date(t.updated_at).toLocaleString("es-CL")}</td>
                <td>{t.updated_by ?? "—"}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => handleRegenerate(t.kind)}
                    className={styles.saveButton}
                    disabled={regenerating === t.kind}
                  >
                    {regenerating === t.kind ? "Regenerando…" : "Regenerar"}
                  </button>
                </td>
              </tr>
            ))}
            {tokens && tokens.length === 0 && (
              <tr>
                <td colSpan={5} className={styles.emptyRow}>
                  Sin tokens configurados
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className={styles.hint}>
          Regenerar el token de TradingView o del EA rompe la conexión hasta que se pegue el nuevo valor en la alerta
          / en el EA de MT4.
        </p>
      </section>
    </div>
  );
}
