import { useEffect, useRef } from 'react'
import {
  saveCachedCashSession,
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
    const recovery = getRejectedSaleRecovery(rejectedSaleEvent)
    if (current.cashSession?.id === recovery.closedSessionId) {
      current.setCashSession(null)
      saveCachedCashSession(context, null)
    }
    current.resetCashUi()
    current.setError('La caja original está cerrada. La venta y su cobro se conservan pendientes de conciliación. No vuelvas a cobrarla; el ticket actual se ha conservado.')
    current.clearRejectedSaleEvent()
  }, [context, rejectedSaleEvent])
}
