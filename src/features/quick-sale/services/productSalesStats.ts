import type { ProductSalesStat, TicketLine } from '../../../types'

function sortStats(stats: ProductSalesStat[]) {
  return stats.toSorted((a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents || a.productId.localeCompare(b.productId))
}

export function addProductSalesStats(currentStats: ProductSalesStat[], lines: TicketLine[]) {
  return addConfirmedProductSalesStats(currentStats, lines.map((line) => ({
    productId: line.productId, quantity: line.quantity, lineTotalCents: line.unitPriceCents * line.quantity,
  })))
}

export function addConfirmedProductSalesStats(currentStats: ProductSalesStat[], lines: Array<{ productId: string; quantity: number; lineTotalCents: number }>) {
  const statsByProduct = new Map(currentStats.map((stat) => [stat.productId, stat]))
  for (const line of lines) {
    if (!line.productId) continue
    const current = statsByProduct.get(line.productId) ?? { productId: line.productId, quantity: 0, totalCents: 0 }
    statsByProduct.set(line.productId, {
      ...current,
      quantity: current.quantity + line.quantity,
      totalCents: current.totalCents + line.lineTotalCents,
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
