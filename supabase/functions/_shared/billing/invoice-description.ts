import { dateOnly, epoch } from './mollie.ts'
import type { MolliePayment, MollieSubscription } from './mollie.ts'
import type { Contract } from './domain.ts'
import type { Operation } from './service.ts'
import { addMonths } from './promotions.ts'

export type InvoiceServiceSnapshot = { description?: string; kind?: 'first' | 'renewal' | 'proration' | 'arrears'; periodStart?: string; periodEnd?: string }
const day = (date: string) => epoch(dateOnly(epoch(date)))
const formatDate = (date: string) => new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(date))
const monthCount = (contract: Contract) => contract.interval === 'year' ? 12 : 1

function snapshot(contract: Contract, kind: NonNullable<InvoiceServiceSnapshot['kind']>, start?: string, end?: string): InvoiceServiceSnapshot {
  const name = contract.planName.trim()
  const title = `${kind === 'proration' ? 'Ampliación de suscripción' : 'Suscripción'} ${/^Tickit\b/i.test(name) ? name : `Tickit ${name}`} — ${contract.interval === 'year' ? 'anual' : 'mensual'}`
  if (!start || !end) return kind === 'first' ? { kind, description: `${title}\nPeríodo pendiente de activación` } : {}
  if (!Number.isFinite(day(start)) || !Number.isFinite(day(end)) || day(end) <= day(start)) return {}
  return { kind, periodStart: start, periodEnd: end, description: `${title}\nPeríodo: del ${formatDate(start)} al ${formatDate(dateOnly(day(end) - 86_400))}` }
}

// Resolve the contract that actually covered the charge, including scheduled changes and restorations.
function renewalContract(subscription: MollieSubscription, start: number, operations: Operation[], payments: MolliePayment[]) {
  return operations.filter(op => op.kind === 'change' && op.contract && ['completed', 'scheduled'].includes(op.status)
    && (op.id === subscription.metadata?.tickit_operation_id || op.stripe_params.subscriptionId === subscription.id))
    .map(op => {
      const payment = payments.find(row => row.id === op.result?.paymentId)
      const effective = op.effective_at ?? op.preview.effectiveAt ?? payment?.paidAt ?? (op.status === 'completed' ? op.created_at : null)
      if (!effective || !Number.isFinite(epoch(effective)) || epoch(effective) > start) return null
      const phase = op.stripe_params.phases?.filter(item => item.start <= start).at(-1)
      const restored = op.restore_contract && op.contract?.exception?.cycles && start >= addMonths(epoch(effective), op.contract.exception.cycles * monthCount(op.contract))
      return { at: epoch(effective), contract: phase?.contract ?? (restored ? op.restore_contract : op.contract) }
    }).filter(item => item !== null).sort((a, b) => b.at - a.at)[0]?.contract ?? null
}

export function invoiceServiceSnapshot(payment: MolliePayment, payments: MolliePayment[], subscriptions: MollieSubscription[], operations: Operation[], existing: Map<string, InvoiceServiceSnapshot | null>): InvoiceServiceSnapshot {
  if (!Number.isFinite(epoch(payment.createdAt)) || payment.paidAt && !Number.isFinite(epoch(payment.paidAt))) return {}
  const kind = payment.metadata?.tickit_kind
  if (kind === 'arrears') {
    const covered = payments.find(row => row.id === payment.metadata?.tickit_covers && row.id !== payment.id && row.metadata?.tickit_kind !== 'arrears')
    if (!covered) return {}
    const original = existing.get(covered.id) ?? invoiceServiceSnapshot(covered, payments, subscriptions, operations, existing)
    return original.description && original.periodEnd ? { ...original, kind: 'arrears', description: `Regularización de cuota\n${original.description}` } : {}
  }
  const operation = operations.find(op => op.id === payment.metadata?.tickit_operation_id)
  if (kind === 'first' && operation?.contract) {
    return payment.paidAt
      ? snapshot(operation.contract, 'first', dateOnly(epoch(payment.paidAt)), dateOnly(addMonths(epoch(payment.paidAt), monthCount(operation.contract))))
      : snapshot(operation.contract, 'first')
  }
  if (kind === 'proration' && operation?.contract) {
    if (!Number.isFinite(operation.proration_date)) return {}
    let end: unknown
    try { end = JSON.parse(operation.stripe_params.baseline ?? '{}').nextPaymentDate } catch { return {} }
    return typeof end === 'string' ? snapshot(operation.contract, 'proration', dateOnly(operation.proration_date), end) : {}
  }
  const subscription = subscriptions.find(sub => sub.id === payment.subscriptionId)
  if (!subscription || !Number.isFinite(epoch(subscription.startDate)) || !['1 month', '12 months'].includes(subscription.interval)) return {}
  const step = subscription.interval === '12 months' ? 12 : 1
  const anchor = day(subscription.startDate), charged = day(payment.createdAt)
  const origin = new Date(anchor * 1000), date = new Date(charged * 1000)
  const distance = (date.getUTCFullYear() - origin.getUTCFullYear()) * 12 + date.getUTCMonth() - origin.getUTCMonth()
  let offset = Math.floor(distance / step) * step
  if (addMonths(anchor, offset) > charged) offset -= step
  if (offset < 0) return {}
  // SEPA settlement may take days; use the calendar charge cycle, never paidAt or the current nextPaymentDate.
  const start = addMonths(anchor, offset), end = addMonths(anchor, offset + step)
  const contract = renewalContract(subscription, start, operations, payments)
  return contract ? snapshot(contract, 'renewal', dateOnly(start), dateOnly(end)) : {}
}
