import type { CashSession, SaleCreatedPayload, TenantContext } from '../../../types/index.ts'
import { payRestaurantLocalFiscal } from '../../tables/service.ts'
import { issuePosInvoice, printPayloadWithLocalFiscal, preparedFiscalInstallation, preflightFiscalInstallation } from './posInvoice.ts'
import type { PreparedFiscalInstallation } from './posInvoice.ts'
import { openLedger, request, transactionDone, readLocalFiscalRecord, reconcileLocalFiscalCopies, type LocalFiscalEntry } from './localLedger.ts'
import { fiscalBridgeAccessToken, fiscalBridgeBaseUrl } from './installation.ts'
import { synchronizeLocalFiscalQueue } from './sync.ts'
import { withConfirmedRestaurantPayments } from '../../restaurant/services/paymentPayload.ts'

type Action = 'close' | 'equal_part' | 'selected_items'

type PreparedRestaurantPayment = { key: string; entry: LocalFiscalEntry; draft: SaleCreatedPayload; action: Action; params: Record<string, unknown> }
function queueRestaurantFiscalDelivery(entry: LocalFiscalEntry): void {
  const baseUrl = fiscalBridgeBaseUrl(entry.record.tenantId)
  if (entry.invoice.transmissionMode !== 'bridge' || !baseUrl) return
  // The restaurant RPC has already confirmed the economic transaction. Delivery
  // must start now without delaying printing or Cashlogy acknowledgement.
  void synchronizeLocalFiscalQueue({ tenantId: entry.record.tenantId, fiscalSubjectId: entry.record.fiscalSubjectId,
    installationId: entry.record.installationId, mode: 'production', baseUrl,
    getAccessToken: fiscalBridgeAccessToken }).catch(() => { /* Retained for background retry. */ })
}
async function pendingRestaurantPayment(key: string): Promise<PreparedRestaurantPayment | undefined> {
  const db = await openLedger()
  try {
    const tx = db.transaction('restaurantPayments', 'readonly')
    const done = transactionDone(tx)
    const value = await request(tx.objectStore('restaurantPayments').get(key)) as PreparedRestaurantPayment | undefined
    await done
    return value
  } finally { db.close() }
}
async function saveRestaurantPayment(value: PreparedRestaurantPayment): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction('restaurantPayments', 'readwrite')
    const done = transactionDone(tx)
    tx.objectStore('restaurantPayments').put(value)
    await done
  } finally { db.close() }
}

function confirmedRestaurantPayload(draft: SaleCreatedPayload, result: Record<string, unknown>): SaleCreatedPayload {
  const { ticketId, saleId, paymentId } = result
  const total = result.totalCents ?? result.paidAmountCents
  if (typeof ticketId !== 'string' || typeof saleId !== 'string'
    || (paymentId !== null && paymentId !== undefined && typeof paymentId !== 'string') || Number(total) !== draft.ticket.totalCents) {
    throw new Error('El resultado económico no coincide con el registro fiscal preparado.')
  }
  return withConfirmedRestaurantPayments({ ...draft, ticket: { ...draft.ticket, id: ticketId },
    lines: draft.lines.map(line => ({ ...line, id: `${ticketId}:${line.id}`, ticketId })),
    sale: { ...draft.sale, id: saleId, ticketId },
    payment: draft.payment ? { ...draft.payment, id: paymentId || saleId, saleId } : null }, result)
}

export async function preflightRestaurantInvoice(context: TenantContext, session: CashSession, saleId: string): Promise<PreparedFiscalInstallation> {
  return preparedFiscalInstallation(context, session, saleId, await preflightFiscalInstallation(context, session))
}

class ConfirmationRequired extends Error {
  readonly result: Record<string, unknown>
  constructor(result: Record<string, unknown>) {
    super('El cobro requiere confirmar las comandas pendientes.')
    this.result = result
  }
}

export async function issueRestaurantInvoice(
  context: TenantContext, cashSession: CashSession, draft: SaleCreatedPayload,
  action: Action, params: Record<string, unknown>,
  installation?: PreparedFiscalInstallation | null,
  operationKey?: string,
): Promise<{ result: Record<string, unknown>; entry: LocalFiscalEntry | null; payload: SaleCreatedPayload | null }> {
  const key = operationKey ?? `${context.tenantId}:${context.venueId}:${context.deviceId}:${cashSession.id}:${draft.sale.id}`
  let pending = await pendingRestaurantPayment(key)
  if (pending && pending.draft.sale.id !== draft.sale.id && pending.action === action
    && pending.entry.record.tenantId === context.tenantId && pending.entry.record.deviceId === context.deviceId) {
    // Partial payments reuse the order/split key. Only a locally committed
    // record releases the previous envelope; unresolved RPCs keep their identity.
    const confirmed = await readLocalFiscalRecord(pending.entry.scope, pending.entry.id)
    if (confirmed && confirmed.record.hash === pending.entry.record.hash
      && confirmed.record.invoiceId === pending.entry.record.invoiceId) pending = undefined
  }
  if (pending) {
    if (pending.draft.sale.id !== draft.sale.id || pending.action !== action
      || pending.entry.record.tenantId !== context.tenantId || pending.entry.record.deviceId !== context.deviceId) {
      throw new Error('La operación fiscal pendiente no pertenece a este cobro.')
    }
    // Consult/replay the exact envelope first. The RPC returns its durable result
    // if the reply was lost, without generating a new invoice or economic sale.
    const result = await payRestaurantLocalFiscal(pending.action, { ...pending.params, allowPending: params.allowPending },
      pending.entry.record as unknown as Record<string, unknown>, { ...pending.entry.invoice, invoiceId: pending.entry.record.invoiceId })
    if (result.requiresConfirmation === true) return { result, entry: null, payload: null }
    const payload = confirmedRestaurantPayload(pending.draft, result)
    const entry: LocalFiscalEntry = { ...pending.entry, invoice: { ...pending.entry.invoice,
      ticketId: payload.ticket.id, saleId: payload.sale.id, paymentId: payload.payment?.id ?? null } }
    await reconcileLocalFiscalCopies(entry.record, context.deviceId, [{ entry, economicPayload: payload, eventId: entry.id }])
    queueRestaurantFiscalDelivery(entry)
    return { result, entry, payload: printPayloadWithLocalFiscal(payload, entry) }
  }
  let result: Record<string, unknown> | null = null
  let finalPayload: SaleCreatedPayload | null = null
  let entry: LocalFiscalEntry
  try { entry = await issuePosInvoice(context, cashSession, draft, true, async (prepared) => {
    // Commit the exact envelope before the remote transaction. A later quota or
    // network error cannot destroy the identity needed to recover its result.
    await saveRestaurantPayment({ key, entry: prepared, draft, action, params })
    result = await payRestaurantLocalFiscal(action, params, prepared.record as unknown as Record<string, unknown>,
      { ...prepared.invoice, invoiceId: prepared.record.invoiceId })
    if (result.requiresConfirmation === true) {
      throw new ConfirmationRequired(result)
    }
    finalPayload = confirmedRestaurantPayload(draft, result)
    return finalPayload
  }, 300000, installation) } catch (error) {
    if (error instanceof ConfirmationRequired) return { result: error.result, entry: null, payload: null }
    throw error
  }
  if (!result || !finalPayload) throw new Error('El cobro fiscal no quedó confirmado.')
  queueRestaurantFiscalDelivery(entry)
  return { result, entry, payload: printPayloadWithLocalFiscal(finalPayload, entry) }
}
