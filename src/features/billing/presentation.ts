import type { BillingAccount, BillingInvoice } from './types'

const labels: Record<string, string> = {
  active: 'Activa', trialing: 'En prueba', manual: 'Manual', pending_payment: 'Alta pendiente',
  incomplete: 'Pago incompleto', incomplete_expired: 'Alta caducada', past_due: 'Pago pendiente',
  unpaid: 'Impagada', canceled: 'Cancelada', paused: 'Pausada', paid: 'Pagada', open: 'Pendiente de pago',
  draft: 'Borrador', void: 'Anulada', uncollectible: 'Devuelta', processing: 'En trámite', pending: 'En trámite',
  quoted: 'Sin confirmar', applying: 'Sin confirmar con Mollie', payment_pending: 'Pago pendiente',
  scheduled: 'Programada', completed: 'Completada', failed: 'Fallida', expired: 'Caducada',
  received: 'Recibido', ignored: 'Sin acción necesaria',
}
// An accepted SEPA debit (Mollie `pending`; Stripe-era `processing`) keeps access until the bank settles it.
export const billingPaymentInTransit = (status: string | null | undefined) => status === 'processing' || status === 'pending'
export const billingStatusLabel = (status: string | null | undefined) => status ? labels[status] ?? 'Sin clasificar' : 'Sin pagos registrados'
export const billingOperationLabel = (kind: string) => ({ change: 'Cambio de plan o complementos', cancel: 'Baja en la renovación', cancel_now: 'Baja inmediata' })[kind] ?? 'Operación de facturación'

export const billingStateClass = {
  success: '!bg-[var(--crm-green-soft)] !text-[var(--crm-green)]',
  warning: '!bg-[var(--crm-yellow-soft)] !text-[var(--crm-text)]',
  info: '!bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]',
  neutral: '!bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]',
}

type AccountState = { label: string; description: string; tone: keyof typeof billingStateClass; needsAttention: boolean }
export function billingAccountState(account: Pick<BillingAccount, 'status' | 'last_payment_status' | 'sync_error' | 'cancel_at_period_end'>): AccountState {
  if (['past_due', 'unpaid'].includes(account.status) || account.last_payment_status === 'uncollectible') return { label: 'Revisar pago', description: 'Hay una cuota sin cobrar o devuelta. Revisa los cobros y paga la cuota pendiente.', tone: 'warning', needsAttention: true }
  if (['incomplete', 'pending_payment', 'incomplete_expired'].includes(account.status)) return { label: account.status === 'incomplete_expired' ? 'Alta caducada' : 'Alta pendiente', description: 'El primer pago aún no ha activado la suscripción.', tone: 'warning', needsAttention: true }
  if (billingPaymentInTransit(account.last_payment_status)) return { label: 'Cobro en trámite', description: 'SEPA autorizado. Espera la respuesta del banco; no repitas el cobro.', tone: 'info', needsAttention: false }
  if (account.last_payment_status === 'open' || account.last_payment_status === 'void') return { label: account.last_payment_status === 'void' ? 'Factura anulada' : 'Pago pendiente', description: 'Revisa la última factura antes de solicitar otro cambio.', tone: 'warning', needsAttention: true }
  if (account.status === 'canceled') return { label: 'Cancelada', description: 'Esta suscripción ya no se renueva.', tone: 'neutral', needsAttention: false }
  if (account.sync_error && account.sync_error !== 'ENTITLEMENTS_PENDING_OPERATIONAL_CLOSE') return { label: 'Comprobar estado', description: 'Actualiza el estado con Mollie para verificar la suscripción.', tone: 'warning', needsAttention: true }
  if (account.cancel_at_period_end) return { label: 'Baja programada', description: 'La suscripción termina en la próxima renovación.', tone: 'neutral', needsAttention: false }
  if (account.status === 'active') return { label: 'Al día', description: 'Gestiona el plan, los complementos y las facturas de este cliente.', tone: 'success', needsAttention: false }
  if (account.status === 'trialing') return { label: 'En prueba', description: 'La suscripción está dentro de su periodo de prueba.', tone: 'info', needsAttention: false }
  if (account.status === 'manual') return { label: 'Gestión manual', description: 'Este cliente todavía no tiene una suscripción activa en Mollie.', tone: 'neutral', needsAttention: false }
  return { label: billingStatusLabel(account.status), description: 'Comprueba el estado con Mollie antes de modificar la suscripción.', tone: 'warning', needsAttention: true }
}

const odooLabels: Record<string, string> = { proforma: 'Proforma', invoiced: 'Emitida', refunded: 'Rectificada', canceled: 'Anulada', failed: 'Pendiente de emisión' }
export const odooDocumentLabel = (state: BillingInvoice['odoo_state']) => state ? odooLabels[state] ?? '—' : '—'
export const odooDocumentAvailable = (state: BillingInvoice['odoo_state']) => state === 'proforma' || state === 'invoiced' || state === 'refunded'
