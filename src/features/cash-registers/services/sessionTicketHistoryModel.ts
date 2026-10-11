import type { SessionTicketRecord } from '../../../types/index.ts'

export const SESSION_TICKETS_PAGE_SIZE = 12

export type NumberedSessionTicket = {
  number: number
  ticket: SessionTicketRecord
}

export type SessionTicketHistoryPage = {
  currentPage: number
  tickets: NumberedSessionTicket[]
  totalResults: number
  source?: 'local'
}

const normalizeSearch = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

/** Search historical snapshots, never the current catalog. */
export function createLocalSessionTicketHistoryPage(tickets: SessionTicketRecord[], page: number, query: string): SessionTicketHistoryPage {
  const text = normalizeSearch(query)
  const amount = query.replace(/[\s€]/g, '').replace(',', '.')
  const amountCents = /^\d+(\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : null
  const filtered = tickets.filter(ticket => !text || amountCents === ticket.totalCents || [
    ticket.id, ticket.payload.ticket.id, String(ticket.ticketNumber ?? ''), `ticket ${ticket.ticketNumber ?? ''}`,
    ticket.payload.localFiscal ? `${ticket.payload.localFiscal.series}/${ticket.payload.localFiscal.number}` : '',
    ...ticket.payload.lines.flatMap(line => [line.productName, line.variantName ?? '',
      ...(line.components ?? []).flatMap(component => [component.productName, component.variantName ?? ''])]),
  ].some(value => normalizeSearch(value).includes(text)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
  const lastPage = Math.max(1, Math.ceil(filtered.length / SESSION_TICKETS_PAGE_SIZE))
  const requestedPage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1
  const currentPage = Math.min(requestedPage, lastPage)
  return { currentPage, totalResults: filtered.length, source: 'local',
    tickets: filtered.slice((currentPage - 1) * SESSION_TICKETS_PAGE_SIZE, currentPage * SESSION_TICKETS_PAGE_SIZE)
      .map(ticket => ({ number: ticket.ticketNumber ?? 0, ticket })) }
}

export function createCachedSessionTicketHistoryPage(
  tickets: SessionTicketRecord[],
): SessionTicketHistoryPage | null {
  if (!tickets.length) return null

  const sortedTickets = [...tickets].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id)
  ))

  return {
    currentPage: 1,
    tickets: sortedTickets
      .slice(0, SESSION_TICKETS_PAGE_SIZE)
      .map((ticket) => ({ number: ticket.ticketNumber ?? 0, ticket })),
    totalResults: sortedTickets.length,
  }
}

export function getVisibleTicketPages(currentPage: number, totalResults: number) {
  const totalPages = Math.max(1, Math.ceil(totalResults / SESSION_TICKETS_PAGE_SIZE))
  const firstVisiblePage = Math.max(1, Math.min(currentPage - 2, totalPages - 4))
  const lastVisiblePage = Math.min(totalPages, firstVisiblePage + 4)

  return Array.from(
    { length: lastVisiblePage - firstVisiblePage + 1 },
    (_, index) => firstVisiblePage + index,
  )
}
