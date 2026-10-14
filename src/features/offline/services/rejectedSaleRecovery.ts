import type { OfflineEvent, TicketLine } from '../../../types'

type RejectedSale = Extract<OfflineEvent, { kind: 'sale_created' }>

interface RejectedSaleRecovery {
  closedSessionId: string
  discount: RejectedSale['payload']['ticket']['discount'] | null
  linesToRestore: TicketLine[] | null
  rejectedSaleId: string
}

export function getRejectedSaleRecovery(
  event: RejectedSale,
  _hasCurrentTicket?: boolean,
): RejectedSaleRecovery {
  return {
    closedSessionId: event.payload.ticket.cashSessionId,
    discount: null,
    linesToRestore: null,
    rejectedSaleId: event.payload.sale.id,
  }
}
