/**
 * Escribe cada correo del bridge a un .html local para revisarlo en el navegador.
 *
 *   npx tsx scripts/preview-emails.ts [carpeta-destino]
 *
 * No manda nada ni necesita RESEND_API_KEY: importa solo los `build*` puros de
 * lib/email.ts. Existe porque el footer legal es copy jurídico y la paleta debe
 * calzar con pessaro.cl: eso se verifica mirándolo, no leyendo el HTML.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildInviteEmail,
  buildPasswordResetEmail,
  buildClientTokenEmail,
  buildClientCreatedNoticeEmail,
  type ClientEmailData,
} from "../lib/email";

const cliente: ClientEmailData = {
  firstName: "Juan",
  lastName: "Pérez",
  email: "juan.perez@ejemplo.cl",
  phone: "+56 9 1234 5678",
  broker: "Tradeview",
  accountType: "real",
  accountNumber: "8814027",
  brokerServer: "Tradeview-Live",
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
};

const salidas = {
  "1-invitacion-usuario": buildInviteEmail({ actionLink: "https://brige.pessaro.cl/set-password#demo", isExisting: false }),
  "2-acceso-actualizado": buildInviteEmail({ actionLink: "https://brige.pessaro.cl/set-password#demo", isExisting: true }),
  "3-reset-contrasena": buildPasswordResetEmail({ actionLink: "https://brige.pessaro.cl/set-password#demo" }),
  "4-token-cliente": buildClientTokenEmail({ client: cliente, token: "a".repeat(64) }),
  "5-aviso-super-admin": buildClientCreatedNoticeEmail({
    client: cliente,
    createdBy: "operador@pessaro.cl",
    assignedAdminEmail: "admin@pessaro.cl",
  }),
};

const destino = resolve(process.argv[2] ?? "./.email-preview");
mkdirSync(destino, { recursive: true });

for (const [nombre, { subject, html }] of Object.entries(salidas)) {
  const ruta = join(destino, `${nombre}.html`);
  writeFileSync(ruta, html, "utf8");
  console.log(`${nombre.padEnd(24)} ${subject}\n${" ".repeat(25)}${ruta}`);
}
