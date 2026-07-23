const RESEND_FROM = "Pessaro Bridge <send@pessaro.cl>";

function inviteEmailHtml(actionLink: string, isExisting: boolean): string {
  const intro = isExisting
    ? "Tu acceso al panel de Pessaro Bridge fue actualizado. Usa el siguiente enlace para confirmar tu sesión."
    : "Te invitaron al panel de administrador de Pessaro Bridge. Para completar tu acceso, define tu contraseña con el siguiente enlace.";
  const cta = isExisting ? "Confirmar mi acceso" : "Configurar mi contraseña";

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#0c0f1a;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0c0f1a;padding:24px 0"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
  <tr><td style="background:linear-gradient(135deg,#141826,#1c2030);border-radius:12px 12px 0 0;padding:24px 28px">
    <p style="margin:0 0 4px;font-size:10px;color:#8b8fa3;letter-spacing:0.12em;text-transform:uppercase">Panel de administrador</p>
    <p style="margin:0;font-size:24px;font-weight:800;letter-spacing:0.06em;color:#f2f0ea">PESSARO <span style="color:#c9a84c">BRIDGE</span></p>
  </td></tr>
  <tr><td style="background:#ffffff;padding:28px;border-left:1px solid #dde6f0;border-right:1px solid #dde6f0">
    <p style="font-size:14px;color:#2d3748;line-height:1.8;margin:0 0 20px">${intro}</p>
    <div style="text-align:center;margin:24px 0">
      <a href="${actionLink}" style="display:inline-block;background:#c9a84c;color:#1a1508;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">${cta} &rarr;</a>
    </div>
    <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:16px 0 0">Si no esperabas esta invitación, puedes ignorar este correo. El enlace expira en 24 horas.</p>
  </td></tr>
  <tr><td style="background:#0c0f1a;border-radius:0 0 12px 12px;padding:16px 28px;font-size:11px;color:#8b8fa3">
    Pessaro Capital &middot; uso interno, no distribuir.
  </td></tr>
</table></td></tr></table></body></html>`;
}

export async function sendInviteEmail(opts: { to: string; actionLink: string; isExisting: boolean }): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Falta RESEND_API_KEY");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [opts.to],
      subject: opts.isExisting ? "Tu acceso a Pessaro Bridge fue actualizado" : "Invitación a Pessaro Bridge",
      html: inviteEmailHtml(opts.actionLink, opts.isExisting),
      reply_to: "send@pessaro.cl",
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Resend respondió ${res.status}: ${data?.message ?? JSON.stringify(data)}`);
  }
  return data.id as string;
}
