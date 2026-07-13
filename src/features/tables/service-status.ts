import type { RestaurantOrderLine, ServiceStatus } from './types'

export function getPendingQuantity(line: Pick<RestaurantOrderLine, 'quantity' | 'servedQuantity'>) {
  return Math.max(0, line.quantity - line.servedQuantity)
}

export function getServiceStatus(line: Pick<RestaurantOrderLine, 'quantity' | 'servedQuantity'>): ServiceStatus {
  if (line.servedQuantity <= 0) return 'pending'
  return line.servedQuantity >= line.quantity ? 'served' : 'partial'
}

export function getOrderPendingUnits(lines: Array<Pick<RestaurantOrderLine, 'quantity' | 'servedQuantity'>>) {
  return lines.reduce((total, line) => total + getPendingQuantity(line), 0)
}

export function isLineRemovable(line: Pick<RestaurantOrderLine, 'servedQuantity'>) {
  return line.servedQuantity === 0
}

export function canDecreaseLineQuantity(line: Pick<RestaurantOrderLine, 'quantity' | 'servedQuantity'>) {
  return line.quantity > line.servedQuantity
}
