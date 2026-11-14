import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0'
import { noticeWindowOpen, sepaCreditor } from './sepa.ts'

export type SepaNotice = {
  key: string; tenantId: string; subscriptionId: string; mandateId: string; recipient: string
  amountCents: number; dueDate: string; reference: string; ibanLast4: string | null
  preNotificationDays: 3 | 14
}
export type SepaNoticeDelivery = { status: 'sent'; messageId: string } | { status: 'not_configured' | 'failed' | 'unknown' }
export type SepaNoticeSender = (notice: SepaNotice) => Promise<SepaNoticeDelivery>
type NoticeRecord = { details: SepaNotice & { status?: string; attemptedAt?: string; sentAt?: string; messageId?: string } }

// Reconciliation already holds the per-business DB lease. These records are in the
// existing service-only audit trail; no payment or access state depends on email.
export async function notifySepa(db: SupabaseClient, notice: SepaNotice, send: SepaNoticeSender) {
  const prior = await db.from('billing_audit').select('details').eq('tenant_id', notice.tenantId).eq('action', 'sepa_notice').eq('details->>key', notice.key).order('created_at', { ascending: false }).limit(1).returns<NoticeRecord[]>()
  if (prior.error) throw new Error('BILLING_DB_SEPA')
  const previous = prior.data?.[0]?.details
  if (previous?.status === 'sent') return null
  if (previous?.status === 'late') return 'late'
  if (previous?.attemptedAt && ['failed', 'not_configured'].includes(previous.status ?? '') && Date.now() - Date.parse(previous.attemptedAt) < 3600_000) return previous.status ?? 'failed'
  const attempts = await db.from('billing_audit').select('details').eq('tenant_id', notice.tenantId).eq('action', 'sepa_notice_attempt').eq('details->>key', notice.key).order('created_at', { ascending: true }).limit(1).returns<NoticeRecord[]>()
  if (attempts.error) throw new Error('BILLING_DB_SEPA')
  const firstAttempt = attempts.data?.[0]?.details.attemptedAt
  // Resend retains idempotency keys for 24h. Do not blindly resend an uncertain
  // delivery after that window or pretend its original notification was timely.
  if ((!previous || previous.status === 'unknown') && firstAttempt && Date.now() - Date.parse(firstAttempt) >= 23 * 3600_000) return 'unknown'
  const attemptedAt = new Date().toISOString()
  const attempt = await db.from('billing_audit').insert({ tenant_id: notice.tenantId, action: 'sepa_notice_attempt', reason: 'Preparación de pre-notificación SEPA', details: { ...notice, attemptedAt } })
  if (attempt.error) throw new Error('BILLING_DB_SEPA')
  let delivery: SepaNoticeDelivery
  try { delivery = await send(notice) } catch { delivery = { status: 'unknown' } }
  const status = delivery.status === 'sent' && !noticeWindowOpen(notice.dueDate, new Date(), notice.preNotificationDays) ? 'late' : delivery.status
  const recorded = await db.from('billing_audit').insert({ tenant_id: notice.tenantId, action: 'sepa_notice', reason: 'Pre-notificación de adeudo SEPA', details: { ...notice, status, attemptedAt, ...(delivery.status === 'sent' ? { sentAt: new Date().toISOString(), messageId: delivery.messageId } : {}) } })
  if (recorded.error) throw new Error('BILLING_DB_SEPA')
  return status === 'sent' ? null : status
}

export function sepaNoticeSender(config: { apiKey?: string; appUrl: string }, send: typeof fetch = fetch): SepaNoticeSender {
  return async notice => {
    if (!config.apiKey?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notice.recipient)) return { status: 'not_configured' }
    let planUrl: URL
    try {
      const base = new URL(config.appUrl)
      if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) return { status: 'not_configured' }
      planUrl = new URL('/crm/plan', base)
    } catch { return { status: 'not_configured' } }
    const amount = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(notice.amountCents / 100)
    const text = [
      'Pre-notificación de adeudo SEPA Core de Tickit POS.',
      `Beneficiario: ${sepaCreditor.beneficiary}, NIF ${sepaCreditor.taxId}. ${sepaCreditor.address}.`,
      `Acreedor de los adeudos: ${sepaCreditor.collectingCreditor}. Identificador SEPA: ${sepaCreditor.identifier}.`,
      `Referencia del mandato: ${notice.reference}.`,
      `Importe: ${amount}. Fecha de vencimiento: ${notice.dueDate}.`,
      notice.ibanLast4 ? `Cuenta terminada en ${notice.ibanLast4}.` : '',
      'La fecha efectiva de anotación bancaria puede depender del calendario de tu entidad. Este aviso no confirma el cobro.',
      'Si los datos no corresponden a tu contrato o necesitas resolver una incidencia, contacta con info@alteilsolutions.com.',
      `Consulta tu plan y las copias de los avisos: ${planUrl.href}`,
    ].filter(Boolean).join('\n\n')
    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${config.apiKey.trim()}`, 'Content-Type': 'application/json', 'Idempotency-Key': `tickit:sepa-notice:${notice.key}` },
        body: JSON.stringify({ from: 'Tickit <bienvenida@notificaciones.tickitpos.com>', reply_to: 'info@alteilsolutions.com', to: [notice.recipient], subject: `Próximo adeudo Tickit: ${amount} · ${notice.dueDate}`, text }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        return { status: response.status >= 500 || [408, 409].includes(response.status) ? 'unknown' : 'failed' }
      }
      const result: unknown = await response.json()
      return typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string' && result.id.trim()
        ? { status: 'sent', messageId: result.id } : { status: 'unknown' }
    } catch { return { status: 'unknown' } }
  }
}
