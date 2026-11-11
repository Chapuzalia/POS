import {
  acceptPaymentOperation, commitPaymentChangeOperation, markPaymentCharging,
  paymentScope, preparePaymentChangeOperation, withPaymentLock,
} from '../../../lib/durableSales.ts'
import type { PaymentMethod, SessionTicketRecord, TenantContext } from '../../../types/index.ts'
import {
  getCashlogyPaymentAmounts, settleCashlogyPaymentIfConfigured,
} from '../../local-printing/cashlogy/useCashlogyStore'
import type { CashlogyTransaction } from '../../local-printing/types'

/** Persist the economic mutation before publishing either secondary cache. */
export async function changeTicketPayment(context: TenantContext, ticket: SessionTicketRecord, method: PaymentMethod,
  confirmedCashlogy: CashlogyTransaction | null = null) {
  return withPaymentLock(paymentScope(context, ticket.cashSessionId), async () => {
    let operation = await preparePaymentChangeOperation(context, ticket, method)
    if (operation.state === 'committed') return operation
    if (operation.state !== 'accepted') {
      let cashlogy = confirmedCashlogy ?? operation.cashlogy
      if (operation.params?.sourceMethod === 'card' && method === 'cash') {
        const recovery = operation.state === 'charging'
        if (!recovery) operation = await markPaymentCharging(operation)
        cashlogy ??= await settleCashlogyPaymentIfConfigured(ticket.totalCents, ticket.payload.sale.id,
          operation.cashlogyRequestId, recovery, operation.key)
        if (cashlogy && (cashlogy.requestedAmountCents !== ticket.totalCents || cashlogy.saleId !== ticket.payload.sale.id)) {
          throw new Error('El cobro confirmado en Cashlogy no pertenece a este ticket.')
        }
      }
      const amounts = getCashlogyPaymentAmounts(cashlogy, ticket.totalCents)
      const payment = operation.payload.payment
      if (!payment) throw new Error('Falta el pago original del ticket.')
      const payload = { ...operation.payload, payment: { ...payment, method,
        receivedCents: method === 'cash' ? amounts.receivedCents ?? ticket.totalCents : null,
        changeCents: method === 'cash' ? amounts.changeCents ?? 0 : 0,
        cashlogyRequestId: method === 'cash' ? cashlogy?.requestId ?? null : null,
        cashlogyTransactionId: method === 'cash' ? cashlogy?.id ?? null : null } }
      if (payload.payments) payload.payments = payload.payments.map(existing => existing.id === payment.id ? payload.payment : existing)
      operation = await acceptPaymentOperation(operation, payload, cashlogy)
    }
    await commitPaymentChangeOperation(operation)
    return { ...operation, state: 'committed' as const, result: { paymentProjectionPending: true } }
  })
}
