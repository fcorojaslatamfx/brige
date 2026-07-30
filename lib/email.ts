const RESEND_FROM = "Pessaro Bridge <send@pessaro.cl>";

/**
 * Paleta de marca, calcada de pessaro.cl (`pessarocl/src/index.css`) y de
 * `app/theme.css`, que es su espejo en el panel.
 *
 * Se duplica aquí como constantes en vez de leer el CSS porque un correo no
 * tiene hoja de estilos: cada color viaja inline en el HTML. Si la paleta de
 * pessaro.cl cambia, este bloque es el único punto a tocar.
 *
 * Jerarquía semántica, la misma del sitio y del panel:
 *   PÚRPURA = acento primario (CTAs, foco).
 *   DORADO  = acento premium secundario (calidad, el token del cliente).
 * El dorado NO es el color por defecto de todo: eso diluía la señal premium.
 */
const C = {
  navy950: "#070c16", // fondo de página
  navy900: "#0a1628", // superficie de la tarjeta
  navy800: "#101d34", // cajas legales (equivale al bg-background/40 del sitio)
  navy700: "#182746", // franja del footer (bg-secondary del sitio)
  purple: "#6c5ce7",
  purpleDeep: "#5e17eb",
  gold: "#d4a656",
  goldLight: "#e8c374",
  text: "#f1f2f6",
  muted: "#9aa3b8",
  border: "rgba(255,255,255,0.08)",
} as const;

/**
 * Footer legal, calcado del footer de pessaro.cl (`src/components/Layout.tsx`
 * + la clase `.legal-box` de `src/index.css`).
 *
 * Dos cosas que NO son libres:
 *
 *  1. El TEXTO es verbatim del sitio. Es copy jurídico revisado por
 *     compliance: no se reescribe, no se resume, no se "mejora".
 *  2. Las tres cajas comparten UNA paleta (navy + borde sutil + título
 *     neutro). En su momento tenían tres — ámbar, roja y neutra — y el
 *     FIX v6.1 del sitio las unificó justamente para que ninguna advertencia
 *     pareciera más grave que otra por su color.
 *
 * Ojo con el copy: el sitio dejó de exponer "SpA" y el RUT en el párrafo de
 * Advertencia Legal Obligatoria (decisión del 24-jul-2026, ver
 * `pessarocl/FIX_v6.1_footer_dedup_paleta.md`). La identificación completa
 * sigue en LEGAL_SOURCE.md, que es documento de registro, no copy público.
 */
function legalBox(title: string, paragraphsHtml: string): string {
  return `<div style="padding:16px;border-radius:8px;border:1px solid ${C.border};background:${C.navy800};margin:0 0 16px">
  <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:${C.text};text-transform:uppercase;letter-spacing:0.08em">${title}</p>
  ${paragraphsHtml}
</div>`;
}

function legalFooterHtml(): string {
  const p = `margin:0;font-size:10px;line-height:1.7;color:${C.text};opacity:0.8;text-align:justify`;

  const riesgo = legalBox(
    "⚠ Advertencia de Riesgo",
    `<p style="${p}">El trading de instrumentos financieros conlleva un alto nivel de riesgo para su capital y puede resultar en pérdidas superiores a su depósito inicial. Los productos apalancados pueden no ser adecuados para todos los inversores. Por favor, asegúrese de comprender plenamente los riesgos involucrados y busque asesoramiento independiente si es necesario. <strong style="display:block;margin-top:4px">Pessaro Capital no ofrece asesoramiento de inversión directo.</strong></p>
     <p style="${p};opacity:0.7;margin-top:8px">Los servicios prestados por Pessaro Capital se limitan exclusivamente a la introducción de brókers. Las plataformas y servicios de cuentas PAMM, MAM o copy trading son proporcionados directamente por dichos brókers, bajo la jurisdicción de su país de origen y las regulaciones que estos mantienen vigentes.</p>`,
  );

  const exencion = legalBox(
    "⚖ Exención de Responsabilidad",
    `<p style="${p}">Pessaro Capital queda exenta de toda responsabilidad por cualquier pérdida, daño o perjuicio derivado de fallas técnicas, interrupciones en el sistema, errores de ejecución, retrasos en la plataforma o por el desempeño operativo y financiero de los brókers introducidos. <strong style="display:block;margin-top:4px">El uso de dichas plataformas y herramientas tecnológicas corre bajo el propio riesgo y responsabilidad del usuario.</strong></p>`,
  );

  const legalObligatoria = legalBox(
    "Advertencia Legal Obligatoria",
    `<p style="${p}">El trading de activos financieros, divisas (Forex), contratos por diferencia (CFDs) y derivados utilizando modelos de inversión colectiva (PAMM/MAM) o algoritmos automatizados presenta un alto nivel de riesgo patrimonial. El apalancamiento financiero puede operar tanto a su favor como en su contra, existiendo la posibilidad matemática de perder la totalidad de los fondos depositados en su intermediario.</p>
     <p style="${p};margin-top:8px">Pessaro Capital, con domicilio legal fijado en Apoquindo 6410, Oficina 605, Piso 6, de la comuna de Las Condes, Santiago, Chile, es una entidad de base tecnológica dedicada en exclusiva al desarrollo, optimización, mantenimiento y soporte de soluciones de software informático. No constituye un intermediario de valores, corredor de bolsa, administradora general de fondos (AGF) ni una firma captadora de depósitos del público regulada bajo la Ley de Bancos de la República de Chile. Las herramientas automatizadas se configuran bajo la exclusiva responsabilidad del usuario e inversionista. Los rendimientos históricos expuestos son puramente informativos y no constituyen promesa ni garantía de ganancias futuras. Asegúrese de comprender íntegramente los riesgos involucrados antes de operar.</p>`,
  );

  return `
<tr><td bgcolor="${C.navy700}" style="background:${C.navy700};padding:24px 20px;border-top:1px solid ${C.border};border-radius:0 0 12px 12px">
  ${riesgo}
  <p style="margin:0 0 16px;font-size:10px;line-height:1.7;color:${C.text};opacity:0.6;text-align:justify;padding:0 4px">El trading de instrumentos apalancados conlleva un alto nivel de riesgo y puede no ser adecuado para todos los inversionistas. El 64% de las cuentas minoristas pierden dinero. Rendimientos pasados no garantizan resultados futuros.</p>
  ${exencion}
  ${legalObligatoria}
  <p style="margin:8px 0 0;font-size:10px;line-height:1.7;color:${C.text};opacity:0.7;text-align:center">
    © 2026 Pessaro Capital SpA. Todos los derechos reservados. Santiago, Chile.<br />
    Desarrollado de conformidad con los estándares de la Ley Fintec N° 21.521<br />
    Pessaro Capital - Apoquindo 6410, oficina 605 Las Condes, Santiago-Chile
  </p>
</td></tr>`;
}

/**
 * Envoltorio común de todo correo saliente: cabecera con wordmark, cuerpo
 * inyectado y footer legal.
 *
 * El wordmark va como TEXTO y no como el logo de `lib/pessaro-logo.ts`: ese
 * asset es .webp, que Outlook y varios clientes de escritorio no renderizan
 * y dejarían un hueco en la cabecera de cada correo.
 */
function emailShell(bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background:${C.navy950};font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.navy950}" style="background:${C.navy950};padding:24px 0"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto">
  <tr><td style="background:linear-gradient(135deg,${C.navy800},${C.navy700});border-radius:12px 12px 0 0;padding:24px 28px;border-bottom:2px solid ${C.purple}">
    <p style="margin:0 0 4px;font-size:10px;color:${C.muted};letter-spacing:0.12em;text-transform:uppercase">Pessaro Capital</p>
    <p style="margin:0;font-size:24px;font-weight:800;letter-spacing:0.06em;color:${C.text}">PESSARO <span style="color:${C.gold}">BRIDGE</span></p>
  </td></tr>
  <tr><td bgcolor="${C.navy900}" style="background:${C.navy900};padding:28px;border-left:1px solid ${C.border};border-right:1px solid ${C.border}">
    ${bodyHtml}
  </td></tr>
  ${legalFooterHtml()}
</table></td></tr></table></body></html>`;
}

/** Párrafo del cuerpo, con el color de texto de la marca ya aplicado. */
function p(text: string, opts: { muted?: boolean } = {}): string {
  const color = opts.muted ? C.muted : C.text;
  const size = opts.muted ? 12 : 14;
  return `<p style="margin:0 0 16px;font-size:${size}px;line-height:1.8;color:${color}">${text}</p>`;
}

/** CTA primario: púrpura, que en pessaro.cl es el color de acción (.btn-primary). */
function ctaButton(actionLink: string, label: string): string {
  return `<div style="text-align:center;margin:24px 0">
      <a href="${actionLink}" style="display:inline-block;background:linear-gradient(135deg,${C.purple},${C.purpleDeep});color:#ffffff;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">${label} &rarr;</a>
    </div>`;
}

/** Tabla de datos clave (etiqueta → valor). Se usa en el aviso a los super_admin. */
function dataTable(rows: [string, string][]): string {
  const cells = rows
    .map(
      ([k, v]) =>
        `<tr>
          <td style="padding:6px 12px 6px 0;font-size:12px;color:${C.muted};white-space:nowrap">${k}</td>
          <td style="padding:6px 0;font-size:13px;color:${C.text};font-weight:600">${v}</td>
        </tr>`,
    )
    .join("");
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid ${C.border};border-radius:8px;background:${C.navy800};padding:12px 16px;margin:0 0 16px">${cells}</table>`;
}

/** Escapa texto de origen humano antes de interpolarlo en el HTML del correo. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-CL", { day: "2-digit", month: "long", year: "numeric" });
}

// ==================== usuarios del panel ====================
//
// Cada correo se arma con un `build*` puro (asunto + HTML) y se envía con su
// `send*`. La separación existe para poder previsualizar y testear el HTML —
// sobre todo el footer legal — sin mandar un correo real ni tener credenciales
// de Resend: ver `scripts/preview-emails.ts`.

export type RenderedEmail = { subject: string; html: string };

export function buildInviteEmail(opts: { actionLink: string; isExisting: boolean }): RenderedEmail {
  const intro = opts.isExisting
    ? "Tu acceso al panel de Pessaro Bridge fue actualizado. Usa el siguiente enlace para confirmar tu sesión."
    : "Te invitaron al panel de administrador de Pessaro Bridge. Para completar tu acceso, define tu contraseña con el siguiente enlace.";
  const cta = opts.isExisting ? "Confirmar mi acceso" : "Configurar mi contraseña";

  const body = `${p(intro)}
    ${ctaButton(opts.actionLink, cta)}
    ${p("Si no esperabas esta invitación, puedes ignorar este correo. El enlace expira en 24 horas.", { muted: true })}`;

  return {
    subject: opts.isExisting ? "Tu acceso a Pessaro Bridge fue actualizado" : "Invitación a Pessaro Bridge",
    html: emailShell(body),
  };
}

export async function sendInviteEmail(opts: { to: string; actionLink: string; isExisting: boolean }): Promise<string> {
  return sendEmail({ to: opts.to, ...buildInviteEmail(opts) });
}

export function buildPasswordResetEmail(opts: { actionLink: string }): RenderedEmail {
  const body = `${p("Solicitaste restablecer tu contraseña del panel de Pessaro Bridge. Usa el siguiente enlace para definir una nueva.")}
    ${ctaButton(opts.actionLink, "Restablecer mi contraseña")}
    ${p("Si no solicitaste este cambio, puedes ignorar este correo — tu contraseña actual sigue vigente. El enlace expira en 24 horas.", { muted: true })}`;

  return { subject: "Restablecer tu contraseña de Pessaro Bridge", html: emailShell(body) };
}

export async function sendPasswordResetEmail(opts: { to: string; actionLink: string }): Promise<string> {
  return sendEmail({ to: opts.to, ...buildPasswordResetEmail(opts) });
}

// ==================== clientes ====================

export type ClientEmailData = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  broker: string;
  accountType: "demo" | "real";
  accountNumber: string;
  brokerServer: string;
  expiresAt: string | null;
};

/** Correo al CLIENTE invitado: su token de señales y cómo configurarlo. */
export function buildClientTokenEmail(opts: { client: ClientEmailData; token: string }): RenderedEmail {
  const { client } = opts;
  const vigencia = client.expiresAt
    ? `Tu acceso está activo hasta el <strong style="color:${C.goldLight}">${formatDate(client.expiresAt)}</strong>.`
    : "Tu acceso no tiene fecha de caducidad.";

  const body = `${p(`Hola ${esc(client.firstName)} ${esc(client.lastName)},`)}
    ${p("Pessaro Capital habilitó tu acceso a las señales del sistema. Configura este token en el campo <strong>InpEaToken</strong> del Expert Advisor de MetaTrader 4:")}
    <div style="background:${C.navy950};border:1px solid ${C.gold};border-radius:8px;padding:16px;margin:0 0 16px;text-align:center">
      <code style="font-size:13px;color:${C.goldLight};word-break:break-all;font-family:'Courier New',monospace">${opts.token}</code>
    </div>
    ${p(vigencia, { muted: true })}
    ${p("Quedó registrado a nombre de la siguiente cuenta:", { muted: true })}
    ${dataTable([
      ["Bróker", esc(client.broker)],
      ["Tipo de cuenta", client.accountType === "real" ? "REAL" : "Demo"],
      ["N° de cuenta", esc(client.accountNumber)],
      ["Servidor", esc(client.brokerServer)],
    ])}
    ${p("Este token es personal e intransferible. No lo compartas: identifica tu acceso de forma única.", { muted: true })}`;

  return { subject: "Tu acceso a las señales de Pessaro Bridge", html: emailShell(body) };
}

export async function sendClientTokenEmail(opts: { client: ClientEmailData; token: string }): Promise<string> {
  return sendEmail({ to: opts.client.email, ...buildClientTokenEmail(opts) });
}

/**
 * Aviso a los super_admin de que se dio de alta un cliente.
 *
 * NO lleva el token. Un correo de notificación se reenvía, se archiva y se lee
 * en el móvil: el token vive en el correo del cliente y en el panel, que es
 * donde está protegido por sesión.
 */
export function buildClientCreatedNoticeEmail(opts: {
  client: ClientEmailData;
  createdBy: string;
  assignedAdminEmail: string | null;
}): RenderedEmail {
  const { client } = opts;

  const body = `${p(`Se dio de alta un nuevo cliente en Pessaro Bridge y ya se le envió su token de señales a <strong>${esc(client.email)}</strong>.`)}
    ${dataTable([
      ["Cliente", `${esc(client.firstName)} ${esc(client.lastName)}`],
      ["Correo", esc(client.email)],
      ["Móvil", esc(client.phone)],
      ["Bróker", esc(client.broker)],
      ["Tipo de cuenta", client.accountType === "real" ? "REAL" : "Demo"],
      ["N° de cuenta", esc(client.accountNumber)],
      ["Servidor", esc(client.brokerServer)],
      ["Vigencia", client.expiresAt ? `hasta el ${formatDate(client.expiresAt)}` : "indefinida"],
      ["Admin asignado", opts.assignedAdminEmail ? esc(opts.assignedAdminEmail) : "sin asignar"],
      ["Dado de alta por", esc(opts.createdBy)],
    ])}
    ${p("El token no se incluye en este aviso: está en el correo del cliente y en el panel, bajo sesión.", { muted: true })}`;

  return {
    subject: `Nuevo cliente en Pessaro Bridge · ${client.firstName} ${client.lastName}`,
    html: emailShell(body),
  };
}

/** Devuelve null si no hay super_admin a quien avisar (no es un error). */
export async function sendClientCreatedNoticeEmail(opts: {
  to: string[];
  client: ClientEmailData;
  createdBy: string;
  assignedAdminEmail: string | null;
}): Promise<string | null> {
  if (opts.to.length === 0) return null;
  return sendEmail({ to: opts.to, ...buildClientCreatedNoticeEmail(opts) });
}

// ==================== transporte ====================

async function sendEmail(opts: { to: string | string[]; subject: string; html: string }): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Falta RESEND_API_KEY");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html: opts.html,
      reply_to: "send@pessaro.cl",
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Resend respondió ${res.status}: ${data?.message ?? JSON.stringify(data)}`);
  }
  return data.id as string;
}
