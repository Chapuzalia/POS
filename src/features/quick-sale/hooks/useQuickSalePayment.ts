import { useCallback, useRef } from 'react'
import { createId } from '../../../lib/format'
import { enqueueOfflineEvent } from '../../../lib/offlineStore'
import { buildSalePayload } from '../services/salePayload'
import { loadFiscalReceiptData } from '../../fiscal/service'
import { loadTicketInvoice } from '../../customers/service'
import {
  finishCashlogyPayment,
  getCashlogyPaymentAmounts,
  settleCashlogyPaymentIfConfigured,
} from '../../local-printing/cashlogy/useCashlogyStore'
import type { AppliedDiscount, CashSession, Customer, PaymentMethod, SaleRecord, SessionTicketRecord, TenantContext, TicketLine } from '../../../types'
import type { CashlogyTransaction } from '../../local-printing/types'

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
  printSale: (payload: SessionTicketRecord['payload']) => Promise<void>
  onError: (message: string | null) => void
}

export function useQuickSalePayment(options: Options) {
  const paymentInFlightRef = useRef(false)

  const completePayment = useCallback(async (
    paymentMethod: PaymentMethod | null,
    receivedCents: number | null,
    confirmedCashlogyTransaction: CashlogyTransaction | null = null,
  ) => {
    const { context, cashSession, lines } = options
    if (!context || !cashSession || lines.length === 0) return
    if (options.invoiceCustomer && !options.isOnline) {
      options.onError('Conéctate antes de cobrar una factura para asignar su número definitivo.')
      return
    }
    if (confirmedCashlogyTransaction && !confirmedCashlogyTransaction.saleId) {
      options.onError('El cobro recuperado no pertenece a una venta rápida identificable.')
      return
    }
    const preview = buildSalePayload(
      context,
      cashSession,
      lines,
      paymentMethod,
      receivedCents,
      options.discount,
      options.invoiceCustomer,
      confirmedCashlogyTransaction?.saleId ? { saleId: confirmedCashlogyTransaction.saleId } : undefined,
    )
    let cashlogyTransaction = null
    if (paymentMethod === 'cash') {
      try {
        cashlogyTransaction = confirmedCashlogyTransaction
          ?? await settleCashlogyPaymentIfConfigured(preview.sale.totalCents, preview.sale.id)
        if (cashlogyTransaction && (
          cashlogyTransaction.requestedAmountCents !== preview.sale.totalCents
          || cashlogyTransaction.saleId !== preview.sale.id
        )) {
          throw new Error('El cobro confirmado en Cashlogy no coincide con esta venta.')
        }
      } catch (error) {
        options.onError(error instanceof Error ? error.message : 'No se pudo completar el cobro con Cashlogy.')
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
    const saleRecord: SaleRecord = { id: payload.sale.id, cashSessionId: cashSession.id, paymentMethod, totalCents: payload.sale.totalCents, createdAt: payload.sale.createdAt }
    const ticketRecord: SessionTicketRecord = { id: payload.sale.id, cashSessionId: cashSession.id, paymentMethod, totalCents: payload.sale.totalCents, createdAt: payload.sale.createdAt, status: 'active', payload, printStatus: 'not_requested', printAttempts: 0 }
    enqueueOfflineEvent({ id: createId(), kind: 'sale_created', tenantId: context.tenantId, createdAt: payload.sale.createdAt, attempts: 0, payload })
    options.persistLedger([...options.ledger, saleRecord])
    options.persistTickets([ticketRecord, ...options.tickets])
    options.mergeProductStats(lines)
    options.persistLines([])
    options.refreshPendingCount()
    options.resetUi(paymentMethod)
    finishCashlogyPayment(cashlogyTransaction)
    let printPayload = payload
    if (options.isOnline) {
      await options.syncPendingEvents()
      try {
        const fiscal = await loadFiscalReceiptData(context.tenantId, payload.ticket.id)
        if (fiscal) printPayload = { ...payload, fiscal }
        const invoice = options.invoiceCustomer
          ? await loadTicketInvoice(context.tenantId, payload.ticket.id)
          : null
        if (options.invoiceCustomer && !invoice) {
          options.onError('La venta ha quedado pendiente de sincronizar. No se imprimirá una factura sin número definitivo.')
          return
        }
        if (invoice) {
          printPayload = { ...printPayload, ticket: { ...printPayload.ticket, invoice } }
        }
        if (fiscal || invoice) {
          options.persistTickets([{ ...ticketRecord, payload: printPayload }, ...options.tickets])
        }
      } catch (fiscalError) {
        console.error('Could not load fiscal QR before printing', fiscalError)
        if (options.invoiceCustomer) {
          options.onError('No se ha podido confirmar el número de factura. Revisa la sincronización antes de imprimir.')
          return
        }
      }
    }
    const printTask = options.printSale(printPayload)
    await printTask
  }, [options])

  return useCallback(async (
    paymentMethod: PaymentMethod | null,
    receivedCents: number | null,
    confirmedCashlogyTransaction: CashlogyTransaction | null = null,
  ) => {
    if (paymentInFlightRef.current) return
    paymentInFlightRef.current = true
    try {
      await completePayment(paymentMethod, receivedCents, confirmedCashlogyTransaction)
    } finally {
      paymentInFlightRef.current = false
    }
  }, [completePayment])
}
