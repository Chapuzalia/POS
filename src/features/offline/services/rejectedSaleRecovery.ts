import type { OfflineEvent, TicketLine } from '../../../types'

type RejectedSale = Extract<OfflineEvent, { kind: 'sale_created' }>

interface RejectedSaleRecovery {
  appendToCurrentTicket: boolean
  closedSessionId: string
  discount: RejectedSale['payload']['ticket']['discount'] | null
  linesToRestore: TicketLine[]
  rejectedSaleId: string
}

export function getRejectedSaleRecovery(
  event: RejectedSale,
  hasCurrentTicket: boolean,
): RejectedSaleRecovery {
  const lines: TicketLine[] = event.payload.lines.map((line) => ({
    id: line.id,
    modifiers: line.modifiers,
    productId: line.productId,
    productName: line.productName,
    basePriceCents: line.basePriceCents,
    componentDeltaCents: line.componentDeltaCents,
    modifierDeltaCents: line.modifierDeltaCents,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    variantId: line.variantId,
    variantName: line.variantName,
    components: line.components,
    catalogSnapshot: line.catalogSnapshot,
  }))
  return {
    appendToCurrentTicket: hasCurrentTicket,
    closedSessionId: event.payload.ticket.cashSessionId,
    discount: event.payload.ticket.discount ?? null,
    linesToRestore: lines,
    rejectedSaleId: event.payload.sale.id,
  }
}
