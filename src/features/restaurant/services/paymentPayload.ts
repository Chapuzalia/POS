import type { SaleCreatedPayload } from '../../../types/domain.ts'

/** Hydrate the complete tender list before saving a fiscal or durable copy. */
export function withConfirmedRestaurantPayments(payload: SaleCreatedPayload, result: Record<string, unknown>): SaleCreatedPayload {
  if (result.singleTicket !== true) return payload
  if (!Array.isArray(result.payments)) throw new Error('Falta el desglose de pagos de la venta.')
  const payments: NonNullable<SaleCreatedPayload['payments']> = result.payments.map((value: unknown) => {
    if (typeof value !== 'object' || value === null) throw new Error('Pago de la venta no válido.')
    const payment = value as Record<string, unknown>
    if (typeof payment.id !== 'string' || payment.tenantId !== payload.sale.tenantId || payment.saleId !== payload.sale.id
      || (payment.method !== 'cash' && payment.method !== 'card')
      || typeof payment.amountCents !== 'number' || !Number.isSafeInteger(payment.amountCents) || payment.amountCents <= 0
      || typeof payment.changeCents !== 'number' || !Number.isSafeInteger(payment.changeCents) || payment.changeCents < 0
      || (payment.receivedCents !== null && (typeof payment.receivedCents !== 'number' || !Number.isSafeInteger(payment.receivedCents)))
      || (payment.method === 'cash' && (typeof payment.receivedCents !== 'number' || payment.receivedCents < payment.amountCents || payment.changeCents !== payment.receivedCents - payment.amountCents))
      || (payment.method === 'card' && (payment.receivedCents !== null || payment.changeCents !== 0))) {
      throw new Error('El pago no coincide con la venta confirmada.')
    }
    return { id: payment.id, tenantId: payload.sale.tenantId, saleId: payload.sale.id, method: payment.method,
      amountCents: payment.amountCents, receivedCents: payment.receivedCents as number | null, changeCents: payment.changeCents,
      cashlogyRequestId: typeof payment.cashlogyRequestId === 'string' ? payment.cashlogyRequestId : null,
      partNumber: typeof payment.partNumber === 'number' && Number.isSafeInteger(payment.partNumber) && payment.partNumber > 0 ? payment.partNumber : undefined,
      cashlogyTransactionId: typeof payment.cashlogyTransactionId === 'string' ? payment.cashlogyTransactionId : null }
  })
  if (new Set(payments.map(payment => payment.id)).size !== payments.length
    || payments.reduce((sum, payment) => sum + payment.amountCents, 0) !== payload.sale.totalCents) {
    throw new Error('Los pagos no coinciden con el total de la venta.')
  }
  const methods = new Set(payments.map(payment => payment.method))
  return { ...payload, payments: payments.length > 1 ? payments : undefined, payment: payments.length === 1 ? payments[0] : null,
    sale: { ...payload.sale, paymentMethod: methods.size === 1 ? payments[0].method : null } }
}
