import { z } from "zod";

/**
 * Contrato JSON del indicador "TD Confluence Londres Nueva York" (Pine v6).
 * No modificar los nombres de campo: los emite Pine tal cual.
 * Compatible con v1.0 (producción) y v1.2: grade, impulse_atr y los campos
 * de conteo/umbral se agregaron en v1.2 y son opcionales. grade/impulse_atr
 * caen a un default cuando faltan; los campos de conteo son best-effort (se
 * reinician si se recarga el script) y se guardan como origin_* solo para
 * auditoría — los definitivos se recalculan en Supabase (ver contar_dia /
 * fn_apply_authoritative_counts), por eso no necesitan default.
 */

const baseFields = {
  account_id: z.string().min(1),
  symbol: z.string().min(1),
  tf: z.string().min(1),
  timestamp: z.number().int().positive(), // epoch ms
};

const originCountFields = {
  current_symbol_count: z.number().int().nonnegative().optional(),
  symbol_threshold: z.number().int().positive().optional(),
  current_global_count: z.number().int().nonnegative().optional(),
  global_threshold: z.number().int().positive().optional(),
  threshold_exceeded: z.boolean().optional(),
};

const partialSchema = z.object({
  lots: z.number().positive(),
  tp: z.number().positive(),
});

const entryFields = {
  ...baseFields,
  type: z.string().optional(),
  grade: z.enum(["ELITE", "STANDARD"]).default("STANDARD"),
  impulse_atr: z.number().default(0),
  price: z.number().positive(),
  sl: z.number().positive(),
  partial_1: partialSchema,
  partial_2: partialSchema,
  risk_usd: z.number().positive(),
  ...originCountFields,
};

export const buySignalSchema = z.object({ action: z.literal("BUY_DUAL"), ...entryFields });
export const sellSignalSchema = z.object({ action: z.literal("SELL_DUAL"), ...entryFields });
export const cancelSignalSchema = z.object({ action: z.literal("CANCEL_ALL"), ...baseFields });

export const webhookPayloadSchema = z.discriminatedUnion("action", [
  buySignalSchema,
  sellSignalSchema,
  cancelSignalSchema,
]);

export type EntrySignalPayload = z.infer<typeof buySignalSchema> | z.infer<typeof sellSignalSchema>;
export type CancelSignalPayload = z.infer<typeof cancelSignalSchema>;
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export function isEntrySignal(payload: WebhookPayload): payload is EntrySignalPayload {
  return payload.action === "BUY_DUAL" || payload.action === "SELL_DUAL";
}

/** Body que envía el EA en POST /api/ack */
export const ackSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["notified", "error"]),
  error: z.string().optional(),
});
export type AckPayload = z.infer<typeof ackSchema>;

/** Body que acepta PUT /api/settings (todos los campos opcionales, parcial) */
export const settingsUpdateSchema = z
  .object({
    symbol_threshold: z.number().int().positive(),
    global_threshold: z.number().int().positive(),
    freshness_seconds: z.number().int().positive(),
    queue_ttl_seconds: z.number().int().positive(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Debe incluir al menos un campo" });
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
