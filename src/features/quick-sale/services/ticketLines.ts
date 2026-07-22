import { createId, getLineSignature } from '../../../lib/format'
import { buildSaleLine } from '../../catalog/services/saleLineBuilder'
import type { CatalogData, ResolvedCatalogItem, ResolvedSellableProduct } from '../../catalog/domain/types'
import type { ProductLineSelection, TicketLine } from '../../../types'

export function addQuickSaleTicketLine(
  lines: TicketLine[],
  catalog: CatalogData,
  sellable: ResolvedSellableProduct,
  selection: ProductLineSelection,
  item: ResolvedCatalogItem | null,
) {
  const candidate = buildSaleLine(createId(), catalog, sellable, selection, item)
  const signature = getLineSignature(candidate)
  const existing = lines.find((line) => getLineSignature(line) === signature)
  return existing
    ? lines.map((line) => line.id === existing.id ? { ...line, quantity: line.quantity + 1 } : line)
    : [...lines, candidate]
}

export function changeQuickSaleTicketLineQuantity(lines: TicketLine[], lineId: string, direction: 1 | -1) {
  return lines
    .map((line) => line.id === lineId ? { ...line, quantity: line.quantity + direction } : line)
    .filter((line) => line.quantity > 0)
}
