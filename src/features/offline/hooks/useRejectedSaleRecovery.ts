import { useEffect, useRef } from 'react'
import {
  clearSessionTickets,
  getCachedTicket,
  removeSaleFromLedger,
  saveCachedCashSession,
  saveCachedTicket,
} from '../../../lib/offlineStore'
import type {
  AppliedDiscount,
  CashSession,
  OfflineEvent,
  SaleRecord,
  SessionTicketRecord,
  TenantContext,
  TicketLine,
} from '../../../types'
import { getRejectedSaleRecovery } from '../services/rejectedSaleRecovery'

type RejectedSaleEvent = Extract<OfflineEvent, { kind: 'sale_created' }>

type Options = {
  context: TenantContext | null
  cashSession: CashSession | null
  rejectedSaleEvent: RejectedSaleEvent | null
  clearRejectedSaleEvent: () => void
  setCashSession: (session: CashSession | null) => void
  setTicketLines: (lines: TicketLine[]) => void
  setDiscount: (discount: AppliedDiscount | null) => void
  setSalesLedger: React.Dispatch<React.SetStateAction<SaleRecord[]>>
  setSessionTickets: React.Dispatch<React.SetStateAction<SessionTicketRecord[]>>
  resetCashUi: () => void
  setError: (message: string) => void
}

export function useRejectedSaleRecovery(options: Options) {
  const latestRef = useRef(options)
  latestRef.current = options
  const { context, rejectedSaleEvent } = options

  useEffect(() => {
    if (!context || !rejectedSaleEvent || rejectedSaleEvent.tenantId !== context.tenantId) return
    const current = latestRef.current
    const currentTicket = getCachedTicket(context)
    const recovery = getRejectedSaleRecovery(rejectedSaleEvent, currentTicket.length > 0)
    const restoredLines = recovery.appendToCurrentTicket
      ? [...currentTicket, ...recovery.linesToRestore]
      : recovery.linesToRestore
    current.setTicketLines(restoredLines)
    saveCachedTicket(context, restoredLines)
    current.setDiscount(recovery.discount)
    if (current.cashSession?.id === recovery.closedSessionId) {
      current.setCashSession(null)
      saveCachedCashSession(context, null)
    }
    current.setSalesLedger((ledger) => ledger.filter((sale) => sale.id !== recovery.rejectedSaleId))
    removeSaleFromLedger(context, recovery.rejectedSaleId)
    current.setSessionTickets((tickets) => tickets.filter((ticket) => ticket.id !== recovery.rejectedSaleId))
    clearSessionTickets(context, recovery.closedSessionId)
    current.resetCashUi()
    current.setError('La venta no se ha registrado porque la caja estaba cerrada. El ticket se ha recuperado para cobrarlo tras abrir una caja nueva.')
    current.clearRejectedSaleEvent()
  }, [context, rejectedSaleEvent])
}
