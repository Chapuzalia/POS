import type { OfflineEvent } from '../../../types'

/** Keep existing operation counts, adding each fiscal ticket only once. */
export function pendingSync(events: OfflineEvent[], fiscalTicketIds: string[]) {
  const pendingTicketIds = new Set<string>()
  const pendingSaleIds = new Set<string>()
  for (const event of events) {
    if (event.kind === 'sale_created') pendingTicketIds.add(event.payload.ticket.id)
    if (event.kind === 'sale_voided') pendingTicketIds.add(event.payload.ticketId)
    if (event.kind === 'sale_payment_changed') pendingSaleIds.add(event.payload.saleId)
  }
  let pendingCount = events.length
  for (const id of new Set(fiscalTicketIds)) {
    if (!pendingTicketIds.has(id)) pendingCount++
    pendingTicketIds.add(id)
  }
  return { pendingCount, pendingTicketIds, pendingSaleIds }
}
