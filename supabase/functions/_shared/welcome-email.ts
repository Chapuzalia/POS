import { welcomeLogoBase64 } from './welcome-email-logo.ts'

export type WelcomeEmailStatus = 'sent' | 'not_configured' | 'failed' | 'unknown'

type WelcomeEmailInput = {
  ownerId: string
  ownerEmail: string
  ownerPassword: string
  ownerFullName: string
  tenantName: string
  billingMode: 'manual' | 'stripe'
}
type WelcomeEmailConfig = { apiKey?: string; appUrl?: string }

const welcomeFrom = 'Tickit <bienvenida@notificaciones.tickitpos.com>'
const welcomeReplyTo = 'info@tickitpos.com'
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)

export async function sendWelcomeEmail(input: WelcomeEmailInput, config: WelcomeEmailConfig, send: typeof fetch = fetch): Promise<WelcomeEmailStatus> {
  const apiKey = config.apiKey?.trim()
  if (!apiKey || !config.appUrl?.trim()) return 'not_configured'
  let loginUrl: URL
  try {
    const appUrl = new URL(config.appUrl)
    if (appUrl.username || appUrl.password || (appUrl.protocol !== 'https:' && !(appUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname)))) return 'not_configured'
    loginUrl = new URL('/crm', appUrl)
  } catch { return 'not_configured' }

  const nextStep = input.billingMode === 'stripe'
    ? 'Al iniciar sesión verás Mi Plan. Podrás revisar o modificar tu plan y extras y completar el pago en Stripe. Las funciones contratadas se activarán cuando se confirme el pago.'
    : 'Ya puedes iniciar sesión y acceder a tu negocio.'
  const body = JSON.stringify({
    from: welcomeFrom,
    reply_to: welcomeReplyTo,
    to: [input.ownerEmail],
    subject: 'Bienvenido a Tickit · Tus datos de acceso',
    text: `Hola ${input.ownerFullName},\n\nTu negocio ${input.tenantName} ya está creado en Tickit.\n\nUsuario: ${input.ownerEmail}\nContraseña inicial: ${input.ownerPassword}\nAcceder a Tickit: ${loginUrl.href}\n\n${nextStep}\n\nSi necesitas ayuda, responde a este correo o escribe a ${welcomeReplyTo}.\n\nEl equipo de Tickit`,
    html: `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <title>Bienvenido a Tickit</title>
  <style>@media only screen and (max-width:620px){.outer-padding{padding:16px 10px!important}.content-padding{padding-left:24px!important;padding-right:24px!important}.welcome-heading{font-size:26px!important;line-height:34px!important}.credentials-padding{padding:18px!important}}</style>
</head>
<body style="margin:0;padding:0;background-color:#f1f4f8;color:#17243b;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Tu cuenta de Tickit está lista. Consulta tus datos de acceso y los siguientes pasos.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f4f8">
    <tr><td align="center" class="outer-padding" style="padding:40px 16px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e1e7ef;border-radius:16px">
        <tr><td class="content-padding" style="padding:32px 40px 28px;border-bottom:1px solid #e8edf3">
          <img src="cid:tickit-welcome-logo" width="134" height="30" alt="Tickit" style="display:block;width:134px;height:30px;border:0;outline:none;text-decoration:none">
        </td></tr>
        <tr><td class="content-padding" style="padding:32px 40px 0">
          <p style="margin:0 0 12px;color:#1478ed;font-size:11px;line-height:16px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase">Tu cuenta está lista</p>
          <h1 class="welcome-heading" style="margin:0 0 24px;color:#17243b;font-size:30px;line-height:38px;font-weight:bold;letter-spacing:-0.6px">Bienvenido a Tickit</h1>
          <p style="margin:0 0 12px;font-size:15px;line-height:24px">Hola ${escapeHtml(input.ownerFullName)},</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:24px">Hemos creado la cuenta de <strong>${escapeHtml(input.tenantName)}</strong>. Estos son tus datos para acceder a tu espacio de gestión.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f9fc" style="width:100%;table-layout:fixed;background-color:#f7f9fc;border:1px solid #e4eaf2;border-radius:10px">
            <tr><td class="credentials-padding" style="padding:24px">
              <p style="margin:0 0 20px;color:#64748b;font-size:10px;line-height:16px;font-weight:bold;letter-spacing:1.3px;text-transform:uppercase">Credenciales de acceso</p>
              <p style="margin:0 0 5px;color:#64748b;font-size:12px;line-height:18px">Usuario</p>
              <p style="margin:0 0 18px;color:#17243b;font-size:15px;line-height:23px;font-weight:bold;word-break:break-all;overflow-wrap:anywhere">${escapeHtml(input.ownerEmail)}</p>
              <p style="margin:0 0 5px;color:#64748b;font-size:12px;line-height:18px">Contraseña inicial</p>
              <p style="margin:0;color:#17243b;font-family:Consolas,'Courier New',monospace;font-size:19px;line-height:28px;font-weight:bold;white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere">${escapeHtml(input.ownerPassword)}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td class="content-padding" style="padding:26px 40px 0">
          <p style="margin:0 0 8px;color:#17243b;font-size:14px;line-height:22px;font-weight:bold">Siguiente paso</p>
          <p style="margin:0 0 24px;color:#526176;font-size:14px;line-height:23px">${nextStep}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#1478ed" style="background-color:#1478ed;border-radius:8px;mso-padding-alt:15px 28px">
            <a href="${escapeHtml(loginUrl.href)}" style="display:inline-block;padding:15px 28px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:bold;text-align:center;text-decoration:none;border-radius:8px">Acceder a mi cuenta</a>
          </td></tr></table>
          <p style="margin:18px 0 30px;color:#8290a3;font-size:12px;line-height:19px">Conserva tus credenciales en un lugar seguro.</p>
        </td></tr>
        <tr><td class="content-padding" style="padding:24px 40px 28px;border-top:1px solid #e8edf3">
          <p style="margin:0 0 6px;color:#17243b;font-size:13px;line-height:20px;font-weight:bold">Estamos para ayudarte</p>
          <p style="margin:0;color:#64748b;font-size:12px;line-height:20px">Responde a este correo o contacta con <a href="mailto:${welcomeReplyTo}" style="color:#1478ed;text-decoration:none">${welcomeReplyTo}</a>.</p>
        </td></tr>
      </table>
      <p style="margin:20px 0 0;color:#8995a6;font-size:11px;line-height:18px">Tickit &middot; Acceso a tu cuenta</p>
    </td></tr>
  </table>
</body>
</html>`,
    attachments: [{ filename: 'tickit-logo.png', content: welcomeLogoBase64, content_id: 'tickit-welcome-logo' }],
  })
  let uncertain = false
  // Keep credentials only in memory. The exact body/key is reused on a bounded
  // retry; no provider errors, payloads or secrets reach logs or API responses.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `tickit-welcome/${input.ownerId}/v1` },
        body,
      })
      if (response.ok) {
        const result: unknown = await response.json()
        if (typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string' && result.id.trim()) return 'sent'
        uncertain = true
      } else {
        await response.body?.cancel()
        if (![408, 409, 429].includes(response.status) && response.status < 500) return uncertain ? 'unknown' : 'failed'
        if (response.status !== 429) uncertain = true
      }
    } catch { uncertain = true }
  }
  return uncertain ? 'unknown' : 'failed'
}
