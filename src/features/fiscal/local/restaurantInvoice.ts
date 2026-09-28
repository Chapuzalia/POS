import type { CashSession, SaleCreatedPayload, TenantContext } from '../../../types/index.ts'
import { payRestaurantLocalFiscal } from '../../tables/service.ts'
import { issuePosInvoice, printPayloadWithLocalFiscal } from './posInvoice.ts'
import type { LocalFiscalEntry } from './localLedger.ts'

type Action = 'close' | 'equal_part' | 'selected_items'

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
): Promise<{ result: Record<string, unknown>; entry: LocalFiscalEntry | null; payload: SaleCreatedPayload | null }> {
  let result: Record<string, unknown> | null = null
  let finalPayload: SaleCreatedPayload | null = null
  let entry: LocalFiscalEntry
  try { entry = await issuePosInvoice(context, cashSession, draft, true, async (prepared) => {
    result = await payRestaurantLocalFiscal(action, params, prepared.record as unknown as Record<string, unknown>,
      { ...prepared.invoice, invoiceId: prepared.record.invoiceId })
    if (result.requiresConfirmation === true) {
      throw new ConfirmationRequired(result)
    }
    const ticketId = result.ticketId
    const saleId = result.saleId
    const paymentId = result.paymentId
    const total = result.totalCents ?? result.paidAmountCents
    if (typeof ticketId !== 'string' || typeof saleId !== 'string'
      || (paymentId !== null && paymentId !== undefined && typeof paymentId !== 'string')
      || Number(total) !== draft.ticket.totalCents) {
      throw new Error('El resultado económico no coincide con el registro fiscal preparado.')
    }
    finalPayload = {
      ...draft,
      ticket: { ...draft.ticket, id: ticketId },
      lines: draft.lines.map(line => ({ ...line, id: `${ticketId}:${line.id}`, ticketId })),
      sale: { ...draft.sale, id: saleId, ticketId },
      payment: draft.payment ? { ...draft.payment, id: paymentId || saleId, saleId } : null,
    }
    return finalPayload
  }, 300000) } catch (error) {
    if (error instanceof ConfirmationRequired) return { result: error.result, entry: null, payload: null }
    throw error
  }
  if (!result || !finalPayload) throw new Error('El cobro fiscal no quedó confirmado.')
  return { result, entry, payload: printPayloadWithLocalFiscal(finalPayload, entry) }
}
