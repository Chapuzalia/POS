import { reportOperationError, operationBreadcrumb } from '../../../lib/observability.ts'
import { getReadableError } from '../../../utils/errors.ts'
import { useCallback, useEffect, useRef } from 'react'
import { acceptPaymentOperation, commitPaymentOperation, discardPreparedPaymentOperation, loadPaymentOperations, markPaymentCharging, paymentScope, preparePaymentOperation, withPaymentLock } from '../../../lib/durableSales.ts'
import { loadSessionTicketFromSupabase } from '../../../services/posService'
import { buildSalePayload } from '../services/salePayload'
import { loadTicketInvoice } from '../../customers/service'
import {
  finishCashlogyPayment,
  getCashlogyPaymentAmounts,
  getCashlogyPaymentSaleId,
  isCashlogyPaymentConfigured,
  settleCashlogyPaymentIfConfigured,
} from '../../local-printing/cashlogy/useCashlogyStore'
import type { AppliedDiscount, CashSession, Customer, PaymentMethod, SaleRecord, SessionTicketRecord, TenantContext, TicketLine } from '../../../types'
import type { CashlogyTransaction } from '../../local-printing/types'
import { requestEarlyCashDrawer } from '../../local-printing/services/earlyCashDrawer'
import { assertRealSaleAllowed } from '../../fiscal/local/mode.ts'
import { resolveLocalFiscalMode } from '../../fiscal/local/tenantMode.ts'
import { issuePosInvoice, preflightPosInvoice, printPayloadWithLocalFiscal, type PreparedFiscalInstallation } from '../../fiscal/local/posInvoice.ts'
import { synchronizeFiscalEconomicSales } from '../../fiscal/local/economicSync.ts'
import { synchronizeLocalFiscalQueue } from '../../fiscal/local/sync.ts'
import { fiscalBridgeAccessToken, fiscalBridgeBaseUrl } from '../../fiscal/local/installation.ts'

type Options = {
  context: TenantContext | null
  cashSession: CashSession | null
  lines: TicketLine[]
  discount: AppliedDiscount | null
  invoiceCustomer: Customer | null
  ledger: SaleRecord[]
  tickets: SessionTicketRecord[]
  isOnline: boolean
  persistLedger: (ledger: SaleRecord[]) => void
  persistTickets: (tickets: SessionTicketRecord[]) => void
  persistLines: (lines: TicketLine[]) => void
  mergeProductStats: (lines: TicketLine[]) => void
  resetUi: (method: PaymentMethod | null) => void
  refreshPendingCount: () => void
  syncPendingEvents: () => Promise<void>
  loadPersistedTicket?: (ticketId: string) => Promise<SessionTicketRecord | null>
  printSale: (payload: SessionTicketRecord['payload'], options?: { cashDrawerAlreadyRequested?: boolean; fiscalMode?: 'legacy' | 'verifactu' }) => Promise<void>
  onError: (message: string | null) => void
  onPaymentInFlightChange?: (inFlight: boolean) => void
}

export function useQuickSalePayment(options: Options) {
  const paymentInFlightRef = useRef(false)
  const latestOptionsRef = useRef(options)
  latestOptionsRef.current = options

  const completePayment = useCallback(async (
    paymentMethod: PaymentMethod | null,
    receivedCents: number | null,
    confirmedCashlogyTransaction: CashlogyTransaction | null = null,
    recoveryKey?: string,
  ) => {
    const { context, cashSession, lines } = options
    const fail = (message: string) => {
      options.onError(message)
      if (confirmedCashlogyTransaction) throw new Error(message)
    }
    if (!context || !cashSession) {
      if (confirmedCashlogyTransaction) fail(!context || !cashSession
        ? 'Abre la sesión de caja correspondiente antes de aplicar el cobro. El cobro sigue pendiente de registrar.'
        : 'No hay productos en el ticket para aplicar este cobro. Recupera el ticket original; no vuelvas a cobrar en la máquina.')
      return
    }
    let localFiscalProduction = await resolveLocalFiscalMode(context.tenantId) !== 'disabled'
    if (!localFiscalProduction) {
      try {
        assertRealSaleAllowed()
      } catch (error) {
        fail(error instanceof Error ? error.message : 'La emisión fiscal no está disponible.')
        return
      }
    }
    if (confirmedCashlogyTransaction) confirmedCashlogyTransaction = {
      ...confirmedCashlogyTransaction,
      saleId: getCashlogyPaymentSaleId(confirmedCashlogyTransaction),
    }
    if (confirmedCashlogyTransaction && !confirmedCashlogyTransaction.saleId) {
      fail('El cobro recuperado no pertenece a una venta rápida identificable. El cobro se conserva pendiente; no vuelvas a cobrar en la máquina.')
      return
    }
    const quickSaleKey = `${paymentScope(context, cashSession.id)}|quick-sale`
    const operations = (await loadPaymentOperations(context, cashSession.id))
      .filter(operation => operation.key === quickSaleKey || operation.key.startsWith(`${quickSaleKey}:`))
    const stored = operations.find(operation => {
      if (recoveryKey) return operation.key === recoveryKey
      if (confirmedCashlogyTransaction) return operation.payload.sale.id === confirmedCashlogyTransaction.saleId
      const sourceIds = operation.params?.sourceLineIds
      return Array.isArray(sourceIds) && lines.some(line => sourceIds.includes(line.id))
    })
    if (recoveryKey && !stored) return // A cancelled attempt must never become a new collection.
    const pending = stored && (stored.state === 'accepted' || stored.state === 'charging'
      || confirmedCashlogyTransaction?.saleId === stored.payload.sale.id) ? stored : undefined
    if (pending?.params?.fiscalMode === 'legacy') localFiscalProduction = false
    else if (pending?.params?.fiscalMode === 'verifactu') localFiscalProduction = true
    if (pending && confirmedCashlogyTransaction && confirmedCashlogyTransaction.saleId !== pending.payload.sale.id) {
      fail('El cobro recuperado no coincide con la venta pendiente. Conserva ambos registros y revisa la operación original.')
      return
    }
    if (!pending && lines.length === 0) {
      if (confirmedCashlogyTransaction) fail('No hay productos en el ticket para aplicar este cobro. Recupera el ticket original; no vuelvas a cobrar en la máquina.')
      return
    }
    if (!pending && !localFiscalProduction && options.invoiceCustomer && !options.isOnline) {
      fail('Conéctate antes de cobrar una factura para asignar su número definitivo.')
      return
    }
    const fingerprint = JSON.stringify({ lines, discount: options.discount, customer: options.invoiceCustomer?.id, paymentMethod, fiscalMode: localFiscalProduction ? 'verifactu' : 'legacy' })
    const candidate = pending?.payload ?? buildSalePayload(
      context,
      cashSession,
      lines,
      paymentMethod,
      receivedCents,
      options.discount,
      options.invoiceCustomer,
      confirmedCashlogyTransaction?.saleId ? { saleId: confirmedCashlogyTransaction.saleId } : undefined,
    )
    // Additive keys retain old singleton journals and give every new ticket its
    // own recovery identity; one unresolved payment cannot occupy the register.
    const operationKey = stored?.key ?? `${quickSaleKey}:${candidate.sale.id}`
    let operation = pending ?? await preparePaymentOperation(operationKey, fingerprint, candidate, {
      sourceLineIds: lines.map(line => line.id), fiscalMode: localFiscalProduction ? 'verifactu' : 'legacy',
    })
    const preview = operation.payload
    const sameDraft = operation.fingerprint === fingerprint
    const clearPaidDraftLines = () => {
      const current = latestOptionsRef.current
      const ids = operation.params?.sourceLineIds
      if (Array.isArray(ids) && current.context && current.cashSession
        && paymentScope(current.context, current.cashSession.id) === paymentScope(context, cashSession.id)) {
        const remaining = current.lines.filter(line => !ids.includes(line.id))
        current.persistLines(remaining)
        if (!remaining.length) current.resetUi(paymentMethod)
      } else if (sameDraft) { options.persistLines([]); options.resetUi(paymentMethod) }
    }
    const savedMethod = preview.sale.paymentMethod
    if (savedMethod !== null && savedMethod !== 'cash' && savedMethod !== 'card') throw new Error('El método del cobro pendiente requiere conciliación.')
    paymentMethod = savedMethod
    if (operation.state === 'committed') {
      clearPaidDraftLines()
      finishCashlogyPayment(operation.cashlogy)
      return
    }
    let preparedFiscalInstallation: PreparedFiscalInstallation | null = null
    if (localFiscalProduction) {
      try { preparedFiscalInstallation = await preflightPosInvoice(context, cashSession, preview) }
      catch (error) {
        if (operation.state === 'prepared') await discardPreparedPaymentOperation(operation.key)
        fail(error instanceof Error ? error.message : 'La instalación fiscal no está preparada para emitir.')
        return
      }
    }
    let cashlogyTransaction = operation.cashlogy
    if (paymentMethod === 'cash' && operation.state !== 'accepted') {
      try {
        const recovery = operation.state === 'charging'
        if (operation.state === 'prepared' && isCashlogyPaymentConfigured()) operation = await markPaymentCharging(operation)
        cashlogyTransaction = confirmedCashlogyTransaction
          ?? await settleCashlogyPaymentIfConfigured(preview.sale.totalCents, preview.sale.id, operation.cashlogyRequestId ?? `cashlogy:sale:${preview.sale.id}`, recovery, operation.key)
        if (cashlogyTransaction && (
          cashlogyTransaction.requestedAmountCents !== preview.sale.totalCents
          || cashlogyTransaction.saleId !== preview.sale.id
        )) {
          throw new Error('El cobro confirmado en Cashlogy no coincide con esta venta.')
        }
      } catch (error) {
        fail(getReadableError(error, { operation: 'sale.payment', saleId: preview.sale.id, cashSessionId: cashSession.id, integration: 'cashlogy', step: 'settle' }, 'No se pudo completar el cobro con Cashlogy.'))
        return
      }
    }
    const cashlogyAmounts = getCashlogyPaymentAmounts(cashlogyTransaction, preview.sale.totalCents)
    const payload = cashlogyTransaction && preview.payment
      ? {
          ...preview,
          payment: {
            ...preview.payment,
            receivedCents: cashlogyAmounts.receivedCents,
            changeCents: cashlogyAmounts.changeCents ?? 0,
            cashlogyRequestId: cashlogyTransaction.requestId,
            cashlogyTransactionId: cashlogyTransaction.id,
          },
        }
      : preview
    if (operation.state !== 'accepted') operation = await acceptPaymentOperation(operation, payload, cashlogyTransaction)
    let fiscalEntry = null
    if (localFiscalProduction) {
      try {
        fiscalEntry = await issuePosInvoice(context, cashSession, payload, false, undefined, undefined, preparedFiscalInstallation)
      } catch (error) {
        fail(error instanceof Error ? error.message : 'No se ha podido guardar el registro fiscal; no se emitirá la factura.')
        return
      }
    }
    const fiscalPayload = fiscalEntry ? printPayloadWithLocalFiscal(payload, fiscalEntry) : payload
    const saleRecord: SaleRecord = { id: payload.sale.id, cashSessionId: cashSession.id, paymentMethod, totalCents: payload.sale.totalCents, createdAt: payload.sale.createdAt }
    const ticketRecord: SessionTicketRecord = { id: payload.sale.id, ticketNumber: payload.ticket.ticketNumber ?? 0, cashSessionId: cashSession.id, paymentMethod, totalCents: payload.sale.totalCents, createdAt: payload.sale.createdAt, status: 'active', payload: fiscalPayload, printStatus: 'not_requested', printAttempts: 0 }
    operationBreadcrumb({ operation: 'sale.payment', saleId: payload.sale.id, ticketId: payload.ticket.id, cashSessionId: cashSession.id, step: 'persist' })
    try {
      await commitPaymentOperation(operation, fiscalPayload, !fiscalEntry)
    } catch (error) {
      reportOperationError(error, { operation: 'sale.payment', saleId: payload.sale.id, step: 'durable_commit', recoverable: true })
      fail('El cobro conserva su identidad. No se pudo finalizar el registro local; recupera este cobro antes de iniciar otro.')
      return
    }
    const updateSecondary = (step: string, update: () => void) => {
      try { update() } catch (error) {
        reportOperationError(error, { operation: 'sale.payment', saleId: payload.sale.id, step, recoverable: true })
        options.onError('La venta está guardada. No se pudo actualizar algún dato local; puedes recuperarla desde el histórico. No vuelvas a cobrarla.')
      }
    }
    updateSecondary('ledger_cache', () => {
      const current = latestOptionsRef.current
      if (!current.context || !current.cashSession || paymentScope(current.context, current.cashSession.id) !== paymentScope(context, cashSession.id)) return
      const savedLedger = [...current.ledger.filter(sale => sale.id !== saleRecord.id), saleRecord]
      current.persistLedger(savedLedger)
      latestOptionsRef.current = { ...current, ledger: savedLedger }
    })
    updateSecondary('ticket_cache', () => {
      const current = latestOptionsRef.current
      if (!current.context || !current.cashSession || paymentScope(current.context, current.cashSession.id) !== paymentScope(context, cashSession.id)) return
      const savedTickets = [ticketRecord, ...current.tickets.filter(ticket => ticket.id !== ticketRecord.id)]
      current.persistTickets(savedTickets)
      latestOptionsRef.current = { ...current, tickets: savedTickets }
    })
    if (sameDraft) {
      updateSecondary('product_stats', () => options.mergeProductStats(lines))
    }
    updateSecondary('pending_count', options.refreshPendingCount)
    const cashDrawerAlreadyRequested = requestEarlyCashDrawer({
      requestId: `drawer:${payload.sale.id}:payment`,
      payments: [{ method: payload.payment?.method, amountCents: payload.payment?.amountCents }],
    })
    updateSecondary('clear_paid_draft', clearPaidDraftLines)
    if (!sameDraft) options.onError('Se ha recuperado el cobro pendiente con sus datos originales. Los productos nuevos del ticket todavía no se han cobrado.')
    updateSecondary('cashlogy_acknowledgement', () => finishCashlogyPayment(cashlogyTransaction))
    // The economic transaction is durable. Network and hardware work must not
    // keep the payment UI (or Cashlogy recovery) waiting for acknowledgement.
    void (async () => {
      if (fiscalEntry) {
        const scope = { tenantId: fiscalEntry.record.tenantId, fiscalSubjectId: fiscalEntry.record.fiscalSubjectId,
          installationId: fiscalEntry.record.installationId }
        void synchronizeFiscalEconomicSales(scope).then(async () => {
          const bridgeUrl = fiscalBridgeBaseUrl(context.tenantId)
          if (bridgeUrl) await synchronizeLocalFiscalQueue({ ...scope, mode: 'production', baseUrl: bridgeUrl,
            getAccessToken: fiscalBridgeAccessToken })
        }).catch(() => { /* Saved in IndexedDB for retry. */ })
      }
      let printPayload = fiscalPayload
      if (options.isOnline && !fiscalEntry) {
        await options.syncPendingEvents()
        try {
          const persistedTicket = await (options.loadPersistedTicket
            ? options.loadPersistedTicket(payload.ticket.id)
            : loadSessionTicketFromSupabase(context, cashSession.id, payload.ticket.id))
          if (persistedTicket) printPayload = persistedTicket.payload
          const invoice = payload.ticket.invoice
            ? await loadTicketInvoice(context.tenantId, payload.ticket.id)
            : null
          if (payload.ticket.invoice && !invoice) {
            options.onError('La venta ha quedado pendiente de sincronizar. No se imprimirá una factura sin número definitivo.')
            return
          }
          if (invoice) {
            printPayload = { ...printPayload, ticket: { ...printPayload.ticket, invoice } }
          }
          if (persistedTicket || invoice) {
            const current = latestOptionsRef.current
            if (current.context?.tenantId === context.tenantId
              && current.context.venueId === context.venueId
              && current.context.deviceId === context.deviceId
              && current.cashSession?.id === cashSession.id
              && current.tickets.some(ticket => ticket.id === payload.sale.id)) {
              current.persistTickets(current.tickets.map(ticket => ticket.id === payload.sale.id
                ? { ...ticket, ticketNumber: persistedTicket?.ticketNumber ?? ticket.ticketNumber,
                    payload: { ...ticket.payload, ticket: printPayload.ticket,
                      fiscal: printPayload.fiscal, localFiscal: printPayload.localFiscal } } : ticket))
            }
          }
        } catch (fiscalError) {
          reportOperationError(fiscalError, { operation: 'sale.fiscal_receipt', saleId: payload.sale.id, ticketId: payload.ticket.id, cashSessionId: cashSession.id, step: 'before_print' })
          if (payload.ticket.invoice) {
            options.onError('No se ha podido confirmar el número de factura. Revisa la sincronización antes de imprimir.')
            return
          }
        }
      }
      await options.printSale(printPayload, { cashDrawerAlreadyRequested, fiscalMode: localFiscalProduction ? 'verifactu' : 'legacy' })
    })().catch(error => {
      reportOperationError(error, { operation: 'sale.payment', saleId: payload.sale.id,
        ticketId: payload.ticket.id, cashSessionId: cashSession.id, step: 'after_persist', recoverable: true })
      options.onError('La venta está guardada. No se ha podido completar la sincronización o la impresión; revisa su estado antes de reimprimir.')
    })
  }, [options])

  const pay = useCallback(async (
    paymentMethod: PaymentMethod | null,
    receivedCents: number | null,
    confirmedCashlogyTransaction: CashlogyTransaction | null = null,
    recoveryKey?: string,
  ) => {
    if (paymentInFlightRef.current) {
      if (confirmedCashlogyTransaction) throw new Error('El registro del cobro anterior sigue en curso. Espera a que termine antes de aplicarlo de nuevo.')
      return
    }
    paymentInFlightRef.current = true
    options.onPaymentInFlightChange?.(true)
    try {
      if (options.context && options.cashSession) {
        await withPaymentLock(paymentScope(options.context, options.cashSession.id), () => completePayment(paymentMethod, receivedCents, confirmedCashlogyTransaction, recoveryKey))
      } else await completePayment(paymentMethod, receivedCents, confirmedCashlogyTransaction, recoveryKey)
    } catch (error) {
      reportOperationError(error, { operation: 'sale.payment', step: 'payment_recovery', recoverable: true })
      options.onError(getReadableError(error, { operation: 'sale.payment' }, 'No se pudo completar el registro. Revisa el cobro original antes de repetirlo.'))
      if (confirmedCashlogyTransaction) throw error
    } finally {
      paymentInFlightRef.current = false
      options.onPaymentInFlightChange?.(false)
    }
  }, [completePayment, options])

  const recoveryScopeRef = useRef<string | null>(null)
  useEffect(() => {
    const { context, cashSession } = options
    if (!context || !cashSession) { recoveryScopeRef.current = null; return }
    const scope = paymentScope(context, cashSession.id)
    if (recoveryScopeRef.current === scope) return
    recoveryScopeRef.current = scope
    void loadPaymentOperations(context, cashSession.id).then(async operations => {
      for (const operation of operations) {
        if (recoveryScopeRef.current !== scope) return
        if ((operation.key !== `${scope}|quick-sale` && !operation.key.startsWith(`${scope}|quick-sale:`))
          || (operation.state !== 'accepted' && operation.state !== 'charging')) continue
        await pay(operation.payload.payment?.method ?? null, operation.payload.payment?.receivedCents ?? null, null, operation.key)
      }
    }).catch(error => {
      reportOperationError(error, { operation: 'sale.payment', step: 'restore_payment', recoverable: true })
      options.onError('No se pudo recuperar el cobro pendiente. Conserva el almacenamiento y reintenta la recuperación antes de volver a cobrar.')
    })
  }, [options, pay])
  return pay
}
