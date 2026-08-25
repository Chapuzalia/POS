import type { TicketLine } from '../../../types'

export function setQuickSaleTicketLineQuantity(lines: TicketLine[], lineId: string, quantity: number) {
  const nextQuantity = Number.isFinite(quantity) ? Math.max(1, Math.trunc(quantity)) : 1
  return lines.map((line) => line.id === lineId ? { ...line, quantity: nextQuantity } : line)
}

export function setQuickSaleTicketLineUnitPrice(lines: TicketLine[], lineId: string, unitPriceCents: number) {
  const nextUnitPriceCents = Number.isFinite(unitPriceCents) ? Math.max(0, Math.round(unitPriceCents)) : 0
  return lines.map((line) => line.id === lineId ? { ...line, unitPriceCents: nextUnitPriceCents } : line)
}
