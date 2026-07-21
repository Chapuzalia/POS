import { useCallback } from 'react'
import { createId } from '../../../lib/format'
import { enqueueOfflineEvent } from '../../../lib/offlineStore'
import { buildSalePayload } from '../../../services/posService'
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
}

export function useQuickSalePayment(options: Options) {
  return useCallback(async (paymentMethod: PaymentMethod | null, receivedCents: number | null) => {
    const { context, cashSession, lines } = options
    if (!context || !cashSession || lines.length === 0) return
    const payload = buildSalePayload(context, cashSession, lines, paymentMethod, receivedCents, options.discount)
    const saleRecord: SaleRecord = { id: payload.sale.id, cashSessionId: cashSession.id, paymentMethod, totalCents: payload.sale.totalCents, createdAt: payload.sale.createdAt }
    enqueueOfflineEvent({ id: createId(), kind: 'sale_created', tenantId: context.tenantId, createdAt: payload.sale.createdAt, attempts: 0, payload })
    options.persistLedger([...options.ledger, saleRecord])
    options.persistTickets([{ id: payload.sale.id, cashSessionId: cashSession.id, paymentMethod, totalCents: payload.sale.totalCents, createdAt: payload.sale.createdAt, status: 'active', payload, printStatus: 'not_requested', printAttempts: 0 }, ...options.tickets])
    options.mergeProductStats(lines)
    options.persistLines([])
    options.refreshPendingCount()
    options.resetUi(paymentMethod)
    const printTask = options.printSale(payload)
    if (options.isOnline) void options.syncPendingEvents()
    await printTask
  }, [options])
}
