import { useCallback } from 'react'
import { createId } from '../../../lib/format'
import { enqueueOfflineEvent } from '../../../lib/offlineStore'
import { buildSalePayload } from '../services/salePayload'
import { loadFiscalReceiptData } from '../../fiscal/service'
import {
  finishCashlogyPayment,
  getCashlogyPaymentAmounts,
  settleCashlogyPaymentIfConfigured,
} from '../../local-printing/cashlogy/useCashlogyStore'
import type { AppliedDiscount, CashSession, PaymentMethod, SaleRecord, SessionTicketRecord, TenantContext, TicketLine } from '../../../types'

type Options = {
  context: TenantContext | null
  cashSession: CashSession | null
  lines: TicketLine[]
  discount: AppliedDiscount | null
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
  return useCallback(async (paymentMethod: PaymentMethod | null, receivedCents: number | null) => {
    const { context, cashSession, lines } = options
    if (!context || !cashSession || lines.length === 0) return
    const preview = buildSalePayload(context, cashSession, lines, paymentMethod, receivedCents, options.discount)
    let cashlogyTransaction = null
    if (paymentMethod === 'cash') {
      try {
        cashlogyTransaction = await settleCashlogyPaymentIfConfigured(preview.sale.totalCents, preview.sale.id)
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
        if (fiscal) {
          printPayload = { ...payload, fiscal }
          options.persistTickets([{ ...ticketRecord, payload: printPayload }, ...options.tickets])
        }
      } catch (fiscalError) {
        console.error('Could not load fiscal QR before printing', fiscalError)
      }
    }
    const printTask = options.printSale(printPayload)
    await printTask
  }, [options])
}
