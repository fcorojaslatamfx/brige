/**
 * Envía correos de PRUEBA reales a una casilla, para revisar formato y footer
 * en un cliente de correo de verdad (Gmail, Outlook…) y no solo en el navegador.
 *
 *   npx tsx scripts/send-test-emails.ts correo@destino.cl [claves...]
 *
 * Claves disponibles: invitacion · acceso-actualizado · reset · token-cliente ·
 * aviso-super-admin. Sin claves manda las tres que cubren todos los elementos
 * visuales (CTA púrpura, caja dorada del token y tabla de datos).
 *
 * ESTO SÍ ENVÍA: consume cuota de Resend y necesita RESEND_API_KEY en
 * .env.local. Para solo mirar el HTML sin mandar nada, usa preview-emails.ts.
 *
 * Los datos son deliberadamente falsos y reconocibles (Juan Pérez, token de
 * relleno) para que un correo de prueba no se confunda nunca con uno real.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const POR_DEFECTO = ["invitacion", "token-cliente", "aviso-super-admin"];

// Resend limita a ~2 req/s: sin pausa el tercer envío rebota con 429.
const PAUSA_MS = 700;
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const destino = process.argv[2];
  if (!destino) {
    console.error("Falta el correo de destino.\n  npx tsx scripts/send-test-emails.ts correo@destino.cl");
    process.exit(1);
  }
  const claves = process.argv.slice(3).length > 0 ? process.argv.slice(3) : POR_DEFECTO;

  // Import dinámico: los `import` estáticos se izan por encima de config() y
  // lib/email se evaluaría sin RESEND_API_KEY cargada.
  const email = await import("../lib/email");

  const cliente: import("../lib/email").ClientEmailData = {
    firstName: "Juan",
    lastName: "Pérez",
    email: destino,
    phone: "+56 9 1234 5678",
    broker: "Tradeview",
    accountType: "real",
    accountNumber: "8814027",
    brokerServer: "Tradeview-Live",
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };
  const link = "https://brige.pessaro.cl/set-password#correo-de-prueba";

  const envios: Record<string, () => Promise<string | null>> = {
    invitacion: () => email.sendInviteEmail({ to: destino, actionLink: link, isExisting: false }),
    "acceso-actualizado": () => email.sendInviteEmail({ to: destino, actionLink: link, isExisting: true }),
    reset: () => email.sendPasswordResetEmail({ to: destino, actionLink: link }),
    "token-cliente": () =>
      email.sendClientTokenEmail({ client: { ...cliente, email: destino }, token: "TOKEN_DE_PRUEBA_" + "0".repeat(48) }),
    "aviso-super-admin": () =>
      email.sendClientCreatedNoticeEmail({
        to: [destino],
        client: cliente,
        createdBy: "correo de prueba (scripts/send-test-emails.ts)",
        assignedAdminEmail: "admin@pessaro.cl",
      }),
  };

  for (const clave of claves) {
    const fn = envios[clave];
    if (!fn) {
      console.error(`  ✗ ${clave}: clave desconocida`);
      continue;
    }
    try {
      const id = await fn();
      console.log(`  ✓ ${clave.padEnd(20)} → ${destino}   resend_id=${id}`);
    } catch (e) {
      console.error(`  ✗ ${clave.padEnd(20)} ${e instanceof Error ? e.message : e}`);
    }
    await espera(PAUSA_MS);
  }
}

main();
