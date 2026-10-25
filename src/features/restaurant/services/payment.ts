import type { CashSession, SaleCreatedPayload, TenantContext } from '../../../types/index.ts'
import type { CashlogyTransaction } from '../../local-printing/types.ts'
import { acceptPaymentOperation, commitPaymentOperation, discardPreparedPaymentOperation, loadPaymentOperation, loadPendingPaymentOperations, markPaymentCharging, markRestaurantCheckoutReserved, paymentScope, preparePaymentOperation, withPaymentLock } from '../../../lib/durableSales.ts'
import { getCashlogyPaymentAmounts, isCashlogyPaymentConfigured, settleCashlogyPaymentIfConfigured } from '../../local-printing/cashlogy/useCashlogyStore.ts'
import { resolveLocalFiscalMode } from '../../fiscal/local/tenantMode.ts'
import { preflightPosInvoice } from '../../fiscal/local/posInvoice.ts'
import { issueRestaurantInvoice } from '../../fiscal/local/restaurantInvoice.ts'
import { payRestaurantIdempotent } from '../../tables/service.ts'
import { withConfirmedRestaurantPayments } from './paymentPayload.ts'
import { prepareRestaurantCheckout, releaseRestaurantCheckout, startRestaurantCheckout } from './checkout.ts'

type Input = {
  context: TenantContext
  session: CashSession
  target: string
  sequence?: number
  action: 'close' | 'equal_part' | 'selected_items'
  draft: SaleCreatedPayload
  params: Record<string, unknown>
  confirmedCashlogy?: CashlogyTransaction | null
}

/** Recover original payments independently of the current table/order map. This
 * replays saved RPC parameters and only queries hardware already in progress. */
export async function recoverRestaurantPayments(context: TenantContext, session: CashSession) {
  const operations = await loadPendingPaymentOperations(context, session.id)
  const recovered = []
  for (const operation of operations) {
    const action = operation.key.split('|restaurant:')[1]?.split(':')[0]
    if (action !== 'close' && action !== 'equal_part' && action !== 'selected_items') continue
    if (!operation.params) throw new Error('Faltan los parámetros del cobro original. Conserva el almacenamiento y solicita conciliación.')
    const target = action === 'equal_part' ? operation.params.splitId : operation.params.orderId
    if (typeof target !== 'string') throw new Error('Falta la comanda del cobro original.')
    const payment = await payRestaurantSale<{ requiresConfirmation?: boolean; ticketId?: string }>({ context, session, action,
      target, draft: operation.payload, params: operation.params })
    if (payment.result.requiresConfirmation) throw new Error('El cobro original requiere confirmar las unidades pendientes de su comanda. No vuelvas a cobrarlo.')
    recovered.push(payment)
  }
  return recovered
}

/** Owns the durable economic boundary; UI reloads and printers run afterwards. */
export async function payRestaurantSale<T extends object>(input: Input): Promise<{
  result: T; payload: SaleCreatedPayload | null; transaction: CashlogyTransaction | null; receivedCents: number | null; changeCents: number | null
}> {
  const { context, session, action } = input
  const scope = paymentScope(context, session.id)
  return withPaymentLock(scope, async () => {
    const key = `${scope}|restaurant:${action}:${input.target}`
    const checkoutParams: Record<string, unknown> = { ...input.params, cashSessionId: session.id }
    const { allowPending: _allowPending, receivedCents: _received, ...economicParams } = checkoutParams
    const pending = await loadPaymentOperation(key)
    const savedMode = pending && ['accepted', 'charging', 'committed'].includes(pending.state) ? pending.params?.fiscalMode : undefined
    let production = savedMode === 'verifactu' || (savedMode !== 'legacy' && await resolveLocalFiscalMode(context.tenantId) !== 'disabled')
    let operation = pending && (pending.state === 'accepted' || pending.state === 'charging' || (pending.state === 'prepared' && pending.checkoutReserved)) ? pending
      : await preparePaymentOperation(key, JSON.stringify({ params: economicParams, sequence: input.sequence,
          lines: input.draft.lines.map(({ id: _id, ticketId: _ticketId, ...line }) => line), totalCents: input.draft.sale.totalCents,
          fiscalMode: production ? 'verifactu' : 'legacy' }), input.draft, { ...checkoutParams, fiscalMode: production ? 'verifactu' : 'legacy' })
    let payload = operation.payload
    const singleTicket = operation.params?.singleTicket === true
    const intermediatePart = singleTicket && operation.params?.finalPart !== true
    const settlementCents = singleTicket ? Number(operation.params?.amountCents) : payload.sale.totalCents
    if (operation.state === 'committed' && operation.result) return {
      result: operation.result as T, payload, transaction: operation.cashlogy,
      receivedCents: payload.payment?.receivedCents ?? null, changeCents: payload.payment?.changeCents ?? null,
    }
    const originalParams = { ...(operation.params ?? checkoutParams), cashSessionId: session.id, paymentOperationId: operation.eventId,
      allowPending: input.params.allowPending }
    // Persist a group-wide reservation before touching hardware. Another checkout
    // cannot collect the same bill while this operation is pending or recovering.
    if (operation.state === 'prepared' && !operation.checkoutReserved) operation = await markRestaurantCheckoutReserved(operation)
    try { await prepareRestaurantCheckout(context, operation.eventId, action, originalParams) }
    catch (error) {
      // A PostgreSQL rejection confirms the transaction did not reserve/charge.
      // A network failure is ambiguous and retains the exact durable operation.
      if (operation.state === 'prepared' && typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
        if (await releaseRestaurantCheckout(context, operation.eventId)) await discardPreparedPaymentOperation(key)
      }
      throw error
    }
    let installation = null
    if (production && !intermediatePart && operation.state === 'prepared') {
      try { installation = await preflightPosInvoice(context, session, payload, 300000) }
      catch (error) {
        if (await releaseRestaurantCheckout(context, operation.eventId)) await discardPreparedPaymentOperation(key)
        throw error
      }
    }
    let transaction = operation.cashlogy
    await startRestaurantCheckout(context, operation.eventId)
    if (operation.state !== 'accepted') {
      if (payload.sale.paymentMethod === 'cash') {
        const recovery = operation.state === 'charging'
        if (!recovery && isCashlogyPaymentConfigured()) operation = await markPaymentCharging(operation)
        transaction = input.confirmedCashlogy ?? await settleCashlogyPaymentIfConfigured(settlementCents,
          payload.sale.id, operation.cashlogyRequestId ?? `cashlogy:sale:${payload.sale.id}`, recovery, operation.key)
        if (transaction && (transaction.requestedAmountCents !== settlementCents || (transaction.saleId && transaction.saleId !== payload.sale.id))) {
          throw new Error('El cobro Cashlogy no coincide con la operación original.')
        }
        const amounts = getCashlogyPaymentAmounts(transaction, settlementCents)
        if (transaction && payload.payment) payload = { ...payload, payment: { ...payload.payment,
          receivedCents: amounts.receivedCents, changeCents: amounts.changeCents ?? 0,
          cashlogyRequestId: transaction.requestId, cashlogyTransactionId: transaction.id } }
      }
      operation = await acceptPaymentOperation(operation, payload, transaction)
    }
    const params = { ...originalParams, receivedCents: payload.payment?.receivedCents ?? null,
      cashlogyRequestId: transaction?.requestId ?? null, cashlogyTransactionId: transaction?.id ?? null }
    let legacyResult: Record<string, unknown> | null = null
    if (!production || intermediatePart) {
      try { legacyResult = await payRestaurantIdempotent(context, operation.eventId, action, params) }
      catch (error) {
        // A confirmed legacy receipt replays unchanged. If activation happened
        // before first DB commit, this precise rejection rolls back the whole
        // legacy RPC; issue fiscally with the already accepted payment instead.
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '55000'
          || !('message' in error) || typeof error.message !== 'string' || !error.message.includes('LOCAL_FISCAL_RECORD_REQUIRED')
          || await resolveLocalFiscalMode(context.tenantId) === 'disabled') throw error
        production = true
      }
    }
    const fiscal = production && !intermediatePart ? await issueRestaurantInvoice(context, session, payload, action, params, installation, key) : null
    const result = fiscal?.result ?? legacyResult
    if (!result) throw new Error('No se pudo confirmar la identidad del cobro.')
    if (result.requiresConfirmation === true) return { result: result as T, payload: null, transaction,
      receivedCents: payload.payment?.receivedCents ?? null, changeCents: payload.payment?.changeCents ?? null }
    if (production && !intermediatePart && !fiscal?.payload) throw new Error('El cobro conserva su identidad fiscal pendiente de recuperar.')
    if (intermediatePart) {
      if (result.completed !== false || result.ticketId !== null || result.saleId !== null) throw new Error('El subpago no coincide con el reparto pendiente.')
      await commitPaymentOperation(operation, payload, false, result)
      return { result: result as T, payload: null, transaction,
        receivedCents: payload.payment?.receivedCents ?? null, changeCents: payload.payment?.changeCents ?? null }
    }
    if (!fiscal) {
      if (typeof result.ticketId !== 'string' || typeof result.saleId !== 'string') throw new Error('Falta la identidad del cobro confirmado.')
      const ticketId = result.ticketId
      payload = { ...payload, ticket: { ...payload.ticket, id: ticketId },
        lines: payload.lines.map(line => ({ ...line, ticketId })), sale: { ...payload.sale, id: result.saleId, ticketId },
        payment: payload.payment ? { ...payload.payment, id: typeof result.paymentId === 'string' ? result.paymentId : payload.payment.id, saleId: result.saleId } : null }
    }
    const confirmedPayload = withConfirmedRestaurantPayments(fiscal?.payload ?? payload, result)
    await commitPaymentOperation(operation, confirmedPayload, false, result)
    return { result: result as T, payload: confirmedPayload, transaction,
      receivedCents: payload.payment?.receivedCents ?? null, changeCents: payload.payment?.changeCents ?? null }
  })
}
