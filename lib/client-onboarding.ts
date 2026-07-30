import { supabase } from "./supabase";
import { createClientToken, toClientEmailData, type ClientTokenRow } from "./clients";
import { sendClientTokenEmail, sendClientCreatedNoticeEmail } from "./email";
import { listSuperAdminEmails } from "./users";
import type { CreateClientInput } from "./schema";

/**
 * Alta de cliente: crea el token, avisa al cliente y avisa a los super_admin.
 *
 * Vive aquí y no en una ruta porque hay DOS puertas de entrada al mismo gesto:
 * POST /api/clients (sección Clientes) y POST /api/users/invite con
 * role="cliente" (formulario de Invitar usuario). Duplicar el flujo garantizaba
 * que tarde o temprano una de las dos dejara de mandar alguno de los correos.
 */

export type OnboardingResult = {
  client: ClientTokenRow;
  /** id de Resend del correo al cliente, o null si el envío falló. */
  clientEmailId: string | null;
  /** id de Resend del aviso a los super_admin, null si falló o no hay a quién avisar. */
  noticeEmailId: string | null;
  /** Mensaje legible cuando algún correo no salió (el alta sí quedó hecha). */
  emailWarning: string | null;
};

export async function onboardClient(
  input: CreateClientInput,
  createdBy: { id: string; email: string | null },
): Promise<OnboardingResult> {
  const client = await createClientToken({ ...input, created_by: createdBy.id });
  const data = toClientEmailData(client);

  // Los correos NO abortan el alta. El token ya existe y es visible en el panel:
  // si Resend está caído, el operador puede reenviarlo con el botón Compartir.
  // Fallar aquí borraría de la respuesta un cliente que sí quedó creado.
  const fallos: string[] = [];

  let clientEmailId: string | null = null;
  try {
    clientEmailId = await sendClientTokenEmail({ client: data, token: client.token });
  } catch (e) {
    fallos.push(`no se pudo enviar el correo al cliente (${e instanceof Error ? e.message : "error"})`);
  }

  let noticeEmailId: string | null = null;
  try {
    const destinatarios = await listSuperAdminEmails();
    const assignedAdminEmail = client.assigned_admin ? await emailOfUser(client.assigned_admin) : null;
    noticeEmailId = await sendClientCreatedNoticeEmail({
      to: destinatarios,
      client: data,
      createdBy: createdBy.email ?? createdBy.id,
      assignedAdminEmail,
    });
  } catch (e) {
    fallos.push(`no se pudo avisar a los super admin (${e instanceof Error ? e.message : "error"})`);
  }

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "client_token_created",
    detail: {
      client_id: client.id,
      client_name: `${client.client_name} ${client.client_last_name}`,
      client_email: client.client_email,
      broker: client.broker,
      account_type: client.account_type,
      expiry: input.expiry,
      expires_at: client.expires_at,
      created_by: createdBy.email ?? createdBy.id,
      correo_al_cliente: clientEmailId !== null,
      aviso_a_super_admin: noticeEmailId !== null,
    },
  });

  return {
    client,
    clientEmailId,
    noticeEmailId,
    emailWarning: fallos.length > 0 ? fallos.join(" · ") : null,
  };
}

/** Correo de un usuario del panel por su id (para nombrar al admin asignado en el aviso). */
async function emailOfUser(userId: string): Promise<string | null> {
  const { data } = await supabase.auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}
