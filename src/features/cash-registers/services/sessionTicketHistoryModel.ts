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
