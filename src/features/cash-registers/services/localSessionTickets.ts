import { getSessionTickets } from '../../../lib/offlineStore'
import { loadDurableSessionTickets } from '../../../lib/durableSales.ts'
import type { CashSession, SaleRecord, SessionTicketRecord, TenantContext } from '../../../types'
import { listLocalFiscalEconomicSales, listLocalFiscalEntries, listLocalFiscalScopes } from '../../fiscal/local/localLedger.ts'
import { printPayloadWithLocalFiscal } from '../../fiscal/local/posInvoice.ts'

/** Read both caches without changing the immutable SIF documents or economic snapshots. */
export async function loadLocalSessionTickets(context: TenantContext, session: CashSession, loadedTickets: SessionTicketRecord[]): Promise<SessionTicketRecord[]> {
  const inSession = (ticket: SessionTicketRecord) => ticket.cashSessionId === session.id
    && ticket.payload.ticket.tenantId === context.tenantId && ticket.payload.ticket.venueId === context.venueId
  const cached = [...await loadDurableSessionTickets(context, session.id), ...loadedTickets, ...getSessionTickets(context, session.id)].filter(inSession)
  const tickets = new Map(cached.map(ticket => [ticket.payload.ticket.id, ticket]))
  const scopes = await listLocalFiscalScopes(context, session.cashRegisterId)
  for (const scope of scopes) {
    const [entries, sales] = await Promise.all([listLocalFiscalEntries(scope), listLocalFiscalEconomicSales(scope)])
    const entriesById = new Map(entries.map(entry => [entry.id, entry]))
    const annulled = new Set(entries.filter(entry => entry.annulment).map(entry => entry.invoice.ticketId))
    for (const sale of sales) {
      const entry = entriesById.get(sale.id)
      const payload = sale.payload
      if (!entry || entry.annulment || payload.ticket.tenantId !== context.tenantId || payload.ticket.venueId !== context.venueId
        || payload.ticket.cashSessionId !== session.id || payload.ticket.cashRegisterId !== session.cashRegisterId
        || entry.record.deviceId !== context.deviceId) continue
      const cachedTicket = tickets.get(payload.ticket.id)
      if (cachedTicket) {
        // Cache holds later payment changes, refunds and printing state.
        tickets.set(payload.ticket.id, { ...cachedTicket,
          status: annulled.has(payload.ticket.id) ? 'voided' : cachedTicket.status,
          payload: printPayloadWithLocalFiscal(cachedTicket.payload, entry) })
      } else {
        tickets.set(payload.ticket.id, { id: payload.sale.id, ticketNumber: payload.ticket.ticketNumber,
          cashSessionId: session.id, paymentMethod: payload.sale.paymentMethod, totalCents: payload.sale.totalCents,
          createdAt: payload.sale.createdAt, status: annulled.has(payload.ticket.id) ? 'voided' : 'active',
          payload: printPayloadWithLocalFiscal(payload, entry) })
      }
    }
  }
  return [...tickets.values()]
}

export async function loadLocalSessionSales(context: TenantContext, session: CashSession): Promise<SaleRecord[]> {
  const tickets = await loadLocalSessionTickets(context, session, [])
  return tickets.filter(ticket => ticket.status !== 'voided').map(ticket => ({ id: ticket.id,
    cashSessionId: session.id, paymentMethod: ticket.paymentMethod, totalCents: ticket.totalCents, createdAt: ticket.createdAt,
    payments: ticket.payload.payments ?? (ticket.payload.payment ? [ticket.payload.payment] : undefined) }))
}
