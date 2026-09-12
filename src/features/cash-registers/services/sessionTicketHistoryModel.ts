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

export function getVisibleTicketPages(currentPage: number, totalResults: number) {
  const totalPages = Math.max(1, Math.ceil(totalResults / SESSION_TICKETS_PAGE_SIZE))
  const firstVisiblePage = Math.max(1, Math.min(currentPage - 2, totalPages - 4))
  const lastVisiblePage = Math.min(totalPages, firstVisiblePage + 4)

  return Array.from(
    { length: lastVisiblePage - firstVisiblePage + 1 },
    (_, index) => firstVisiblePage + index,
  )
}
