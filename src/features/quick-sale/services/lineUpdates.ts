import type { TicketLine } from '../../../types'

export function applyQuickSaleLinesUpdate(
  previous: TicketLine[],
  update: (lines: TicketLine[]) => TicketLine[],
  persist: (lines: TicketLine[]) => void,
) {
  const next = update(previous)
  persist(next)
  return next
}
