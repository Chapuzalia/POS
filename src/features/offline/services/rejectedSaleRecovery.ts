import type { OfflineEvent, TicketLine } from '../../../types'

type RejectedSale = Extract<OfflineEvent, { kind: 'sale_created' }>

export function getRejectedSaleRecovery(event: RejectedSale, hasCurrentTicket: boolean) {
  const lines: TicketLine[] = event.payload.lines.map((line) => ({
    id: line.id,
    modifiers: line.modifiers,
    productId: line.productId,
    productName: line.productName,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    variantId: line.variantId,
    variantName: line.variantName,
  }))
  return {
    closedSessionId: event.payload.ticket.cashSessionId,
    discount: event.payload.ticket.discount ?? null,
    linesToRestore: hasCurrentTicket ? null : lines,
    rejectedSaleId: event.payload.sale.id,
  }
}
