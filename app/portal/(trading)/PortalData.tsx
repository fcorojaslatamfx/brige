"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { PortalAccountData } from "@/lib/portal-account";

/**
 * Estado compartido del Trading Portal.
 *
 * Una sola petición a /api/portal/account alimenta las siete páginas. El
 * portal original montaba `useAccount` y `useTrades` de forma independiente en
 * cada página, así que navegar entre ellas relanzaba tres consultas cada vez y
 * no había ninguna capa de caché. Aquí el contexto vive en el layout, por
 * encima del router, de modo que cambiar de pestaña no vuelve a pedir nada.
 *
 * Tampoco hay Realtime. Con telemetría a 60 s no aportaba frescura real, y
 * mantenerlo obligaba a poner la anon key de Supabase en el navegador y a
 * abrir un canal por pestaña. El refresco va alineado con la cadencia del EA:
 * pedir más a menudo solo produciría respuestas idénticas.
 */

export const STORAGE_KEY = "pessaro_client_token";

/** Alineado con InpTelemetryAccountSeconds del EA. Pedir más rápido no da datos nuevos. */
const REFRESH_MS = 60_000;

export type PortalClient = {
  name: string;
  broker: string;
  account_number: string;
  account_type: "demo" | "real";
  broker_server: string;
  expires_at: string | null;
};

type PortalState = PortalAccountData & {
  client: PortalClient | null;
  loading: boolean;
  error: string | null;
  token: string;
  refetch: () => void;
  signOut: () => void;
};

const EMPTY: PortalAccountData = {
  account: null, positions: [], trades: [], equity: [], trades_total: 0, stale_seconds: null,
};

const Ctx = createContext<PortalState | null>(null);

export function usePortal(): PortalState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePortal debe usarse dentro de <PortalDataProvider>");
  return ctx;
}

export function PortalDataProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState("");
  const [data, setData] = useState<PortalAccountData>(EMPTY);
  const [client, setClient] = useState<PortalClient | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mismo token y misma clave que /portal (la vista de señales): el cliente
  // entra una vez y las dos secciones lo comparten.
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (saved) setToken(saved);
    else setLoading(false);
  }, []);

  const fetchData = useCallback(async (t: string) => {
    try {
      const res = await fetch(`/api/portal/account?token=${encodeURIComponent(t)}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "No se pudo cargar tu cuenta.");
        return;
      }
      const { ok: _ok, server_time: _st, client: c, ...rest } = json;
      setClient(c);
      setData(rest as PortalAccountData);
      setError(null);
    } catch {
      setError("No se pudo contactar al bridge.");
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetchData(token).finally(() => setLoading(false));
    const id = setInterval(() => fetchData(token), REFRESH_MS);
    return () => clearInterval(id);
  }, [token, fetchData]);

  const value: PortalState = {
    ...data,
    client,
    loading,
    error,
    token,
    refetch: () => { if (token) void fetchData(token); },
    signOut: () => {
      window.localStorage.removeItem(STORAGE_KEY);
      setToken("");
      setData(EMPTY);
      setClient(null);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
