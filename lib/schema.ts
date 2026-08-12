import { z } from "zod";

/**
 * Contrato JSON del indicador "TD Confluence Londres Nueva York" (Pine v6).
 * No modificar los nombres de campo: los emite Pine tal cual.
 *
 * CONTRATO v2.0 (meta-prompt v3.0 §3.1). Cambios respecto de v1.x:
 *
 *  - `timestamp` pasa a ser `timenow` (instante real de emisión) en vez de
 *    `time` (apertura de la vela). Es lo único que se compara contra
 *    freshness_seconds. Con el valor viejo, un disparo intrabarra podía
 *    llegar con 897 s de "retraso" aparente y morir como stale.
 *  - `bar_time` (nuevo, apertura de la vela) es la clave estable de
 *    deduplicación. Opcional durante la transición: si no viene, el handler
 *    cae a `timestamp`, que es exactamente lo que emitía el Pine v1.x.
 *  - Se añaden SETUP_BUY / SETUP_SELL / SETUP_CANCEL: el setup armado es el
 *    momento en que existe una orden límite pendiente colocable, y hasta
 *    ahora no salía del gráfico.
 *  - `schema` permite convivencia de versiones durante el despliegue.
 *
 * Sigue aceptando payloads v1.x sin cambios: grade/impulse_atr caen a un
 * default y los campos de conteo son best-effort (se reinician si se recarga
 * el script). Estos últimos se guardan como origin_* SOLO para auditoría de
 * discrepancias; los definitivos los calcula Supabase (calc_thresholds /
 * fn_apply_authoritative_counts), que es la única capa con visión de cartera.
 */

/** Acciones que transportan niveles completos y consumen cupo del día. */
export const ENTRY_ACTIONS = ["BUY_DUAL", "SELL_DUAL", "SETUP_BUY", "SETUP_SELL"] as const;
/** Acciones de retiro: forma reducida, sin niveles. */
export const CANCEL_ACTIONS = ["CANCEL_ALL", "SETUP_CANCEL"] as const;

export type EntryAction = (typeof ENTRY_ACTIONS)[number];
export type CancelAction = (typeof CANCEL_ACTIONS)[number];
export type SignalAction = EntryAction | CancelAction;

const baseFields = {
  account_id: z.string().min(1),
  symbol: z.string().min(1).max(20),
  tf: z.string().min(1).optional(),
  bar_time: z.number().int().positive().optional(), // apertura de vela → dedup
  timestamp: z.number().int().positive(), // timenow → frescura
  schema: z.string().optional(),
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
  type: z.enum(["LIMIT", "STOP", "MARKET"]).default("LIMIT"),
  grade: z.enum(["ELITE", "STANDARD"]).default("STANDARD"),
  impulse_atr: z.number().nonnegative().default(0),
  price: z.number().positive(),
  sl: z.number().positive(),
  partial_1: partialSchema,
  partial_2: partialSchema,
  risk_usd: z.number().positive(),
  ...originCountFields,
};

export const buySignalSchema = z.object({ action: z.literal("BUY_DUAL"), ...entryFields });
export const sellSignalSchema = z.object({ action: z.literal("SELL_DUAL"), ...entryFields });
export const setupBuySignalSchema = z.object({ action: z.literal("SETUP_BUY"), ...entryFields });
export const setupSellSignalSchema = z.object({ action: z.literal("SETUP_SELL"), ...entryFields });
export const cancelSignalSchema = z.object({ action: z.literal("CANCEL_ALL"), ...baseFields });
export const setupCancelSignalSchema = z.object({ action: z.literal("SETUP_CANCEL"), ...baseFields });

export const webhookPayloadSchema = z.discriminatedUnion("action", [
  buySignalSchema,
  sellSignalSchema,
  setupBuySignalSchema,
  setupSellSignalSchema,
  cancelSignalSchema,
  setupCancelSignalSchema,
]);

export type EntrySignalPayload =
  | z.infer<typeof buySignalSchema>
  | z.infer<typeof sellSignalSchema>
  | z.infer<typeof setupBuySignalSchema>
  | z.infer<typeof setupSellSignalSchema>;
export type CancelSignalPayload = z.infer<typeof cancelSignalSchema> | z.infer<typeof setupCancelSignalSchema>;
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export function isEntrySignal(payload: WebhookPayload): payload is EntrySignalPayload {
  return (ENTRY_ACTIONS as readonly string[]).includes(payload.action);
}

/** true para SETUP_BUY / SETUP_SELL: hay una pendiente colocable, el precio aún no la tocó. */
export function isSetupSignal(action: SignalAction): boolean {
  return action === "SETUP_BUY" || action === "SETUP_SELL";
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
    // Retención de armados (migración 016). Admite 0 = desactivada, así que
    // es nonnegative y no positive. El tope contra queue_ttl_seconds lo impone
    // el CHECK de la tabla: aquí no se conoce el TTL vigente.
    setup_hold_seconds: z.number().int().nonnegative(),
    suppress_orphan_cancels: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Debe incluir al menos un campo" });
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

/** Kinds gestionados desde /status/tokens (ver lib/tokens.ts). */
export const tokenKindSchema = z.enum(["tv_webhook", "ea", "operator"]);
export const tokenRegenerateSchema = z.object({ kind: tokenKindSchema });
export type TokenKindInput = z.infer<typeof tokenKindSchema>;

/**
 * Caducidad de un token de cliente (ver lib/clients.ts).
 *
 * Sin opción "indefinido": todo acceso de cliente vence, y solo en 7, 14 o 30
 * días. Un token sin fecha de término solo se corta si alguien se acuerda de
 * revocarlo, y lo que no tiene fecha no se revisa nunca. El mismo enum
 * gobierna el alta y la renovación, así que no hay forma de renovar por un
 * plazo que no se pueda otorgar en el alta.
 */
export const clientExpirySchema = z.enum(["7d", "14d", "30d"]);

/**
 * Perfil del cliente SIN el correo, compartido por los dos caminos de alta:
 * POST /api/clients (sección Clientes) y POST /api/users/invite con
 * role="cliente". El correo va aparte porque en el formulario de invitación es
 * el campo `email` de más arriba, no un `client_email`.
 *
 * Todos obligatorios y sin `.optional()`: ese es el mecanismo real de
 * "requerido" — el `required` de HTML lo saltaría un fetch directo a la API.
 * Nombre y apellido pasaron a serlo en la migración 017: los correos que salen
 * saludan al cliente por su nombre, y un "Hola," vacío es un defecto visible.
 *
 * Va declarado ANTES de los esquemas de invitación porque `inviteClientSchema`
 * lo expande: un `const` no se iza, y tenerlo abajo reventaba en la carga del
 * módulo por zona muerta temporal.
 */
const clientProfileFields = {
  client_name: z.string().trim().min(1, "El nombre es obligatorio").max(80),
  client_last_name: z.string().trim().min(1, "El apellido es obligatorio").max(80),
  client_phone: z.string().trim().min(3, "El móvil es obligatorio").max(30),
  broker: z.string().trim().min(1, "El bróker es obligatorio").max(80),
  account_type: z.enum(["demo", "real"], { errorMap: () => ({ message: "Tipo de cuenta inválido" }) }),
  account_number: z.string().trim().min(1, "El número de cuenta es obligatorio").max(40),
  broker_server: z.string().trim().min(1, "El servidor del bróker es obligatorio").max(80),
  assigned_admin: z.string().uuid().optional(),
  expiry: clientExpirySchema,
};

/** Roles gestionados desde /status/users (ver lib/users.ts). */
export const roleSchema = z.enum(["super_admin", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const inviteUserSchema = z.object({
  email: z.string().email(),
  role: roleSchema,
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

/**
 * Alta desde /status/users con rol "cliente".
 *
 * `cliente` NO entra en `roleSchema` a propósito: un cliente no es usuario del
 * panel, no tiene fila en `user_roles` y no puede iniciar sesión. Comparte el
 * formulario de invitación porque para el operador es el mismo gesto ("dar de
 * alta a alguien"), pero por debajo es el flujo de `client_tokens`. Meterlo en
 * `roleSchema` lo haría asignable desde /api/users/role y chocaría con el CHECK
 * de la tabla.
 */
export const inviteClientSchema = z.object({
  role: z.literal("cliente"),
  email: z.string().email(),
  ...clientProfileFields,
});
export type InviteClientInput = z.infer<typeof inviteClientSchema>;

/** Body de POST /api/users/invite: usuario del panel o cliente, discriminado por `role`. */
export const inviteSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("admin"), email: z.string().email() }),
  z.object({ role: z.literal("super_admin"), email: z.string().email() }),
  inviteClientSchema,
]);
export type InviteInput = z.infer<typeof inviteSchema>;

export const changeRoleSchema = z.object({
  user_id: z.string().uuid(),
  role: roleSchema,
});

export const revokeUserSchema = z.object({
  user_id: z.string().uuid(),
});

/** Body que acepta POST /api/auth/forgot-password (sin sesión, ver README). */
export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

/** Body de POST /api/clients: crear token de cliente (solo super_admin). */
export const createClientSchema = z.object({
  ...clientProfileFields,
  client_email: z.string().email(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

/** Body de POST /api/clients/revoke. */
export const revokeClientSchema = z.object({ id: z.string().uuid() });

/**
 * Body de POST /api/clients/renew: extender la vigencia de un token existente.
 *
 * Lleva `client_email` además del `id` y NO es redundante: es la confirmación
 * de identidad del token. El panel se refresca cada 5 s, así que la fila que el
 * operador tenía en pantalla al pulsar "Renovar" puede no ser la que está bajo
 * ese `id` cuando llega el request. Renovar por 30 días el acceso del cliente
 * equivocado es silencioso — nadie ve un error — y por eso el servidor exige
 * que el correo coincida con el de la fila antes de tocar nada.
 *
 * La renovación NO acepta nombre, móvil ni datos de cuenta: el token queda
 * ligado a la identidad con la que se creó. Cambiar a quién pertenece un token
 * vivo es un alta nueva, no una renovación.
 */
export const renewClientSchema = z.object({
  id: z.string().uuid(),
  client_email: z.string().email(),
  expiry: clientExpirySchema,
});
export type RenewClientInput = z.infer<typeof renewClientSchema>;

/** Body de POST /api/clients/share: reenviar el token de cliente por correo. */
export const shareClientSchema = z.object({ id: z.string().uuid() });
