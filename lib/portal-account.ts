import { supabase } from "./supabase";

/**
 * Lectura de los datos de trading que el portal muestra al cliente.
 *
 * Todo sale de UNA función y se sirve en UNA respuesta. El portal original
 * hacía tres consultas independientes desde el navegador (cuenta, posiciones,
 * historial) y las repetía en cada una de sus seis páginas, porque cada una
 * montaba los hooks por su cuenta y no había capa de caché. Aquí el navegador
 * hace una sola petición y el servidor paraleliza contra Postgres.
 */

export type PortalAccount = {
  id: string;
  account_number: string;
  account_type: "real" | "demo";
  currency: string;
  leverage: string | null;
  balance: number;
  equity: number;
  margin_used: number;
  free_margin: number;
  margin_level: number;
  floating_pnl: number;
  initial_balance: number;
  status: string | null;
  broker: string | null;
  server: string | null;
  updated_at: string;
};

export type PortalPosition = {
  ticket: number;
  symbol: string;
  position_type: "BUY" | "SELL";
  lots: number;
  open_price: number;
  current_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  profit_loss: number | null;
  swap: number | null;
  open_time: string;
};

export type PortalTrade = {
  ticket: number;
  symbol: string;
  position_type: "BUY" | "SELL";
  lots: number;
  open_price: number;
  close_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  profit_loss: number;
  commission: number | null;
  swap: number | null;
  open_time: string;
  close_time: string;
  duration_mins: number | null;
  /**
   * Balance acumulado tras la operación. La telemetría NO lo rellena: el EA
   * conoce el balance actual de la cuenta, no cuál era tras cada cierre
   * histórico. Queda nulo salvo que se derive server-side más adelante.
   */
  running_balance: number | null;
  comment: string | null;
};

export type PortalEquityPoint = {
  snapshot_at: string;
  balance: number;
  equity: number;
  floating: number | null;
};

export type PortalAccountData = {
  account: PortalAccount | null;
  positions: PortalPosition[];
  trades: PortalTrade[];
  equity: PortalEquityPoint[];
  trades_total: number;
  /**
   * Antigüedad en segundos del último reporte del EA. La UI lo muestra como
   * "actualizado hace Xs" en vez de presentar las cifras como si fueran de
   * este instante: con telemetría a 60 s, el P&L flotante tiene retraso y
   * disimularlo sería mentir sobre un número con el que el cliente decide.
   */
  stale_seconds: number | null;
};

/** Tope por defecto del historial. El portal original hacía select('*') sin límite. */
export const TRADES_PAGE_SIZE = 200;

export async function getPortalAccountData(
  clientId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<PortalAccountData> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? TRADES_PAGE_SIZE));
  const offset = Math.max(0, opts.offset ?? 0);

  const { data: accountRow } = await supabase
    .from("tp_accounts")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();

  // Sin cuenta no hay nada que buscar: el cliente tiene token pero su EA aún
  // no ha reportado. Devolver la forma vacía evita tres consultas inútiles y
  // deja que la UI muestre "esperando al terminal" en vez de un error.
  if (!accountRow) {
    return { account: null, positions: [], trades: [], equity: [], trades_total: 0, stale_seconds: null };
  }

  const account = accountRow as PortalAccount;

  const [positionsRes, tradesRes, equityRes] = await Promise.all([
    supabase.from("tp_open_positions").select("*").eq("account_id", account.id).order("open_time", { ascending: false }),
    supabase
      .from("tp_trades")
      .select("*", { count: "exact" })
      .eq("account_id", account.id)
      .order("close_time", { ascending: false })
      .range(offset, offset + limit - 1),
    supabase
      .from("tp_equity_snapshots")
      .select("snapshot_at, balance, equity, floating")
      .eq("account_id", account.id)
      .order("snapshot_at", { ascending: true }),
  ]);

  return {
    account,
    positions: (positionsRes.data ?? []) as PortalPosition[],
    trades: (tradesRes.data ?? []) as PortalTrade[],
    equity: (equityRes.data ?? []) as PortalEquityPoint[],
    trades_total: tradesRes.count ?? 0,
    stale_seconds: Math.round((Date.now() - new Date(account.updated_at).getTime()) / 1000),
  };
}
