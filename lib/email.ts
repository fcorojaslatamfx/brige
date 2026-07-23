const RESEND_FROM = "Pessaro Bridge <send@pessaro.cl>";

/**
 * Mismo texto legal obligatorio del footer de pessaro.cl (advertencia de riesgo +
 * exención de responsabilidad + advertencia legal + datos societarios), exigido
 * por compliance en todo correo saliente de Pessaro Capital, no solo invitaciones.
 */
function legalFooterHtml(): string {
  return `
<tr><td style="background:#0c0f1a;padding:20px 28px;font-size:11px;line-height:1.6;color:#8b8fa3;border-top:1px solid rgba(242,240,234,0.08)">
  <p style="margin:0 0 10px;font-weight:700;color:#e8c374;font-size:11px">⚠ Advertencia de Riesgo</p>
  <p style="margin:0 0 8px">El trading de instrumentos financieros conlleva un alto nivel de riesgo para su capital y puede resultar en pérdidas superiores a su depósito inicial. Los productos apalancados pueden no ser adecuados para todos los inversores. Por favor, asegúrese de comprender plenamente los riesgos involucrados y busque asesoramiento independiente si es necesario. Pessaro Capital no ofrece asesoramiento de inversión directo.</p>
  <p style="margin:0 0 8px">Los servicios prestados por Pessaro Capital se limitan exclusivamente a la introducción de brókers. Las plataformas y servicios de cuentas PAMM, MAM o copy trading son proporcionados directamente por dichos brókers, bajo la jurisdicción de su país de origen y las regulaciones que estos mantienen vigentes.</p>
  <p style="margin:0 0 12px">El trading de instrumentos apalancados conlleva un alto nivel de riesgo y puede no ser adecuado para todos los inversionistas. El 64% de las cuentas minoristas pierden dinero. Rendimientos pasados no garantizan resultados futuros.</p>

  <p style="margin:0 0 10px;font-weight:700;color:#e8c374;font-size:11px">⚖ Exención de Responsabilidad</p>
  <p style="margin:0 0 8px">Pessaro Capital queda exenta de toda responsabilidad por cualquier pérdida, daño o perjuicio derivado de fallas técnicas, interrupciones en el sistema, errores de ejecución, retrasos en la plataforma o por el desempeño operativo y financiero de los brókers introducidos.</p>
  <p style="margin:0 0 12px">El uso de dichas plataformas y herramientas tecnológicas corre bajo el propio riesgo y responsabilidad del usuario.</p>

  <p style="margin:0 0 10px;font-weight:700;color:#e8c374;font-size:11px">Advertencia Legal Obligatoria</p>
  <p style="margin:0 0 8px">El trading de activos financieros, divisas (Forex), contratos por diferencias (CFDs) y derivados utilizando modelos de inversión colectiva (PAMM/MAM) o algoritmos automatizados presenta un alto nivel de riesgo patrimonial. El apalancamiento financiero puede operar tanto a su favor como en su contra, existiendo la posibilidad matemática de perder la totalidad de los fondos depositados en su intermediario.</p>
  <p style="margin:0 0 12px">Pessaro Capital SpA, con Rol Único Tributario (RUT) número 77.863.269-1 y domicilio legal fijado en Apoquindo 6410, Oficina 605, Piso 6, de la comuna de Las Condes, Santiago, Chile, es una entidad de base tecnológica dedicada en exclusiva al desarrollo, optimización, mantenimiento y soporte de soluciones de software informático. No constituye un intermediario de valores, corredor de bolsa, administradora general de fondos (AGF) ni una firma captadora de depósitos del público regulada bajo la Ley de Bancos de la República de Chile. Las herramientas automatizadas se configuran bajo la exclusiva responsabilidad del usuario e inversionista. Los rendimientos históricos expuestos son puramente informativos y no constituyen promesa ni garantía de ganancias futuras. Asegúrese de comprender íntegramente los riesgos involucrados antes de operar.</p>

  <p style="margin:0 0 4px">© 2026 Pessaro Capital SpA. Todos los derechos reservados. Santiago, Chile.</p>
  <p style="margin:0 0 4px">Desarrollado de conformidad con los estándares de la Ley Fintec N° 21.521</p>
  <p style="margin:0">PESSARO CAPITAL SPA · RUT 77.863.269-1 · Apoquindo 6410, Oficina 605, Piso 6, Las Condes, Santiago, Chile</p>
</td></tr>`;
}

/** Envoltorio común (header con wordmark + cuerpo inyectado + footer legal) para todo correo saliente. */
function emailShell(bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#0c0f1a;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0c0f1a;padding:24px 0"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
  <tr><td style="background:linear-gradient(135deg,#141826,#1c2030);border-radius:12px 12px 0 0;padding:24px 28px">
    <p style="margin:0 0 4px;font-size:10px;color:#8b8fa3;letter-spacing:0.12em;text-transform:uppercase">Panel de administrador</p>
    <p style="margin:0;font-size:24px;font-weight:800;letter-spacing:0.06em;color:#f2f0ea">PESSARO <span style="color:#c9a84c">BRIDGE</span></p>
  </td></tr>
  <tr><td style="background:#ffffff;padding:28px;border-left:1px solid #dde6f0;border-right:1px solid #dde6f0">
    ${bodyHtml}
  </td></tr>
  ${legalFooterHtml()}
</table></td></tr></table></body></html>`;
}

function ctaButton(actionLink: string, label: string): string {
  return `<div style="text-align:center;margin:24px 0">
      <a href="${actionLink}" style="display:inline-block;background:#c9a84c;color:#1a1508;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">${label} &rarr;</a>
    </div>`;
}

export async function sendInviteEmail(opts: { to: string; actionLink: string; isExisting: boolean }): Promise<string> {
  const intro = opts.isExisting
    ? "Tu acceso al panel de Pessaro Bridge fue actualizado. Usa el siguiente enlace para confirmar tu sesión."
    : "Te invitaron al panel de administrador de Pessaro Bridge. Para completar tu acceso, define tu contraseña con el siguiente enlace.";
  const cta = opts.isExisting ? "Confirmar mi acceso" : "Configurar mi contraseña";

  const body = `<p style="font-size:14px;color:#2d3748;line-height:1.8;margin:0 0 20px">${intro}</p>
    ${ctaButton(opts.actionLink, cta)}
    <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:16px 0 0">Si no esperabas esta invitación, puedes ignorar este correo. El enlace expira en 24 horas.</p>`;

  return sendEmail({
    to: opts.to,
    subject: opts.isExisting ? "Tu acceso a Pessaro Bridge fue actualizado" : "Invitación a Pessaro Bridge",
    html: emailShell(body),
  });
}

export async function sendPasswordResetEmail(opts: { to: string; actionLink: string }): Promise<string> {
  const body = `<p style="font-size:14px;color:#2d3748;line-height:1.8;margin:0 0 20px">Solicitaste restablecer tu contraseña del panel de Pessaro Bridge. Usa el siguiente enlace para definir una nueva.</p>
    ${ctaButton(opts.actionLink, "Restablecer mi contraseña")}
    <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:16px 0 0">Si no solicitaste este cambio, puedes ignorar este correo — tu contraseña actual sigue vigente. El enlace expira en 24 horas.</p>`;

  return sendEmail({
    to: opts.to,
    subject: "Restablecer tu contraseña de Pessaro Bridge",
    html: emailShell(body),
  });
}

async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Falta RESEND_API_KEY");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [opts.to],
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
