import type { ProductSalesStat, TicketLine } from '../../../types'

function sortStats(stats: ProductSalesStat[]) {
  return stats.toSorted((a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents || a.productId.localeCompare(b.productId))
}

export function addProductSalesStats(currentStats: ProductSalesStat[], lines: TicketLine[]) {
  const statsByProduct = new Map(currentStats.map((stat) => [stat.productId, stat]))
  for (const line of lines) {
    const current = statsByProduct.get(line.productId) ?? { productId: line.productId, quantity: 0, totalCents: 0 }
    statsByProduct.set(line.productId, {
      ...current,
      quantity: current.quantity + line.quantity,
      totalCents: current.totalCents + line.unitPriceCents * line.quantity,
    })
  }
  return sortStats([...statsByProduct.values()])
}

export function removeProductSalesStats(currentStats: ProductSalesStat[], lines: Array<{ productId: string; quantity: number; lineTotalCents: number }>) {
  const statsByProduct = new Map(currentStats.map((stat) => [stat.productId, stat]))
  for (const line of lines) {
    const current = statsByProduct.get(line.productId)
    if (!current) continue
    const quantity = Math.max(0, current.quantity - line.quantity)
    if (!quantity) {
      statsByProduct.delete(line.productId)
      continue
    }
    statsByProduct.set(line.productId, { ...current, quantity, totalCents: Math.max(0, current.totalCents - line.lineTotalCents) })
  }
  return sortStats([...statsByProduct.values()])
}
